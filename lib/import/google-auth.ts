/**
 * A Firebase service account key, checked, and the access tokens it mints.
 *
 * The person pastes the key file Firebase gives them (Project settings →
 * Service accounts → Generate new private key). It is read once, here, into a
 * parsed private key that lives in memory for the job and is never written,
 * logged or sent anywhere but as the signature of a JWT to Google's token
 * endpoint (the OAuth 2.0 JWT bearer flow, RFC 7523):
 *
 *   assertion = RS256( { iss: client_email, scope, aud: token URL, iat, exp } )
 *   POST https://oauth2.googleapis.com/token  grant_type=jwt-bearer&assertion=…
 *
 * The token URL is fixed. A key's own `token_uri` is never used, so a crafted
 * key cannot point Backenly at another host. Tokens are cached per job and per
 * scope set (lib/import/google-http.ts GOOGLE_SCOPES) and renewed five minutes
 * before they expire, so an import longer than an hour keeps working.
 */

import { createPrivateKey, createSign, type KeyObject } from 'crypto'
import { ImportInputError } from './driver'
import { throwIfAborted } from './pg-engine'
import {
  GOOGLE_SCOPES,
  assertGoogleUrl,
  abortableSleep,
  defaultGoogleTransport,
  parseGoogleError,
  GoogleNetworkError,
  type GoogleScopeSet,
  type GoogleTransport,
} from './google-http'

export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'

const MAX_KEY_FILE_BYTES = 64 * 1024
const TOKEN_LIFETIME_S = 3600
const REFRESH_MARGIN_MS = 5 * 60 * 1000

const WHERE_TO_GET_ONE =
  'In Firebase, open Project settings → Service accounts → Generate new private key, and paste the JSON file it downloads.'

/** A checked service account key. `key` is never serialised. */
export interface ServiceAccount {
  projectId: string
  clientEmail: string
  privateKeyId: string | null
  key: KeyObject
}

function refuse(message: string): never {
  throw new ImportInputError(message, 'serviceAccountJson')
}

/** Read and check the pasted key file. Refusals name the field and say what to do. */
export function parseServiceAccount(text: unknown): ServiceAccount {
  if (typeof text !== 'string' || !text.trim()) {
    refuse(`Paste the service account key. ${WHERE_TO_GET_ONE}`)
  }
  if (Buffer.byteLength(text, 'utf8') > MAX_KEY_FILE_BYTES) {
    refuse(`This is too large to be a service account key. ${WHERE_TO_GET_ONE}`)
  }
  let json: Record<string, unknown>
  try {
    const parsed = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
    json = parsed as Record<string, unknown>
  } catch {
    refuse(`This isn't a service account key. ${WHERE_TO_GET_ONE}`)
  }

  if (json.type !== 'service_account') {
    if (json.project_info && json.client) {
      refuse(`This is google-services.json, your app's config file, not a service account key. ${WHERE_TO_GET_ONE}`)
    }
    if (json.type === 'authorized_user') {
      refuse(`This is a personal Google sign-in, not a service account key. ${WHERE_TO_GET_ONE}`)
    }
    if (typeof json.apiKey === 'string' && typeof json.projectId === 'string') {
      refuse(`This is your web app's Firebase config, not a service account key. ${WHERE_TO_GET_ONE}`)
    }
    refuse(`This JSON isn't a service account key. ${WHERE_TO_GET_ONE}`)
  }

  const universe = json.universe_domain
  if (universe !== undefined && universe !== 'googleapis.com') {
    refuse('This key belongs to a Google Cloud universe other than googleapis.com, which Backenly can\'t read from.')
  }

  const projectId = typeof json.project_id === 'string' ? json.project_id.trim() : ''
  // Google Cloud project ids: 6–30 lowercase letters, digits and hyphens, with
  // an optional legacy domain prefix ("example.com:my-project").
  if (!/^(?:[a-z0-9][a-z0-9.-]{0,62}:)?[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId)) {
    refuse(`This key has no valid project_id. ${WHERE_TO_GET_ONE}`)
  }

  const clientEmail = typeof json.client_email === 'string' ? json.client_email.trim() : ''
  if (!/^[a-z0-9][a-z0-9._-]*@[a-z0-9.-]+\.gserviceaccount\.com$/i.test(clientEmail)) {
    refuse(`This key's client_email isn't a service account address. ${WHERE_TO_GET_ONE}`)
  }

  const pem = typeof json.private_key === 'string' ? json.private_key : ''
  if (!pem.includes('PRIVATE KEY')) {
    refuse(`This key has no private_key. ${WHERE_TO_GET_ONE}`)
  }
  let key: KeyObject
  try {
    key = createPrivateKey({ key: pem, format: 'pem' })
  } catch {
    refuse('The private key in this file can\'t be read. Download a new key and paste the file unchanged.')
  }
  if (key.asymmetricKeyType !== 'rsa') {
    refuse('The private key in this file isn\'t an RSA key, which Google service account keys always are. Download a new key.')
  }

  const privateKeyId = typeof json.private_key_id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(json.private_key_id)
    ? json.private_key_id
    : null

  return { projectId, clientEmail, privateKeyId, key }
}

