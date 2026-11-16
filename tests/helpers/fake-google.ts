/**
 * A stand-in for the Google REST APIs the Firebase importer reads, answering
 * the way Google answers: Firestore's documents list (page tokens, `recursive`,
 * `showMissing`), listCollectionIds, COUNT aggregation; Identity Toolkit's
 * config and accounts:batchGet; Cloud Storage's object list and alt=media;
 * the Firebase project; the Rules API; and the OAuth token endpoint, which
 * checks the RS256 signature of every assertion against the key it issued.
 *
 * Bodies follow Google's own JSON (integers as strings, timestamps with
 * nanoseconds, url-safe base64 for password hashes, error shapes per API), so
 * the importer's parsing is exercised against the real formats. Not a test
 * file: it is imported by __tests__/import/firebase-*.test.ts.
 */

import { createVerify, generateKeyPairSync } from 'crypto'
import type { GoogleRequest, GoogleResponse } from '@/lib/import/google-http'
import type { FsValue } from '@/lib/import/drivers/firebase-schema'

export function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): GoogleResponse {
  return {
    status,
    headers: new Map(Object.entries({ 'content-type': 'application/json; charset=UTF-8', ...headers })),
    body: Buffer.from(JSON.stringify(body)),
  }
}

/** Google's error body for a JSON API (google.rpc.Status). */
export function rpcError(code: number, status: string, message: string, reason?: string): unknown {
  return {
    error: {
      code,
      message,
      status,
      ...(reason
        ? { details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason, domain: 'googleapis.com', metadata: { service: 'firestore.googleapis.com' } }] }
        : {}),
    },
  }
}

export interface TestServiceAccount {
  json: string
  projectId: string
  clientEmail: string
  publicKeyPem: string
}

/** A real RSA key pair made for the test, in a key file shaped like Firebase's. Never a real credential. */
export function makeServiceAccount(projectId = 'demo-shop', extra: Record<string, unknown> = {}): TestServiceAccount {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  })
  const clientEmail = `firebase-adminsdk-x1y2z@${projectId}.iam.gserviceaccount.com`
  const json = JSON.stringify({
    type: 'service_account',
    project_id: projectId,
    private_key_id: 'k1a2b3c4d5',
    private_key: privateKey,
    client_email: clientEmail,
    client_id: '109876543210987654321',
    auth_uri: 'https://accounts.google.com/o/oauth2/auth',
    // A key's own token_uri is never used: the fake fails the test if it is called.
    token_uri: 'https://token.attacker.example/token',
    auth_provider_x509_cert_url: 'https://www.googleapis.com/oauth2/v1/certs',
    client_x509_cert_url: `https://www.googleapis.com/robot/v1/metadata/x509/${encodeURIComponent(clientEmail)}`,
    universe_domain: 'googleapis.com',
    ...extra,
  })
  return { json, projectId, clientEmail, publicKeyPem: publicKey }
}

function b64urlDecode(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
}

/** Segment by segment, the way Firestore orders document names. */
export function compareDocPaths(a: string, b: string): number {
  const x = a.split('/')
  const y = b.split('/')
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1
  }
  return x.length - y.length
}

function token(offset: number): string {
  return Buffer.from(`o:${offset}`).toString('base64')
}

function offsetOf(t: string | null): number {
  if (!t) return 0
  const m = /^o:(\d+)$/.exec(Buffer.from(t, 'base64').toString('utf8'))
  if (!m) throw new Error(`bad page token ${t}`)
  return Number(m[1])
}

export interface FakeDoc {
  fields?: Record<string, FsValue>
  createTime?: string
  updateTime?: string
}

export type FakeApi = 'firestore' | 'auth' | 'storage' | 'firebase' | 'rules'

export class FakeGoogle {
  readonly calls: GoogleRequest[] = []
  readonly root: string
  /** Documents by path below the root (posts/a, posts/a/comments/c). */
  readonly docs = new Map<string, FakeDoc>()
  users: any[] = []
  hashConfig: Record<string, unknown> | null = null
  authConfigured = true
  objects = new Map<string, { contentType: string | null; data: Buffer }>()
  /** The bucket that exists. */
  bucket: string | null
  /** What the Firebase project config says the bucket is (null: newer projects say nothing). */
  configBucket: string | null
  displayName = 'Demo Shop'
  rulesSource: string | null = null
  readonly deny = new Set<FakeApi>()
  readonly disabled = new Set<FakeApi>()
  recursiveUnsupported = false
  firestoreMissing = false
  tokenRefusal: { status: number; body: unknown } | null = null
  /** Answer the next N calls to a URL fragment with this status first (retries). */
  readonly flaky: Array<{ match: RegExp; status: number; times: number; headers?: Record<string, string> }> = []
  tokensIssued = 0
  readonly scopesIssued: string[] = []

