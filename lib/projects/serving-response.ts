/**
 * The serving gate's answer for a Next.js route.
 *
 * The runtime refuses every /api/v1/{projectId} request for a project that is
 * locked, paused, or whose state cannot be read (server/lib/serving-gate.ts).
 * Next owns some of those routes outright (end-user auth, realtime, storage,
 * functions, healthz), so the same decision is made here, from the same reader
 * (getProjectServingState), with the same codes and messages, so a client sees
 * one answer whichever process served it.
 *
 * Null when the project serves, and when it does not exist: the route answers
 * a missing project itself, as before.
 */

import { NextResponse } from 'next/server'
import { createErrorResponse, ErrorCodes } from '@/lib/api/v1/errors'
import {
  getProjectServingState,
  PAUSED_CODE,
  PAUSED_MESSAGE,
  pausedDetails,
  type ProjectServingState,
} from '@/lib/projects/serving-state'

/** The runtime gate's words for a locked project (server/lib/serving-gate.ts LOCKED_MESSAGE). */
export const LOCKED_MESSAGE = 'This project is currently locked by the platform operator. Contact support.'

export const STATE_UNAVAILABLE_CODE = 'PROJECT_STATE_UNAVAILABLE'

export async function servingRefusal(projectId: string): Promise<NextResponse | null> {
  return refusalForState(projectId, await getProjectServingState(projectId))
}

/** The answer for a state already read: null when the project serves or does not exist. */
export function refusalForState(projectId: string, state: ProjectServingState): NextResponse | null {
  switch (state.kind) {
    case 'serving':
    case 'not_found':
      return null
    case 'locked':
      return createErrorResponse(ErrorCodes.FORBIDDEN, LOCKED_MESSAGE, 503)
    case 'paused':
      return createErrorResponse(PAUSED_CODE, PAUSED_MESSAGE, 503, pausedDetails(projectId, state))
    case 'unavailable': {
      const response = createErrorResponse(
        STATE_UNAVAILABLE_CODE,
        'Could not confirm this project is available. Try again shortly.',
        503,
      )
      response.headers.set('Retry-After', '5')
      return response
    }
  }
}

/** Whether a project serves right now; for long-lived responses that re-check as they run. */
export async function stillServing(projectId: string): Promise<boolean> {
  const state = await getProjectServingState(projectId)
  return state.kind === 'serving'
}
