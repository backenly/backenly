/**
 * The children this host runs: at most one PostgREST per project, started on
 * the first request and stopped when idle.
 *
 *   single flight   concurrent first requests for a project share one start
 *   hard cap        at maxChildren, the least recently used child with no
 *                   request in flight is stopped to make room; when every
 *                   child is busy the request is refused (DATA_PLANE_BUSY)
 *                   rather than queued
 *   idle reap       a child with no proxied request for idleMs is stopped
 *   crashes         a child that exits on its own is started again by the next
 *                   request; crashLimit failures of one database within
 *                   crashWindowMs (an exit, or a start that never became
 *                   ready) open that database's circuit for circuitOpenMs
 *   one database,   a database this host serves for one project is refused
 *   one project     for another (DATABASE_IN_USE), and a token naming another
 *                   database than the project's running child is refused
 *                   (DATABASE_MISMATCH): moving a project to another database
 *                   is an explicit restart, so tokens minted before the move
 *                   can never switch it back
 *
 * Every lifecycle event is one log line, prefixed with the project id.
 */

import type { ChildExit, LaunchedChild, Launcher } from './launcher'
import { projectLine, type LogLine } from './log'

export interface RegistryConfig {
  maxChildren: number
  idleMs: number
  readyTimeoutMs: number
  stopGraceMs: number
  crashLimit: number
  crashWindowMs: number
  circuitOpenMs: number
  busyRetryAfterSeconds: number
}

/** A request this host answers itself instead of forwarding. */
export class HostRefusal extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message)
    this.name = 'HostRefusal'
    Object.setPrototypeOf(this, HostRefusal.prototype)
  }
}

export type StopReason = 'idle' | 'evicted' | 'restart' | 'shutdown' | 'start-failed' | 'crashed'

interface Entry {
  projectId: string
  database: string
  state: 'starting' | 'ready'
  child: LaunchedChild | null
  ready: Promise<void>
  startedAt: number
  readyAt: number | null
  coldStartMs: number | null
  rssAtReadyBytes: number | null
  lastUsed: number
  inFlight: number
  stopping: boolean
  stopReason: StopReason | null
  stopped: Promise<unknown> | null
  failed: boolean
}

export interface Lease {
  port: number
  release(): void
}

export interface ChildState {
  projectId: string
  database: string | null
  state: 'stopped' | 'starting' | 'ready' | 'circuit_open'
  pid: number | null
  startedAt: string | null
  coldStartMs: number | null
  lastUsedAt: string | null
  inFlight: number
  rssBytes: number | null
  rssAtReadyBytes: number | null
  recentFailures: number
  circuitOpenUntil: string | null
}

const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString())

export class ChildRegistry {
  private readonly entries = new Map<string, Entry>()
  private readonly failures = new Map<string, number[]>()
  private readonly circuits = new Map<string, number>()
  private closed = false
  private readonly now: () => number
  private readonly log: LogLine

  constructor(
    private readonly launcher: Launcher,
    private readonly config: RegistryConfig,
    options: { now?: () => number; log?: LogLine } = {},
  ) {
    this.now = options.now ?? Date.now
    this.log = options.log ?? (() => {})
  }

  /** Children running or starting. */
  get size(): number {
    return this.entries.size
  }

  /**
   * A lease on the project's child, started if it is not running. The caller
   * must release it when its request ends; until then the child is not idle.
   */
  async acquire(projectId: string, database: string): Promise<Lease> {
    return this.acquireOnce(projectId, database, true)
  }

