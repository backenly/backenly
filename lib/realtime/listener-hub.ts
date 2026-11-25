/**
 * Realtime Listener Hub — one LISTEN connection per database, per process.
 *
 * WHY THIS EXISTS
 * ---------------
 * The previous architecture opened one dedicated (non-pooled) pg.Client per
 * SSE subscriber. With Postgres max_connections = 100 on the production box,
 * ~90 concurrent realtime clients — across ALL projects combined — would
 * exhaust the database and take down the entire platform, while the plan
 * table promises 25 (Free) / 1,000 (Pro) / custom (Enterprise) concurrent
 * connections PER PROJECT. Those numbers are only physically possible when
 * the LISTEN fan-out is shared.
 *
 * This hub holds exactly ONE direct pg connection per database per process,
 * LISTENs on every channel that has at least one subscriber, and dispatches
 * NOTIFY payloads to in-process handlers. SSE responses are plain HTTP — they
 * no longer consume any database connection.
 *
 * CHANNELS: each project's stream has its own channel name, kept by the
 * platform (lib/realtime/channels.ts). The hub reads it when the first
 * subscriber of a project arrives, LISTENs on it, and follows it when it is
 * replaced: at once when the old channel says so, and on the next repair pass
 * otherwise. The name never leaves the hub: subscribers are given the
 * stream's label (workspaceChannelName), which is all the SDK reads.
 *
 * REPAIR: while a listener has streams, a pass about once a minute brings their
 * schemas' notify and presence functions current (an older release running
 * beside this one, or a restore, can put an older body back) and follows any
 * channel that changed. Two queries per listener when nothing needs doing.
 *
 * DATABASES: a project's channel is NOTIFYed by the database holding its data
 * (lib/data-plane/regional.ts), so it is LISTENed there and nowhere else. A
 * LISTEN on another database would succeed and then never hear anything. A
 * shared project's database is its region's own: one listener per region,
 * keyed `${region}:control`, opened with the first stream in the region and
 * kept, exactly as before. A project with a database of its own is heard on a
 * listener of that database, keyed `${region}:${database}`: opened with the
 * project's first stream in this process and closed
 * REALTIME_LISTENER_IDLE_CLOSE_MS (60 s) after its last, so a database nobody
 * is streaming from holds no connection. At most REALTIME_DATABASE_LISTENERS_MAX
 * (20) of those are open per process; past that a listener waiting out its
 * grace is closed early to make room, and when none is, the stream is refused
 * with REALTIME_BUSY, which the client retries. Never a stream that would hear
 * nothing.
 *
 * QUOTA: because nginx routes all /api/v1 traffic to a single runtime
 * process (and dev traffic to a single next dev process), the in-process
 * subscriber count per project is the exact live connection count. The
 * plan cap is enforced here, on subscribe, via the quota kernel — reserve
 * first, then check, so two racing connects can't both slip under the cap.
 * The count is the hub's, not a region's: the cap is the account's, across
 * every region its projects are in.
 *
 * RESILIENCE: if a region's pg connection drops, its listener reconnects with
 * capped exponential backoff and re-LISTENs every active channel. Subscribers
 * stay attached through the gap (their HTTP streams are independent); events
 * during the outage are lost, which matches LISTEN/NOTIFY semantics —
 * clients needing gapless data must re-fetch via REST.
 */

import { Client } from 'pg'
import {
  regionDataInstanceUrl,
  regionDatabaseUrl,
  requireRegionDataInstanceUrl,
  requireRegionDatabaseUrl,
  withDatabase,
} from '@/lib/data-plane/regional'
import { workspaceChannelName, workspaceSchemaName } from '@/lib/security/workspace-schema'
import { enforceRealtimeConnection } from '@/lib/quota/kernel'
import { isChannelControlFrame, isChannelName } from '@/lib/realtime/channel-sql'
import {
  bringFunctionsCurrent,
  bringProjectFunctionsCurrent,
  channelsOfSchemas,
  currentProjectChannel,
  projectChannel,
  projectRealtimeDatabase,
  realtimeDatabaseKey,
  realtimeDatabasePool,
  type RealtimeDatabase,
} from '@/lib/realtime/channels'

export type NotificationHandler = (payload: Record<string, unknown>) => void

