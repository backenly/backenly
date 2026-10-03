/**
 * The Cloud project lifecycle, as resolved WITHOUT the private overlay.
 *
 * `@cloud/project-lifecycle` resolves here only when
 * `lib/cloud/project-lifecycle.ts` is absent, which means no Cloud overlay has
 * been applied. A real Cloud deployment cannot reach this file: it sets
 * BACKENLY_EDITION=cloud explicitly, and assertEditionCompositionOrExit refuses
 * to start without the overlay. What reaches here is the unset-edition default,
 * which is CI, local development and any public checkout.
 *
 * ---- WHAT LEFT ----------------------------------------------------------
 *
 * The organization half. Cloud attaches a new project to the creator's personal
 * organization so that team access, invitations and the members page have
 * something to hang off. A public checkout has no organization layer, so it
 * creates the project and stops there, and the result is a perfectly usable
 * project owned by the account that asked for it.
 *
 * ---- WHAT DID NOT ------------------------------------------------------
 *
 * Provisioning. Both editions build the project the same way, through
 * lib/projects/provision.ts, because "a Project row is not a project" is a
 * property of the product and not of the tenancy model. Reducing this to
 * `prisma.project.create()` would recreate the exact class of bug that shipped
 * a data plane answering PGRST106 on every table, forever.
 */
import { prisma } from '@/lib/db'
import { createProvisionedProject } from '@/lib/projects/provision'
import { createDefaultApiKey } from '@/lib/projects/default-api-key'
import { getProjectResolver } from '@/lib/edition'
import { PROJECT_LIST_SELECT } from '@/lib/edition/project-listing'
import type {
  ProjectCreateInput,
  ProjectCreateResult,
  ProjectListEntry,
} from '@/lib/edition/types'

/**
 * Projects this caller may see.
 *
 * The clause comes from ProjectResolver, which is the one authority for project
 * access. Listing is the same question as resolving, asked of many rows at
 * once, and the two answered it separately until they disagreed.
 */
export async function listAccessibleProjects(userId: string): Promise<ProjectListEntry[]> {
  const projects = await prisma.project.findMany({
    where: await getProjectResolver().accessibleProjectsWhere(userId),
    select: PROJECT_LIST_SELECT,
    orderBy: { updatedAt: 'desc' },
  })
  return projects as ProjectListEntry[]
}

/** Create a fully provisioned project, with no organization to attach it to. */
export async function createProject(input: ProjectCreateInput): Promise<ProjectCreateResult> {
  const provisioned = await createProvisionedProject({
    name: input.name,
    description: input.description ?? null,
    userId: input.userId,
    environment: input.environment,
    apiUrlDev: input.apiUrlDev ?? null,
    apiUrlStaging: input.apiUrlStaging ?? null,
    apiUrlProd: input.apiUrlProd ?? null,
  })

  const apiKey = await createDefaultApiKey(provisioned.id, provisioned.name, input.userId)
  return { project: await loadCreatedProject(provisioned.id), apiKey }
}

/**
 * Read the project back in the shape a listing uses.
 *
 * Re-read rather than assembled from the input so the response carries the
 * database's own defaults, and so both editions return the identical shape from
 * `create` and from `list`.
 */
export async function loadCreatedProject(
  projectId: string,
): Promise<ProjectCreateResult['project']> {
  const project = await prisma.project.findUniqueOrThrow({
    where: { id: projectId },
    select: {
      ...PROJECT_LIST_SELECT,
      user: { select: { id: true, email: true, name: true } },
    },
  })
  return project as ProjectCreateResult['project']
}
