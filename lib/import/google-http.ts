/**
 * Google's REST APIs for the Firebase importer: one transport, a fixed list of
 * hosts, retries for what Google asks to be retried, and refusals said in the
 * words of the person who has to fix them.
 *
 * Only the hosts in GOOGLE_API_HOSTS are ever called. Nothing in a service
 * account key (its token_uri, its auth URIs) chooses a host, redirects are
 * never followed (a 3xx is an error), and every request goes through the
 * platform's outbound guard (lib/security/outbound-guard.ts), which resolves
 * the name itself and refuses private, loopback and link-local addresses.
 *
 * Read-only: GET, and POST only for Google's query endpoints, whose bodies are
 * queries (Firestore runQuery, runAggregationQuery, listCollectionIds; the
 * OAuth token exchange).
 */

import { safeFetch } from '@/lib/security/outbound-guard'
import { ImportAborted, throwIfAborted } from './pg-engine'

export const GOOGLE_API_HOSTS: ReadonlySet<string> = new Set([
  'oauth2.googleapis.com',
  'firestore.googleapis.com',
  'identitytoolkit.googleapis.com',
  'storage.googleapis.com',
  'firebase.googleapis.com',
  'firebaserules.googleapis.com',
])

/**
 * The OAuth scope each API is called with. A token carries one set, so a
 * Firestore read cannot be replayed against Storage, and Storage gets
 * read-only. Identity Toolkit's admin config (the password hash parameters)
 * accepts only cloud-platform; what the token can do is still bounded by the
 * service account's roles, and this module only ever reads.
 */
export const GOOGLE_SCOPES = {
  firestore: ['https://www.googleapis.com/auth/datastore'],
  auth: ['https://www.googleapis.com/auth/cloud-platform'],
  storage: ['https://www.googleapis.com/auth/devstorage.read_only'],
  firebase: ['https://www.googleapis.com/auth/firebase.readonly'],
} as const

export type GoogleScopeSet = keyof typeof GOOGLE_SCOPES

/** Which API answered; decides the words of a refusal. */
export type GoogleApiName = 'token' | 'firestore' | 'auth' | 'storage' | 'firebase' | 'rules'

export interface GoogleRequest {
  method: 'GET' | 'POST'
  url: string
  headers?: Record<string, string>
  body?: string
  /** Bytes after which the answer is abandoned. */
  maxBytes?: number
  timeoutMs?: number
}

export interface GoogleResponse {
  status: number
  headers: Map<string, string>
  body: Buffer
}

/** How bytes reach Google. Production uses safeFetch; tests hand in recorded answers. */
export type GoogleTransport = (req: GoogleRequest) => Promise<GoogleResponse>

const DEFAULT_MAX_BYTES = 32 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 60_000

export const defaultGoogleTransport: GoogleTransport = async (req) => {
  const res = await safeFetch(req.url, {
    method: req.method,
    headers: req.headers,
    body: req.body,
    timeoutMs: req.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxBytes: req.maxBytes ?? DEFAULT_MAX_BYTES,
    // A redirect is an error: following one could leave Google's hosts.
    maxRedirects: 0,
    egressScope: 'import',
  })
  return { status: res.status, headers: res.headers, body: Buffer.from(await res.arrayBuffer()) }
}

/** The URL, parsed, when it is https on one of Google's API hosts; otherwise a refusal. */
export function assertGoogleUrl(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('The Firebase importer refused a malformed address.')
  }
  if (url.protocol !== 'https:' || !GOOGLE_API_HOSTS.has(url.hostname) || url.username || url.password || (url.port && url.port !== '443')) {
    throw new Error(`The Firebase importer only calls Google's APIs; it refused ${url.hostname || 'an address'}.`)
  }
  return url
}

// ── Errors ─────────────────────────────────────────────────────────────────────

/** Google answered with an error. `code` is Google's status word (PERMISSION_DENIED), `reason` its detail (SERVICE_DISABLED). */
export class GoogleApiError extends Error {
  constructor(
    readonly api: GoogleApiName,
    readonly status: number,
    readonly code: string,
    readonly reason: string,
    readonly googleMessage: string,
  ) {
    super(plainGoogleError(api, status, code, reason, googleMessage))
    this.name = 'GoogleApiError'
  }

  get permissionDenied(): boolean {
    return this.status === 403 && this.reason !== 'SERVICE_DISABLED' && this.reason !== 'ACCESS_TOKEN_SCOPE_INSUFFICIENT'
  }

  get serviceDisabled(): boolean {
    return this.reason === 'SERVICE_DISABLED' || /has not been used in project|it is disabled/i.test(this.googleMessage)
  }

