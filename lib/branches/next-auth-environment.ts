/**
 * The Next.js side of lib/branches/auth-environment.ts: resolve the environment
 * an end-user auth route runs in, and mark its response with it.
 *
 * Kept apart from auth-environment.ts so the Express runtime, which imports
 * that file, never loads next/server.
 */

import { NextResponse } from 'next/server'
import { createErrorResponse } from '@/lib/api/v1/errors'
import { resolveAuthEnvironment, type AuthEnvironment, type AuthEnvironmentResult } from './auth-environment'
import { ENVIRONMENT_HEADER, environmentHeaderValue } from './key-scope'

/**
 * Run an auth route in the environment its key chose. The refusal for a key
 * that must not fall back to production is answered here, and every response
 * the route gives carries X-Backenly-Environment, so a test can tell which
 * environment said "wrong password" as well as which one created the user.
 */
export async function inAuthEnvironment(
  request: Request,
  projectId: string,
  route: (env: AuthEnvironment) => Promise<Response>,
): Promise<Response> {
  let result: AuthEnvironmentResult
  try {
    result = await resolveAuthEnvironment(projectId, request.headers, new URL(request.url, 'http://localhost'))
  } catch (error: any) {
    // Never guessed: with the key unread, production is not a safe default.
    console.error('[AuthEnvironment] key lookup failed:', error?.message ?? error)
    return createErrorResponse('INTERNAL_ERROR', 'Could not read the API key this request presented.', 500)
  }
  if (!result.env) {
    return NextResponse.json(result.refusal!.body, { status: result.refusal!.status })
  }
  const response = await route(result.env)
  response.headers.set(ENVIRONMENT_HEADER, environmentHeaderValue(result.env.branch?.name))
  return response
}
