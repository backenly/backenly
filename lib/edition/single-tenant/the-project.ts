/**
 * THE project, on a deployment that has exactly one.
 *
 * Three seams need this answer and they must not each derive it: the resolver
 * (may this caller reach a project), the lifecycle (which projects exist, and
 * may another be created) and the fleet scheduler (which projects does a
 * background pass run against). Two implementations of "which project is this
 * deployment" is how a self-host install ends up healing one project and
 * listing another.
 *
 * The refusals are not defensive decoration. Single-tenant treats every
 * authenticated account as an operator of the deployment, so running it against
 * a database holding several projects would grant one tenant's data to another.
 * It declines to answer rather than answer wrongly.
 */
import { prisma } from '@/lib/db'
import { ProjectNotFoundError } from '../types'

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

/** Forget a cached id that has just been proven gone, so the next call re-infers. */
export function forgetTheProjectId(): void {
  cachedProjectId = null
}

export async function theProjectId(): Promise<string> {
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
