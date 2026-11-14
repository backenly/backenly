/**
 * PresenceModule
 *
 * Tracks which users are currently online.
 * Uses REST (POST heartbeat) as the "send" channel
 * and SSE (subscribe) as the "receive" channel.
 *
 * Usage:
 *   // Mark yourself online, as the signed-in user (by the id sign-in returned)
 *   const { user } = await backend.auth.signIn({ email, password })
 *   await backend.presence.join(user.id, { name: 'Ajay', avatar: '/me.jpg' })
 *
 *   // Get current online users
 *   const users = await backend.presence.list()
 *   // [{ userId, metadata, joinedAt, lastSeen }]
 *
 *   // Subscribe to join/leave/update events
 *   const unsub = backend.presence.subscribe((event) => {
 *     if (event.event === 'join')   addOnlineUser(event.userId, event.metadata)
 *     if (event.event === 'leave')  removeOnlineUser(event.userId)
 *     if (event.event === 'update') updateUserMeta(event.userId, event.metadata)
 *   })
 *   // cleanup: return () => unsub()
 *
 *   // Mark yourself offline
 *   await backend.presence.leave()
 *
 * How it works (invisible to the user):
 *   join()  → POST /api/v1/:projectId/presence  (starts 25-s heartbeat loop)
 *   leave() → DELETE /api/v1/:projectId/presence (stops heartbeat, page-unload safe)
 *   list()  → GET /api/v1/:projectId/presence
 *   subscribe() → SSE stream, filtered for type:"presence" events
 *
 * Server TTL is 60 s — heartbeat every 25 s keeps the user "online".
 */

import type { BackenlyClient } from './client.js'
import { BackenlyError, errorFromResponse, normalizeError } from './errors.js'
import type { Unsubscribe } from './realtime.js'

export interface PresenceUser {
  userId: string
  metadata: Record<string, unknown>
  joinedAt: string
  lastSeen: string
}

export interface PresenceEvent {
  type: 'presence'
  event: 'join' | 'leave' | 'update'
  userId: string
  metadata?: Record<string, unknown>
  timestamp: number
}

export type PresenceCallback = (event: PresenceEvent) => void

const HEARTBEAT_MS = 25_000 // 25 s — well within the 60 s server TTL

/**
 * The server does not take who this client says it is: no sign-in, another
 * user's id, a blocked user, or a key it refuses. Sending again cannot change
 * that, so a session refused this way ends.
 */
function refusesIdentity(err: unknown): err is BackenlyError {
  return err instanceof BackenlyError && (err.status === 401 || err.status === 403)
}

export class PresenceModule {
  private userId: string | null = null
  private metadata: Record<string, unknown> = {}
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private unloadHandler: (() => void) | null = null
  // join(), update() and leave() calls so far, and the join or update sends
  // still waiting for an answer. An answer to a call that is no longer the
  // latest decides nothing, and a heartbeat refused while a call is on its
  // way leaves that call to decide.
  private calls = 0
  private sending = 0

  constructor(private readonly client: BackenlyClient) {}

  // ── Public API ───────────────────────────────────────────────────────────

  /**
   * Announce that this user is online. Starts a heartbeat loop automatically.
   * Attach metadata (name, avatar, role…) for other clients to display.
   * Call leave() when the user logs out or you want to go offline.
   *
   * Identity is bound server-side: with the public key, `userId` must be the
   * signed-in user's own id (the X-User-Token the client already sends after
   * auth.signIn / signUp), and without a signed-in user the server refuses
   * with PRESENCE_TOKEN_REQUIRED. Only service-role keys may announce other
   * users. Metadata is client-chosen display data — subscribers should treat
   * it as what the user chose to show, not as verified facts.
   *
   * Resolves once the server has the user online. When it does not, rejects
   * with the server's BackenlyError: `code` PRESENCE_TOKEN_REQUIRED (status
   * 401) before sign-in, PRESENCE_IDENTITY_MISMATCH (403) for any id but the
   * signed-in user's, such as a username or an email. Nothing is left running
   * after a refused join, so no heartbeat goes on posting refused requests.
   * A join for the user already online changes only the metadata: if that
   * fails for any reason but who the user is, they stay online as before.
   */
  async join(userId: string, metadata: Record<string, unknown> = {}): Promise<void> {
    if (typeof window === 'undefined') return // SSR — no-op

    // Stop any existing session first
    if (this.userId && this.userId !== userId) {
      await this.leave()
    }

    const call = ++this.calls
    // What a session already running for this user announces; null when none is.
    const running = this.userId === userId && this.heartbeatTimer !== null ? this.metadata : null
    this.userId = userId
    this.metadata = metadata

    // Send initial join immediately
    await this._sendForCall(call, running)
    // Left, or joined as someone else, while this join was on its way.
    if (this.userId !== userId) return

    // Start heartbeat
    if (!this.heartbeatTimer) {
      this.heartbeatTimer = setInterval(() => {
        void this._beat()
      }, HEARTBEAT_MS)
    }

    // Auto-leave on page unload (keepalive: true survives navigation)
    if (!this.unloadHandler) {
      this.unloadHandler = () => { this.leave() }
      window.addEventListener('beforeunload', this.unloadHandler, { once: true })
    }
  }

