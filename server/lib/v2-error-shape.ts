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
import { postgrestErrorBody } from '@/lib/api/v2/error-shape'

export { postgrestErrorBody }

/** Express middleware for /api/v2: every res.json error body leaves in PostgREST's shape. */
export function postgrestErrorShape(_req: Request, res: Response, next: NextFunction): void {
  const json = res.json.bind(res)
  res.json = ((body?: unknown) => json(postgrestErrorBody(res.statusCode, body))) as Response['json']
  next()
}
