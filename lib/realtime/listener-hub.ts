/**
 * Realtime Listener Hub — one LISTEN connection per region, per process.
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
 * This hub holds exactly ONE direct pg connection per region per process,
 * LISTENs on every channel that has at least one subscriber, and dispatches
 * NOTIFY payloads to in-process handlers. SSE responses are plain HTTP — they
 * no longer consume any database connection.
 *
 * REGIONS: a project's channel is NOTIFYed by its own database, in the region
 * the project lives in (lib/data-plane/regional.ts), so it is LISTENed there and
 * nowhere else. A LISTEN on another region's database would succeed and then
 * never hear anything. Until a project lives outside the home region, the only
 * connection ever opened is the home one, exactly as before.
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
import { projectRegion, regionDatabaseUrl, requireRegionDatabaseUrl } from '@/lib/data-plane/regional'
import type { CloudRegionId } from '@/lib/regions'
import { workspaceChannelName } from '@/lib/security/workspace-schema'
import { enforceRealtimeConnection } from '@/lib/quota/kernel'

export type NotificationHandler = (payload: Record<string, unknown>) => void

export type SubscribeResult =
  | { ok: true; channel: string; unsubscribe: () => void }
  | { ok: false; code: 'PLAN_LIMIT_EXCEEDED' | 'INVALID_PROJECT'; message: string }

const RECONNECT_BASE_MS = 500
const RECONNECT_MAX_MS = 15_000
// Light liveness ping — detects a silently dead socket long before a
// subscriber notices missing events. Local DB, so this is nearly free.
const PING_INTERVAL_MS = 4 * 60_000

/** One region's LISTEN connection and the channels it carries. */
class RegionListener {
  private client: Client | null = null
  private connectPromise: Promise<void> | null = null
  readonly handlers = new Map<string, Set<NotificationHandler>>() // channel → handlers
  private reconnectAttempt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private destroyed = false

  constructor(readonly region: CloudRegionId) {}

  /**
   * LISTEN needs a direct connection — PgBouncer transaction mode drops it.
   * The region's direct connection, else its application one, as
   * DIRECT_URL || DATABASE_URL always was at home. Never another region's: an
   * unconfigured region throws REGION_NOT_CONFIGURED.
   */
  private connectionString(): string {
    return regionDatabaseUrl(this.region, 'direct') ?? requireRegionDatabaseUrl(this.region, 'app')
  }

  /** Start delivering a channel's notifications to `handler`; returns the way to stop. */
  async listen(channel: string, handler: NotificationHandler): Promise<() => void> {
    // Checked on every subscribe, as workspaceRawClient checks on every call:
    // a region whose connection was removed is refused even while a listener
    // opened earlier is still up.
    this.connectionString()
    await this.ensureConnected()

    let set = this.handlers.get(channel)
    if (!set) {
      set = new Set()
      this.handlers.set(channel, set)
      await this.client!.query(`LISTEN "${channel}"`)
    }
    set.add(handler)

    return () => {
      const current = this.handlers.get(channel)
      if (!current) return
      current.delete(handler)
      if (current.size === 0) {
        this.handlers.delete(channel)
        // Best-effort UNLISTEN — session teardown covers failures.
        this.client?.query(`UNLISTEN "${channel}"`).catch(() => {})
      }
    }
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
      const set = this.handlers.get(msg.channel)
      if (!set || set.size === 0) return
      let payload: Record<string, unknown>
      try {
        payload = JSON.parse(msg.payload || '{}')
      } catch {
        console.warn('[ListenerHub] Malformed NOTIFY on', msg.channel, '—', msg.payload?.slice(0, 200))
        return
      }
      for (const handler of set) {
        try { handler(payload) } catch { /* one bad subscriber never blocks the rest */ }
      }
    })

    client.on('error', () => {
      this.scheduleReconnect()
    })

    await client.connect()
    this.client = client
    this.reconnectAttempt = 0

    if (this.pingTimer) clearInterval(this.pingTimer)
    this.pingTimer = setInterval(() => {
      this.client?.query('SELECT 1').catch(() => this.scheduleReconnect())
    }, PING_INTERVAL_MS)

    // Re-LISTEN every channel that has live subscribers (no-op on first connect).
    for (const channel of this.handlers.keys()) {
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
      if (this.handlers.size === 0) return // nobody listening — reconnect lazily on next subscribe
      try {
        await this.ensureConnected()
        console.log(`[ListenerHub] Reconnected to Postgres in ${this.region}, channels re-LISTENed:`, this.handlers.size)
      } catch (err: any) {
        console.warn(`[ListenerHub] Reconnect in ${this.region} failed:`, err?.message)
        this.scheduleReconnect()
      }
    }, delay)
  }
}

class ListenerHub {
  private regions = new Map<CloudRegionId, RegionListener>()
  private counts = new Map<string, number>() // projectId → live subscriber count

  /** Live subscriber count for a project (exposed for status/verification). */
  connectionCount(projectId: string): number {
    return this.counts.get(projectId) ?? 0
  }

  /** Total channels currently LISTENed, across regions (for verification). */
  channelCount(): number {
    let total = 0
    for (const listener of this.regions.values()) total += listener.handlers.size
    return total
  }

  /**
   * Register a subscriber for a project's realtime channel.
   * Enforces the plan's concurrent-connection cap. Reserve-then-check: the
   * count is bumped BEFORE the async quota read so concurrent connects at
   * the cap can't both pass.
   */
  async subscribe(projectId: string, handler: NotificationHandler): Promise<SubscribeResult> {
    let channel: string
    try {
      channel = workspaceChannelName(projectId)
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

      // The channel is NOTIFYed by the project's own database, in its region.
      const stopListening = await this.listenerFor(await projectRegion(projectId)).listen(channel, handler)

      const unsubscribe = () => {
        release()
        stopListening()
      }

      return { ok: true, channel, unsubscribe }
    } catch (err) {
      release()
      throw err
    }
  }

  private listenerFor(region: CloudRegionId): RegionListener {
    let listener = this.regions.get(region)
    if (!listener) {
      listener = new RegionListener(region)
      this.regions.set(region, listener)
    }
    return listener
  }
}

// One hub per process. Survives Next.js dev HMR via globalThis stash — module
// re-evaluation must not orphan the pg connections or the subscriber registry.
const globalStore = globalThis as unknown as { __backenlyListenerHub?: ListenerHub }

export const listenerHub: ListenerHub =
  globalStore.__backenlyListenerHub ?? (globalStore.__backenlyListenerHub = new ListenerHub())
