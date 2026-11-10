/**
 * The runtime says when a body is over its size limit, and names the limit.
 *
 * Production QA (2026-11-09) filed "400 where 413 would be right" against
 * /api/v2. The runtime does answer 413 for a body over its JSON limit
 * (express.json, 10 MB), but its error handler gave it the code BAD_REQUEST
 * and the sentence "The request body could not be read.", which is what a
 * malformed body gets: a caller could not tell a batch that was too big from
 * one that was broken. The web tier's own limit (middleware.ts) already
 * answers PAYLOAD_TOO_LARGE with the size; the runtime now says the same.
 */
import http from 'http'
import type { AddressInfo } from 'net'
import { randomUUID } from 'crypto'
import app from '@/server/app'

let server: http.Server
let base = ''

beforeAll(async () => {
  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

const post = (body: string) =>
  fetch(`${base}/api/v2/${randomUUID()}/products`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'not-checked-before-the-body' },
    body,
  })

describe('a body the runtime will not read', () => {
  it('over the limit is 413 PAYLOAD_TOO_LARGE, and names the limit', async () => {
    const res = await post(JSON.stringify([{ note: 'x'.repeat(11 * 1024 * 1024) }]))
    expect(res.status).toBe(413)
    expect(await res.json()).toEqual({
      error: 'Request body is larger than the 10 MB this endpoint accepts.',
      code: 'PAYLOAD_TOO_LARGE',
    })
  }, 60_000)

  it('that is not JSON is still 400 BAD_REQUEST, saying so', async () => {
    const res = await post('{"note": ')
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'The request body is not valid JSON.', code: 'BAD_REQUEST' })
  }, 60_000)
})
