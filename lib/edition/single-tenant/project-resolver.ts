/**
 * Single-tenant ProjectResolver: one deployment is one project.
 *
 * This is the self-hosted edition. It keeps `projectId` everywhere, because it
 * is load-bearing in 83 of 119 Prisma models, in `workspace_<uuid>` schema
 * names, in `bkn_ro_<hex>` role names, in per-project JWT signing and in every
 * /api/v1/[projectId]/** URL. "Single project" means the Project table holds
 * one ROW, never that the model was removed.
 *
 * Two consequences follow, and they are the edition difference:
 *
 *   1. Implicit resolution is CORRECT here. With exactly one project there is
 *      nothing to disambiguate, so a request that names no project gets the one
 *      that exists. Cloud refuses the same request, because there the answer
 *      would be a guess.
 *
 *   2. Authorization is deployment-level. Anyone with an account on a
 *      self-hosted instance is an operator of it; there are no organizations,
 *      no invites and no project-scoped grants to consult, because that whole
 *      layer is the Cloud control plane.
 *
 * Point 2 is why the count guard below is not defensive decoration. This
 * resolver is permissive by design, so running it against a multi-tenant
 * database would be a cross-tenant authorization bypass, granting any logged-in
 * user the project it happened to pick. It refuses to answer at all rather than
 * answer wrongly.
 */
import { prisma } from '@/lib/db'
import {
  type ApiKeyIdentity,
  type Edition,
  type ProjectResolver,
  type ResolvedProject,
  ProjectAccessDeniedError,
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

export class MultipleProjectsInSingleTenantError extends Error {
  constructor(count: number) {
    super(
      `Single-tenant edition found ${count} projects. One deployment is one project. ` +
        'Refusing to resolve a project: this resolver treats any authenticated user as an ' +
        'operator of the deployment, so choosing between tenants here would grant one ' +
        "tenant's data to another. Set BACKENLY_EDITION=cloud if this is a multi-tenant " +
        'database, or point this deployment at its own.'
    )
    this.name = 'MultipleProjectsInSingleTenantError'
  }
}

export class NoProjectBootstrappedError extends Error {
  constructor() {
    super('No project exists yet. Run `npm run bootstrap` to provision this deployment.')
    this.name = 'NoProjectBootstrappedError'
  }
}

/** Cached because it cannot change while the process lives: one deployment, one project. */
let cachedProjectId: string | null = null

/** Tests create and drop the single project, so they need to clear the cache. */
export function resetSingleTenantCache(): void {
  cachedProjectId = null
}

async function theProjectId(): Promise<string> {
  if (cachedProjectId) return cachedProjectId

  const pinned = process.env.BACKENLY_PROJECT_ID?.trim()
  if (pinned) {
    const exists = await prisma.project.findUnique({ where: { id: pinned }, select: { id: true } })
    if (!exists) throw new ProjectNotFoundError(pinned)
    cachedProjectId = exists.id
    return cachedProjectId
  }

  // Unpinned: infer it, but only when the inference is unambiguous.
  const count = await prisma.project.count()
  if (count === 0) throw new NoProjectBootstrappedError()
  if (count > 1) throw new MultipleProjectsInSingleTenantError(count)

  const only = await prisma.project.findFirst({ select: { id: true } })
  if (!only) throw new NoProjectBootstrappedError()
  cachedProjectId = only.id
  return cachedProjectId
}

async function loadTheProject(): Promise<ResolvedProject> {
  const id = await theProjectId()
  const project = await prisma.project.findUnique({ where: { id }, select: PROJECT_SELECT })
  if (!project) {
    // The pinned or cached id has gone. Drop the cache so a later call can
    // re-infer rather than failing forever on a stale value.
    cachedProjectId = null
    throw new ProjectNotFoundError(id)
  }
  return project as ResolvedProject
}

/**
 * A named project must be THE project.
 *
 * Answering "not found" for any other id is deliberate: on a single-project
 * deployment no other project exists, so that is simply true, and it avoids
 * implying that some other tenant might be here.
 */
async function assertIsTheProject(projectId: string): Promise<ResolvedProject> {
  const project = await loadTheProject()
  if (projectId !== project.id) throw new ProjectNotFoundError(projectId)
  return project
}

export const singleTenantProjectResolver: ProjectResolver = {
  edition: 'single-tenant' as Edition,

  async resolveForUser(_userId, projectId) {
    // No membership check: on a self-hosted instance every account is an
    // operator of the deployment. `userId` is accepted so the interface is
    // identical across editions and call sites need no edition awareness.
    if (!projectId) return loadTheProject()
    return assertIsTheProject(projectId)
  },

  async resolveForApiKey(identity: ApiKeyIdentity) {
    // An unscoped key is fine here, unlike in Cloud: there is only one project
    // it could mean.
    if (!identity.projectId) return loadTheProject()
    try {
      return await assertIsTheProject(identity.projectId)
    } catch (err) {
      // A key naming a project this deployment does not have is a stale or
      // foreign credential, which is a denial rather than a missing resource.
      if (err instanceof ProjectNotFoundError) throw new ProjectAccessDeniedError('This API key is not valid for this deployment')
      throw err
    }
  },

  async resolveTrusted(projectId, reason) {
    if (!reason || !reason.trim()) {
      throw new Error('resolveTrusted requires a written reason: it bypasses authorization')
    }
    return assertIsTheProject(projectId)
  },
}
