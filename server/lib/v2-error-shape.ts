/**
 * Errors from /api/v2 in PostgREST's own shape.
 *
 * v2 exists so that someone fluent in PostgREST is fluent here, and PostgREST
 * answers an error as { code, message, details, hint }. v2's own refusals
 * mostly did, but the doors it shares with v1 did not: the region and serving
 * gates, the key's method permission, the exposure check, a body the parser
 * could not read, a server error. Those answered in v1's envelope,
 * { success: false, error, code } or { error: { code, message } }, so one v2
 * client could not read every v2 error the same way. Production QA
 * (2026-11-09) counted four envelopes across the APIs.
 *
 * Every JSON error body on a v2 response is put in PostgREST's shape on the way
 * out: `error` becomes `message`, `success` goes, `details` and `hint` are
 * always there (null when there is nothing to say), and any other field the
 * refusal carried (a key's `required` permission, a region's address) is kept.
 * A PostgREST error comes out as it went in. Successes are never touched, and
 * nothing outside /api/v2 is.
 */

import type { NextFunction, Request, Response } from 'express'

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

/** Express middleware for /api/v2: every res.json error body leaves in PostgREST's shape. */
export function postgrestErrorShape(_req: Request, res: Response, next: NextFunction): void {
  const json = res.json.bind(res)
  res.json = ((body?: unknown) => json(postgrestErrorBody(res.statusCode, body))) as Response['json']
  next()
}