export type SubscribeResult =
  | { ok: true; channel: string; unsubscribe: () => void }
  | { ok: false; code: 'PLAN_LIMIT_EXCEEDED' | 'INVALID_PROJECT' | 'REALTIME_BUSY'; message: string }

/** What a stream refused for want of a listener is told. Retryable: the SDK reconnects with backoff. */
export const REALTIME_BUSY_MESSAGE =
  'This server is carrying as many realtime databases as it can right now, so the stream was not opened. Try again shortly.'

const RECONNECT_BASE_MS = 500
const RECONNECT_MAX_MS = 15_000
// Light liveness ping — detects a silently dead socket long before a
// subscriber notices missing events. Local DB, so this is nearly free.
const PING_INTERVAL_MS = 4 * 60_000
/** How often a region with streams checks their functions and channels. */
const REPAIR_INTERVAL_MS = 60_000
/** How long a new stream waits for its project's functions to be checked. */
const FUNCTION_CHECK_WAIT_MS = 2_000
/** How long a project database's listener stays open after its last stream, unless set. */
const IDLE_CLOSE_MS = 60_000
/** How many project databases' listeners one process keeps open, unless set. */
const DATABASE_LISTENERS_MAX = 20

function positiveFromEnv(variable: string, fallback: number, min: number): number {
  const parsed = Number.parseInt(process.env[variable] ?? '', 10)
  return Number.isInteger(parsed) && parsed >= min ? parsed : fallback
}

/** REALTIME_LISTENER_IDLE_CLOSE_MS: read when a listener's last stream goes. */
function idleCloseMs(): number {
  return positiveFromEnv('REALTIME_LISTENER_IDLE_CLOSE_MS', IDLE_CLOSE_MS, 0)
}

/** REALTIME_DATABASE_LISTENERS_MAX: read when a project database's listener is to be opened. */
function databaseListenersMax(): number {
  return positiveFromEnv('REALTIME_DATABASE_LISTENERS_MAX', DATABASE_LISTENERS_MAX, 1)
}

function errorText(err: unknown): unknown {
  return err instanceof Error ? err.message : err
}

/**
 * Bring a project's notify and presence functions current when a stream opens:
 * a schema whose realtime was enabled under an older release still runs the
 * old body until then. Waited for briefly, so the first change the subscriber
 * makes is announced; a failure is logged and left to the repair pass, and
 * never fails the stream.
 */
async function bringFunctionsCurrentBriefly(projectId: string): Promise<void> {
  const check = bringProjectFunctionsCurrent(projectId).then(
    () => undefined,
    (err) => {
      // A constant format: the project id is passed as a value, never read as a format.
      console.warn(
        '[ListenerHub] could not bring the realtime notify function of %s up to date:',
        projectId,
        errorText(err),
      )
    },
  )
  let timer: ReturnType<typeof setTimeout> | undefined
  const waited = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, FUNCTION_CHECK_WAIT_MS)
    timer.unref?.()
  })
  await Promise.race([check, waited])
  if (timer) clearTimeout(timer)
}

/** A project's subscribers in one database, and the channel they hear. */
interface Stream {
  readonly projectId: string
  readonly schema: string
  /** What subscribers and logs are shown: never the channel. */
  readonly label: string
  channel: string | null
  readonly handlers: Set<NotificationHandler>
  attaching: Promise<void> | null
  rechecking: Promise<void> | null
  recheckAgain: boolean
  dropped: boolean
}

/**
 * One database's LISTEN connection and the streams it carries: a region's own
 * database (target.database null), kept for the life of the process, or a
 * project's own, closed once nobody has streamed from it for a while.
 */
class DatabaseListener {
  private client: Client | null = null
  private connectPromise: Promise<void> | null = null
  private readonly streams = new Map<string, Stream>() // projectId → stream
  private readonly byChannel = new Map<string, Stream>() // channel → stream
  /** Channels this connection LISTENs on, and how many streams hold each. */
  private readonly listening = new Map<string, number>()
  private reconnectAttempt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private repairTimer: ReturnType<typeof setInterval> | null = null
  private repairing: Promise<void> | null = null
  /** Function failures already logged, so a lasting one is said once. */
  private readonly reported = new Set<string>()
  private destroyed = false
  /** Subscribes under way here: none of them may find the listener closed. */
  private joining = 0
  private idleTimer: ReturnType<typeof setTimeout> | null = null

