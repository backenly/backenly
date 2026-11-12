/**
 * postgrestErrorBody: a v2 error body in PostgREST's shape,
 * { code, message, details, hint }. server/lib/v2-error-shape.ts.
 */
import { postgrestErrorBody } from '@/server/lib/v2-error-shape'

it("turns v1's flat envelope into PostgREST's shape", () => {
  expect(postgrestErrorBody(404, { error: 'Resource "users" not found', code: 'NOT_FOUND' }))
    .toEqual({ code: 'NOT_FOUND', message: 'Resource "users" not found', details: null, hint: null })
})

it("turns v1's nested envelope into PostgREST's shape, keeping its details", () => {
  const paused = { success: false, error: { code: 'PROJECT_PAUSED', message: 'This project is paused.', details: { reason: 'inactivity' } } }
  expect(postgrestErrorBody(503, paused))
    .toEqual({ code: 'PROJECT_PAUSED', message: 'This project is paused.', details: { reason: 'inactivity' }, hint: null })
})

it('leaves a PostgREST error as it is', () => {
  const pgrst = { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned', details: 'The result contains 0 rows', hint: null }
  expect(postgrestErrorBody(406, pgrst)).toEqual(pgrst)
})

it('keeps the other fields a refusal carries', () => {
  const permission = { code: 'INSUFFICIENT_KEY_PERMISSIONS', error: "This API key does not have 'write' permission.", required: 'write', permissions: ['read'], hint: 'Use a key with write access.' }
  expect(postgrestErrorBody(403, permission)).toEqual({
    code: 'INSUFFICIENT_KEY_PERMISSIONS',
    message: "This API key does not have 'write' permission.",
    details: null,
    hint: 'Use a key with write access.',
    required: 'write',
    permissions: ['read'],
  })
})

it('names the status when the refusal named no code', () => {
  expect(postgrestErrorBody(413, { error: 'The request body could not be read.' }))
    .toMatchObject({ code: 'PAYLOAD_TOO_LARGE', message: 'The request body could not be read.' })
  expect(postgrestErrorBody(418, { error: 'teapot' })).toMatchObject({ code: 'HTTP_418' })
})

it('never touches a success, a list or a non-object', () => {
  const rows = [{ id: 1 }]
  expect(postgrestErrorBody(200, rows)).toBe(rows)
  const created = { id: 1, error: 'a column that happens to be called error' }
  expect(postgrestErrorBody(201, created)).toBe(created)
  expect(postgrestErrorBody(500, 'plain text')).toBe('plain text')
  expect(postgrestErrorBody(500, [1, 2])).toEqual([1, 2])
})
