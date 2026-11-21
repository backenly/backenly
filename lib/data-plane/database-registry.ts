/**
 * A BOUNDED SET OF OPEN CONNECTIONS, ONE PER PROJECT DATABASE
 * ===========================================================
 * A project with a database of its own (lib/data-plane/regional.ts) is reached
 * on a client opened for that database alone. A process may serve many such
 * projects, so it keeps at most `max` of them open, least recently used out
 * first, and closes one to make room only when it is idle:
 *
 *   pinned       never closed while pinned. A governed change pins its
 *                project's client for its whole run (lib/changes/ledger.ts),
 *                so every statement it sends goes over one client.
 *   in flight    never closed while a query or a transaction is running on it
 *                (`track`).
 *   just used    never closed within `minIdleMs` of its last use, so a value
 *                handed out a moment ago is not closed before its query starts.
 *
 * When every entry is in use and the set is full, opening another is refused
 * with DatabaseBusyError, which is retryable. Nothing is ever opened past the
 * cap.
 *
 * ONE DATA INSTANCE, SEVERAL SETS. A process opens a project database's
 * connections through more than one set (its Prisma clients, its pg pools), and
 * every one of them lands on the same data instance. So an entry may also be
 * admitted to a ConnectionBudget, a cap on the connections a process keeps to
 * that instance across every set: an entry counts its most connections there
 * while it is open, and at the cap the least recently used idle entry of ANY
 * set is let go to make room. A caller that can wait (whenRoom) waits a few
 * seconds for room when none is idle, and is then refused with the same
 * retryable DatabaseBusyError.
 *
 * Generic and synchronous: the values are created by the caller's factory and
 * closed by `close`, so the rules are tested with stand-ins
 * (tests/unit/project-database-resolution.spec.ts) and a value is available in
 * the same tick it is asked for, as a Prisma batch transaction needs.
 */

/** Every entry is in use and the set is full: try again shortly. */
export class DatabaseBusyError extends Error {
  readonly code = 'PROJECT_DATABASE_BUSY'
  readonly retryable = true
  readonly status = 503

  constructor(
    readonly what: string,
    readonly max: number,
  ) {
    super(`All ${max} ${what} this server keeps open are in use. Nothing was sent; try again shortly.`)
    this.name = 'DatabaseBusyError'
  }
}

/** Counts one use of an entry from start to the returned `done`, which may be called more than once. */
export interface UseTracker {
  start(): () => void
}

export interface RegistryOptions<T> {
  /** At most this many values are open at once. */
  max: number
  /** Closes a value that leaves the set. Errors are swallowed: the value is gone either way. */
  close: (value: T, key: string) => void | Promise<void>
  /**
   * Connections a value still holds after `close`, for a value that is let go
   * rather than ended (a pg pool a caller may still be using, whose idle
   * connections close on their own). Counted by its budget until they are gone.
   */
  held?: (value: T) => number
  /** Whether the value has nothing in use of its own (for a pg Pool: nothing checked out, nobody waiting). */
  idle?: (value: T) => boolean
  /** An entry used more recently than this is not closed to make room. */
  minIdleMs?: number
  now?: () => number
  /** Plural, for the busy error: "project database clients". */
  what: string
}

interface Entry<T> {
  key: string
  value: T
  pins: number
  inFlight: number
  lastUsed: number
  /** The budget the entry was admitted to, and its place there. */
  budget?: ConnectionBudget
  member?: BudgetMember
}

/** Where a new entry's connections are counted, and how many it may open. */
export interface Admission {
  budget: ConnectionBudget
  /** The most connections the new value may hold at once. */
  weight: number
}

export class DatabaseRegistry<T> {
  private readonly entries = new Map<string, Entry<T>>()
  private readonly now: () => number

  constructor(private readonly options: RegistryOptions<T>) {
    if (!Number.isInteger(options.max) || options.max < 1) throw new Error(`a registry of ${options.what} needs a cap of at least 1`)
    this.now = options.now ?? Date.now
  }

  get size(): number {
    return this.entries.size
  }

  get max(): number {
    return this.options.max
  }

