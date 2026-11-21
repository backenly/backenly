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
import { quoteIdent, workspaceSchemaName } from '@/lib/security/workspace-schema'
import { ensureSchemaRegistered } from '@/lib/postgrest/registration'
import { JWTSecretManager } from '@/lib/services/jwtSecretManager'
import { createEmptyGraph } from '@/lib/orchestration/backend-state-graph'
import { currentEdition } from '@/lib/edition'
import { generateUniqueSlug } from '@/lib/utils/slug'
import {
  databaseClient,
  regionRawClient,
  requireRegionDataInstanceUrl,
  type WorkspaceRawClient,
} from '@/lib/data-plane/regional'
import {
  createProjectDatabase,
  dropProjectDatabase,
  grantBackupReadOn,
  requireRegionDbcreatorUrl,
  type CreatedProjectDatabase,
} from '@/lib/data-plane/project-databases'
import { HOME_REGION, type CloudRegionId } from '@/lib/regions'
import { grantWorkspaceBackupAccess } from '@/lib/services/direct-access'
import { tenancyForNewProject } from './database-tenancy'

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
  /**
   * Optional presentation and routing fields.
   *
   * They live here rather than being patched onto the row afterwards because a
   * caller that updates a project it has just created has, for a moment,
   * published a project in a state it never intended. `slug` is generated when
   * absent: it is unique-constrained and every listing surface keys off it, and
   * the two pre-existing callers of this function created rows without one.
   */
  slug?: string
  environment?: string
  apiUrlDev?: string | null
  apiUrlStaging?: string | null
  apiUrlProd?: string | null
  /**
   * The region the project's data lives in (lib/regions.ts). Omitted or null
   * is the home region, recorded as null like every project before regions.
   * The caller names it: nothing can look it up, because the row does not
   * exist yet, and projectRegion() reads a project with no row as home.
   */
  region?: CloudRegionId | null
}

export interface ProvisionedProject {
  id: string
  name: string
  slug: string
  postgresSchema: string
  /** False when PostgREST could not be told about the schema. See the warning. */
  dataPlaneRegistered: boolean
  /**
   * 'dedicated' when the project was given a database of its own, which its
   * region's switch decides (lib/projects/database-tenancy.ts); 'shared'
   * otherwise. Recorded on its row.
   */
  databaseTenancy: 'shared' | 'dedicated'
}

/**
 * Create a project and everything that makes it usable.
 *
 * Ordering matters and is not cosmetic:
 *
 *   1. The workspace schema, in the database of the project's region. It comes
 *      first because that database is the one this sequence may be unable to
 *      reach: a region can be configured here and still not answer, and then
 *      the creation fails with nothing written at home. The id is fresh, so
 *      `CREATE SCHEMA IF NOT EXISTS` makes a new, empty schema. The backup
 *      role is given read on it there and then (see below).
 *   2. The project row, its backend graph and its workspace row, in one home
 *      transaction, so a project is never listed without the state the brain
 *      and the autonomy loop reconcile against, or without the workspace that
 *      names its schema. If that transaction fails, the schema from step 1
 *      belongs to no project: it is dropped and the transaction's error is
 *      rethrown.
 *   3. The PostgREST registration and the signing secret, neither of which
 *      fails the creation (see each below).
 *
 * Writing the row first, as this did before, meant a region whose database was
 * configured but unreachable left a project in the console with no schema and
 * no workspace, although the request that created it answered 500.
 *
 * A DATABASE OF ITS OWN. Where the region's switch gives the new project one
 * (lib/projects/database-tenancy.ts), step 1 first creates that database from
 * the region's template (lib/data-plane/project-databases.ts), then the
 * workspace schema inside it, as the application's role, and the backup
 * role's read there. The row records the database (databaseTenancy,
 * databaseName, databaseInstance). If the home transaction fails, the whole
 * database belongs to no project and is dropped; a crash before that leaves it
 * to the daily orphan sweep.
 */
