/**
 * The SDK sends the project key on sign-up and sign-in.
 *
 * The end-user auth routes resolve the project's environment from the key, so
 * a sign-up with no `x-api-key` is refused. @backenly/sdk 0.3.1, the version on
 * npm since 2026-07-26, sent none on auth.signUp and auth.signIn: they skip the
 * client's auth headers (an end-user token must not ride along), and the key
 * went with them. Apps fell back to raw fetch. The source was fixed on
 * 2026-10-04 (keyHeaders) and never released; this pins it so the release
 * carries it.
 *
 * Runs the SDK itself against a stand-in fetch that records what it was sent.
 */

import '@/tests/helpers/real-web-standard'

import { BackenlyClient } from '@backenly/sdk'

const PROJECT = '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b'
const API = 'https://backenly.test'
const KEY = 'proj_live_auth_key_test_not_a_real_key'
const SESSION = 'header.payload.signature'

interface Sent {
  path: string
  headers: Record<string, string>
}

let sent: Sent[] = []
const realFetch = globalThis.fetch

beforeEach(() => {
  sent = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {}
    new Headers(init?.headers).forEach((value, name) => { headers[name] = value })
    sent.push({ path: new URL(String(input)).pathname.replace(`/api/v1/${PROJECT}`, ''), headers })
    return new Response(JSON.stringify({ data: { token: SESSION, user: { id: 'u1', email: 'a@example.test' } } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
})

afterAll(() => {
  globalThis.fetch = realFetch
})

const client = () => new BackenlyClient({ projectId: PROJECT, apiKey: KEY, apiUrl: API })

describe('auth sends the project key', () => {
  it('on signUp, and no end-user token', async () => {
    const backend = client()
    await backend.auth.signUp({ email: 'a@example.test', password: 'Password-123' })
    expect(sent).toHaveLength(1)
    expect(sent[0].path).toBe('/auth/signup')
    expect(sent[0].headers['x-api-key']).toBe(KEY)
    expect(sent[0].headers['authorization']).toBeUndefined()
  })

  it('on signIn, even when a session is already held', async () => {
    const backend = client()
    await backend.auth.signIn({ email: 'a@example.test', password: 'Password-123' })
    await backend.auth.signIn({ email: 'a@example.test', password: 'Password-123' })
    expect(sent.map((s) => s.path)).toEqual(['/auth/signin', '/auth/signin'])
    for (const request of sent) {
      expect(request.headers['x-api-key']).toBe(KEY)
      expect(request.headers['x-user-token']).toBeUndefined()
    }
  })
})