  get notFound(): boolean {
    return this.status === 404
  }
}

/** Google could not be reached, or did not finish answering. */
export class GoogleNetworkError extends Error {
  constructor(readonly api: GoogleApiName, readonly cause: string) {
    super("Couldn't reach Google. Try again in a moment.")
    this.name = 'GoogleNetworkError'
  }
}

/** An answer larger than the caller allowed; a caller that pages can ask for less. */
export class GoogleResponseTooLargeError extends Error {
  constructor(readonly api: GoogleApiName, readonly limit: number) {
    super(`Google's answer was larger than ${Math.round(limit / (1024 * 1024))} MB.`)
    this.name = 'GoogleResponseTooLargeError'
  }
}

/** The role that lets a service account read what `api` refused. */
const ROLE_FOR: Record<GoogleApiName, { what: string; role: string }> = {
  token: { what: 'Google', role: 'Service Account Token Creator' },
  firestore: { what: 'Firestore', role: 'Cloud Datastore Viewer' },
  auth: { what: 'Firebase Authentication', role: 'Firebase Authentication Admin' },
  storage: { what: 'Cloud Storage', role: 'Storage Object Viewer' },
  firebase: { what: "the Firebase project's settings", role: 'Firebase Viewer' },
  rules: { what: "the project's security rules", role: 'Firebase Rules Viewer' },
}

const API_LABEL: Record<GoogleApiName, string> = {
  token: 'Google sign-in',
  firestore: 'Cloud Firestore API',
  auth: 'Identity Toolkit API',
  storage: 'Cloud Storage API',
  firebase: 'Firebase Management API',
  rules: 'Firebase Rules API',
}

/** One sentence a person can act on. */
export function plainGoogleError(api: GoogleApiName, status: number, code: string, reason: string, message: string): string {
  const { what, role } = ROLE_FOR[api]
  if (reason === 'SERVICE_DISABLED' || /has not been used in project|it is disabled/i.test(message)) {
    return `The ${API_LABEL[api]} is turned off for this Firebase project, so Backenly can't read ${what}.`
  }
  if (reason === 'ACCESS_TOKEN_SCOPE_INSUFFICIENT') {
    return `Google refused Backenly's request to read ${what}. Try again; if it keeps happening, tell Backenly support.`
  }
  if (status === 403 || code === 'PERMISSION_DENIED') {
    return `This key can't read ${what}. Give the service account the ${role} role.`
  }
  if (status === 401 || code === 'UNAUTHENTICATED') {
    return "Google didn't accept this key. Generate a new private key and paste it here."
  }
  if (status === 404 || code === 'NOT_FOUND') {
    return `${what[0].toUpperCase()}${what.slice(1)} wasn't found in this Firebase project.`
  }
  if (status === 429 || code === 'RESOURCE_EXHAUSTED') {
    return `Google is limiting how fast ${what} can be read right now. Try again in a few minutes.`
  }
  if (status >= 500) return `Google had a problem reading ${what}. Try again in a moment.`
  const said = message ? `: ${message.replace(/\s+/g, ' ').slice(0, 200)}` : ''
  return `Google refused to read ${what}${said}`
}

/** Google's error body, in its two shapes (google.rpc.Status, and Cloud Storage's), possibly inside an array. */
export function parseGoogleError(body: Buffer | string): { code: string; reason: string; message: string } {
  let parsed: any
  try {
    parsed = JSON.parse(typeof body === 'string' ? body : body.toString('utf8'))
  } catch {
    return { code: '', reason: '', message: '' }
  }
  if (Array.isArray(parsed)) parsed = parsed.find((x) => x && x.error) ?? parsed[0]
  const err = parsed?.error
  if (typeof err === 'string') {
    // OAuth's shape: { error: 'invalid_grant', error_description: '…' }
    return { code: err, reason: err, message: String(parsed?.error_description ?? '') }
  }
  const details: any[] = Array.isArray(err?.details) ? err.details : []
  const info = details.find((d) => typeof d?.reason === 'string')
  const legacy = Array.isArray(err?.errors) ? err.errors.find((e: any) => typeof e?.reason === 'string') : null
  return {
    code: typeof err?.status === 'string' ? err.status : '',
    reason: info?.reason ?? legacy?.reason ?? '',
    message: typeof err?.message === 'string' ? err.message : '',
  }
}

// ── The client ─────────────────────────────────────────────────────────────────

