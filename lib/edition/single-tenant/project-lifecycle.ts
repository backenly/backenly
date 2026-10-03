/**
 * Single-tenant ProjectLifecycle: one deployment is one project.
 *
 * ---- LISTING ------------------------------------------------------------
 *
 * Resolves THE project rather than enumerating the table. The distinction is
 * not performance. A self-hosted deployment answering "which projects" with a
 * scan is a deployment that will happily show a second project the moment one
 * appears, and the single-tenant resolver treats every authenticated account as
 * an operator of whatever it returns. Resolving the pinned id instead means a
 * stray row is invisible rather than shared.
 *
 * ---- CREATION -----------------------------------------------------------
 *
 * Refused. The one project is provisioned by `npm run bootstrap`, which
 * reconciles rather than inserts and is idempotent. The refusal is raised by
 * the provisioner itself (lib/projects/provision.ts), so it holds for every
 * caller and not merely for the ones that come through this seam.
 */
import { prisma } from '@/lib/db'
import { createProvisionedProject } from '@/lib/projects/provision'
import { PROJECT_LIST_SELECT } from '../project-listing'
import type {
  Edition,
  ProjectCreateInput,
  ProjectCreateResult,
  ProjectLifecycle,
  ProjectListEntry,
} from '../types'
import { theProjectId } from './the-project'

export const singleTenantProjectLifecycle: ProjectLifecycle = {
  edition: 'single-tenant' as Edition,

  /**
   * THE project, or an empty list before bootstrap has run.
   *
   * Not filtered by ownership. Bootstrap creates the project before anyone has
   * signed up, so an ownership filter showed the operator an empty dashboard on
   * every fresh install while GET /api/projects/<id> returned that same project
   * happily. Two answers to one question is what this seam exists to prevent.
   */
  async list(_userId: string): Promise<ProjectListEntry[]> {
    let id: string
    try {
      id = await theProjectId()
    } catch {
      // Not bootstrapped, or ambiguous. An empty list is the honest answer for
      // a listing; the errors still surface on the paths that RESOLVE a project,
      // where refusing to answer is the safe outcome and silence is not.
      return []
    }

    const project = await prisma.project.findUnique({ where: { id }, select: PROJECT_LIST_SELECT })
    return project ? [project as ProjectListEntry] : []
  },

  /**
   * There is no second project to create.
   *
   * Delegated rather than thrown here so that the invariant belongs to the
   * provisioner. A refusal that lived only in this method would be bypassed by
   * anything that called `createProvisionedProject` directly, which is exactly
   * how the two pre-Phase-3 creation paths came to exist.
   */
  async create(input: ProjectCreateInput): Promise<ProjectCreateResult> {
    await createProvisionedProject({ name: input.name, userId: input.userId })
    // Unreachable: the provisioner refuses before it inserts anything.
    throw new Error('single-tenant project creation should have been refused')
  },
}
