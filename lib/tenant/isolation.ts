/**
 * Tenant Isolation Service
 *
 * Request-level adapter over the ProjectResolver seam. This file used to be a
 * SECOND definition of project access: `where: { id, userId }`, owner only,
 * with no idea that organizations exist. lib/auth/project-access.ts said one
 * thing and this said another, and this one won on volume — 36 files reach a
 * project through here, against six that consult the organization-aware check.
 *
 * Two defects came from that, and both are fixed by delegating rather than
 * deciding:
 *
 *   1. An invited organization member was denied everything routed through
 *      here: storage, logs, monitoring, security issues, end-user auth,
 *      workspace files, provider credentials.
 *
 *   2. Worse, a request that named NO project resolved to the caller's OLDEST
 *      OWNED project. That is not a denial, it is a wrong answer with a 200 on
 *      it. An organization member reading storage saw their own project's
 *      buckets, so the organization's project rendered as empty rather than as
 *      an error, and the bug looked like a working feature.
 *
 * Extraction still happens here, because it is request shaped. The DECISION
 * belongs to lib/edition — one authority, per credential type, per edition.
 */

import { NextRequest } from 'next/server'
import { authenticateRequest } from '@/lib/auth/middleware'
import { recordSecurityEvent } from '@/lib/platform/controls'
import {
  getProjectResolver,
  ProjectContextRequiredError,
  ProjectResolutionError,
} from '@/lib/edition'

/**
 * Thrown for every refusal on this path.
 *
 * Carries `status` and `code` from the resolver. Existing callers all do
 * `instanceof TenantIsolationError` and answer 403, so their behaviour is
 * unchanged by this commit; the richer fields are here so that surfacing a
 * genuine 400 PROJECT_REQUIRED is a per-route edit later rather than a
 * 22-file rewrite now.
 */
export class TenantIsolationError extends Error {
  readonly status: number
  readonly code: string

  constructor(message: string, status = 403, code = 'PROJECT_FORBIDDEN') {
    super(message)
    this.name = 'TenantIsolationError'
    this.status = status
    this.code = code
  }
}

/**
 * Resolve the project this request may act on.
 *
 * Sources, in order: `X-Project-Id`, then `?projectId=`. Whatever is found is
 * a REQUEST, never a grant — the resolver decides whether the caller may have
 * it.
 *
 * This path is human sessions only. `authenticateRequest` verifies a JWT from
 * the bearer header or the auth cookie and has no API-key branch at all, so a
 * machine credential cannot arrive here and be measured against organization
 * membership. Keys are resolved by `resolveForApiKey`, which authorizes on the
 * project the key was issued for.
 *
 * NO FALLBACK. When nothing names a project, Cloud refuses. Single-tenant
 * resolves the one project that exists, which is correct there and only there.
 */
export async function getCurrentProjectId(request: NextRequest): Promise<string> {
  const headerProjectId = request.headers.get('x-project-id')
  const url = new URL(request.url)
  const queryProjectId = url.searchParams.get('projectId')
  const requested = headerProjectId ?? queryProjectId

  const auth = await authenticateRequest(request)
  if (!auth.authenticated || !auth.userId) {
    throw new TenantIsolationError('Authentication required', 401, 'UNAUTHENTICATED')
  }

  try {
    const project = await getProjectResolver().resolveForUser(auth.userId, requested)
    return project.id
  } catch (err) {
    if (err instanceof ProjectResolutionError) {
      // A caller asking for a project they may not have is a high-value signal
      // and stays on the Security tab. Asking for NO project is a client bug,
      // not an attack, so it is not reported as one.
      if (!(err instanceof ProjectContextRequiredError) && requested) {
        const ip =
          request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
          request.headers.get('x-real-ip') ||
          null
        recordSecurityEvent({
          kind: 'cross_tenant',
          severity: 'high',
          userId: auth.userId,
          userEmail: auth.userEmail ?? null,
          projectId: requested,
          ip,
          summary: `User ${auth.userEmail ?? auth.userId} requested a project they may not access`,
          detail: {
            requestedProjectId: requested,
            path: request.nextUrl.pathname,
            method: request.method,
            via: 'getCurrentProjectId',
            code: err.code,
          },
        }).catch(() => {})
      }
      throw new TenantIsolationError(err.message, err.status, err.code)
    }
    throw err
  }
}

/**
 * Resolve the request's project ID, or throw.
 *
 * Kept as a named export because `withTenantIsolation` and existing callers
 * read better with it. It adds nothing: authorization is entirely the
 * resolver's, and re-checking here would cost a second identity lookup while
 * being unable to reach a different verdict.
 */
export async function requireProjectId(request: NextRequest): Promise<string> {
  return getCurrentProjectId(request)
}

/**
 * Validate that a resource belongs to the specified project.
 *
 * Not an authorization check and must never be used as one: it compares two
 * ids the caller already holds. It exists so a route that has authorized a
 * project cannot then act on a row belonging to a different one.
 */
export async function validateProjectOwnership(
  projectId: string,
  resourceProjectId: string | null | undefined,
  resourceType: string = 'Resource'
): Promise<void> {
  if (!resourceProjectId) {
    throw new TenantIsolationError(`${resourceType} is not associated with a project`)
  }

  if (resourceProjectId !== projectId) {
    throw new TenantIsolationError(`${resourceType} does not belong to the specified project`)
  }
}

/**
 * Run a handler with the request's authorized project.
 *
 * The wrapper 22 routes use. It is deliberately the only ergonomic way to get
 * a project id on this path, so that "which project may this caller act on" is
 * answered in one place.
 */
export async function withTenantIsolation<T>(
  request: NextRequest,
  handler: (projectId: string, request: NextRequest) => Promise<T>
): Promise<T> {
  const projectId = await requireProjectId(request)
  return handler(projectId, request)
}

/**
 * Deleted in the ProjectResolver consolidation, listed so nobody reintroduces
 * them by reflex:
 *
 *   userHasProjectAccess     owner-only boolean access check
 *   getUserProjectIds        owner-only project list
 *   validateApiKeyProject    authorized a KEY by its creator's ownership
 *   withTenantScope          `{ ...where, projectId }` helper
 *   withOptionalTenantScope  the same, nullable
 *
 * All five had zero callers outside this file. That is exactly why they were
 * worth removing rather than leaving: an unused authorization helper is a
 * loaded gun for the next contributor who imports the wrong one, and these
 * encoded the owner-only rule this commit exists to retire.
 *
 * `validateApiKeyProject` deserves its own note. It resolved a key by asking
 * whether the key's OWNER owned the project, which is the wrong question in
 * both directions: it revokes a live production key when its creator changes
 * teams, and widens one when its creator is promoted. A key is authorized by
 * the project it was issued for. Use `resolveForApiKey`.
 *
 * For a boolean access check use `hasProjectAccess` from
 * lib/auth/project-access.ts. For a project list use the union query in
 * app/api/projects/route.ts, which already counts organization membership.
 */