  readonly key: string
  readonly region: RealtimeDatabase['region']

  constructor(
    readonly target: RealtimeDatabase,
    /** Called once the listener has closed itself, so the hub forgets it. */
    private readonly onClosed: (listener: DatabaseListener) => void = () => {},
  ) {
    this.key = realtimeDatabaseKey(target)
    this.region = target.region
  }

  get channelCount(): number {
    return this.listening.size
  }

  /** A project's own database: closed after its last stream. A region's own is kept. */
  get closesWhenIdle(): boolean {
    return this.target.database !== null
  }

  /** No stream and no subscribe under way: only waiting out its grace before it closes. */
  get idle(): boolean {
    return this.streams.size === 0 && this.joining === 0
  }

  get closed(): boolean {
    return this.destroyed
  }

  /**
   * LISTEN needs a direct connection — PgBouncer transaction mode drops it.
   * A region's own database: its direct connection, else its application one,
   * as DIRECT_URL || DATABASE_URL always was at home. A project's own database:
   * the data instance's direct connection, else its application one
   * (DATA_DIRECT_URL || DATA_DATABASE_URL at home), with the project's
   * database. Never another region's: an unconfigured region throws
   * REGION_NOT_CONFIGURED.
   */
  private connectionString(): string {
    const { region, database } = this.target
    if (database === null) return regionDatabaseUrl(region, 'direct') ?? requireRegionDatabaseUrl(region, 'app')
    return withDatabase(regionDataInstanceUrl(region, 'direct') ?? requireRegionDataInstanceUrl(region, 'app'), database)
  }

  /**
   * Start delivering a project's notifications to `handler`. Returns the way to
   * stop, and whether this call opened the project's stream in this process.
   */
  async listen(projectId: string, handler: NotificationHandler): Promise<{ stop: () => void; opened: boolean }> {
    if (this.destroyed) throw new Error('This realtime listener has closed')
    // Counted from here, so the listener is not closed under a subscribe that
    // is still connecting.
    this.joining++
    this.cancelIdleClose()
    try {
      return await this.join(projectId, handler)
    } finally {
      this.joining--
      this.closeLaterIfIdle()
    }
  }

  private async join(projectId: string, handler: NotificationHandler): Promise<{ stop: () => void; opened: boolean }> {
    // Checked on every subscribe, as workspaceRawClient checks on every call:
    // a region whose connection was removed is refused even while a listener
    // opened earlier is still up.
    this.connectionString()
    await this.ensureConnected()

    let stream = this.streams.get(projectId)
    const opened = !stream
    if (!stream) {
      stream = {
        projectId,
        schema: workspaceSchemaName(projectId),
        label: workspaceChannelName(projectId),
        channel: null,
        handlers: new Set(),
        attaching: null,
        rechecking: null,
        recheckAgain: false,
        dropped: false,
      }
      this.streams.set(projectId, stream)
    }
    const joined = stream
    joined.handlers.add(handler)
    const stop = () => {
      joined.handlers.delete(handler)
      if (joined.handlers.size === 0) this.drop(joined)
    }

    try {
      if (!joined.channel) {
        joined.attaching ??= this.attach(joined)
        await joined.attaching
      }
    } catch (err) {
      stop()
      throw err
    }
    this.startRepairs()
    return { stop, opened }
  }

  /** Read the project's channel (created the first time) and LISTEN on it. */
  private attach(stream: Stream): Promise<void> {
    return (async () => {
      await this.switchTo(stream, await projectChannel(stream.projectId))
    })().finally(() => {
      stream.attaching = null
    })
  }

  /**
   * Move a stream to `channel`: LISTEN on the new one before letting the old
   * one go, so nothing sent on the new one is missed. Only a value that is a
   * channel name is ever written into LISTEN.
   */
  private async switchTo(stream: Stream, channel: string): Promise<void> {
    if (!isChannelName(channel)) throw new Error('Not a realtime channel name')
    if (stream.dropped || stream.channel === channel) return
    const previous = stream.channel
    stream.channel = channel
    this.byChannel.set(channel, stream)
    const listening = this.hold(channel)
    if (previous) {
      if (this.byChannel.get(previous) === stream) this.byChannel.delete(previous)
      this.letGo(previous)
    }
    await listening
  }

