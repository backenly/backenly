/**
 * RealtimeModule
 *
 * One shared EventSource per BackenlyClient, routing three distinct event classes:
 *
 * 1. DB change events  — fired by Postgres NOTIFY triggers on user tables
 *      { type: "insert"|"update"|"delete", table, data, old?, timestamp }
 *    → backend.messages.subscribe(callback)
 *    → backend.realtime.subscribe("messages", callback)
 *    → backend.realtime.subscribe("*", callback)
 *
 * 2. Presence events  — fired by the _backenly_presence trigger
 *      { type: "presence", event: "join"|"leave"|"update", userId, metadata?, timestamp }
 *    → backend.presence.subscribe(callback)     [via PresenceModule]
 *    → backend.realtime.onPresence(callback)
 *
 * 3. Broadcast events — fired by POST /api/v1/:projectId/broadcast (no DB write)
 *      { type: "broadcast", channel: "typing", payload: {...}, timestamp }
 *    → backend.onBroadcast("typing", callback)  [via BackenlyClient]
 *    → backend.realtime.onBroadcast("typing", callback)
 *
 * Connection management:
 *   - One EventSource is opened lazily on the first subscription.
 *   - The SSE URL uses ?table=X only when there is exactly one DB table
 *     subscription and zero presence/broadcast subscriptions (bandwidth optimisation).
 *   - If a new subscription type requires an unfiltered stream, the connection is
 *     recycled transparently.
 *   - EventSource auto-reconnects on drop (3 s back-off).
 *   - When all subscribers are removed, the EventSource is closed.
 */

import type { BackenlyClient } from './client.js'
import type { PresenceCallback, PresenceEvent } from './presence.js'

// ── Event types ──────────────────────────────────────────────────────────────

export interface DBChangeEvent<T = Record<string, unknown>> {
  type: 'insert' | 'update' | 'delete'
  table: string
  data?: T
  old?: T
  truncated?: boolean
  timestamp?: number
}

export interface ConnectedEvent {
  type: 'connected'
  projectId: string
  channel: string
  timestamp?: number
}

export interface StreamErrorEvent {
  type: 'error'
  message: string
  /** Machine code when the server refuses the stream (e.g. PLAN_LIMIT_EXCEEDED). */
  code?: string
  timestamp?: number
}

export interface BroadcastEvent {
  type: 'broadcast'
  channel: string
  payload: Record<string, unknown>
  timestamp: number
}

/** Union of all event shapes the SSE stream can carry */
export type RealtimeEvent<T = Record<string, unknown>> =
  | DBChangeEvent<T>
  | ConnectedEvent
  | StreamErrorEvent
  | PresenceEvent
  | BroadcastEvent

export type RealtimeCallback<T = Record<string, unknown>> = (
  event: DBChangeEvent<T> | ConnectedEvent | StreamErrorEvent
) => void

export type BroadcastCallback = (
  payload: Record<string, unknown>,
  event: BroadcastEvent
) => void

export type Unsubscribe = () => void

// ── Internal subscription types ───────────────────────────────────────────────

interface DBSubscription {
  table: string        // table name or '*' for wildcard
  callback: RealtimeCallback<any>
}

interface BroadcastSubscription {
  channel: string
  callback: BroadcastCallback
}

// ── Module ────────────────────────────────────────────────────────────────────

export class RealtimeModule {
  private es: EventSource | null = null
  private currentFilter: string | undefined = undefined

  // Three independent subscriber lists — each gets its own slice of events
  private dbSubs: DBSubscription[] = []
  private presenceSubs: PresenceCallback[] = []
  private broadcastSubs: BroadcastSubscription[] = []

  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectAttempt = 0
  // Fatal = the server refused the stream for a reason retrying can't fix
  // (plan connection cap, revoked API key). Reconnecting would burn a
  // connection slot every few seconds forever.
  private fatal = false

  constructor(private readonly client: BackenlyClient) {}

  /** Exponential backoff with jitter, 1s → 30s cap. Resets on 'connected'. */
  private _backoffMs(): number {
    const base = Math.min(30_000, 1_000 * Math.pow(2, this.reconnectAttempt))
    return Math.floor(base * (0.75 + Math.random() * 0.5))
  }

  private _isFatalError(event: StreamErrorEvent): boolean {
    if (event.code === 'PLAN_LIMIT_EXCEEDED' || event.code === 'INVALID_PROJECT') return true
    const msg = event.message || ''
    return /reached its limit|api key|unauthor/i.test(msg)
  }

  // ── DB change subscriptions ────────────────────────────────────────────────

