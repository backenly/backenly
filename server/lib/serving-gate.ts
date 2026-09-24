/**
 * The runtime's serving gate: one check in front of every project route.
 *
 * Mounted in server/app.ts ahead of the Next proxy and every router, on both
 * `/api/v1/:projectId` and `/api/v2/:projectId`. It runs BEFORE authentication
 * on purpose: a sealed project answers the same way whatever credential is
 * presented, and the check must not depend on which of the runtime's several
 * auth paths a request happens to take. See lib/projects/serving-state.ts for
 * why the question lives here rather than in each router.
 *
 * A project that does not exist is passed through untouched, so every route
 * keeps answering its own 404 exactly as before.
 */
import type { NextFunction, Request, Response } from 'express'
import {
  getProjectServingState,
  PAUSED_CODE,
  PAUSED_MESSAGE,
  pausedDetails,
} from '@/lib/projects/serving-state'
import { ErrorCodes, sendError } from './response'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Byte-for-byte the lockdown answer the Next v1 middleware and both bootstrap
 * routes already give, so a client sees one contract whichever surface it hit.
 */
export const LOCKED_MESSAGE =
  'This project is currently locked by the platform operator. Contact support.'

export async function projectServingGate(req: Request, res: Response, next: NextFunction) {
  const projectId = req.params.projectId
  // Not a project path (or not one this gate can judge): leave it to the routes.
  if (!projectId || !UUID_RE.test(projectId)) return next()

  const state = await getProjectServingState(projectId)

  switch (state.kind) {
    case 'serving':
    case 'not_found':
      return next()

    case 'locked':
      return sendError(res, ErrorCodes.FORBIDDEN, LOCKED_MESSAGE, 503)

    case 'paused':
      // No Retry-After: nothing changes until the owner resumes it, and a
      // client that backs off and retries would only keep asking.
      return sendError(res, PAUSED_CODE, PAUSED_MESSAGE, 503, pausedDetails(projectId, state))

    case 'unavailable':
      res.setHeader('Retry-After', '5')
      return sendError(
        res,
        'PROJECT_STATE_UNAVAILABLE',
        'Could not confirm this project is available. Try again shortly.',
        503,
      )
  }
}
