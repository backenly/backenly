/**
 * The one way application code creates a project.
 *
 * A Project row is not a project. Without a workspace schema, a PostgREST
 * registration, a backend graph and a signing secret, the row exists and every
 * data-plane request against it answers PGRST106 forever. Two live code paths
 * did exactly that:
 *
 *   lib/services/backend-replacement.ts   reached from /api/connect/replace-backend
 *   lib/services/intent-reconstructor.ts  reached from /api/connect/url
 *
 * Both created a bare row and returned it, so a user connecting a frontend got
 * a project whose database never worked. The second was worse: it hardcoded
 * `userId = 'system'`, which is not a user id at all.
 *
 * Neither was a missing feature. They were written before the provisioning
 * sequence existed and never revisited, which is what happens whenever the
 * sequence lives inline in one route instead of behind a function. So it now
 * lives here, and scripts/verify-project-provisioning.ts fails the build if a
 * new caller starts creating rows on its own.
 */
import { randomUUID } from 'crypto'
import { prisma } from '@/lib/db'
import { workspaceSchemaName } from '@/lib/security/workspace-schema'
import { ensureSchemaRegistered } from '@/lib/postgrest/registration'
import { JWTSecretManager } from '@/lib/services/jwtSecretManager'
import { createEmptyGraph } from '@/lib/orchestration/backend-state-graph'
import { currentEdition } from '@/lib/edition'

export class ProjectCreationUnsupportedError extends Error {
  readonly code = 'PROJECT_CREATION_UNSUPPORTED'
  constructor() {
    super(
      'This deployment is single-tenant: one deployment is one project, provisioned by ' +
        '`npm run bootstrap`. Creating a second project is not supported here. ' +
        'Multi-project management is a Backenly Cloud capability.'
    )
    this.name = 'ProjectCreationUnsupportedError'
  }
}

export interface ProvisionInput {
  name: string
  description?: string | null
  userId: string
  organizationId?: string | null
}

export interface ProvisionedProject {
  id: string
  name: string
  postgresSchema: string
  /** False when PostgREST could not be told about the schema. See the warning. */
  dataPlaneRegistered: boolean
}

/**
 * Create a project and everything that makes it usable.
 *
 * Ordering matters and is not cosmetic. The row and its graph go in one
 * transaction so a project can never exist without the state the brain and the
 * autonomy loop reconcile against. The schema, its registration and the signing
 * secret follow OUTSIDE that transaction, because `CREATE SCHEMA` is DDL and a
 * failure there should leave a repairable project rather than roll back a row
 * the caller has already been told about.
 */
export async function createProvisionedProject(input: ProvisionInput): Promise<ProvisionedProject> {
  // Single-tenant creates its one project through bootstrap, which reconciles
  // rather than inserts. Refusing here is what keeps "one deployment is one
  // project" an invariant instead of a convention.
  if (currentEdition() === 'single-tenant') throw new ProjectCreationUnsupportedError()

  const id = randomUUID()

  await prisma.$transaction(async tx => {
    await tx.project.create({
      data: {
        id,
        name: input.name,
        description: input.description ?? null,
        userId: input.userId,
        organizationId: input.organizationId ?? null,
      },
    })
    const graph = await tx.backendGraph.create({
      data: { projectId: id, graphData: createEmptyGraph(id) as any },
      select: { id: true },
    })
    await tx.project.update({ where: { id }, data: { activeGraphId: graph.id } })
  })

  const postgresSchema = workspaceSchemaName(id)
  await prisma.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "${postgresSchema.replace(/"/g, '""')}"`)

  await prisma.workspace.create({
    data: {
      name: `${input.name} Workspace`,
      projectId: id,
      userId: input.userId,
      postgresSchema,
      databaseProvisioned: true,
      databaseProvisionedAt: new Date(),
    },
  })

  // Without this the project's entire /db/* plane answers PGRST106 on every
  // table, forever. An event trigger covers CREATE SCHEMA, but `IF NOT EXISTS`
  // against an already-present schema fires no trigger, so the explicit call
  // stays: a repair should not depend on a single mechanism.
  const registration = await ensureSchemaRegistered(id)
  if (!registration.registered) {
    console.warn(
      `[provision] PostgREST registration failed for ${id}: ${registration.error ?? 'unknown'}. ` +
        'The data plane will answer PGRST106 until it is registered.'
    )
  }

  // Non-fatal: the end-user signup route provisions this lazily on first use.
  try {
    await JWTSecretManager.getOrCreateSecret(id)
  } catch (err) {
    console.warn(`[provision] jwtSecret not seeded for ${id}: ${(err as Error)?.message ?? err}`)
  }

  return { id, name: input.name, postgresSchema, dataPlaneRegistered: registration.registered }
}