function base64url(input: Buffer | string): string {
  return (typeof input === 'string' ? Buffer.from(input, 'utf8') : input)
    .toString('base64')
    .replace(/=+$/, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
}

/** The signed assertion for the JWT bearer flow. */
export function signServiceAccountJwt(sa: ServiceAccount, scopes: readonly string[], nowMs: number): string {
  const iat = Math.floor(nowMs / 1000)
  const header = { alg: 'RS256', typ: 'JWT', ...(sa.privateKeyId ? { kid: sa.privateKeyId } : {}) }
  const payload = {
    iss: sa.clientEmail,
    scope: scopes.join(' '),
    aud: GOOGLE_TOKEN_URL,
    iat,
    exp: iat + TOKEN_LIFETIME_S,
  }
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`
  const signature = createSign('RSA-SHA256').update(signingInput).sign(sa.key)
  return `${signingInput}.${base64url(signature)}`
}

/** What Google's token endpoint said, in words the person can act on. */
function plainTokenRefusal(code: string, description: string): string {
  const d = description.toLowerCase()
  if (d.includes('invalid jwt signature')) {
    return 'Google doesn\'t accept this key: it was deleted or replaced. Generate a new private key and paste it here.'
  }
  if (d.includes('disabled')) {
    return 'This service account is disabled in Google Cloud. Enable it, or generate a key for an enabled one.'
  }
  if (code === 'invalid_client' || d.includes('not found') || d.includes('does not exist')) {
    return 'This service account no longer exists. Generate a new private key and paste it here.'
  }
  if (d.includes('iat') || d.includes('exp') || d.includes('timeframe')) {
    return 'Google refused the sign-in because this server\'s clock is off. Try again in a moment.'
  }
  return 'Google didn\'t accept this key. Generate a new private key and paste it here.'
}

export interface TokenSourceOptions {
  transport?: GoogleTransport
  now?: () => number
  signal?: AbortSignal
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
}

/** Access tokens for one job: minted on first use, cached per scope set, renewed before they expire. */
export class GoogleTokenSource {
  private readonly cache = new Map<GoogleScopeSet, { token: string; expiresAt: number }>()
  private readonly inflight = new Map<GoogleScopeSet, Promise<string>>()
  private readonly transport: GoogleTransport
  private readonly now: () => number
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>
  /** How many tokens were minted; tests read it. */
  minted = 0

  constructor(private readonly sa: ServiceAccount, private readonly opts: TokenSourceOptions = {}) {
    this.transport = opts.transport ?? defaultGoogleTransport
    this.now = opts.now ?? Date.now
    this.sleep = opts.sleep ?? abortableSleep
  }

  token = async (scope: GoogleScopeSet, opts: { force?: boolean } = {}): Promise<string> => {
    const cached = this.cache.get(scope)
    if (!opts.force && cached && cached.expiresAt - REFRESH_MARGIN_MS > this.now()) return cached.token
    const pending = this.inflight.get(scope)
    if (pending) return pending
    const p = this.mint(scope).finally(() => this.inflight.delete(scope))
    this.inflight.set(scope, p)
    return p
  }

  private async mint(scope: GoogleScopeSet): Promise<string> {
    assertGoogleUrl(GOOGLE_TOKEN_URL)
    const assertion = signServiceAccountJwt(this.sa, GOOGLE_SCOPES[scope], this.now())
    const body = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }).toString()
    for (let attempt = 1; ; attempt++) {
      if (this.opts.signal) throwIfAborted(this.opts.signal)
      let status: number
      let text: string
      try {
        const res = await this.transport({
          method: 'POST',
          url: GOOGLE_TOKEN_URL,
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
          body,
          maxBytes: 64 * 1024,
          timeoutMs: 30_000,
        })
        status = res.status
        text = res.body.toString('utf8')
      } catch (err: any) {
        if (attempt < 3) {
          await this.sleep(500 * 2 ** (attempt - 1), this.opts.signal)
          continue
        }
        throw new GoogleNetworkError('token', String(err?.message ?? err))
      }
      if (status >= 500 && attempt < 3) {
        await this.sleep(500 * 2 ** (attempt - 1), this.opts.signal)
        continue
      }
      if (status !== 200) {
        const e = parseGoogleError(text)
        if (status >= 500) throw new GoogleNetworkError('token', `token endpoint answered ${status}`)
        throw new ImportInputError(plainTokenRefusal(e.code, e.message), 'serviceAccountJson')
      }
      let parsed: any
      try {
        parsed = JSON.parse(text)
      } catch {
        throw new GoogleNetworkError('token', 'token endpoint answered with something that is not JSON')
      }
      const token = typeof parsed?.access_token === 'string' ? parsed.access_token : ''
      if (!token) throw new GoogleNetworkError('token', 'token endpoint answered without a token')
      const lifetime = Number(parsed.expires_in)
      const expiresAt = this.now() + (Number.isFinite(lifetime) && lifetime > 0 ? lifetime : TOKEN_LIFETIME_S) * 1000
      this.cache.set(scope, { token, expiresAt })
      this.minted++
      return token
    }
  }
}
