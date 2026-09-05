/**
 * Cloud ProjectResolver: multi-tenant, organization-aware, no implicit project.
 *
 * Wraps `verifyProjectAccess` rather than reimplementing it. That function is
 * already the correct answer for a human session (owner, else organization
 * membership, else the project-scoped grant a `restricted` member needs); it is
 * simply outvoted roughly seventy to six by call sites that ask the question
 * their own way. Reusing it here means this seam changes WHO decides, not what
 * the decision is, which is what keeps commit 2 a seam and not a behaviour
 * rewrite.
 */
import { prisma } from '@/lib/db'
import { verifyProjectAccess } from '@/lib/auth/project-access'
import {
  type ApiKeyIdentity,
  type Edition,
  type ProjectResolver,
  type ResolvedProject,
  ProjectAccessDeniedError,
  ProjectContextRequiredError,
  ProjectNotFoundError,
} from '../types'

const PROJECT_SELECT = {
  id: true,
  name: true,
  userId: true,
  organizationId: true,
  workspaces: {
    select: {
      id: true,
      postgresSchema: true,
      mongodbDatabase: true,
      databaseProvisioned: true,
    },
  },
} as const

/** Load a project with no authorization. Callers must have authorized already. */
async function loadProject(projectId: string): Promise<ResolvedProject> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: PROJECT_SELECT,
  })
  if (!project) throw new ProjectNotFoundError(projectId)
  return project as ResolvedProject
}

export const cloudProjectResolver: ProjectResolver = {
  edition: 'cloud' as Edition,

  async resolveForUser(userId, projectId) {
    // No fallback. See ProjectContextRequiredError in ../types for why
    // "resolve to the caller's oldest project" is worse than an error.
    if (!projectId) throw new ProjectContextRequiredError()

    try {
      const project = await verifyProjectAccess(projectId, userId)
      return project as ResolvedProject
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (message === 'PROJECT_NOT_FOUND') throw new ProjectNotFoundError(projectId)
      if (message === 'PROJECT_FORBIDDEN') throw new ProjectAccessDeniedError()
      throw err
    }
  },

  async resolveForApiKey(identity: ApiKeyIdentity) {
    // A key that is not project-scoped cannot name a project by other means.
    // Accepting one from the URL or a header here would rebuild the IDOR that
    // lib/auth/apiKeyAuth.ts exists to prevent ("NEVER accepts projectId from
    // query params"), so the absence of a scope is refused rather than filled in.
    if (!identity.projectId) throw new ProjectContextRequiredError('This API key is not scoped to a project')

    // Deliberately NOT re-checked against the owner's current organization
    // membership. The key is authorized by the project it was issued for. Asking
    // the human question here would revoke a live production key when its
    // creator changes teams, and widen one when its creator is promoted.
    return loadProject(identity.projectId)
  },

  /**
   * Owner, unrestricted member of the project's organization, or an explicit
   * project grant. Lifted verbatim out of GET /api/projects so that the listing
   * rule lives beside the resolution rule instead of drifting from it.
   */
  async accessibleProjectsWhere(userId: string): Promise<Record<string, unknown>> {
    return {
      OR: [
        { userId },
        { organization: { members: { some: { userId, restricted: false } } } },
        { projectMembers: { some: { userId } } },
      ],
    }
  },

  async resolveTrusted(projectId, reason) {
    if (!reason || !reason.trim()) {
      throw new Error('resolveTrusted requires a written reason: it bypasses authorization')
    }
    return loadProject(projectId)
  },
}