  private async acquireOnce(projectId: string, database: string, mayRetry: boolean): Promise<Lease> {
    if (this.closed) throw new HostRefusal(503, 'DATA_PLANE_UNAVAILABLE', 'This host is shutting down.', 1)

    let entry = this.entries.get(projectId)
    if (entry && entry.database !== database) {
      throw new HostRefusal(
        409,
        'DATABASE_MISMATCH',
        'This project is served here from another database. A restart moves it to the database the token names.',
      )
    }
    if (!entry) {
      this.assertDatabaseFree(projectId, database)
      this.assertCircuitClosed(projectId, database)
      this.makeRoom(projectId)
      entry = this.spawn(projectId, database)
    }

    entry.inFlight++
    entry.lastUsed = this.now()
    try {
      await entry.ready
    } catch (err) {
      entry.inFlight--
      // Waiting on a child that a restart replaced: follow the replacement once
      // rather than failing a request nothing is wrong with.
      if (mayRetry && entry.stopReason === 'restart') return this.acquireOnce(projectId, database, false)
      throw err
    }
    if (entry.stopping) {
      entry.inFlight--
      if (mayRetry) return this.acquireOnce(projectId, database, false)
      throw new HostRefusal(503, 'DATA_PLANE_START_FAILED', 'The project database server stopped while starting.', 2)
    }

    const leased = entry
    const port = leased.child!.port
    let released = false
    return {
      port,
      release: () => {
        if (released) return
        released = true
        leased.inFlight = Math.max(0, leased.inFlight - 1)
        leased.lastUsed = this.now()
      },
    }
  }

  /** A snapshot of the project's child; `database` is the token's, for the circuit when nothing runs. */
  state(projectId: string, database: string): ChildState {
    const entry = this.entries.get(projectId)
    const db = entry?.database ?? database
    const until = this.circuitUntil(db)
    return {
      projectId,
      database: entry ? entry.database : null,
      state: entry ? entry.state : until !== null ? 'circuit_open' : 'stopped',
      pid: entry?.child?.pid ?? null,
      startedAt: entry ? iso(entry.startedAt) : null,
      coldStartMs: entry?.coldStartMs ?? null,
      lastUsedAt: entry ? iso(entry.lastUsed) : null,
      inFlight: entry?.inFlight ?? 0,
      rssBytes: entry?.child?.rssBytes() ?? null,
      rssAtReadyBytes: entry?.rssAtReadyBytes ?? null,
      recentFailures: this.recentFailures(db),
      circuitOpenUntil: iso(until),
    }
  }

  /** The child itself, for a live probe. */
  child(projectId: string): LaunchedChild | null {
    const entry = this.entries.get(projectId)
    return entry && entry.state === 'ready' ? entry.child : null
  }

  /**
   * Stop the project's child and start it again: the heal for one project's
   * database server. An explicit restart also closes the database's circuit.
   */
  async restart(projectId: string, database: string): Promise<ChildState> {
    if (this.closed) throw new HostRefusal(503, 'DATA_PLANE_UNAVAILABLE', 'This host is shutting down.', 1)
    this.closeCircuit(projectId, database, 'restart requested')
    const existing = this.entries.get(projectId)
    if (existing) await this.retire(existing, 'restart')

    let entry = this.entries.get(projectId)
    if (entry && entry.database !== database) {
      // A request still carrying the previous database started it meanwhile.
      await this.retire(entry, 'restart')
      entry = this.entries.get(projectId)
    }
    if (!entry) {
      this.assertDatabaseFree(projectId, database)
      this.makeRoom(projectId)
      entry = this.spawn(projectId, database)
    }
    await entry.ready
    return this.state(projectId, database)
  }

  /** Stop every child idle for idleMs. Resolves when they have exited. */
  async reapIdle(): Promise<number> {
    const now = this.now()
    const idle = [...this.entries.values()].filter(
      (e) => e.state === 'ready' && e.inFlight === 0 && now - e.lastUsed >= this.config.idleMs,
    )
    await Promise.all(idle.map((e) => this.retire(e, 'idle')))
    return idle.length
  }

