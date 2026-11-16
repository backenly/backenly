/**
 * The Firebase importer's way into Google: the pasted service account key,
 * the access tokens it mints (OAuth 2.0 JWT bearer flow, RS256 with node's
 * crypto), and the HTTP layer that only ever calls Google's API hosts.
 *
 * The key is generated for the test (tests/helpers/fake-google.ts); the token
 * endpoint is a fake that checks every assertion's signature against it.
 * Database-free.
 */

import { createVerify, generateKeyPairSync } from 'crypto'
import { GOOGLE_TOKEN_URL, GoogleTokenSource, parseServiceAccount, signServiceAccountJwt } from '@/lib/import/google-auth'
import {
  GOOGLE_SCOPES,
  GoogleApiError,
  GoogleClient,
  assertGoogleUrl,
  parseGoogleError,
  plainGoogleError,
} from '@/lib/import/google-http'
import { ImportInputError } from '@/lib/import/driver'
import { ImportAborted } from '@/lib/import/pg-engine'
import { FakeGoogle, jsonResponse, makeServiceAccount, rpcError } from '../../tests/helpers/fake-google'

const SA = makeServiceAccount('demo-shop')
const noSleep = async () => {}

function refusalOf(fn: () => unknown): ImportInputError {
  try {
    fn()
  } catch (err) {
    expect(err).toBeInstanceOf(ImportInputError)
    expect((err as ImportInputError).field).toBe('serviceAccountJson')
    return err as ImportInputError
  }
  throw new Error('expected a refusal')
}