  private drop(stream: Stream): void {
    if (stream.dropped) return
    stream.dropped = true
    if (this.streams.get(stream.projectId) === stream) this.streams.delete(stream.projectId)
    if (stream.channel) {
      if (this.byChannel.get(stream.channel) === stream) this.byChannel.delete(stream.channel)
      this.letGo(stream.channel)
      stream.channel = null
    }
    if (this.streams.size === 0) {
      this.stopRepairs()
      this.closeLaterIfIdle()
    }
  }

  // ── Closing a project database's listener ───────────────────────────────────

  private cancelIdleClose(): void {
    if (!this.idleTimer) return
    clearTimeout(this.idleTimer)
    this.idleTimer = null
  }

  /** A project database's listener with nobody on it closes after its grace, unless someone arrives first. */
  private closeLaterIfIdle(): void {
    if (!this.closesWhenIdle || this.destroyed || !this.idle || this.idleTimer) return
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      if (this.idle) this.close()
    }, idleCloseMs())
    this.idleTimer.unref?.()
  }

  /**
   * Close the connection and every timer, for good. Only ever with no stream
   * and no subscribe under way: a stream is never left on a listener that can
   * no longer hear.
   */
  close(): void {
    if (this.destroyed || !this.idle) return
    this.destroyed = true
    this.cancelIdleClose()
    this.stopRepairs()
    if (this.pingTimer) {
      clearInterval(this.pingTimer)
      this.pingTimer = null
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    const client = this.client
    this.client = null
    this.listening.clear()
    client?.end().catch(() => {})
    this.onClosed(this)
  }

  /**
   * Counted, and decided when called: LISTEN and UNLISTEN go out on the one
   * connection in the order the streams asked, so a stream letting a channel
   * go never silences another that has just taken it.
   */
  private hold(channel: string): Promise<void> {
    const holders = this.listening.get(channel) ?? 0
    this.listening.set(channel, holders + 1)
    if (holders > 0 || !this.client) return Promise.resolve() // a reconnect LISTENs on it
    return this.client.query(`LISTEN "${channel}"`).then(() => undefined)
  }

  private letGo(channel: string): void {
    const holders = this.listening.get(channel) ?? 0
    if (holders > 1) {
      this.listening.set(channel, holders - 1)
      return
    }
    this.listening.delete(channel)
    // Best-effort UNLISTEN — session teardown covers failures.
    this.client?.query(`UNLISTEN "${channel}"`).catch(() => {})
  }

  /**
   * Read the project's channel again and follow it if it moved. Calls while
   * one is running ask for one more read after it, never for a second at once.
   */
  private recheck(stream: Stream): void {
    if (stream.dropped) return
    if (stream.rechecking) {
      stream.recheckAgain = true
      return
    }
    stream.rechecking = (async () => {
      do {
        stream.recheckAgain = false
        const channel = await currentProjectChannel(stream.projectId)
        // No channel: the project's schema is gone, and nothing will be sent.
        if (channel !== null && !stream.dropped && channel !== stream.channel) await this.switchTo(stream, channel)
      } while (stream.recheckAgain && !stream.dropped)
    })()
      .catch((err) => {
        console.warn('[ListenerHub] could not read the realtime channel of %s:', stream.projectId, errorText(err))
      })
      .finally(() => {
        stream.rechecking = null
      })
  }

  // ── Repair pass ─────────────────────────────────────────────────────────────

  private startRepairs(): void {
    if (this.repairTimer || this.destroyed) return
    this.repairTimer = setInterval(() => {
      void this.repair()
    }, REPAIR_INTERVAL_MS)
    this.repairTimer.unref?.()
  }

  private stopRepairs(): void {
    if (!this.repairTimer) return
    clearInterval(this.repairTimer)
    this.repairTimer = null
  }

  /** One pass over this listener's streams; a pass already running is shared. */
  repair(): Promise<void> {
    if (!this.repairing) {
      this.repairing = this.runRepair().finally(() => {
        this.repairing = null
      })
    }
    return this.repairing
  }

  private async runRepair(): Promise<void> {
    const streams = [...this.streams.values()].filter((stream) => stream.channel !== null)
    if (streams.length === 0) return
    const schemas = streams.map((stream) => stream.schema)

    // 1. Functions that are not the current ones are replaced.
    try {
      const { failures } = await bringFunctionsCurrent(await realtimeDatabasePool(this.target), schemas)
      for (const { schema, error } of failures) {
        const key = `${schema}:${(error as { code?: string } | null)?.code ?? 'error'}`
        if (this.reported.has(key)) continue
        this.reported.add(key)
        console.warn('[ListenerHub] could not bring the realtime functions of %s up to date:', schema, errorText(error))
      }
    } catch (err) {
      console.warn('[ListenerHub] realtime function check in %s failed:', this.region, errorText(err))
    }

    // 2. A channel that was replaced, or whose row is gone, is read again.
    try {
      const channels = await channelsOfSchemas(this.target, schemas)
      for (const stream of streams) {
        if (!stream.dropped && channels.get(stream.schema) !== stream.channel) this.recheck(stream)
      }
    } catch (err) {
      console.warn('[ListenerHub] realtime channel check in %s failed:', this.region, errorText(err))
    }
    await Promise.all(streams.map((stream) => stream.rechecking ?? Promise.resolve()))
  }

  // ── Connection lifecycle ────────────────────────────────────────────────────

  private async ensureConnected(): Promise<void> {
    if (this.client) return
    if (this.connectPromise) return this.connectPromise
    this.connectPromise = this.openConnection()
    try {
      await this.connectPromise
    } finally {
      this.connectPromise = null
    }
  }

  private async openConnection(): Promise<void> {
    const client = new Client({
      connectionString: this.connectionString(),
      connectionTimeoutMillis: 10_000,
    })

    client.on('notification', (msg) => {
      const stream = this.byChannel.get(msg.channel)
      if (!stream || stream.handlers.size === 0) return
      let payload: Record<string, unknown>
      try {
        payload = JSON.parse(msg.payload || '{}')
      } catch {
        // A constant format; the stream is named by its label, never its channel.
        console.warn('[ListenerHub] Malformed NOTIFY on %s —', stream.label, msg.payload?.slice(0, 200))
        return
      }
      // The channel was replaced: follow it. Never a subscriber's event.
      if (isChannelControlFrame(payload)) {
        this.recheck(stream)
        return
      }
      for (const handler of stream.handlers) {
        try { handler(payload) } catch { /* one bad subscriber never blocks the rest */ }
      }
    })

    client.on('error', () => {
      this.scheduleReconnect()
    })

    await client.connect()
    if (this.destroyed) {
      // Closed while connecting: nobody is left to hear on it.
      client.end().catch(() => {})
      return
    }
    this.client = client
    this.reconnectAttempt = 0

    if (this.pingTimer) clearInterval(this.pingTimer)
    this.pingTimer = setInterval(() => {
      this.client?.query('SELECT 1').catch(() => this.scheduleReconnect())
    }, PING_INTERVAL_MS)

    // Re-LISTEN every channel that has live subscribers (no-op on first connect).
    for (const channel of this.listening.keys()) {
      await client.query(`LISTEN "${channel}"`).catch(() => {})
    }
  }

  private scheduleReconnect(): void {
    if (this.destroyed || this.reconnectTimer) return
    const dead = this.client
    this.client = null
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null }
    dead?.end().catch(() => {})

    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** this.reconnectAttempt)
    this.reconnectAttempt += 1
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null
      if (this.streams.size === 0) return // nobody listening — reconnect lazily on next subscribe
      try {
        await this.ensureConnected()
        console.log(`[ListenerHub] Reconnected to Postgres in ${this.region}, channels re-LISTENed:`, this.listening.size)
        // A channel replaced while the connection was down is followed now.
        void this.repair()
      } catch (err: any) {
        console.warn(`[ListenerHub] Reconnect in ${this.region} failed:`, err?.message)
        this.scheduleReconnect()
      }
    }, delay)
  }
}

