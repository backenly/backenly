/**
 * What a client, an agent and an exporting owner see of a paused project.
 *
 * Database-free: export links, the storage access decision they feed, the
 * paused-response contract, the SDK's reconnect rule and the MCP client's retry
 * rule. The server behaviour behind them (the gate, the clock, the download
 * route) is covered against real Postgres in tests/integration.
 */
import http from 'http'
import type { AddressInfo } from 'net'

import { isExportToken, signExportToken, verifyExportToken } from '@/lib/storage/export-token'
import { mayRead } from '@/lib/storage/access-policy'
import { pausedDetails } from '@/lib/projects/serving-state'
import { RealtimeModule } from '@/packages/sdk/src/realtime'
import { BackenlyClient } from '@/packages/mcp-server/src/http'

const SECRET = 'export-token-test-secret-at-least-32-chars'
const FILE = '0c7b5f3e-1f1d-4d0e-9b5f-6a2f3f9d1c11'

describe('export links', () => {
  it('verify for exactly the file they were minted for, until they expire', () => {
    const now = 1_700_000_000_000
    const token = signExportToken(FILE, 3600, SECRET, now)

    expect(isExportToken(token)).toBe(true)
    expect(verifyExportToken(FILE, token, SECRET, now + 1000)).toBe(true)
    expect(verifyExportToken('another-file', token, SECRET, now + 1000)).toBe(false)
    expect(verifyExportToken(FILE, token, SECRET, now + 3600_001)).toBe(false)
    expect(verifyExportToken(FILE, token, 'a-different-secret-entirely-000000', now)).toBe(false)
    expect(verifyExportToken(FILE, token.slice(0, -1) + '0', SECRET, now)).toBe(false)
  })

  it('cannot be forged from an ordinary signed link, which is a different HMAC domain', () => {
    // The ordinary format: `<expires>:<hmac(fileId:expires)>`. Prefixing it
    // with `x.` must not turn it into an export link.
    const expires = Date.now() + 60_000
    const crypto = require('crypto') as typeof import('crypto')
    const ordinary = `${expires}:${crypto.createHmac('sha256', SECRET).update(`${FILE}:${expires}`).digest('hex')}`

    expect(isExportToken(ordinary)).toBe(false)
    expect(verifyExportToken(FILE, `x.${ordinary}`, SECRET)).toBe(false)
  })
})

describe('what an export link may read', () => {
  const object = (bucketPolicy: string) => ({ bucketPolicy, fileIsPublic: false, uploadedBy: 'someone-else' })

  it.each(['private', 'owner_only', 'public_read'])('reads a %s object, on the administrator’s authority', policy => {
    expect(mayRead(object(policy), { kind: 'signed', purpose: 'export' }).allowed).toBe(true)
  })

  it('does not widen an ORDINARY signed link, which owner_only still refuses', () => {
    expect(mayRead(object('owner_only'), { kind: 'signed' }).allowed).toBe(false)
  })
})

describe('the paused response', () => {
  const pausedAt = new Date('2026-09-10T08:00:00.000Z')
  const before = process.env.NEXT_PUBLIC_APP_URL
  afterEach(() => {
    if (before === undefined) delete process.env.NEXT_PUBLIC_APP_URL
    else process.env.NEXT_PUBLIC_APP_URL = before
  })

  it('carries the hint and fixUrl the SDK already turns into a console banner', () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.test/'
    const d = pausedDetails('p1', { pausedAt, reason: 'inactivity' })
    expect(d.resumeUrl).toBe('https://app.example.test/app/projects/p1')
    expect(d.fixUrl).toBe(d.resumeUrl)
    expect(d.hint).toMatch(/paused/i)
  })

  it('never guesses a host it was not given', () => {
    delete process.env.NEXT_PUBLIC_APP_URL
    const d = pausedDetails('p1', { pausedAt, reason: 'inactivity' })
    expect(d.resumeUrl).toBeNull()
    expect(d.fixUrl).toBeNull()
    expect(d.resumePath).toBe('/app/projects/p1')
  })
})

describe('the SDK stops reconnecting to a project a person has to act on', () => {
  const realtime = new RealtimeModule({} as any) as any
  it.each(['PROJECT_PAUSED', 'PROJECT_LOCKED', 'PLAN_LIMIT_EXCEEDED'])('%s is fatal', code => {
    expect(realtime._isFatalError({ type: 'error', message: '', code })).toBe(true)
  })
  it('a transient error is not', () => {
    expect(realtime._isFatalError({ type: 'error', message: 'socket closed' })).toBe(false)
  })
})

describe('the MCP client does not retry a paused project', () => {
  let server: http.Server
  let hits = 0
  let body: Record<string, unknown> = {}

  beforeAll(async () => {
    server = http.createServer((_req, res) => {
      hits++
      res.writeHead(503, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    })
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  })
  afterAll(async () => {
    server.closeAllConnections()
    await new Promise<void>(r => server.close(() => r()))
  })

  function client() {
    const port = (server.address() as AddressInfo).port
    return new BackenlyClient({ apiKey: 'bk_test', endpoint: `http://127.0.0.1:${port}` })
  }

  it('answers once, with the code and where to resume', async () => {
    hits = 0
    body = {
      ok: false,
      code: 'PROJECT_PAUSED',
      error: 'This project is paused.',
      resumeUrl: 'https://app.example.test/app/projects/p1',
    }
    const err = await client().dbQuery({ table: 't' }).catch(e => e)

    expect(hits).toBe(1)
    expect(err.code).toBe('PROJECT_PAUSED')
    expect(err.message).toContain('https://app.example.test/app/projects/p1')
  }, 30_000)

  it('still retries an ordinary 503, so the rule above is not vacuous', async () => {
    hits = 0
    body = { ok: false, error: 'Service unavailable' }
    await client().dbQuery({ table: 't' }).catch(() => {})
    expect(hits).toBe(3)
  }, 30_000)
})
