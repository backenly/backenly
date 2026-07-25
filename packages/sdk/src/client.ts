import { AuthModule } from './auth.js'
import { QueryBuilder, TableClient } from './database.js'
import { StorageModule } from './storage.js'
import { RealtimeModule } from './realtime.js'
import type { BroadcastCallback, Unsubscribe } from './realtime.js'
import { PresenceModule } from './presence.js'
import type { BackenlyConfig } from './types.js'
import { BackenlyError, normalizeError } from './errors.js'

/**
 * BackenlyClient
 *
 * Simple usage (recommended default):
 *   backend.posts.list()
 *   backend.posts.create({ title: 'Hello' })
 *   backend.posts.get('id')
 *   backend.posts.update('id', { title: 'Updated' })
 *   backend.posts.delete('id')
 *   backend.auth.signUp({ email, password })
 *   backend.auth.signIn({ email, password })
 *
 * Realtime:
 *   backend.messages.subscribe(callback)                // DB change events
 *   backend.presence.join(userId, metadata?)            // go online
 *   backend.presence.subscribe(callback)                // who's online
 *   backend.broadcast('typing', { userId })             // ephemeral event
 *   backend.onBroadcast('typing', (payload) => …)       // receive it
 *
 * Advanced:
 *   backend.from('posts').select().eq('status', 'active').limit(10)
 */
export class BackenlyClient {
  private projectId: string
  private apiUrl: string
  private apiKey: string | null = null
  private userToken: string | null = null
  private bootstrapPromise: Promise<string> | null = null

  // Cached module instances (lazy)
  private tableClientCache: Record<string, TableClient<any>> = {}
  private _realtime: RealtimeModule | null = null
  private _presence: PresenceModule | null = null

  constructor(config: BackenlyConfig) {
    if (!config.projectId) {
      throw new Error('projectId is required')
    }

    this.projectId = config.projectId
    this.apiUrl =
      config.apiUrl ||
      (typeof process !== 'undefined' && process.env?.NEXT_PUBLIC_BACKENLY_URL) ||
      'https://backenly.com'

    // Keep the public API key and end-user JWT separate. The public key
    // authenticates the app; the user token supplies RLS context.
    if (config.apiKey) {
      this.apiKey = config.apiKey
    }

    if (typeof window !== 'undefined') {
      const savedToken = localStorage.getItem('backenly_token')
      if (savedToken) {
        this.userToken = savedToken
      }
    }

    // No apiKey → auto-bootstrap mode: fetch the project's public anon key
    // from /api/v1/{projectId}/bootstrap. Kick the handshake immediately so
    // the key is usually resolved before the first data call, and so
    // consumers that read it synchronously (SSE URLs, unload beacons) find
    // it in place. request() also awaits it, so a slow handshake can never
    // produce a request with a missing Authorization header.
    if (!this.apiKey && typeof window !== 'undefined') {
      this.ensureApiKey().catch(() => {
        // Swallow here — the failure will be rethrown (with a useful
        // message) by whichever request() call actually needs the key.
      })
    }

    // Return a Proxy so that `backend.posts` returns a TableClient for any
    // property name not already defined on the class.
    return new Proxy(this, {
      get(target, prop: string | symbol) {
        if (prop in target) {
          const val = (target as any)[prop]
          return typeof val === 'function' ? val.bind(target) : val
        }
        if (typeof prop === 'string') {
          if (!target.tableClientCache[prop]) {
            target.tableClientCache[prop] = new TableClient(target, prop)
          }
          return target.tableClientCache[prop]
        }
        return undefined
      },
    })
  }

  // ── Standard modules ──────────────────────────────────────────────────────

  get auth(): AuthModule {
    return new AuthModule(this)
  }

  get storage(): StorageModule {
    return new StorageModule(this)
  }

  // ── Realtime modules (singletons) ─────────────────────────────────────────

  /** Low-level realtime access. Prefer backend.messages.subscribe() for DB events. */
  get realtime(): RealtimeModule {
    if (!this._realtime) {
      this._realtime = new RealtimeModule(this)
    }
    return this._realtime
  }

