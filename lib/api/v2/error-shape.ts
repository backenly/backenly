/**
 * Errors from /api/v2 in PostgREST's own shape: { code, message, details, hint }.
 *
 * v2 exists so that someone fluent in PostgREST is fluent here. Applied by the
 * runtime to every JSON error on /api/v2 (server/lib/v2-error-shape.ts), and by
 * Next to the v2 errors it writes itself: the body-size limit in middleware.ts
 * and the refusals and forwarding errors of recordedV1
 * (lib/traffic/recorded-v1.ts). No imports, so the edge middleware can use it.
 *
 * `error` becomes `message`, `success` goes, `details` and `hint` are always
 * there (null when there is nothing to say), and any other field the refusal
 * carried (a key's `required` permission, a region's address) is kept. A
 * PostgREST error comes out as it went in. Successes are never touched.
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
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** An error body as PostgREST would answer it. Anything that is not an error body comes back unchanged. */
export function postgrestErrorBody(status: number, body: unknown): unknown {
  if (status < 400 || !isRecord(body)) return body
  const { success: _success, error, ...rest } = body
  const nested = isRecord(error) ? error : null
  const { code: nestedCode, message: nestedMessage, details: nestedDetails, hint: nestedHint, ...nestedRest } = nested ?? {}
  const code = nestedCode ?? rest.code ?? CODE_FOR_STATUS[status] ?? `HTTP_${status}`
  const message = nestedMessage ?? (typeof error === 'string' ? error : undefined) ?? rest.message ?? 'The request failed.'
  return {
    ...rest,
    ...nestedRest,
    code: String(code),
    message: String(message),
    details: nestedDetails ?? rest.details ?? null,
    hint: nestedHint ?? rest.hint ?? null,
  }
}