export async function createProvisionedProject(input: ProvisionInput): Promise<ProvisionedProject> {
  // Single-tenant creates its one project through bootstrap, which reconciles
  // rather than inserts. Refusing here is what keeps "one deployment is one
  // project" an invariant instead of a convention.
  if (currentEdition() === 'single-tenant') throw new ProjectCreationUnsupportedError()

  const region = input.region ?? HOME_REGION
  // Decided once, here, and recorded on the row: nothing infers it later.
  const tenancy = await tenancyForNewProject({ region, userId: input.userId })

  // The database the schema goes in: the region's, or for a project with a
  // database of its own, the region's data instance. Resolving it only checks
  // that this process has the connection strings it needs there, and refuses
  // a region it has none for. Whether that database answers is learned by
  // creating the schema below, which is why nothing is written at home first.
  let db: WorkspaceRawClient | null = null
  if (tenancy === 'dedicated') {
    requireRegionDbcreatorUrl(region)
    requireRegionDataInstanceUrl(region, 'app')
  } else {
    db = regionRawClient(region)
  }

  const id = randomUUID()
  const postgresSchema = workspaceSchemaName(id)

  const slug =
    input.slug ??
    (await generateUniqueSlug(input.name, async candidate => {
      const taken = await prisma.project.findUnique({ where: { slug: candidate }, select: { id: true } })
      return !!taken
    }))

  let own: CreatedProjectDatabase | null = null
  if (tenancy === 'dedicated') {
    own = await createProjectDatabase({ region, projectId: id })
    try {
      db = databaseClient(region, own.database, id)
      await createOwnSchema(db, postgresSchema, region, own.database)
    } catch (err) {
      await dropUnclaimedDatabase(own, id)
      throw err
    }
  } else {
    await (db as WorkspaceRawClient).$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(postgresSchema)}`)

    // Snapshots dump the schema as the backup role, and nothing else grants it
    // read on a project without direct access: every snapshot of such a project
    // failed "permission denied for schema". The grant also sets the default
    // privileges that cover each table the application adds later. Not fatal,
    // like the registration below: the project works without it, and the next
    // sync of its grants (syncDirectAccessGrants) makes it again.
    try {
      await grantWorkspaceBackupAccess(region, postgresSchema)
    } catch (err) {
      console.warn(
        `[provision] the backup role was not granted read on ${postgresSchema} in ${region}: ` +
          `${(err as Error)?.message ?? err}. Its snapshots fail until its grants are synced.`
      )
    }
  }

  try {
    await prisma.$transaction(async tx => {
      await tx.project.create({
        data: {
          id,
          name: input.name,
          slug,
          description: input.description ?? null,
          userId: input.userId,
          organizationId: input.organizationId ?? null,
          environment: input.environment ?? 'development',
          apiUrlDev: input.apiUrlDev ?? null,
          apiUrlStaging: input.apiUrlStaging ?? null,
          apiUrlProd: input.apiUrlProd ?? null,
          region: region === HOME_REGION ? null : region,
          // Where its data is, recorded once: a database of its own, or (the
          // columns' defaults) its region's shared one.
          ...(own ? { databaseTenancy: 'dedicated', databaseName: own.database, databaseInstance: own.instance } : {}),
          // New Cloud projects start protected: a coding agent changes the schema
          // on a preview branch and production gets it through a reviewed merge.
          // Never on a self-hosted install, which has no branches to use instead.
          // The owner can turn it off in Settings. lib/branches/protection.ts.
          protectedProduction: currentEdition() === 'cloud',
        },
      })
      const graph = await tx.backendGraph.create({
        data: { projectId: id, graphData: createEmptyGraph(id) as any },
        select: { id: true },
      })
      await tx.project.update({ where: { id }, data: { activeGraphId: graph.id } })
      await tx.workspace.create({
        data: {
          name: `${input.name} Workspace`,
          projectId: id,
          userId: input.userId,
          postgresSchema,
          databaseProvisioned: true,
          databaseProvisionedAt: new Date(),
        },
      })
    })
  } catch (err) {
    // A database of its own now belongs to no project, schema and all: it is
    // dropped whole, best effort, and never replaces the error that explains
    // the failure.
    if (own) {
      await dropUnclaimedDatabase(own, id)
      throw err
    }
    // The schema now belongs to no project. Dropping it is best effort and never
    // replaces the error that explains the failure. Not CASCADE: it was created
    // empty a moment ago, so a drop that had to remove something inside it would
    // be removing something this call did not create.
    await (db as WorkspaceRawClient).$executeRawUnsafe(`DROP SCHEMA IF EXISTS ${quoteIdent(postgresSchema)}`).catch((dropErr: unknown) => {
      console.error(
        `[provision] ${postgresSchema} in ${region} belongs to no project and could not be dropped: ` +
          `${(dropErr as Error)?.message ?? dropErr}`
      )
    })
    throw err
  }

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

  return {
    id,
    name: input.name,
    slug,
    postgresSchema,
    dataPlaneRegistered: registration.registered,
    databaseTenancy: own ? 'dedicated' : 'shared',
  }
}

/**
 * The workspace schema in a project's own database, as the application's role,
 * and the backup role's read on it. The schema's creation fires the database's
 * own event triggers, which register it with its own PostgREST registry. The
 * backup grant is not fatal, as for a shared project: the next sync of the
 * project's grants makes it again.
 */
async function createOwnSchema(db: WorkspaceRawClient, schema: string, region: CloudRegionId, database: string): Promise<void> {
  await db.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(schema)}`)
  try {
    if (!(await grantBackupReadOn(db, schema))) {
      console.warn(`[provision] ${database} in ${region} has no grant helper, so the backup role was not granted read on ${schema}`)
    }
  } catch (err) {
    console.warn(
      `[provision] the backup role was not granted read on ${schema} in ${database} (${region}): ` +
        `${(err as Error)?.message ?? err}. Its snapshots fail until its grants are synced.`
    )
  }
}

/** Drop a database made for a project whose creation then failed. Best effort; the orphan sweep is behind it. */
async function dropUnclaimedDatabase(own: CreatedProjectDatabase, projectId: string): Promise<void> {
  await dropProjectDatabase({ region: own.region, database: own.database, projectId }).catch((dropErr: unknown) => {
    console.error(
      `[provision] ${own.database} in ${own.region} belongs to no project and could not be dropped: ` +
        `${(dropErr as Error)?.message ?? dropErr}. The daily orphan sweep drops it.`
    )
  })
}