  /**
   * Presence — who is online right now.
   *
   * @example
   * await backend.presence.join('user-123', { name: 'Ajay' })
   * const unsub = backend.presence.subscribe((event) => {
   *   if (event.event === 'join')  addAvatar(event.userId)
   *   if (event.event === 'leave') removeAvatar(event.userId)
   * })
   * const users = await backend.presence.list()
   * await backend.presence.leave()
   */
  get presence(): PresenceModule {
    if (!this._presence) {
      this._presence = new PresenceModule(this)
    }
    return this._presence
  }

  // ── Broadcast ─────────────────────────────────────────────────────────────

  /**
   * Fire an ephemeral broadcast event to all connected clients.
   * Nothing is written to the database — purely in-memory fan-out via pg_notify.
   *
   * @example
   * // Typing indicator
   * backend.broadcast('typing', { userId: 'u1', room: 'general' })
   *
   * // Custom cursor position
   * backend.broadcast('cursor', { userId: 'u1', x: 120, y: 340 })
   */
  async broadcast(
    channel: string,
    payload: Record<string, unknown> = {}
  ): Promise<void> {
    await this.request(`/api/v1/${this.projectId}/broadcast`, {
      method: 'POST',
      body: JSON.stringify({ channel, payload }),
    })
  }

  /**
   * Subscribe to broadcast events on a named channel.
   * Returns an unsubscribe function.
   *
   * @example
   * const unsub = backend.onBroadcast('typing', (payload) => {
   *   showTypingIndicator(payload.userId as string)
   * })
   * // React cleanup:
   * return () => unsub()
   */
  onBroadcast(channel: string, callback: BroadcastCallback): Unsubscribe {
    return this.realtime.onBroadcast(channel, callback)
  }

  // ── Advanced query builder ────────────────────────────────────────────────

  from<T = any>(table: string): QueryBuilder<T> {
    return new QueryBuilder<T>(this, table)
  }

  // ── Token management ──────────────────────────────────────────────────────

  setAuthToken(token: string | null): void {
    this.setUserToken(token)
  }

  setUserToken(token: string | null): void {
    this.userToken = token
    if (typeof window !== 'undefined') {
      if (token) {
        localStorage.setItem('backenly_token', token)
      } else {
        localStorage.removeItem('backenly_token')
      }
    }
  }

  getAuthToken(): string | null {
    return this.getUserToken()
  }

  getUserToken(): string | null {
    return this.userToken
  }

  getApiKey(): string | null {
    return this.apiKey
  }

  /**
   * Resolve the API key, auto-fetching the project's public anon key via the
   * bootstrap handshake when createClient() was called without one.
   *
   * The handshake runs once per client — concurrent callers share the same
   * in-flight promise — and a failed attempt resets it so the next call
   * retries instead of poisoning the client forever.
   */
  async ensureApiKey(): Promise<string> {
    if (this.apiKey) return this.apiKey
    if (!this.bootstrapPromise) {
      this.bootstrapPromise = this.fetchAnonKey()
    }
    try {
      const key = await this.bootstrapPromise
      this.apiKey = key
      return key
    } catch (error) {
      this.bootstrapPromise = null
      throw error
    }
  }

  private async fetchAnonKey(): Promise<string> {
    let response: Response
    try {
      response = await fetch(`${this.apiUrl}/api/v1/${this.projectId}/bootstrap`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
      })
    } catch {
      throw new BackenlyError(
        `Could not reach ${this.apiUrl} to auto-fetch the project's anon key. ` +
          `Check your network, or pass apiKey to createClient() explicitly.`,
        'BOOTSTRAP_UNREACHABLE',
      )
    }

    const body = await response.json().catch(() => null) as any

    if (!response.ok) {
      throw new BackenlyError(
        body?.error?.message ?? `Bootstrap handshake failed with HTTP ${response.status}`,
        body?.error?.code ?? 'BOOTSTRAP_FAILED',
        response.status,
      )
    }

