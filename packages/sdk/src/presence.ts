/**
 * PresenceModule
 *
 * Tracks which users are currently online.
 * Uses REST (POST heartbeat) as the "send" channel
 * and SSE (subscribe) as the "receive" channel.
 *
 * Usage:
 *   // Mark yourself online
 *   await backend.presence.join('user-123', { name: 'Ajay', avatar: '/me.jpg' })
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

import type { BackenlyClient } from './client'
import type { Unsubscribe } from './realtime'

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

export class PresenceModule {
  private userId: string | null = null
  private metadata: Record<string, unknown> = {}
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private unloadHandler: (() => void) | null = null

  constructor(private readonly client: BackenlyClient) {}

  // ── Public API ───────────────────────────────────────────────────────────

  /**
   * Announce that this user is online. Starts a heartbeat loop automatically.
   * Attach metadata (name, avatar, role…) for other clients to display.
   * Call leave() when the user logs out or you want to go offline.
   */
  async join(userId: string, metadata: Record<string, unknown> = {}): Promise<void> {
    if (typeof window === 'undefined') return // SSR — no-op

    // Stop any existing session first
    if (this.userId && this.userId !== userId) {
      await this.leave()
    }

    this.userId = userId
    this.metadata = metadata

    // Send initial join immediately
    await this._send()

    // Start heartbeat
    if (!this.heartbeatTimer) {
      this.heartbeatTimer = setInterval(() => {
        this._send().catch(() => {})
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
   */
  async update(metadata: Record<string, unknown>): Promise<void> {
    if (!this.userId) return
    this.metadata = { ...this.metadata, ...metadata }
    await this._send()
  }

  /**
   * Mark this user as offline. Stops heartbeats and notifies all subscribers.
   */
  async leave(): Promise<void> {
    const userId = this.userId
    if (!userId) return

    // Stop heartbeat
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

    // Fire DELETE — keepalive: true survives page unload
    try {
      const projectId = this.client.getProjectId()
      const apiUrl = this.client.getApiUrl()
      const apiKey = this.client.getApiKey()
      const userToken = this.client.getUserToken()
      const headers: Record<string, string> = {}
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`
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

  private async _send(): Promise<void> {
    if (!this.userId) return
    const projectId = this.client.getProjectId()
    const apiUrl = this.client.getApiUrl()
    // Heartbeats ride raw fetch, not client.request() — resolve the
    // auto-fetched anon key ourselves. Best-effort: a failed handshake must
    // not blow up the heartbeat loop, so fall back to whatever is cached.
    const apiKey = await this.client.ensureApiKey().catch(() => this.client.getApiKey())
    const userToken = this.client.getUserToken()

    await fetch(`${apiUrl}/api/v1/${projectId}/presence`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        ...(userToken ? { 'X-User-Token': userToken } : {}),
      },
      body: JSON.stringify({ userId: this.userId, metadata: this.metadata }),
    })
  }
}