  constructor(readonly sa: TestServiceAccount) {
    this.root = `projects/${sa.projectId}/databases/(default)/documents`
    this.bucket = `${sa.projectId}.appspot.com`
    this.configBucket = this.bucket
  }

  put(path: string, fields: Record<string, FsValue>, time = '2024-03-01T10:15:30.123456789Z'): void {
    this.docs.set(path, { fields, createTime: time, updateTime: time })
  }

  readonly transport = async (req: GoogleRequest): Promise<GoogleResponse> => {
    this.calls.push(req)
    for (const f of this.flaky) {
      if (f.times > 0 && f.match.test(req.url)) {
        f.times--
        return jsonResponse(f.status, rpcError(f.status, 'UNAVAILABLE', 'The service is currently unavailable.'), f.headers ?? {})
      }
    }
    const url = new URL(req.url)
    if (url.hostname === 'oauth2.googleapis.com') return this.tokenEndpoint(req)
    const auth = req.headers?.Authorization ?? ''
    if (!/^Bearer tok-/.test(auth)) return jsonResponse(401, rpcError(401, 'UNAUTHENTICATED', 'Request had invalid authentication credentials.'))
    switch (url.hostname) {
      case 'firestore.googleapis.com': return this.firestore(req, url)
      case 'identitytoolkit.googleapis.com': return this.identityToolkit(req, url)
      case 'storage.googleapis.com': return this.storage(req, url)
      case 'firebase.googleapis.com': return this.firebase(url)
      case 'firebaserules.googleapis.com': return this.rules(url)
      default: throw new Error(`unexpected host ${url.hostname}`)
    }
  }

  /** Every host the importer called. */
  hostsCalled(): string[] {
    return [...new Set(this.calls.map((c) => new URL(c.url).hostname))].sort()
  }

  private tokenEndpoint(req: GoogleRequest): GoogleResponse {
    if (req.url !== 'https://oauth2.googleapis.com/token' || req.method !== 'POST') throw new Error(`bad token call ${req.method} ${req.url}`)
    if (this.tokenRefusal) return jsonResponse(this.tokenRefusal.status, this.tokenRefusal.body)
    const form = new URLSearchParams(req.body ?? '')
    if (form.get('grant_type') !== 'urn:ietf:params:oauth:grant-type:jwt-bearer') return jsonResponse(400, { error: 'unsupported_grant_type' })
    const [h, p, s] = (form.get('assertion') ?? '').split('.')
    const verified = createVerify('RSA-SHA256').update(`${h}.${p}`).verify(this.sa.publicKeyPem, b64urlDecode(s))
    if (!verified) return jsonResponse(400, { error: 'invalid_grant', error_description: 'Invalid JWT Signature.' })
    const claims = JSON.parse(b64urlDecode(p).toString('utf8'))
    if (claims.iss !== this.sa.clientEmail || claims.aud !== 'https://oauth2.googleapis.com/token' || claims.exp - claims.iat > 3600) {
      return jsonResponse(400, { error: 'invalid_grant', error_description: 'Invalid JWT: Token must be a short-lived token (60 minutes) and in a reasonable timeframe.' })
    }
    this.tokensIssued++
    this.scopesIssued.push(claims.scope)
    return jsonResponse(200, { access_token: `tok-${this.tokensIssued}`, expires_in: 3599, token_type: 'Bearer' })
  }

  // ── Firestore ──────────────────────────────────────────────────────────────

