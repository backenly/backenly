/**
 * Express middleware for /api/v1: every res.json error body leaves with a
 * top-level `code` and `message` (lib/api/v1/error-shape.ts). Mounted before
 * every gate, so their refusals are covered too. The Next-owned v1 sections
 * the runtime forwards are shaped by Next itself (lib/traffic/recorded-v1.ts).
 *
 * Except a reply a project's function wrote (/fn/{name}): its status and body
 * are the app's own, answered as written (lib/services/ai-functions/reply.ts),
 * and a 400 the function chose is not one of Backenly's errors. The route marks
 * it with markAsWritten.
 */

import type { NextFunction, Request, Response } from 'express'
import { v1ErrorBody } from '@/lib/api/v1/error-shape'

/** This response is a function's own reply, sent as it wrote it. */
export function markAsWritten(res: Response): Response {
  res.locals.v1AsWritten = true
  return res
}

export function v1ErrorShape(_req: Request, res: Response, next: NextFunction): void {
  const json = res.json.bind(res)
  res.json = ((body?: unknown) =>
    json(res.locals.v1AsWritten === true ? body : v1ErrorBody(res.statusCode, body))) as Response['json']
  next()
}
