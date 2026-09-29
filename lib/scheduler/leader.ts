/**
 * One scheduler per database.
 *
 * The web server runs every scheduled job in-process (instrumentation.ts).
 * Two web processes against one database therefore meant every job twice:
 * users' own cron functions, the autonomy loop, backups, the usage close. So
 * Backenly Cloud ran exactly one web task and deployed it stop-first, which
 * made every deploy a short outage, and a self-hoster running two instances
 * behind a load balancer silently doubled their users' cron jobs.
 *
 * Now every process may schedule, but a job only runs in the process that
 * holds one PostgreSQL advisory lock. Everything else about the process (HTTP,
 * realtime, the usage ledger) is unaffected.
 *
 * Why a session-scoped advisory lock on a dedicated connection:
 *   • It is exactly "held while this process is alive". A process that exits
 *     or crashes closes its connection and the database drops the lock, so a
 *     new instance takes over without anyone having to expire a lease.
 *   • It needs no table, no migration and no privilege beyond LOGIN.
 *   • It is the pattern lib/ai/build-runtime/build-lock.ts settled on after the
 *     pooled version leaked: a session lock must stay on the session that took
 *     it, so this connection is never shared with anything else.
 *
 * Fails closed. Until the lock is confirmed, and whenever the connection is in
 * doubt, this process runs nothing: a missed tick is repaired by the next one
 * (every job here is periodic, and the ones that must not skip a period, such
 * as the usage close, are written to catch up), while a doubled tick is not.
 *
 * The two-integer key form lives in a separate key space from the single
 * bigint keys the build lock uses, so the two can never collide.
 */
import { Client } from 'pg'

/** 'BKNS' and slot 1: the scheduler. Other slots are free for future singletons. */
export const SCHEDULER_LOCK_KEY: readonly [number, number] = [0x424b4e53, 1]

export interface LeadershipOptions {
  connectionString?: string
  /** How often a follower asks for the lock, and a lost connection reconnects. */
  retryMs?: number
  /** How often the leader proves its session (and therefore its lock) is alive. */
  heartbeatMs?: number
  /** Upper bound on any single query to the lock connection. */
  queryTimeoutMs?: number
  log?: (line: string) => void
}

export class SchedulerLeadership {
  private client: Client | null = null
  private leader = false
  private stopped = false
  private timer: NodeJS.Timeout | null = null
  private readonly opts: Required<Omit<LeadershipOptions, 'connectionString'>> & { connectionString?: string }

  constructor(options: LeadershipOptions = {}) {
    this.opts = {
      connectionString: options.connectionString,
      retryMs: options.retryMs ?? 5_000,
      heartbeatMs: options.heartbeatMs ?? 15_000,
      queryTimeoutMs: options.queryTimeoutMs ?? 10_000,
      log: options.log ?? ((line) => console.log(line)),
    }
  }

  isLeader(): boolean {
    return this.leader && !this.stopped
  }

  start(): void {
    if (this.timer || this.stopped) return
    void this.tick()
  }

  /** Stop scheduling here and hand the lock over now rather than at exit. */
  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    const wasLeader = this.leader
    this.leader = false
    await this.dropConnection()
    if (wasLeader) this.opts.log('[Scheduler] released the scheduler lock')
  }

  private schedule(ms: number): void {
    if (this.stopped) return
    this.timer = setTimeout(() => void this.tick(), ms)
    this.timer.unref?.()
  }

  private async tick(): Promise<void> {
    this.timer = null
    if (this.stopped) return
    try {
      const client = await this.connection()
      if (this.leader) {
        // Same session answering means the same session holds the lock.
        await client.query('SELECT 1')
      } else {
        const res = await client.query<{ acquired: boolean }>(
          'SELECT pg_try_advisory_lock($1::int, $2::int) AS acquired',
          [SCHEDULER_LOCK_KEY[0], SCHEDULER_LOCK_KEY[1]],
        )
        if (res.rows[0]?.acquired === true && !this.stopped) {
          this.leader = true
          this.opts.log('[Scheduler] this instance holds the scheduler lock and runs the scheduled jobs')
        }
      }
    } catch (err: any) {
      this.loseConnection(err?.message ?? String(err))
    }
    this.schedule(this.leader ? this.opts.heartbeatMs : this.opts.retryMs)
  }

  private async connection(): Promise<Client> {
    if (this.client) return this.client
    const connectionString = this.opts.connectionString ?? process.env.DATABASE_URL
    if (!connectionString) throw new Error('DATABASE_URL is not set')
    const client = new Client({
      connectionString,
      application_name: 'backenly-scheduler-lock',
      connectionTimeoutMillis: this.opts.queryTimeoutMs,
      query_timeout: this.opts.queryTimeoutMs,
      keepAlive: true,
    })
    // A connection that dies between ticks must stop this process scheduling
    // at once, not at the next heartbeat.
    client.on('error', (err) => this.loseConnection(err.message))
    client.on('end', () => {
      if (this.client === client) this.loseConnection('connection closed')
    })
    this.client = client
    await client.connect()
    return client
  }

  private loseConnection(reason: string): void {
    const wasLeader = this.leader
    this.leader = false
    void this.dropConnection()
    if (wasLeader && !this.stopped) {
      this.opts.log(`[Scheduler] lost the scheduler lock (${reason}); scheduled jobs paused here until it is re-acquired`)
    }
  }

  private async dropConnection(): Promise<void> {
    const client = this.client
    this.client = null
    if (!client) return
    client.removeAllListeners('end')
    client.on('error', () => {})
    await client.end().catch(() => {})
  }
}

// ── The process-wide instance ────────────────────────────────────────────────

const g = globalThis as unknown as { __backenlySchedulerLeadership?: SchedulerLeadership }

/**
 * Call once at startup, before scheduling anything. Also releases the lock on
 * SIGTERM/SIGINT so the replacement instance takes over as soon as this one
 * starts shutting down, instead of when its connection finally closes.
 */
export function startSchedulerLeadership(options?: LeadershipOptions): SchedulerLeadership {
  if (g.__backenlySchedulerLeadership) return g.__backenlySchedulerLeadership
  const leadership = new SchedulerLeadership(options)
  g.__backenlySchedulerLeadership = leadership
  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.once(sig, () => void leadership.stop())
  }
  leadership.start()
  return leadership
}

export function isSchedulerLeader(): boolean {
  return g.__backenlySchedulerLeadership?.isLeader() ?? false
}

/**
 * Wrap a scheduled job so it runs only where the scheduler lock is held. The
 * check is made when the tick fires, so leadership moving between ticks moves
 * the jobs with it.
 */
export function leaderOnly(
  task: () => unknown,
  isLeader: () => boolean = isSchedulerLeader,
): () => Promise<void> {
  return async () => {
    if (!isLeader()) return
    await task()
  }
}
