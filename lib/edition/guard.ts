/**
 * Boolean project-access guard for routes that answer 404 either way.
 *
 * WHY THIS EXISTS, given that a helper layer is usually the wrong instinct: the
 * routes under app/api/projects/[id]/** did this themselves, 53 times across 36
 * files, several of them with a private `assertOwner` of their own:
 *
 *   const project = await prisma.project.findFirst({
 *     where: { id: projectId, userId },
 *     select: { id: true },
 *   })
 *   if (!project) return NextResponse.json({ error: '...' }, { status: 404 })
 *
 * So this replaces 36 local helpers with one shared function rather than adding
 * a layer on top of them. The alternative was an inline try/catch around the
 * resolver at every site, which is the same six lines copied 53 more times.
 *
 * WHY A BOOLEAN, when ProjectResolver deliberately distinguishes "does not
 * exist" (404) from "exists and is not yours" (403): because this route family
 * deliberately does NOT distinguish, and preserving that is the point.
 *
 * The old query could not tell the two apart — `findFirst` with a userId
 * predicate returns null for both — so every one of these routes has always
 * answered 404 to a stranger. That is the correct behaviour to keep: a 403
 * confirms the project exists, which tells an unauthorized caller something a
 * 404 does not. Migrating the authorization decision must not also start
 * leaking existence, so the distinction is collapsed HERE, on purpose, and the
 * caller keeps returning the 404 it always returned.
 *
 * Routes that should distinguish must not use this. They should call
 * `getProjectResolver().resolveForUser(...)` and map `err.status` themselves.
 */
import { getProjectResolver, ProjectResolutionError } from './index'

/**
 * True when this user may act on this project under the running edition.
 *
 * Cloud consults ownership, organization membership, and the project-scoped
 * grant a `restricted` member needs. Single-tenant treats any authenticated
 * account as an operator of the one project.
 *
 * Only a resolution refusal returns false. An unexpected error (a dead database,
 * a bug) is rethrown rather than reported as "denied", because silently
 * answering 404 to an infrastructure fault turns an outage into a wrong answer
 * and hides it from the caller and the logs alike.
 */
export async function canAccessProject(userId: string, projectId: string): Promise<boolean> {
  try {
    await getProjectResolver().resolveForUser(userId, projectId)
    return true
  } catch (err) {
    if (err instanceof ProjectResolutionError) return false
    throw err
  }
}
