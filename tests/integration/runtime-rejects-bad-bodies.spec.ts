/**
 * A BODY THE RUNTIME CANNOT READ IS THE CALLER'S, NOT A SERVER ERROR
 * ==================================================================
 *
 * Found by fuzzing a project's data API against its own OpenAPI document
 * (Schemathesis): a POST to /db/<table> whose body was not valid JSON reached
 * the global error handler as body-parser's SyntaxError and was answered
 *
 *   500 {"error":"Internal server error","code":"INTERNAL_ERROR"}
 *
 * so one client's typo counted as the platform failing, in the response and in
 * every error rate that reads it. body-parser marks the error as the caller's
 * (its own 4xx status, `expose`); the handler now answers with that.
 *
 * The real Express app on an ephemeral port: what is under test is what the
 * parser and the global handler do together.
 */
import http from 'http'
import { randomUUID } from 'crypto'
import type { AddressInfo } from 'net'
import app from '@/server/app'

let server: http.Server
let base: string

beforeAll(async () => {
  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

const post = (body: string) =>
  fetch(`${base}/api/v1/${randomUUID()}/db/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'not-a-real-key' },
    body,
  })

describe('a body that is not valid JSON', () => {
  it('is answered 400 with the shape every other v1 error has', async () => {
    const res = await post('{not json')
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'The request body is not valid JSON.', code: 'BAD_REQUEST' })
  })

  it('is answered 400 for bytes that are not text at all', async () => {
    const res = await post('\u0000ÿþ8R')
    expect(res.status).toBe(400)
  })

  it('still reaches the route when it is valid (the control)', async () => {
    const res = await post('{"status":"pending"}')
    // Past the parser: refused by the route for its credentials, never a 500.
    expect(res.status).not.toBe(400)
    expect(res.status).toBeLessThan(500)
  })
})