  private firestore(req: GoogleRequest, url: URL): GoogleResponse {
    if (this.disabled.has('firestore')) {
      return jsonResponse(403, rpcError(403, 'PERMISSION_DENIED', 'Cloud Firestore API has not been used in project 123456 before or it is disabled.', 'SERVICE_DISABLED'))
    }
    if (this.deny.has('firestore')) return jsonResponse(403, rpcError(403, 'PERMISSION_DENIED', 'Missing or insufficient permissions.'))
    if (this.firestoreMissing) return jsonResponse(404, rpcError(404, 'NOT_FOUND', `The database (default) does not exist for project ${this.sa.projectId}`))
    const path = url.pathname.replace(/^\/v1\//, '').split('/').map(decodeURIComponent).join('/')
    const [resource, method] = path.split(':') as [string, string | undefined]
    if (!resource.startsWith(this.root)) throw new Error(`firestore resource outside the root: ${resource}`)
    const rel = resource.slice(this.root.length).replace(/^\//, '')
    const body = req.body ? JSON.parse(req.body) : {}
    if (method === 'listCollectionIds') return this.listCollectionIds(rel, body)
    if (method === 'runAggregationQuery') return this.aggregate(rel, body)
    if (method) throw new Error(`unexpected firestore method ${method}`)
    return this.listDocuments(rel, url.searchParams)
  }

  private listCollectionIds(parent: string, body: { pageSize?: number; pageToken?: string }): GoogleResponse {
    const ids = new Set<string>()
    for (const p of this.docs.keys()) {
      if (!parent) ids.add(p.split('/')[0])
      else if (p.startsWith(`${parent}/`)) ids.add(p.slice(parent.length + 1).split('/')[0])
    }
    const all = [...ids].sort()
    const start = offsetOf(body.pageToken ?? null)
    const size = Math.min(body.pageSize ?? 100, 2) // two a page, so paging is exercised
    const page = all.slice(start, start + size)
    return jsonResponse(200, { collectionIds: page, ...(start + size < all.length ? { nextPageToken: token(start + size) } : {}) })
  }

  private aggregate(parent: string, body: any): GoogleResponse {
    const from = body?.structuredAggregationQuery?.structuredQuery?.from?.[0] ?? {}
    const prefix = parent ? `${parent}/` : ''
    let n = 0
    for (const p of this.docs.keys()) {
      if (!p.startsWith(prefix)) continue
      const segs = p.slice(prefix.length).split('/')
      if (from.allDescendants) {
        if (segs[segs.length - 2] === from.collectionId) n++
      } else if (segs.length === 2 && segs[0] === from.collectionId) {
        n++
      }
    }
    return jsonResponse(200, [{ result: { aggregateFields: { n: { integerValue: String(n) } } }, readTime: '2024-05-01T00:00:00.000001Z' }])
  }

  private listDocuments(collectionPath: string, q: URLSearchParams): GoogleResponse {
    const recursive = q.get('recursive') === 'true'
    const showMissing = q.get('showMissing') === 'true'
    if (recursive && this.recursiveUnsupported) {
      return jsonResponse(400, rpcError(400, 'INVALID_ARGUMENT', 'Invalid JSON payload received. Unknown name "recursive": Cannot bind query parameter.'))
    }
    const depth = collectionPath.split('/').length
    let names: string[]
    if (recursive) {
      names = [...this.docs.keys()].filter((p) => p.startsWith(`${collectionPath}/`))
    } else {
      const ids = new Set<string>()
      for (const p of this.docs.keys()) {
        if (!p.startsWith(`${collectionPath}/`)) continue
        const segs = p.split('/')
        if (segs.length === depth + 1) ids.add(p)
        else if (showMissing) ids.add(segs.slice(0, depth + 1).join('/'))
      }
      names = [...ids]
    }
    names.sort(compareDocPaths)
    const start = offsetOf(q.get('pageToken'))
    const size = Number(q.get('pageSize') ?? 20)
    const page = names.slice(start, start + size).map((p) => {
      const d = this.docs.get(p)
      if (!d) return { name: `${this.root}/${p}` }
      return { name: `${this.root}/${p}`, fields: d.fields ?? {}, createTime: d.createTime, updateTime: d.updateTime }
    })
    return jsonResponse(200, { ...(page.length ? { documents: page } : {}), ...(start + size < names.length ? { nextPageToken: token(start + size) } : {}) })
  }

  // ── Identity Toolkit ───────────────────────────────────────────────────────

  private identityToolkit(req: GoogleRequest, url: URL): GoogleResponse {
    if (this.deny.has('auth')) {
      return jsonResponse(403, rpcError(403, 'PERMISSION_DENIED', "Caller does not have required permission to use project. Grant the caller the roles/serviceusage.serviceUsageConsumer role."))
    }
    if (!this.authConfigured) {
      return jsonResponse(400, { error: { code: 400, message: 'CONFIGURATION_NOT_FOUND', errors: [{ message: 'CONFIGURATION_NOT_FOUND', domain: 'global', reason: 'invalid' }], status: 'INVALID_ARGUMENT' } })
    }
    const p = this.sa.projectId
    if (url.pathname === `/admin/v2/projects/${p}/config`) {
      return jsonResponse(200, {
        name: `projects/${p}/config`,
        signIn: { email: { enabled: true, passwordRequired: true }, ...(this.hashConfig ? { hashConfig: this.hashConfig } : {}) },
      })
    }
    if (url.pathname === `/v1/projects/${p}/accounts:batchGet`) {
      const start = offsetOf(url.searchParams.get('nextPageToken'))
      const size = Math.min(Number(url.searchParams.get('maxResults') ?? 20), 3) // three a page, so paging is exercised
      const page = this.users.slice(start, start + size)
      return jsonResponse(200, {
        kind: 'identitytoolkit#DownloadAccountResponse',
        ...(page.length ? { users: page } : {}),
        ...(start + size < this.users.length ? { nextPageToken: token(start + size) } : {}),
      })
    }
    if (url.pathname === `/v1/projects/${p}/accounts:query` && req.method === 'POST') {
      return jsonResponse(200, { recordsCount: String(this.users.length) })
    }
    throw new Error(`unexpected identity toolkit call ${url.pathname}`)
  }

  // ── Cloud Storage ──────────────────────────────────────────────────────────

  private storage(_req: GoogleRequest, url: URL): GoogleResponse {
    const m = /^\/storage\/v1\/b\/([^/]+)\/o(?:\/(.+))?$/.exec(url.pathname)
    if (!m) throw new Error(`unexpected storage call ${url.pathname}`)
    const bucket = decodeURIComponent(m[1])
    if (this.deny.has('storage')) {
      const message = `${this.sa.clientEmail} does not have storage.objects.list access to the Google Cloud Storage bucket. Permission 'storage.objects.list' denied on resource (or it may not exist).`
      return jsonResponse(403, { error: { code: 403, message, errors: [{ message, domain: 'global', reason: 'forbidden' }] } })
    }
    if (bucket !== this.bucket) {
      return jsonResponse(404, { error: { code: 404, message: 'The specified bucket does not exist.', errors: [{ message: 'The specified bucket does not exist.', domain: 'global', reason: 'notFound' }] } })
    }
    if (m[2]) {
      const name = decodeURIComponent(m[2])
      if (url.searchParams.get('alt') !== 'media') throw new Error('object metadata was not expected')
      const o = this.objects.get(name)
      if (!o) return jsonResponse(404, { error: { code: 404, message: `No such object: ${bucket}/${name}`, errors: [{ message: 'No such object', domain: 'global', reason: 'notFound' }] } })
      return { status: 200, headers: new Map([['content-type', o.contentType ?? 'application/octet-stream']]), body: o.data }
    }
    const names = [...this.objects.keys()].sort()
    const start = offsetOf(url.searchParams.get('pageToken'))
    const size = Math.min(Number(url.searchParams.get('maxResults') ?? 1000), 2) // two a page
    const items = names.slice(start, start + size).map((name) => {
      const o = this.objects.get(name)!
      return { name, size: String(o.data.length), ...(o.contentType ? { contentType: o.contentType } : {}) }
    })
    return jsonResponse(200, { ...(items.length ? { items } : {}), ...(start + size < names.length ? { nextPageToken: token(start + size) } : {}) })
  }

  // ── Firebase project and rules ─────────────────────────────────────────────

  private firebase(url: URL): GoogleResponse {
    if (this.deny.has('firebase')) return jsonResponse(403, rpcError(403, 'PERMISSION_DENIED', 'The caller does not have permission'))
    const p = this.sa.projectId
    if (url.pathname === `/v1beta1/projects/${p}`) {
      return jsonResponse(200, {
        name: `projects/${p}`,
        projectId: p,
        projectNumber: '123456789012',
        displayName: this.displayName,
        ...(this.configBucket ? { resources: { hostingSite: p, storageBucket: this.configBucket, locationId: 'us-central' } } : {}),
        state: 'ACTIVE',
        etag: '1_abc',
      })
    }
    if (url.pathname === `/v1beta1/projects/${p}/adminSdkConfig`) {
      return jsonResponse(200, { projectId: p, ...(this.configBucket ? { storageBucket: this.configBucket } : {}) })
    }
    throw new Error(`unexpected firebase call ${url.pathname}`)
  }

  private rules(url: URL): GoogleResponse {
    if (this.deny.has('rules') || this.rulesSource === null) return jsonResponse(403, rpcError(403, 'PERMISSION_DENIED', 'The caller does not have permission'))
    const p = this.sa.projectId
    if (url.pathname === `/v1/projects/${p}/releases/cloud.firestore`) {
      return jsonResponse(200, { name: `projects/${p}/releases/cloud.firestore`, rulesetName: `projects/${p}/rulesets/8f2c1d`, createTime: '2024-01-01T00:00:00Z' })
    }
    if (url.pathname === `/v1/projects/${p}/rulesets/8f2c1d`) {
      return jsonResponse(200, { name: `projects/${p}/rulesets/8f2c1d`, source: { files: [{ name: 'firestore.rules', content: this.rulesSource }] } })
    }
    throw new Error(`unexpected rules call ${url.pathname}`)
  }
}