export interface GoogleClientOptions {
  /** An access token for a scope set; `force` asks for a fresh one after a 401. */
  token: (scope: GoogleScopeSet, opts?: { force?: boolean }) => Promise<string>
  transport?: GoogleTransport
  signal?: AbortSignal
  maxAttempts?: number
  /** Tests skip the waiting. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
}

export interface GoogleCallOptions {
  maxBytes?: number
  timeoutMs?: number
  /** Extra request headers (never Authorization). */
  headers?: Record<string, string>
}

const RETRY_STATUS = new Set([408, 429, 500, 502, 503, 504])

/** The error a canceled job stops with: the runner's own reason, or "canceled". */
function abortError(signal: AbortSignal): ImportAborted {
  return signal.reason instanceof ImportAborted ? signal.reason : new ImportAborted('canceled')
}

export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError(signal))
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortError(signal!))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function backoffMs(attempt: number, retryAfter: string | undefined): number {
  const seconds = retryAfter ? Number(retryAfter) : NaN
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 60_000)
  return Math.min(500 * 2 ** (attempt - 1), 20_000) + Math.floor(Math.random() * 250)
}

/** An authorized caller of Google's APIs for one import job. */
export class GoogleClient {
  private readonly transport: GoogleTransport
  private readonly maxAttempts: number
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>

  constructor(private readonly opts: GoogleClientOptions) {
    this.transport = opts.transport ?? defaultGoogleTransport
    this.maxAttempts = Math.max(1, opts.maxAttempts ?? 5)
    this.sleep = opts.sleep ?? abortableSleep
  }

  get signal(): AbortSignal | undefined {
    return this.opts.signal
  }

  /** GET or POST a JSON API; the parsed answer. */
  async json<T = any>(api: GoogleApiName, scope: GoogleScopeSet, method: 'GET' | 'POST', url: string, body?: unknown, call: GoogleCallOptions = {}): Promise<T> {
    const res = await this.send(api, scope, method, url, body === undefined ? undefined : JSON.stringify(body), {
      ...call,
      headers: { ...(call.headers ?? {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    })
    const text = res.body.toString('utf8')
    if (!text.trim()) return {} as T
    try {
      return JSON.parse(text) as T
    } catch {
      throw new GoogleApiError(api, res.status, 'INVALID_RESPONSE', '', 'Google answered with something that is not JSON.')
    }
  }

  /** GET raw bytes (a Storage object). */
  async bytes(api: GoogleApiName, scope: GoogleScopeSet, url: string, call: GoogleCallOptions = {}): Promise<GoogleResponse> {
    return this.send(api, scope, 'GET', url, undefined, call)
  }

  private async send(
    api: GoogleApiName,
    scope: GoogleScopeSet,
    method: 'GET' | 'POST',
    url: string,
    body: string | undefined,
    call: GoogleCallOptions,
  ): Promise<GoogleResponse> {
    assertGoogleUrl(url)
    const signal = this.opts.signal
    let refreshed = false
    let forceToken = false
    for (let attempt = 1; ; attempt++) {
      if (signal) throwIfAborted(signal)
      const token = await this.opts.token(scope, { force: forceToken })
      forceToken = false
      let res: GoogleResponse
      try {
        res = await this.transport({
          method,
          url,
          body,
          maxBytes: call.maxBytes,
          timeoutMs: call.timeoutMs,
          headers: { ...(call.headers ?? {}), Authorization: `Bearer ${token}`, Accept: 'application/json' },
        })
      } catch (err: any) {
        const msg = String(err?.message ?? err)
        if (/exceeded \d+ bytes/i.test(msg)) throw new GoogleResponseTooLargeError(api, call.maxBytes ?? DEFAULT_MAX_BYTES)
        if (/redirect/i.test(msg)) throw new GoogleApiError(api, 0, 'REDIRECT', '', 'Google answered with a redirect, which the importer does not follow.')
        if (attempt < this.maxAttempts) {
          await this.sleep(backoffMs(attempt, undefined), signal)
          continue
        }
        throw new GoogleNetworkError(api, msg)
      }
      if (res.status >= 200 && res.status < 300) return res
      if (res.status === 401 && !refreshed) {
        // The token expired early or was revoked: one fresh token, once.
        refreshed = true
        forceToken = true
        continue
      }
      if (RETRY_STATUS.has(res.status) && attempt < this.maxAttempts) {
        await this.sleep(backoffMs(attempt, res.headers.get('retry-after')), signal)
        continue
      }
      const e = parseGoogleError(res.body)
      throw new GoogleApiError(api, res.status, e.code, e.reason, e.message)
    }
  }
}

/** Percent-encode each segment of a Firestore or Storage path, keeping the slashes. */
export function encodePath(path: string): string {
  return path.split('/').map((s) => encodeURIComponent(s)).join('/')
}