  has(key: string): boolean {
    return this.entries.has(key)
  }

  /**
   * The open value for `key`, created with `create` when there is none. May
   * close the least recently used idle entry to make room, here or, with an
   * `admission`, in any set counted by the same budget, and throws
   * DatabaseBusyError when there is none to close.
   */
  get(key: string, create: (tracker: UseTracker) => T, admission?: Admission): T {
    return this.entry(key, create, admission).value
  }

  /** Count one use of `key`'s entry until the returned function is called. A no-op for a key not open. */
  track(key: string): () => void {
    const entry = this.entries.get(key)
    if (!entry) return () => {}
    return this.trackerFor(entry).start()
  }

  /**
   * Open `key` if needed and keep it open until the returned release is
   * called (more than once is harmless). Pins nest.
   */
  pin(key: string, create: (tracker: UseTracker) => T, admission?: Admission): () => void {
    const entry = this.entry(key, create, admission)
    entry.pins++
    let released = false
    return () => {
      if (released) return
      released = true
      entry.pins--
      entry.lastUsed = this.now()
    }
  }

  /** Whether `key` is open and pinned. */
  isPinned(key: string): boolean {
    return (this.entries.get(key)?.pins ?? 0) > 0
  }

  /**
   * Close every value, pinned or not, and forget them all: with `close`, when
   * shutting down needs more than making room does.
   */
  async closeAll(close: RegistryOptions<T>['close'] = this.options.close): Promise<void> {
    const all = [...this.entries.values()]
    this.entries.clear()
    // Ended, not let go: nothing they held is left to count.
    for (const entry of all) if (entry.member) entry.budget?.leave(entry.member)
    await Promise.all(all.map((entry) => this.closeQuietly(entry, close)))
  }

  private entry(key: string, create: (tracker: UseTracker) => T, admission?: Admission): Entry<T> {
    const existing = this.entries.get(key)
    if (existing) {
      // Most recently used goes last; the first in the map is the oldest.
      this.entries.delete(key)
      this.entries.set(key, existing)
      existing.lastUsed = this.now()
      return existing
    }
    if (this.entries.size >= this.options.max) this.evictOne()
    if (admission && !admission.budget.makeRoom(admission.weight)) throw admission.budget.busy()

    const entry = { key, pins: 0, inFlight: 0, lastUsed: this.now() } as Entry<T>
    entry.value = create(this.trackerFor(entry))
    this.entries.set(key, entry)
    if (admission) {
      const member: BudgetMember = {
        weight: admission.weight,
        lastUsed: () => entry.lastUsed,
        evictable: () => this.closable(entry, this.now()),
        evict: () => this.remove(entry),
      }
      entry.budget = admission.budget
      entry.member = member
      admission.budget.join(member)
    }
    return entry
  }

  /** Whether an entry may be closed to make room: not pinned, not running, not just used, and idle by its own account. */
  private closable(entry: Entry<T>, now: number): boolean {
    if (entry.pins > 0 || entry.inFlight > 0) return false
    if (now - entry.lastUsed < (this.options.minIdleMs ?? 0)) return false
    return !this.options.idle || this.options.idle(entry.value)
  }

  /** Forget and close an entry, telling its budget what it still holds. */
  private remove(entry: Entry<T>): void {
    if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key)
    if (entry.member) {
      const held = this.options.held
      entry.budget?.leave(entry.member, held ? () => held(entry.value) : undefined)
    }
    void this.closeQuietly(entry)
  }

  private trackerFor(entry: Entry<T>): UseTracker {
    return {
      start: () => {
        entry.inFlight++
        entry.lastUsed = this.now()
        let done = false
        return () => {
          if (done) return
          done = true
          entry.inFlight--
          entry.lastUsed = this.now()
        }
      },
    }
  }

  private evictOne(): void {
    const now = this.now()
    for (const entry of this.entries.values()) {
      if (!this.closable(entry, now)) continue
      this.remove(entry)
      return
    }
    throw new DatabaseBusyError(this.options.what, this.options.max)
  }

  private async closeQuietly(entry: Entry<T>, close: RegistryOptions<T>['close'] = this.options.close): Promise<void> {
    try {
      await close(entry.value, entry.key)
    } catch {
      // Closing a value that already failed is not an error worth surfacing.
    }
  }
}

