/**
 * Every v1 error body carries a top-level `code` and `message`
 * (lib/api/v1/error-shape.ts). Production QA 2026-11-09, report 16, counted
 * four envelopes; a client had to try each one to learn what went wrong. They
 * are added beside what each body already says, never moved or removed.
 */
import { v1ErrorBody } from '@/lib/api/v1/error-shape'

describe('the four envelopes QA found', () => {
  it('{ error: { code, message } } gains its code and message at the top', () => {
    const body = { error: { code: 'VALIDATION_ERROR', message: 'Password must be at least 8 characters.', details: { fields: {} } } }
    expect(v1ErrorBody(400, body)).toEqual({ ...body, code: 'VALIDATION_ERROR', message: 'Password must be at least 8 characters.' })
  })

  it('{ error, code, requestId, layer, diagnosis } gains its message', () => {
    const body = { error: 'Record not found', code: 'NOT_FOUND', requestId: 'r1', layer: 'database', diagnosis: 'x' }
    expect(v1ErrorBody(404, body)).toEqual({ ...body, message: 'Record not found' })
  })

  it('{ error, code } gains its message', () => {
    expect(v1ErrorBody(401, { error: 'An API key is required.', code: 'API_KEY_REQUIRED' }))
      .toEqual({ error: 'An API key is required.', code: 'API_KEY_REQUIRED', message: 'An API key is required.' })
  })

  it('{ success: false, error, code } gains its message, and keeps success', () => {
    expect(v1ErrorBody(421, { success: false, error: 'Served only in us-east-1.', code: 'WRONG_REGION' }))
      .toEqual({ success: false, error: 'Served only in us-east-1.', code: 'WRONG_REGION', message: 'Served only in us-east-1.' })
  })
})

describe('what it leaves alone', () => {
  it('a body that already has both, exactly as it is', () => {
    const body = { code: 'PGRST116', message: 'no rows', details: null, hint: null }
    expect(v1ErrorBody(406, body)).toBe(body)
  })

  it('a code or message already there, even one it would have chosen differently', () => {
    expect(v1ErrorBody(404, { error: { code: 'NESTED', message: 'nested' }, code: 'TOP' }))
      .toEqual({ error: { code: 'NESTED', message: 'nested' }, code: 'TOP', message: 'nested' })
  })

  it('successes, and anything that is not an object', () => {
    const ok = { data: [] }
    expect(v1ErrorBody(200, ok)).toBe(ok)
    expect(v1ErrorBody(500, 'plain text')).toBe('plain text')
    expect(v1ErrorBody(500, [1, 2])).toEqual([1, 2])
    expect(v1ErrorBody(500, null)).toBeNull()
  })

  it('names the status when the body names nothing', () => {
    expect(v1ErrorBody(429, {})).toEqual({ code: 'RATE_LIMIT_EXCEEDED', message: 'The request failed.' })
    expect(v1ErrorBody(418, {})).toEqual({ code: 'HTTP_418', message: 'The request failed.' })
  })
})
