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
   * close the least recently used idle entry to make room, and throws
   * DatabaseBusyError when there is none to close.
   */
  get(key: string, create: (tracker: UseTracker) => T): T {
    return this.entry(key, create).value
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
  pin(key: string, create: (tracker: UseTracker) => T): () => void {
    const entry = this.entry(key, create)
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
    await Promise.all(all.map((entry) => this.closeQuietly(entry, close)))
  }

  private entry(key: string, create: (tracker: UseTracker) => T): Entry<T> {
    const existing = this.entries.get(key)
    if (existing) {
      // Most recently used goes last; the first in the map is the oldest.
      this.entries.delete(key)
      this.entries.set(key, existing)
      existing.lastUsed = this.now()
      return existing
    }
    if (this.entries.size >= this.options.max) this.evictOne()

    const entry = { key, pins: 0, inFlight: 0, lastUsed: this.now() } as Entry<T>
    entry.value = create(this.trackerFor(entry))
    this.entries.set(key, entry)
    return entry
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
    const minIdle = this.options.minIdleMs ?? 0
    for (const entry of this.entries.values()) {
      if (entry.pins > 0 || entry.inFlight > 0) continue
      if (now - entry.lastUsed < minIdle) continue
      if (this.options.idle && !this.options.idle(entry.value)) continue
      this.entries.delete(entry.key)
      void this.closeQuietly(entry)
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