class ListenerHub {
  private listeners = new Map<string, DatabaseListener>() // realtimeDatabaseKey → listener
  private counts = new Map<string, number>() // projectId → live subscriber count

  /** Live subscriber count for a project (exposed for status/verification). */
  connectionCount(projectId: string): number {
    return this.counts.get(projectId) ?? 0
  }

  /** Total channels currently LISTENed, across databases (for verification). */
  channelCount(): number {
    let total = 0
    for (const listener of this.listeners.values()) total += listener.channelCount
    return total
  }

  /** The databases this process holds a listener on, by key (for status/verification). */
  listenerKeys(): string[] {
    return [...this.listeners.keys()]
  }

  /**
   * Close this process's listener on one project database, if it holds one:
   * for a database about to be dropped (lib/data-plane/project-databases.ts),
   * whose project is past serving anyone. Its streams end with it.
   */
  closeDatabase(target: RealtimeDatabase): void {
    if (target.database === null) return
    this.listeners.get(realtimeDatabaseKey(target))?.close()
  }

  /**
   * Run the repair pass on every listener now, and wait for it: functions
   * brought current, replaced channels followed. The timer does the same
   * about once a minute.
   */
  async repairNow(): Promise<void> {
    await Promise.all([...this.listeners.values()].map((listener) => listener.repair()))
  }