  /**
   * Subscribe to INSERT / UPDATE / DELETE events on a table.
   * Pass '*' to receive events from all tables.
   * Returns an unsubscribe function.
   *
   * @example
   * const unsub = backend.realtime.subscribe('messages', (event) => {
   *   if (event.type === 'insert') addMessage(event.data)
   * })
   * return () => unsub()
   */
  subscribe<T = Record<string, unknown>>(
    table: string,
    callback: RealtimeCallback<T>
  ): Unsubscribe {
    if (typeof window === 'undefined') return () => {}

    const entry: DBSubscription = { table, callback }
    this.dbSubs.push(entry)
    this._connect()

    return () => {
      this.dbSubs = this.dbSubs.filter((s) => s !== entry)
      this._maybeDisconnect()
    }
  }

  // ── Presence subscriptions ─────────────────────────────────────────────────

  /**
   * Subscribe to presence events (join / leave / update).
   * Prefer backend.presence.subscribe() — this is the internal hook.
   */
  onPresence(callback: PresenceCallback): Unsubscribe {
    if (typeof window === 'undefined') return () => {}

    this.presenceSubs.push(callback)
    this._connect() // may upgrade filtered → unfiltered

    return () => {
      this.presenceSubs = this.presenceSubs.filter((c) => c !== callback)
      this._maybeDisconnect()
    }
  }

  // ── Broadcast subscriptions ────────────────────────────────────────────────

  /**
   * Subscribe to ephemeral broadcast events on a named channel.
   * Prefer backend.onBroadcast() — this is the internal hook.
   *
   * @example
   * const unsub = backend.realtime.onBroadcast('typing', (payload) => {
   *   showTyping(payload.userId as string)
   * })
   */
  onBroadcast(channel: string, callback: BroadcastCallback): Unsubscribe {
    if (typeof window === 'undefined') return () => {}

    const entry: BroadcastSubscription = { channel, callback }
    this.broadcastSubs.push(entry)
    this._connect()

    return () => {
      this.broadcastSubs = this.broadcastSubs.filter((s) => s !== entry)
      this._maybeDisconnect()
    }
  }

  // ── Private: connection management ────────────────────────────────────────

  /** Optimal ?table= filter for the current subscriber set */
  private _computeFilter(): string | undefined {
    // Presence and broadcast events ride the unfiltered stream
    if (this.presenceSubs.length > 0 || this.broadcastSubs.length > 0) {
      return undefined
    }
    const tables = Array.from(new Set(this.dbSubs.map((s) => s.table)))
    // Use filter only for a single, non-wildcard table
    if (tables.length === 1 && tables[0] !== '*') {
      return tables[0]
    }
    return undefined
  }

