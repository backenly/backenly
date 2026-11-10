/**
 * Every v1 error body carries a top-level `code` and `message`.
 *
 * Production QA (2026-11-09, report 16) counted four error envelopes across the
 * APIs, and a client had to try each one to learn what went wrong:
 *
 *   { error: { code, message } }                    auth, database, most Next routes
 *   { error, code, requestId, layer, diagnosis }    /db
 *   { error, code }                                 the gates, a body that would not parse
 *   { success: false, error, code }                 older routes
 *
 * v2 answers in PostgREST's shape (server/lib/v2-error-shape.ts). v1 is a
 * contract apps already read, so nothing is moved or removed here: `code` and
 * `message` are added beside whatever the body already says, taken from it,
 * and a body that already has them is left exactly as it is. So a client can
 * always read `body.code` and `body.message`, and one that read
 * `body.error.message` or `body.error` still can.
 *
 * Applied once per server, to every JSON error on /api/v1: the runtime's
 * res.json (server/lib/v1-error-shape.ts) and Next's recordedV1
 * (lib/traffic/recorded-v1.ts). No imports, so both can use it.
 */

const CODE_FOR_STATUS: Record<number, string> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  405: 'METHOD_NOT_ALLOWED',
  409: 'CONFLICT',
  413: 'PAYLOAD_TOO_LARGE',
  421: 'WRONG_REGION',
  429: 'RATE_LIMIT_EXCEEDED',
  500: 'INTERNAL_ERROR',
  502: 'UPSTREAM_UNAVAILABLE',
  503: 'SERVICE_UNAVAILABLE',
  504: 'UPSTREAM_TIMEOUT',
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

const text = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined)

/** An error body with a top-level `code` and `message`. Anything that is not an error body comes back unchanged. */
export function v1ErrorBody(status: number, body: unknown): unknown {
  if (status < 400 || !isRecord(body)) return body
  const hasCode = body.code !== undefined && body.code !== null
  const hasMessage = body.message !== undefined && body.message !== null
  if (hasCode && hasMessage) return body
  const nested = isRecord(body.error) ? body.error : null
  return {
    ...body,
    ...(hasCode ? {} : { code: text(nested?.code) ?? CODE_FOR_STATUS[status] ?? `HTTP_${status}` }),
    ...(hasMessage ? {} : { message: text(nested?.message) ?? text(body.error) ?? 'The request failed.' }),
  }
}