// ── A cap per data instance, across sets ─────────────────────────────────────

/** How long a caller that can wait waits for room before it is refused. */
export const ROOM_WAIT_MS = 5_000
/** How often a waiting caller looks again. */
const ROOM_POLL_MS = 50

/** One open value counted by a ConnectionBudget, as its registry describes it. */
export interface BudgetMember {
  /** The most connections it may hold while it is open. */
  readonly weight: number
  lastUsed(): number
  /** Whether it may be let go now: nothing pinned, running or checked out on it, and not just used. */
  evictable(): boolean
  /** Let it go: its registry forgets and closes it, and calls leave(). */
  evict(): void
}

export interface BudgetOptions {
  /** The most connections counted at once. A function is read each time, so a changed setting applies at once. */
  cap: number | (() => number)
  /** Plural, for the busy error: "connections to project databases in us-east-1". */
  what: string
}

/**
 * The connections a process keeps to one data instance, counted across every
 * registry whose entries are admitted to it.
 *
 * An open entry counts its weight, the most connections it may hold, so
 * whatever it does next stays under the cap without asking again. An entry let
 * go that still holds connections (a pool a caller may still be using, whose
 * idle connections close on their own) counts what it still holds until they
 * are gone: the cap is a count of connections, not of entries.
 *
 * Synchronous, so a registry can be asked in the same tick (whenRoom is the
 * waiting form).
 */
export class ConnectionBudget {
  private readonly members = new Set<BudgetMember>()
  private readonly lingering = new Set<() => number>()

  constructor(private readonly options: BudgetOptions) {}

  get cap(): number {
    const { cap } = this.options
    return typeof cap === 'function' ? cap() : cap
  }

  /** Connections counted now: each open entry's weight, and what entries let go still hold. */
  used(): number {
    let total = 0
    for (const member of this.members) total += member.weight
    for (const held of this.lingering) {
      const n = held()
      if (n > 0) total += n
      else this.lingering.delete(held)
    }
    return total
  }

  /**
   * Whether `weight` more connections fit, after letting go of idle entries,
   * least recently used first, until they do. False when they cannot: nothing
   * left to let go is idle.
   */
  makeRoom(weight: number): boolean {
    const cap = this.cap
    if (weight > cap) return false
    while (this.used() + weight > cap) {
      let victim: BudgetMember | null = null
      for (const member of this.members) {
        if (member.evictable() && (victim === null || member.lastUsed() < victim.lastUsed())) victim = member
      }
      if (victim === null) return false
      victim.evict()
      // A registry always leaves as it evicts; this keeps a faulty one from looping here.
      this.members.delete(victim)
    }
    return true
  }

  join(member: BudgetMember): void {
    this.members.add(member)
  }

  /** An entry is gone; `stillHeld`, when given, counts what it holds until that reaches zero. */
  leave(member: BudgetMember, stillHeld?: () => number): void {
    this.members.delete(member)
    if (stillHeld && stillHeld() > 0) this.lingering.add(stillHeld)
  }

  busy(): DatabaseBusyError {
    return new DatabaseBusyError(this.options.what, this.cap)
  }
}

/**
 * `attempt`, tried again while it throws DatabaseBusyError, for at most
 * `waitMs`: what needs room waits for some to come free (a query finishing, a
 * pool's idle connections closing), then is refused with the last busy error,
 * which is retryable. Any other error is thrown at once.
 */
export async function whenRoom<R>(attempt: () => R, waitMs: number = ROOM_WAIT_MS): Promise<R> {
  const deadline = Date.now() + Math.max(0, waitMs)
  for (;;) {
    try {
      return attempt()
    } catch (err) {
      if (!(err instanceof DatabaseBusyError)) throw err
      const left = deadline - Date.now()
      if (left <= 0) throw err
      await new Promise((resolve) => setTimeout(resolve, Math.min(ROOM_POLL_MS, left)))
    }
  }
}
