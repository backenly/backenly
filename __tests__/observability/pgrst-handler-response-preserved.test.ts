/**
 * The PGRST303 diagnostic sits inside the data-plane error path, so its
 * correctness is not only "does it log" but "does the response reaching the
 * caller stay byte-identical". These tests drive the real handler against a
 * stubbed PostgREST that returns PGRST303 and assert the response contract is
 * untouched — including when the diagnostic itself fails.
 */
import type { Request, Response } from 'express'

jest.mock('@/lib/postgrest/exposure', () => ({
  checkExposure: jest.fn(async () => ({ allowed: true })),
  operationFor: jest.requireActual('@/lib/postgrest/exposure').operationFor,
  tableHasSoftDelete: jest.fn(async () => false),
}))
jest.mock('@/lib/postgrest/registration', () => ({ ensureSchemaRegistered: jest.fn(async () => {}) }))

const logSpy = jest.fn()
jest.mock('@/lib/observability/pgrst-clock-diagnostic', () => {
  const actual = jest.requireActual('@/lib/observability/pgrst-clock-diagnostic')
  return { ...actual, logPgrstClockDiagnostic: (...a: unknown[]) => logSpy(...a) }
})

const PGRST303_BODY = JSON.stringify({
  code: 'PGRST303', details: null, hint: null, message: 'JWT issued at future',
})

function mockRes() {
  const headers: Record<string, string> = {}
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    setHeader: (k: string, v: string) => { headers[k.toLowerCase()] = v },
    status(code: number) { this.statusCode = code; return this },
    json(payload: unknown) { this.body = payload; return this },
  }
  return { res: res as unknown as Response & typeof res, headers }
}

function mockReq(remoteAddress = '127.0.0.1'): Request {
  return {
    method: 'GET', query: {}, headers: {}, body: undefined,
    socket: { remoteAddress },
  } as unknown as Request
}

/** Run the handler against a PostgREST stub that always answers `status`/`body`. */
async function run(status: number, body: string, remoteAddress = '127.0.0.1') {
  jest.resetModules()
  process.env.POSTGREST_URL = 'http://postgrest.invalid'
  process.env.POSTGREST_JWT_SECRET = 'test-secret-not-a-real-key'

  global.fetch = jest.fn(async () => ({
    ok: status < 400,
    status,
    headers: new Headers({ 'content-range': '0-0/0' }),
    text: async () => body,
  })) as unknown as typeof fetch

  const { handleViaPostgrest } = await import('@/server/routes/postgrest-handler')
  const { res, headers } = mockRes()
  const handled = await handleViaPostgrest(mockReq(remoteAddress), res, ['widgets'], {
    projectId: '11111111-2222-3333-4444-555555555555',
    isServiceRole: true,
  })
  return { handled, res, headers }
}

describe('PGRST303 diagnostic preserves the response contract', () => {
  beforeEach(() => { logSpy.mockReset(); logSpy.mockImplementation(() => null) })

  it('runs the diagnostic when PostgREST reports PGRST303', async () => {
    await run(401, PGRST303_BODY)
    expect(logSpy).toHaveBeenCalledTimes(1)
    const arg = logSpy.mock.calls[0][0] as Record<string, unknown>
    expect(arg).toMatchObject({ table: 'widgets' })
    expect(arg.timing).toBeDefined()
    // The handler passes timing integers, never a token.
    expect(Object.keys(arg)).not.toContain('internalToken')
  })

  it('leaves the mapped status and body contract unchanged', async () => {
    const withDiag = await run(401, PGRST303_BODY)

    // Same upstream response, but with the diagnostic throwing internally.
    logSpy.mockImplementation(() => { throw new Error('diagnostic exploded') })
    const withBrokenDiag = await run(401, PGRST303_BODY)

    // requestId is a fresh uuid per request by design, so it is compared for
    // presence and shape rather than equality; everything else must match.
    const strip = (b: unknown) => {
      const { requestId, ...rest } = (b ?? {}) as Record<string, unknown>
      return { rest, requestId }
    }
    const a = strip(withDiag.res.body)
    const b = strip(withBrokenDiag.res.body)

    expect(withDiag.res.statusCode).toBeGreaterThanOrEqual(400)
    expect(withBrokenDiag.res.statusCode).toBe(withDiag.res.statusCode)
    expect(b.rest).toEqual(a.rest)
    expect(typeof b.requestId).toBe(typeof a.requestId)
    expect(withBrokenDiag.handled).toBe(withDiag.handled)
  })

  it('keeps the request-id and layer headers', async () => {
    const { headers } = await run(401, PGRST303_BODY)
    const names = Object.keys(headers)
    expect(names.some(n => n.includes('request-id'))).toBe(true)
    expect(names.some(n => n.includes('layer'))).toBe(true)
  })

  it('never returns JWT timing to the caller', async () => {
    const { res } = await run(401, PGRST303_BODY)
    const serialized = JSON.stringify(res.body)
    for (const leak of ['iat', 'exp', 'iatMinusNowS', 'tokenAgeS', 'nowEpochS', 'pgrst303_clock']) {
      expect(serialized).not.toContain(leak)
    }
  })

  it('stays silent for a non-PGRST303 upstream error', async () => {
    await run(404, JSON.stringify({ code: 'PGRST205', message: 'table not found' }))
    expect(logSpy).not.toHaveBeenCalled()
  })

  it('stays silent on a successful request', async () => {
    await run(200, JSON.stringify([{ id: 1 }]))
    expect(logSpy).not.toHaveBeenCalled()
  })
})
