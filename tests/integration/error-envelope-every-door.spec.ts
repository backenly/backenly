/**
 * Every error an app can get from Backenly's API carries a top-level `code` and
 * `message`, and /api/v2 answers in PostgREST's shape: { code, message,
 * details, hint }.
 *
 * Production QA re-test, 2026-11-16, #16: a v1 413 was { error: { code,
 * message } } with no top-level code; a v2 413 was { success: false, code,
 * message }; the v2 route's own refusals came back in v1's shape; and a stored
 * file's public address answered { error } alone. Those are the errors Next
 * writes itself, before or around the runtime, whose own errors were already
 * shaped.
 *
 * One error per door, from the code that answers it: Next's middleware, the
 * Next v1 and v2 routes, a stored file's address, and the runtime (served in
 * this process) for v1, v2, end-user auth and functions.
 */
import '../helpers/real-web-standard'

// `jose` ships ESM-only and jest cannot parse it; no token is verified on the
// paths under test (the data API authenticates by key, after the middleware).
jest.mock('jose', () => ({ jwtVerify: jest.fn(async () => ({ payload: {} })) }))

import http from 'http'
import type { AddressInfo } from 'net'
import { randomUUID } from 'crypto'
import { NextRequest } from 'next/server'
import { middleware } from '@/middleware'
import { GET as v1Route } from '@/app/api/v1/[projectId]/[...unmatched]/route'
import { GET as v2Route } from '@/app/api/v2/[projectId]/[[...path]]/route'
import { GET as fileRoute } from '@/app/api/storage/files/[fileId]/download/route'
import app from '@/server/app'

let server: http.Server
let runtime = ''
const originalRuntimeUrl = process.env.RUNTIME_API_URL

beforeAll(async () => {
  // Next answers v1 and v2 itself when no separate runtime is configured.
  delete process.env.RUNTIME_API_URL
  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  runtime = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  if (originalRuntimeUrl === undefined) delete process.env.RUNTIME_API_URL
  else process.env.RUNTIME_API_URL = originalRuntimeUrl
})

type Answer = { status: number; body: any }

const read = async (res: Response | null | undefined): Promise<Answer> => ({
  status: res!.status,
  body: await res!.json(),
})

const tooLarge = { 'content-type': 'application/json', 'content-length': String(11 * 1024 * 1024) }
const projectId = randomUUID()

/** Every v1 error: a top-level code and message, whatever else it carries. */
function inV1Shape({ body }: Answer): void {
  expect(typeof body.code).toBe('string')
  expect(typeof body.message).toBe('string')
  expect(body.code.length).toBeGreaterThan(0)
  expect(body.message.length).toBeGreaterThan(0)
}

/** Every v2 error: PostgREST's { code, message, details, hint }, and nothing of v1's envelope. */
function inPostgrestShape(answer: Answer): void {
  inV1Shape(answer)
  expect(answer.body).toHaveProperty('details')
  expect(answer.body).toHaveProperty('hint')
  expect(answer.body).not.toHaveProperty('error')
  expect(answer.body).not.toHaveProperty('success')
}

describe("Next's middleware", () => {
  it('a v1 body over the limit: 413 with a top-level code and message, and the nested error kept', async () => {
    const answer = await read(await middleware(new NextRequest(`https://backenly.test/api/v1/${projectId}/db/products`, { method: 'POST', headers: tooLarge })))
    expect(answer.status).toBe(413)
    inV1Shape(answer)
    expect(answer.body).toMatchObject({
      code: 'PAYLOAD_TOO_LARGE',
      message: 'Request body is larger than the 10 MB this endpoint accepts.',
      error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body is larger than the 10 MB this endpoint accepts.' },
    })
  })

  it("a v2 body over the limit: 413 in PostgREST's shape", async () => {
    const answer = await read(await middleware(new NextRequest(`https://backenly.test/api/v2/${projectId}/products`, { method: 'POST', headers: tooLarge })))
    expect(answer.status).toBe(413)
    inPostgrestShape(answer)
    expect(answer.body).toEqual({
      code: 'PAYLOAD_TOO_LARGE',
      message: 'Request body is larger than the 10 MB this endpoint accepts.',
      details: null,
      hint: null,
    })
  })
})

describe('the Next routes', () => {
  it("a v2 error Next writes is in PostgREST's shape", async () => {
    const answer = await read(await v2Route(new NextRequest(`https://backenly.test/api/v2/${projectId}/products`), {
      params: Promise.resolve({ projectId, path: ['products'] }),
    }))
    expect(answer.status).toBe(404)
    inPostgrestShape(answer)
  })

  it('CONTROL: a v1 error Next writes keeps v1 shape', async () => {
    const answer = await read(await v1Route(new NextRequest(`https://backenly.test/api/v1/${projectId}/nothing-here`), {
      params: Promise.resolve({ projectId, unmatched: ['nothing-here'] }),
    }))
    expect(answer.status).toBe(404)
    inV1Shape(answer)
  })

  it("a stored file's public address answers a missing file with a code and message", async () => {
    const fileId = randomUUID()
    const answer = await read(await fileRoute(new NextRequest(`https://backenly.test/api/storage/files/${fileId}/download`), {
      params: Promise.resolve({ fileId }),
    }))
    expect(answer.status).toBe(404)
    inV1Shape(answer)
    expect(answer.body).toMatchObject({ error: 'File not found', code: 'NOT_FOUND', message: 'File not found' })
  }, 60_000)
})

describe('CONTROL: the runtime', () => {
  const big = JSON.stringify([{ note: 'x'.repeat(11 * 1024 * 1024) }])
  const post = (path: string) =>
    fetch(`${runtime}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'not-checked-before-the-body' }, body: big })

  it('a v1 body over the limit', async () => {
    const answer = await read(await post(`/api/v1/${projectId}/db/products`))
    expect(answer.status).toBe(413)
    inV1Shape(answer)
  }, 60_000)

  it('a v2 body over the limit', async () => {
    const answer = await read(await post(`/api/v2/${projectId}/products`))
    expect(answer.status).toBe(413)
    inPostgrestShape(answer)
  }, 60_000)

  it('an end-user auth path that does not exist', async () => {
    const answer = await read(await fetch(`${runtime}/api/v1/${projectId}/auth/nothing-here`))
    expect(answer.status).toBe(404)
    inV1Shape(answer)
  }, 60_000)

  it('a function call without a key', async () => {
    const answer = await read(await fetch(`${runtime}/api/v1/${projectId}/fn/nothing-here`, { method: 'POST' }))
    expect(answer.status).toBeGreaterThanOrEqual(400)
    inV1Shape(answer)
  }, 60_000)
})