  /**
   * Register a subscriber for a project's realtime stream.
   * Enforces the plan's concurrent-connection cap. Reserve-then-check: the
   * count is bumped BEFORE the async quota read so concurrent connects at
   * the cap can't both pass.
   *
   * `channel` in the result is the stream's label, for display; the channel
   * the hub listens on is never handed out.
   */
  async subscribe(projectId: string, handler: NotificationHandler): Promise<SubscribeResult> {
    let label: string
    try {
      label = workspaceChannelName(projectId)
    } catch {
      return { ok: false, code: 'INVALID_PROJECT', message: 'Invalid project ID' }
    }

    const reserved = (this.counts.get(projectId) ?? 0) + 1
    this.counts.set(projectId, reserved)

    let released = false
    const release = () => {
      if (released) return
      released = true
      const current = this.counts.get(projectId) ?? 0
      if (current <= 1) this.counts.delete(projectId)
      else this.counts.set(projectId, current - 1)
    }

    try {
      // reserved - 1 = connections that existed before this one. The cap is
      // the account's, so the owner's other projects' live streams count too.
      const decision = await enforceRealtimeConnection(projectId, reserved - 1, (others) =>
        others.reduce((sum, id) => sum + this.connectionCount(id), 0),
      )
      if (!decision.allowed) {
        release()
        return {
          ok: false,
          code: 'PLAN_LIMIT_EXCEEDED',
          message: decision.message ?? 'Realtime connection limit reached',
        }
      }

      // The channel is NOTIFYed by the database holding the project's data.
      const listener = this.listenerFor(await projectRealtimeDatabase(projectId))
      if (!listener) {
        release()
        return { ok: false, code: 'REALTIME_BUSY', message: REALTIME_BUSY_MESSAGE }
      }
      const { stop: stopListening, opened } = await listener.listen(projectId, handler)
      // Once per stream this process opens; the repair pass keeps it so after.
      if (opened) await bringFunctionsCurrentBriefly(projectId)

      const unsubscribe = () => {
        release()
        stopListening()
      }

      return { ok: true, channel: label, unsubscribe }
    } catch (err) {
      release()
      throw err
    }
  }

  /**
   * The listener for `target`, opened if need be. A region's own database's is
   * always given. A project database's is null when this process already keeps
   * as many as it may and none of them is idle enough to close for it.
   */
  private listenerFor(target: RealtimeDatabase): DatabaseListener | null {
    const key = realtimeDatabaseKey(target)
    const existing = this.listeners.get(key)
    if (existing && !existing.closed) return existing

    if (target.database !== null) {
      const open = [...this.listeners.values()].filter((listener) => listener.closesWhenIdle && !listener.closed)
      if (open.length >= databaseListenersMax()) {
        // One nobody is streaming from, waiting out its grace, makes room.
        const spare = open.find((listener) => listener.idle)
        if (!spare) return null
        spare.close()
      }
    }

    const listener = new DatabaseListener(target, (closed) => {
      if (this.listeners.get(closed.key) === closed) this.listeners.delete(closed.key)
    })
    this.listeners.set(key, listener)
    return listener
  }
}

// One hub per process. Survives Next.js dev HMR via globalThis stash — module
// re-evaluation must not orphan the pg connections or the subscriber registry.
const globalStore = globalThis as unknown as { __backenlyListenerHub?: ListenerHub }

export const listenerHub: ListenerHub =
  globalStore.__backenlyListenerHub ?? (globalStore.__backenlyListenerHub = new ListenerHub())