describe('the service account key', () => {
  it('reads a Firebase key file', () => {
    const sa = parseServiceAccount(SA.json)
    expect(sa.projectId).toBe('demo-shop')
    expect(sa.clientEmail).toBe(SA.clientEmail)
    expect(sa.privateKeyId).toBe('k1a2b3c4d5')
    expect(sa.key.asymmetricKeyType).toBe('rsa')
    // The parsed key never turns back into its text.
    expect(JSON.stringify(sa)).not.toContain('PRIVATE KEY')
  })

  it('says what to paste when it is not a service account key', () => {
    expect(refusalOf(() => parseServiceAccount('')).message).toMatch(/Paste the service account key/)
    expect(refusalOf(() => parseServiceAccount('{not json')).message).toMatch(/isn't a service account key.*Generate new private key/)
    expect(refusalOf(() => parseServiceAccount(JSON.stringify({ project_info: { project_id: 'x' }, client: [] }))).message).toMatch(/google-services\.json/)
    expect(refusalOf(() => parseServiceAccount(JSON.stringify({ type: 'authorized_user', client_id: 'x' }))).message).toMatch(/personal Google sign-in/)
    expect(refusalOf(() => parseServiceAccount(JSON.stringify({ apiKey: 'AIzaSy-test', projectId: 'demo-shop' }))).message).toMatch(/web app's Firebase config/)
    expect(refusalOf(() => parseServiceAccount('x'.repeat(70 * 1024))).message).toMatch(/too large/)
  })

  it('refuses a key with a broken field, naming it', () => {
    const base = JSON.parse(SA.json)
    const variant = (patch: Record<string, unknown>) => JSON.stringify({ ...base, ...patch })
    expect(refusalOf(() => parseServiceAccount(variant({ project_id: '' }))).message).toMatch(/no valid project_id/)
    expect(refusalOf(() => parseServiceAccount(variant({ project_id: 'Bad/Project' }))).message).toMatch(/no valid project_id/)
    expect(refusalOf(() => parseServiceAccount(variant({ client_email: 'someone@example.com' }))).message).toMatch(/client_email isn't a service account/)
    expect(refusalOf(() => parseServiceAccount(variant({ private_key: undefined }))).message).toMatch(/no private_key/)
    const damaged = base.private_key.split('\n').map((line: string, i: number) => (i === 3 ? 'AAAA' : line)).join('\n')
    expect(refusalOf(() => parseServiceAccount(variant({ private_key: damaged }))).message).toMatch(/can't be read/)
    expect(refusalOf(() => parseServiceAccount(variant({ universe_domain: 'example.cloud' }))).message).toMatch(/universe/)
    const ec = generateKeyPairSync('ec', { namedCurve: 'P-256', privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } })
    expect(refusalOf(() => parseServiceAccount(variant({ private_key: ec.privateKey }))).message).toMatch(/isn't an RSA key/)
  })

  it('accepts a legacy domain-scoped project id', () => {
    const json = JSON.stringify({ ...JSON.parse(SA.json), project_id: 'example.com:legacy-app' })
    expect(parseServiceAccount(json).projectId).toBe('example.com:legacy-app')
  })
})

describe('minting tokens', () => {
  it('signs an RS256 assertion Google can verify, for one scope set, lasting an hour', () => {
    const sa = parseServiceAccount(SA.json)
    const jwt = signServiceAccountJwt(sa, GOOGLE_SCOPES.firestore, Date.UTC(2026, 10, 16, 9, 0, 0))
    const [h, p, s] = jwt.split('.')
    const dec = (x: string) => JSON.parse(Buffer.from(x.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'))
    expect(dec(h)).toEqual({ alg: 'RS256', typ: 'JWT', kid: 'k1a2b3c4d5' })
    const claims = dec(p)
    expect(claims).toEqual({
      iss: SA.clientEmail,
      scope: 'https://www.googleapis.com/auth/datastore',
      aud: GOOGLE_TOKEN_URL,
      iat: Date.UTC(2026, 10, 16, 9, 0, 0) / 1000,
      exp: Date.UTC(2026, 10, 16, 9, 0, 0) / 1000 + 3600,
    })
    const sig = Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
    expect(createVerify('RSA-SHA256').update(`${h}.${p}`).verify(SA.publicKeyPem, sig)).toBe(true)
  })

  it('exchanges it at oauth2.googleapis.com only, never at the key file token_uri', async () => {
    const google = new FakeGoogle(SA)
    const tokens = new GoogleTokenSource(parseServiceAccount(SA.json), { transport: google.transport, sleep: noSleep })
    const t = await tokens.token('firestore')
    expect(t).toBe('tok-1')
    expect(google.calls.map((c) => c.url)).toEqual(['https://oauth2.googleapis.com/token'])
    expect(google.calls[0].body).toMatch(/^grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=/)
    expect(google.scopesIssued).toEqual(['https://www.googleapis.com/auth/datastore'])
  })

  it('caches per scope set for the job, and renews five minutes before expiry', async () => {
    const google = new FakeGoogle(SA)
    let now = Date.UTC(2026, 10, 16, 9, 0, 0)
    const tokens = new GoogleTokenSource(parseServiceAccount(SA.json), { transport: google.transport, now: () => now, sleep: noSleep })
    expect(await tokens.token('firestore')).toBe('tok-1')
    expect(await tokens.token('firestore')).toBe('tok-1')
    expect(await tokens.token('storage')).toBe('tok-2')
    expect(google.scopesIssued[1]).toBe('https://www.googleapis.com/auth/devstorage.read_only')
    now += 50 * 60 * 1000 // 50 minutes: still more than 5 left of 3599 s
    expect(await tokens.token('firestore')).toBe('tok-1')
    now += 6 * 60 * 1000 // 56 minutes
    expect(await tokens.token('firestore')).toBe('tok-3')
    expect(await tokens.token('firestore', { force: true })).toBe('tok-4')
    expect(tokens.minted).toBe(4)
  })

  it('mints one token for concurrent first calls', async () => {
    const google = new FakeGoogle(SA)
    const tokens = new GoogleTokenSource(parseServiceAccount(SA.json), { transport: google.transport, sleep: noSleep })
    const all = await Promise.all([tokens.token('auth'), tokens.token('auth'), tokens.token('auth')])
    expect(new Set(all).size).toBe(1)
    expect(google.tokensIssued).toBe(1)
  })

  it('says, under the key field, when Google refuses the key', async () => {
    const google = new FakeGoogle(SA)
    // A key from another account: its signature does not verify.
    const stranger = makeServiceAccount('demo-shop')
    const tokens = new GoogleTokenSource(parseServiceAccount(stranger.json.replace(stranger.clientEmail, SA.clientEmail)), {
      transport: google.transport,
      sleep: noSleep,
    })
    const err = await tokens.token('firestore').catch((e) => e)
    expect(err).toBeInstanceOf(ImportInputError)
    expect(err.field).toBe('serviceAccountJson')
    expect(err.message).toBe("Google doesn't accept this key: it was deleted or replaced. Generate a new private key and paste it here.")

    google.tokenRefusal = { status: 400, body: { error: 'invalid_grant', error_description: 'Invalid grant: account not found' } }
    const gone = await new GoogleTokenSource(parseServiceAccount(SA.json), { transport: google.transport, sleep: noSleep }).token('firestore').catch((e) => e)
    expect(gone.message).toBe('This service account no longer exists. Generate a new private key and paste it here.')

    google.tokenRefusal = { status: 400, body: { error: 'invalid_grant', error_description: 'Service account is disabled.' } }
    const disabled = await new GoogleTokenSource(parseServiceAccount(SA.json), { transport: google.transport, sleep: noSleep }).token('firestore').catch((e) => e)
    expect(disabled.message).toMatch(/disabled in Google Cloud/)
  })

  it('retries the token endpoint when Google is briefly unavailable', async () => {
    const google = new FakeGoogle(SA)
    google.flaky.push({ match: /oauth2/, status: 503, times: 2 })
    const t = await new GoogleTokenSource(parseServiceAccount(SA.json), { transport: google.transport, sleep: noSleep }).token('firestore')
    expect(t).toBe('tok-1')
    expect(google.calls).toHaveLength(3)
  })
})

describe('calling Google', () => {
  function client(google: FakeGoogle, signal?: AbortSignal) {
    const tokens = new GoogleTokenSource(parseServiceAccount(SA.json), { transport: google.transport, sleep: noSleep, signal })
    return { tokens, client: new GoogleClient({ token: tokens.token, transport: google.transport, sleep: noSleep, signal }) }
  }

  it('calls only https Google API hosts', async () => {
    expect(() => assertGoogleUrl('https://firestore.googleapis.com/v1/projects/x')).not.toThrow()
    for (const bad of [
      'http://firestore.googleapis.com/v1/x',
      'https://firestore.googleapis.com.evil.example/v1/x',
      'https://metadata.google.internal/computeMetadata/v1/',
      'https://user:pw@storage.googleapis.com/storage/v1/b/x/o',
      'https://storage.googleapis.com:8443/storage/v1/b/x/o',
      'https://token.attacker.example/token',
    ]) {
      expect(() => assertGoogleUrl(bad)).toThrow(/only calls Google's APIs|malformed/)
    }
    const google = new FakeGoogle(SA)
    await expect(client(google).client.json('firestore', 'firestore', 'GET', 'https://evil.example/v1/x')).rejects.toThrow(/only calls Google's APIs/)
    expect(google.calls).toHaveLength(0)
  })

  it('sends the bearer token and retries what Google asks to be retried', async () => {
    const google = new FakeGoogle(SA)
    google.put('posts/a', { title: { stringValue: 'Hello' } })
    google.flaky.push({ match: /firestore/, status: 429, times: 1, headers: { 'retry-after': '0' } })
    google.flaky.push({ match: /firestore/, status: 503, times: 1 })
    const { client: c } = client(google)
    const res = await c.json<any>('firestore', 'firestore', 'GET', `https://firestore.googleapis.com/v1/${google.root}/posts?pageSize=10`)
    expect(res.documents[0].fields.title.stringValue).toBe('Hello')
    const firestoreCalls = google.calls.filter((x) => x.url.includes('firestore'))
    expect(firestoreCalls).toHaveLength(3)
    expect(firestoreCalls.every((x) => x.headers?.Authorization === 'Bearer tok-1')).toBe(true)
  })

  it('takes a fresh token once when Google answers 401', async () => {
    const google = new FakeGoogle(SA)
    google.put('posts/a', { title: { stringValue: 'Hello' } })
    let first = true
    const transport = async (req: any) => {
      if (first && req.url.includes('firestore')) {
        first = false
        return jsonResponse(401, rpcError(401, 'UNAUTHENTICATED', 'Request had invalid authentication credentials.'))
      }
      return google.transport(req)
    }
    const tokens = new GoogleTokenSource(parseServiceAccount(SA.json), { transport, sleep: noSleep })
    const c = new GoogleClient({ token: tokens.token, transport, sleep: noSleep })
    await c.json('firestore', 'firestore', 'GET', `https://firestore.googleapis.com/v1/${google.root}/posts`)
    expect(tokens.minted).toBe(2)
  })

  it('words a missing permission as the role to add, per API', async () => {
    const google = new FakeGoogle(SA)
    google.deny.add('firestore')
    const err = await client(google).client.json('firestore', 'firestore', 'GET', `https://firestore.googleapis.com/v1/${google.root}/posts`).catch((e) => e)
    expect(err).toBeInstanceOf(GoogleApiError)
    expect(err.permissionDenied).toBe(true)
    expect(err.message).toBe("This key can't read Firestore. Give the service account the Cloud Datastore Viewer role.")

    expect(plainGoogleError('auth', 403, 'PERMISSION_DENIED', '', 'denied')).toBe(
      "This key can't read Firebase Authentication. Give the service account the Firebase Authentication Admin role.",
    )
    expect(plainGoogleError('storage', 403, '', 'forbidden', 'x does not have storage.objects.list access')).toBe(
      "This key can't read Cloud Storage. Give the service account the Storage Object Viewer role.",
    )
    expect(plainGoogleError('firestore', 403, 'PERMISSION_DENIED', 'SERVICE_DISABLED', 'Cloud Firestore API has not been used')).toBe(
      "The Cloud Firestore API is turned off for this Firebase project, so Backenly can't read Firestore.",
    )
    expect(plainGoogleError('firestore', 503, 'UNAVAILABLE', '', '')).toBe('Google had a problem reading Firestore. Try again in a moment.')
  })

  it('reads both of Google error shapes, and OAuth errors', () => {
    expect(parseGoogleError(JSON.stringify(rpcError(403, 'PERMISSION_DENIED', 'nope', 'SERVICE_DISABLED')))).toEqual({
      code: 'PERMISSION_DENIED',
      reason: 'SERVICE_DISABLED',
      message: 'nope',
    })
    expect(parseGoogleError(JSON.stringify([{ error: { code: 400, status: 'INVALID_ARGUMENT', message: 'bad' } }]))).toEqual({
      code: 'INVALID_ARGUMENT',
      reason: '',
      message: 'bad',
    })
    expect(parseGoogleError(JSON.stringify({ error: { code: 403, message: 'm', errors: [{ reason: 'forbidden' }] } })).reason).toBe('forbidden')
    expect(parseGoogleError(JSON.stringify({ error: 'invalid_grant', error_description: 'Invalid JWT Signature.' }))).toEqual({
      code: 'invalid_grant',
      reason: 'invalid_grant',
      message: 'Invalid JWT Signature.',
    })
    expect(parseGoogleError('<html>502</html>')).toEqual({ code: '', reason: '', message: '' })
  })

  it('stops with ImportAborted when the job is canceled', async () => {
    const google = new FakeGoogle(SA)
    const controller = new AbortController()
    controller.abort()
    const err = await client(google, controller.signal).client.json('firestore', 'firestore', 'GET', `https://firestore.googleapis.com/v1/${google.root}/posts`).catch((e) => e)
    expect(err).toBeInstanceOf(ImportAborted)
    expect(google.calls).toHaveLength(0)
  })
})