  /** Stop every child and refuse new work. Resolves when every child has exited. */
  async shutdown(): Promise<void> {
    this.closed = true
    await Promise.all(
      [...this.entries.values()].map(async (entry) => {
        await this.retire(entry, 'shutdown')
        // A child still being launched is stopped by start() once it exists.
        await entry.ready.catch(() => {})
        await (entry.stopped ?? Promise.resolve())
      }),
    )
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private spawn(projectId: string, database: string): Entry {
    const now = this.now()
    const entry: Entry = {
      projectId,
      database,
      state: 'starting',
      child: null,
      ready: Promise.resolve(),
      startedAt: now,
      readyAt: null,
      coldStartMs: null,
      rssAtReadyBytes: null,
      lastUsed: now,
      inFlight: 0,
      stopping: false,
      stopReason: null,
      stopped: null,
      failed: false,
    }
    this.entries.set(projectId, entry)
    entry.ready = this.start(entry)
    // Observed by every waiter; this keeps a start nobody waits on from being reported as unhandled.
    entry.ready.catch(() => {})
    return entry
  }

  private async start(entry: Entry): Promise<void> {
    const { projectId, database } = entry
    let child: LaunchedChild
    try {
      child = await this.launcher({ projectId, database })
    } catch (err) {
      this.forget(entry)
      this.markFailed(entry, `could not be started: ${err instanceof Error ? err.message : String(err)}`)
      throw new HostRefusal(503, 'DATA_PLANE_START_FAILED', 'The project database server could not be started.', 2)
    }
    entry.child = child
    this.log(projectLine(projectId, `starting for database ${database} (pid ${child.pid ?? 'unknown'})`))
    void child.exited.then((exit) => this.onExit(entry, exit))

    if (entry.stopping) {
      // Stopped (restart, shutdown, ...) while the launcher was still starting it.
      entry.stopped = child.stop(this.config.stopGraceMs)
      throw new HostRefusal(503, 'DATA_PLANE_START_FAILED', 'The project database server was stopped while starting.', 2)
    }

    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`not ready within ${this.config.readyTimeoutMs} ms`)), this.config.readyTimeoutMs)
      timer.unref?.()
    })
    try {
      await Promise.race([child.ready, timeout])
    } catch (err) {
      if (entry.stopping && entry.stopReason !== 'crashed') {
        throw new HostRefusal(503, 'DATA_PLANE_START_FAILED', 'The project database server was stopped while starting.', 2)
      }
      this.markFailed(entry, `did not become ready: ${err instanceof Error ? err.message : String(err)}`)
      void this.retire(entry, 'start-failed')
      throw new HostRefusal(503, 'DATA_PLANE_START_FAILED', 'The project database server did not start.', 2)
    } finally {
      if (timer) clearTimeout(timer)
    }

    if (entry.stopping) {
      throw new HostRefusal(503, 'DATA_PLANE_START_FAILED', 'The project database server was stopped while starting.', 2)
    }
    entry.state = 'ready'
    entry.readyAt = this.now()
    entry.coldStartMs = entry.readyAt - entry.startedAt
    entry.rssAtReadyBytes = child.rssBytes()
    const rss = entry.rssAtReadyBytes === null ? '' : `, ${(entry.rssAtReadyBytes / 1048576).toFixed(1)} MiB resident`
    this.log(projectLine(projectId, `ready in ${entry.coldStartMs} ms (pid ${child.pid ?? 'unknown'}${rss})`))
  }

  private onExit(entry: Entry, exit: ChildExit): void {
    this.forget(entry)
    const how = `code ${exit.code}, signal ${exit.signal}`
    if (entry.stopping && entry.stopReason !== 'crashed') {
      this.log(projectLine(entry.projectId, `stopped (${entry.stopReason}; ${how})`))
      return
    }
    entry.stopping = true
    entry.stopReason = 'crashed'
    this.markFailed(entry, `exited on its own (${how})`)
  }

  /** Stop a child for `reason`. Idempotent; resolves when it has exited. */
  private retire(entry: Entry, reason: StopReason): Promise<unknown> {
    this.forget(entry)
    if (entry.stopping) return entry.stopped ?? Promise.resolve()
    entry.stopping = true
    entry.stopReason = reason
    this.log(projectLine(entry.projectId, `stopping (${reason}; pid ${entry.child?.pid ?? 'not started'})`))
    // Before the launcher returns there is no process yet; start() stops it when it does.
    entry.stopped = entry.child ? entry.child.stop(this.config.stopGraceMs) : Promise.resolve()
    return entry.stopped
  }

  /** Drop the entry from the map if it is still the project's current one. */
  private forget(entry: Entry): void {
    if (this.entries.get(entry.projectId) === entry) this.entries.delete(entry.projectId)
  }

  /** Count one failure of the entry's database, at most once per child; may open its circuit. */
  private markFailed(entry: Entry, why: string): void {
    if (entry.failed) return
    entry.failed = true
    const now = this.now()
    const recent = (this.failures.get(entry.database) ?? []).filter((t) => now - t < this.config.crashWindowMs)
    recent.push(now)
    const window = Math.round(this.config.crashWindowMs / 1000)
    this.log(
      projectLine(entry.projectId, `failed: ${why} (${recent.length} of ${this.config.crashLimit} within ${window} s)`),
    )
    if (recent.length >= this.config.crashLimit) {
      const until = now + this.config.circuitOpenMs
      this.circuits.set(entry.database, until)
      this.failures.delete(entry.database)
      this.log(
        projectLine(entry.projectId, `circuit open for database ${entry.database} until ${new Date(until).toISOString()}`),
      )
    } else {
      this.failures.set(entry.database, recent)
    }
  }

  private recentFailures(database: string): number {
    const now = this.now()
    return (this.failures.get(database) ?? []).filter((t) => now - t < this.config.crashWindowMs).length
  }

  private circuitUntil(database: string): number | null {
    const until = this.circuits.get(database)
    if (until === undefined) return null
    return this.now() < until ? until : null
  }

  private assertCircuitClosed(projectId: string, database: string): void {
    const until = this.circuits.get(database)
    if (until === undefined) return
    const now = this.now()
    if (now >= until) {
      this.closeCircuit(projectId, database, 'window passed')
      return
    }
    throw new HostRefusal(
      503,
      'DATA_PLANE_CIRCUIT_OPEN',
      `The project database server failed ${this.config.crashLimit} times in a row and is not being started again yet.`,
      Math.max(1, Math.ceil((until - now) / 1000)),
    )
  }

  private closeCircuit(projectId: string, database: string, why: string): void {
    const wasOpen = this.circuits.delete(database)
    this.failures.delete(database)
    if (wasOpen) this.log(projectLine(projectId, `circuit closed for database ${database} (${why})`))
  }

  private assertDatabaseFree(projectId: string, database: string): void {
    for (const entry of this.entries.values()) {
      if (entry.database === database && entry.projectId !== projectId) {
        throw new HostRefusal(409, 'DATABASE_IN_USE', 'This database is served here for another project.')
      }
    }
  }

  /** At the cap, stop the least recently used child with nothing in flight, or refuse. */
  private makeRoom(projectId: string): void {
    if (this.entries.size < this.config.maxChildren) return
    let victim: Entry | null = null
    for (const entry of this.entries.values()) {
      if (entry.state !== 'ready' || entry.inFlight > 0) continue
      if (!victim || entry.lastUsed < victim.lastUsed) victim = entry
    }
    if (!victim) {
      this.log(projectLine(projectId, `refused: all ${this.config.maxChildren} database servers are busy`))
      throw new HostRefusal(
        503,
        'DATA_PLANE_BUSY',
        'Every database server on this host is busy. Retry shortly.',
        this.config.busyRetryAfterSeconds,
      )
    }
    this.log(projectLine(victim.projectId, `evicted to make room for ${projectId}`))
    void this.retire(victim, 'evicted')
  }
}