  /**
   * Update presence metadata without changing userId.
   * Useful for updating status, current page, etc.
   *
   * Rejects with the server's BackenlyError when it does not take the change.
   * A 401 or 403 ends the session, as it does for join(); after any other
   * failure the heartbeat goes on announcing the metadata the server last took.
   */
  async update(metadata: Record<string, unknown>): Promise<void> {
    if (!this.userId) return
    const call = ++this.calls
    const before = this.metadata
    this.metadata = { ...before, ...metadata }
    await this._sendForCall(call, before)
  }

  /**
   * Mark this user as offline. Stops heartbeats and notifies all subscribers.
   */
  async leave(): Promise<void> {
    const userId = this.userId
    if (!userId) return
    this.calls += 1
    this._end()

    // Fire DELETE — keepalive: true survives page unload
    try {
      const projectId = this.client.getProjectId()
      const apiUrl = this.client.getApiUrl()
      const apiKey = this.client.getApiKey()
      const userToken = this.client.getUserToken()
      const headers: Record<string, string> = {}
      if (apiKey) headers['x-api-key'] = apiKey
      if (userToken) headers['X-User-Token'] = userToken

      await fetch(
        `${apiUrl}/api/v1/${projectId}/presence?userId=${encodeURIComponent(userId)}`,
        {
          method: 'DELETE',
          keepalive: true,
          headers,
        }
      )
    } catch {
      // Best-effort — if the page is unloading, the browser handles keepalive
    }
  }

  /**
   * Get the current list of online users (lastSeen within TTL).
   */
  async list(): Promise<PresenceUser[]> {
    const projectId = this.client.getProjectId()
    const res = await this.client.request(`/api/v1/${projectId}/presence`)
    return res.users ?? []
  }

  /**
   * Subscribe to live presence events (join / leave / update).
   * Returns an unsubscribe function.
   *
   * @example
   * const unsub = backend.presence.subscribe((event) => {
   *   if (event.event === 'join') showAvatar(event.userId)
   * })
   * // React cleanup:
   * return () => unsub()
   */
  subscribe(callback: PresenceCallback): Unsubscribe {
    return this.client.realtime.onPresence(callback)
  }

  // ── Private ──────────────────────────────────────────────────────────────

  /**
   * Send a join or update, and when the server does not take it, put things
   * back, unless a later call has been made since (that one decides). A
   * refusal of who this client is ends the session. Any other failure leaves
   * a session that was running (`before`, its metadata) announcing what the
   * server last took, and leaves nothing running where none was (null).
   */
  private async _sendForCall(call: number, before: Record<string, unknown> | null): Promise<void> {
    const sent = this.metadata
    this.sending += 1
    try {
      await this._send()
    } catch (err) {
      if (call === this.calls) {
        if (refusesIdentity(err) || before === null) this._end()
        else if (this.metadata === sent) this.metadata = before
      }
      throw err
    } finally {
      this.sending -= 1
    }
  }

  /**
   * One heartbeat. Refused for who this client is, with no call made or on
   * its way since it was sent, every later beat would be refused too: stop,
   * and say why once. Anything else, such as a 5xx or a dropped connection,
   * is tried again on the next beat.
   */
  private async _beat(): Promise<void> {
    const call = this.calls
    try {
      await this._send()
    } catch (err) {
      if (!refusesIdentity(err) || call !== this.calls || this.sending > 0 || !this.userId) return
      console.warn(
        '[Backenly Presence] Stopped announcing %s, refused with %s: %s',
        this.userId,
        err.code ?? err.status,
        err.message,
      )
      this._end()
    }
  }

  /** Stop announcing from this client: no heartbeat, no unload hook, no user. Nothing is sent. */
  private _end(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
    if (this.unloadHandler) {
      window.removeEventListener('beforeunload', this.unloadHandler)
      this.unloadHandler = null
    }
    this.userId = null
    this.metadata = {}
  }

  private async _send(): Promise<void> {
    const userId = this.userId
    if (!userId) return
    const metadata = this.metadata
    const projectId = this.client.getProjectId()
    const apiUrl = this.client.getApiUrl()
    // Heartbeats ride raw fetch, not client.request() — resolve the
    // auto-fetched anon key ourselves. Best-effort: a failed handshake must
    // not blow up the heartbeat loop, so fall back to whatever is cached.
    const apiKey = await this.client.ensureApiKey().catch(() => this.client.getApiKey())
    const userToken = this.client.getUserToken()

    let response: Response
    try {
      response = await fetch(`${apiUrl}/api/v1/${projectId}/presence`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { 'x-api-key': apiKey } : {}),
          ...(userToken ? { 'X-User-Token': userToken } : {}),
        },
        body: JSON.stringify({ userId, metadata }),
      })
    } catch (err) {
      throw normalizeError(err)
    }
    // The answer decides, as it does for client.request(): a refusal reaches
    // the caller with the server's code, message and status.
    if (!response.ok) throw await errorFromResponse(response, 'Presence')
  }
}