    const anonKey = body?.data?.anonKey ?? body?.anonKey
    if (typeof anonKey !== 'string' || anonKey.length === 0) {
      throw new BackenlyError(
        'Bootstrap handshake returned no anon key. Generate one from the ' +
          'Connect Frontend page, or pass apiKey to createClient() explicitly.',
        'BOOTSTRAP_FAILED',
      )
    }

    return anonKey
  }

  getProjectId(): string {
    return this.projectId
  }

  getApiUrl(): string {
    return this.apiUrl
  }

  // ── Internal HTTP ─────────────────────────────────────────────────────────

  /**
   * The same authenticated fetch as `request`, returning the raw `Response`.
   *
   * `request` parses JSON and throws on a non-2xx, which discards two things a
   * PostgREST caller needs: the `Content-Range` header (the exact row count) and
   * the structured error body (`{ message, code, details, hint }` — the shape
   * supabase-js callers branch on). The compat shim needs both, so it needs the
   * response object, not a parsed body.
   */
  async rawRequest(
    endpoint: string,
    options?: RequestInit & { skipAuth?: boolean },
  ): Promise<Response> {
    if (!this.apiKey && !options?.skipAuth) {
      await this.ensureApiKey()
    }

    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (this.apiKey && !options?.skipAuth) headers['x-api-key'] = this.apiKey
    if (this.userToken && !options?.skipAuth) headers['X-User-Token'] = this.userToken
    if (options?.headers) {
      Object.entries(options.headers as Record<string, string>).forEach(
        ([key, value]) => { headers[key] = value },
      )
    }

    const { skipAuth: _skipAuth, ...fetchOptions } = options ?? {}
    return fetch(`${this.apiUrl}${endpoint}`, { ...fetchOptions, headers })
  }

  async request(endpoint: string, options?: RequestInit & { skipAuth?: boolean }): Promise<any> {
    // Auto-bootstrap: never let an authenticated request leave without a
    // credential. If the key is missing this throws a descriptive
    // BackenlyError instead of letting the server 401 with "missing header".
    if (!this.apiKey && !options?.skipAuth) {
      await this.ensureApiKey()
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }

    // ── The project key goes in x-api-key. NEVER in Authorization ────────────
    //
    // These are two different credentials and the server treats them as such:
    // `x-api-key` is looked up as a hashed project key, while `Authorization:
    // Bearer` is parsed as a JWT and verified against the project's signing
    // secret. An `sk_live_…` key is not a JWT, so sending it as a Bearer token
    // fails at `token.split('.')[1]` and comes back 401 INVALID_TOKEN.
    //
    // This client sent every data-plane call the second way, so the published
    // SDK could not read or write anything — and because it is also what people
    // reverse-engineer the contract from, it taught the wrong scheme to anyone
    // who read it.
    //
    // `Authorization` stays reserved for the END-USER JWT, which is what
    // `X-User-Token` carries here. The two are sent together on purpose: the key
    // says which project, the user token says which end-user, and RLS needs both.
    if (this.apiKey && !options?.skipAuth) {
      headers['x-api-key'] = this.apiKey
    }

    if (this.userToken && !options?.skipAuth) {
      headers['X-User-Token'] = this.userToken
    }

    if (options?.headers) {
      Object.entries(options.headers as Record<string, string>).forEach(
        ([key, value]) => { headers[key] = value }
      )
    }

    try {
      const { skipAuth: _skipAuth, ...fetchOptions } = options ?? {}
      const response = await fetch(`${this.apiUrl}${endpoint}`, {
        ...fetchOptions,
        headers,
      })

      if (!response.ok) {
        const body = await response.json().catch(() => ({
          error: `Request failed with status ${response.status}`,
        }))
        // Stamp the HTTP status onto the body so normalizeError can pass it
        // through to BackenlyError. Without this the SDK silently dropped
        // status from every error, making 401s indistinguishable from 500s
        // in caller catch blocks.
        ;(body as any).status = response.status
        throw normalizeError(body)
      }

      return response.json()
    } catch (error) {
      throw normalizeError(error)
    }
  }
}