  /**
   * ── Why this asks the server for a ticket first ───────────────────────────
   *
   * `EventSource` cannot send headers, so the credential must go in the URL. It
   * used to be the project API key — and a URL is the worst place for a
   * long-lived credential: nginx access logs, every proxy in the path, browser
   * history, and `Referer` on outbound links all keep a copy. Clients that
   * hand-rolled the connection were putting the end-user's session JWT there too.
   *
   * So the SDK exchanges its headers for a ticket that lasts 30 seconds and one
   * connection. What leaks into a log is already spent. The `?apiKey=` form is
   * kept as a fallback for a server that predates the ticket endpoint — never as
   * the first choice.
   */
  private async _mintTicket(): Promise<string | null> {
    const projectId = this.client.getProjectId()
    const base = this.client.getApiUrl()
    const apiKey = this.client.getApiKey()
    if (!apiKey) return null
    try {
      const res = await fetch(new URL(`/api/v1/${projectId}/realtime/ticket`, base).toString(), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          ...(this.client.getUserToken() ? { 'X-User-Token': this.client.getUserToken()! } : {}),
        },
      })
      if (!res.ok) return null
      const body = (await res.json()) as { ticket?: string }
      return typeof body?.ticket === 'string' && body.ticket ? body.ticket : null
    } catch {
      // Network failure, or a server without the endpoint. Fall back rather than
      // leave the caller with no realtime at all.
      return null
    }
  }

  private _sseUrl(filter: string | undefined, ticket: string | null): string {
    const projectId = this.client.getProjectId()
    const base = this.client.getApiUrl()
    const url = new URL(`/api/v1/${projectId}/realtime`, base)
    if (filter) url.searchParams.set('table', filter)
    if (ticket) {
      url.searchParams.set('ticket', ticket)
      return url.toString()
    }
    // Fallback for a server without /realtime/ticket. Deprecated: this puts a
    // long-lived key into the URL, which is the problem the ticket solves.
    const apiKey = this.client.getApiKey()
    if (apiKey) url.searchParams.set('apiKey', apiKey)
    return url.toString()
  }

  private _connect(): void {
    if (this.fatal) return

    // EventSource can't send headers and can't swap query params once open,
    // so the anon key must be resolved before the URL is built. Without this
    // gate, a client created without an apiKey opens an SSE that 401s in an
    // endless reconnect loop. Reuses the same backoff as onerror on failure.
    if (!this.client.getApiKey()) {
      this.client.ensureApiKey().then(
        () => {
          if (this._hasSubscribers) this._connect()
        },
        () => {
          if (this.fatal || !this._hasSubscribers || this.reconnectTimer) return
          const delay = this._backoffMs()
          this.reconnectAttempt += 1
          this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null
            this._connect()
          }, delay)
        },
      )
      return
    }

    const neededFilter = this._computeFilter()

    // Already connected with the right filter — nothing to do
    if (
      this.es &&
      this.es.readyState !== EventSource.CLOSED &&
      this.currentFilter === neededFilter
    ) {
      return
    }

    // Close stale or mis-filtered connection
    if (this.es && this.es.readyState !== EventSource.CLOSED) {
      this.es.close()
    }

    this.currentFilter = neededFilter

    // A ticket is single-use, so it must be minted per CONNECTION — including
    // every reconnect, which is why this sits inside _connect and not in the
    // constructor. `_openStream` is separated out so both the ticketed and the
    // fallback path share one set of handlers.
    void this._mintTicket().then(
      (ticket) => {
        // A later _connect may have superseded this attempt while the mint was
        // in flight; don't clobber a live stream with a stale one.
        if (this.fatal || !this._hasSubscribers) return
        if (this.currentFilter !== neededFilter) return
        this._openStream(neededFilter, ticket)
      },
      () => {
        if (this.fatal || !this._hasSubscribers) return
        if (this.currentFilter !== neededFilter) return
        this._openStream(neededFilter, null)
      },
    )
  }

  private _openStream(neededFilter: string | undefined, ticket: string | null): void {
    if (this.es && this.es.readyState !== EventSource.CLOSED) this.es.close()
    this.es = new EventSource(this._sseUrl(neededFilter, ticket))

    this.es.onmessage = (msg) => {
      try {
        this._dispatch(JSON.parse(msg.data))
      } catch {
        // Ignore parse errors
      }
    }

    this.es.onerror = () => {
      this.es?.close()
      this.es = null
      if (this.fatal) return
      if (this._hasSubscribers && !this.reconnectTimer) {
        const delay = this._backoffMs()
        this.reconnectAttempt += 1
        this.reconnectTimer = setTimeout(() => {
          this.reconnectTimer = null
          this._connect()
        }, delay)
      }
    }
  }

  private _disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.es?.close()
    this.es = null
    this.currentFilter = undefined
  }

  private _maybeDisconnect(): void {
    if (!this._hasSubscribers) {
      this._disconnect()
      return
    }
    // Re-evaluate filter — e.g., last broadcast sub removed → can now use table filter
    const neededFilter = this._computeFilter()
    if (neededFilter !== this.currentFilter) {
      this._connect() // recycle transparently
    }
  }

  private get _hasSubscribers(): boolean {
    return (
      this.dbSubs.length > 0 ||
      this.presenceSubs.length > 0 ||
      this.broadcastSubs.length > 0
    )
  }

  // ── Private: event dispatch ───────────────────────────────────────────────

  private _dispatch(event: RealtimeEvent): void {
    const { type } = event

    if (type === 'connected') {
      this.reconnectAttempt = 0
    }

    if (type === 'error' && this._isFatalError(event as StreamErrorEvent)) {
      // The server refused the stream for a non-transient reason. Stop
      // reconnecting — retrying would hammer the server (and, for a plan
      // connection cap, keep stealing a slot every attempt). Subscribers
      // still receive the error frame below so apps can surface it.
      this.fatal = true
      if (typeof console !== 'undefined') {
        console.warn(`[Backenly Realtime] Stream closed permanently: ${(event as StreamErrorEvent).message}`)
      }
      this._disconnect()
    }

    // ── Presence ─────────────────────────────────────────────────────────────
    if (type === 'presence') {
      for (const cb of this.presenceSubs) {
        try { cb(event as PresenceEvent) } catch {}
      }
      return
    }

    // ── Broadcast ─────────────────────────────────────────────────────────────
    if (type === 'broadcast') {
      const be = event as BroadcastEvent
      for (const sub of this.broadcastSubs) {
        if (sub.channel === be.channel) {
          try { sub.callback(be.payload, be) } catch {}
        }
      }
      return
    }

    // ── DB change + system (connected / error) ────────────────────────────────
    for (const sub of this.dbSubs) {
      const isSystem = type === 'connected' || type === 'error'
      const isTableMatch =
        sub.table === '*' ||
        ((type === 'insert' || type === 'update' || type === 'delete') &&
          (event as DBChangeEvent).table === sub.table)

      if (isSystem || isTableMatch) {
        try { sub.callback(event as any) } catch {}
      }
    }
  }
}
