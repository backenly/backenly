/**
 * The role a console request needs on its project.
 *
 * Reading a project needs membership. Changing it needs the Developer role.
 * The wrappers that hand a route its project (`withProjectAccess`,
 * `withTenantIsolation`, `withProjectValidation`) apply that by HTTP method,
 * so a new POST, PUT, PATCH or DELETE route starts at Developer without anyone
 * writing a check. A route passes `{ floor }` to say otherwise:
 *
 *   'view'        any member    a POST that changes nothing: a read-only
 *                               query, a preview, a dry run
 *   'write'       DEVELOPER+    creates or changes project state
 *   'administer'  ADMIN+        credentials and secrets, and removal the
 *                               dashboard cannot undo
 *
 * A route that lowers the default to 'view' says why at the call site, and
 * scripts/audit-route-authorization.ts lists it in its baseline.
 */

import { NextResponse } from 'next/server'
import { roleAtLeast, type ProjectRole } from '@/lib/edition/types'

export type ProjectFloor = 'view' | 'write' | 'administer'

const MINIMUM_ROLE: Record<ProjectFloor, ProjectRole> = {
  view: 'VIEWER',
  write: 'DEVELOPER',
  administer: 'ADMIN',
}

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/** The floor a request gets when its route names none. */
export function defaultFloor(method: string): ProjectFloor {
  return READ_METHODS.has(method.toUpperCase()) ? 'view' : 'write'
}

/** The floor this request must meet: the route's own, or the method's default. */
export function floorFor(method: string, floor?: ProjectFloor): ProjectFloor {
  return floor ?? defaultFloor(method)
}

export function roleMeetsFloor(role: ProjectRole, floor: ProjectFloor): boolean {
  return roleAtLeast(role, MINIMUM_ROLE[floor])
}

export const ROLE_INSUFFICIENT_CODE = 'PROJECT_ROLE_INSUFFICIENT'

/** What a member is told when their role is below the floor. */
export function roleInsufficientMessage(method: string): string {
  return READ_METHODS.has(method.toUpperCase())
    ? 'Your role in this project does not allow reading this'
    : 'Your role in this project does not allow this change'
}

/**
 * The refusal for a member whose role is below the floor.
 *
 * 403, not 404: the caller is a member and already sees the project, so there
 * is nothing to hide, and the console can tell "not allowed" from "gone".
 */
export function roleRefusal(method: string): NextResponse<{ error: string; code: string }> {
  return NextResponse.json(
    { error: roleInsufficientMessage(method), code: ROLE_INSUFFICIENT_CODE },
    { status: 403 },
  )
}
