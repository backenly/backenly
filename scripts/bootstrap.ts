#!/usr/bin/env tsx
/**
 * Provision THE project for a self-hosted Backenly deployment.
 *
 * One deployment is one project, so this runs once and then keeps running
 * safely. It is a RECONCILER, not an installer: every step checks the world
 * before changing it, so a partially provisioned deployment is repaired rather
 * than duplicated or refused.
 *
 * That matters more than it sounds. Self-hosters rerun bootstrap. CI reruns it.
 * Upgrades will eventually rerun parts of it. A script that only works against
 * a pristine database is a script that fails exactly when someone is already
 * having a bad day, so:
 *
 *   fresh database          creates everything
 *   already bootstrapped    succeeds, changes nothing
 *   half provisioned        repairs only what is missing
 *
 * What "operational" means here, and why a Project row alone is not it:
 *
 *   Project row          identity
 *   workspace_<uuid>     the schema its tables live in
 *   PostgREST registered without this the whole /db/* plane answers PGRST106
 *   BackendGraph         the state the brain and autonomy reconcile against
 *   jwtSecret            per-project signing for end-user auth
 *   anonKey              the credential a frontend embeds
 *   bkn_ro_/bkn_rw_      direct database roles
 *
 * Exit codes:
 *   0  ready
 *   2  refused (incompatible database, or a pinned id that does not match)
 *   3  core bootstrapped, prerequisites unmet — NOT ready
 *
 * Usage:
 *   npm run bootstrap
 *   npm run bootstrap -- --owner you@example.com
 */
import { randomUUID, createHash, randomBytes } from 'crypto'
import { prisma } from '@/lib/db'
import { workspaceSchemaName } from '@/lib/security/workspace-schema'
import { ensureSchemaRegistered } from '@/lib/postgrest/registration'
import { JWTSecretManager } from '@/lib/services/jwtSecretManager'
import { getDirectAccessStatus, provisionDirectAccess } from '@/lib/services/direct-access'
import { createEmptyGraph } from '@/lib/orchestration/backend-state-graph'

const args = process.argv.slice(2)
const ownerEmail = (() => {
  const i = args.indexOf('--owner')
  return i >= 0 ? args[i + 1] : null
})()

/** Steps report what they DID, so a rerun visibly changes nothing. */
type Outcome = 'created' | 'already present' | 'repaired' | 'skipped (see warning)'
const log: Array<[string, Outcome]> = []
const step = (what: string, outcome: Outcome) => log.push([what, outcome])

/**
 * Prerequisites bootstrap cannot install itself.
 *
 * Tracked rather than merely warned about, because "core bootstrapped" and
 * "Backenly is ready" are different states and deployment automation must be
 * able to tell them apart. A script that prints warnings and exits 0 reads as
 * success to every CI runner on earth.
 */
const pending: Array<{ what: string; fix: string }> = []
const needs = (what: string, fix: string) => pending.push({ what, fix })

class BootstrapRefusal extends Error {
  constructor(code: string, detail: string) {
    super(`${code}\n\n${detail}`)
    this.name = 'BootstrapRefusal'
  }
}

/**
 * Decide which project this deployment IS, or refuse.
 *
 * BACKENLY_PROJECT_ID is the deployment's identity and must stay stable
 * forever: it is baked into the workspace schema name, the bkn_* role names,
 * storage paths, PostgREST registration and every /api/v1/<id>/ URL. So this
 * never invents a new id when one is already configured or already in use.
 */
async function resolveTheProjectId(): Promise<{ id: string; existed: boolean }> {
  const pinned = process.env.BACKENLY_PROJECT_ID?.trim() || null
  const count = await prisma.project.count()

  // Refuse before touching anything. Picking one of several projects would
  // hand one tenant's data to another, because the single-tenant resolver
  // treats every authenticated account as an operator of whatever it returns.
  if (count > 1) {
    const sample = await prisma.project.findMany({ select: { id: true, name: true }, take: 5 })
    throw new BootstrapRefusal(
      'BACKENLY_SINGLE_TENANT_INVALID_DATABASE',
      `Expected exactly one Backenly project but found ${count}.\n` +
        'This database appears to belong to a Backenly Cloud or multi-project installation.\n\n' +
        sample.map(p => `  ${p.id}  ${p.name}`).join('\n') +
        (count > sample.length ? `\n  ... and ${count - sample.length} more` : '') +
        '\n\nBootstrap will not choose one, delete one, or downgrade this database.\n' +
        'Point this deployment at its own database, or run it with BACKENLY_EDITION=cloud.'
    )
  }

  if (pinned) {
    const existing = await prisma.project.findUnique({ where: { id: pinned }, select: { id: true } })
    if (existing) return { id: existing.id, existed: true }

    // A pinned id that does not exist, next to a project that does, is a
    // mismatch rather than a request for a second project. Creating one here
    // would produce the two-project state refused above, from a typo.
    if (count === 1) {
      const other = await prisma.project.findFirst({ select: { id: true, name: true } })
      throw new BootstrapRefusal(
        'BACKENLY_PROJECT_ID_MISMATCH',
        `BACKENLY_PROJECT_ID is set to ${pinned}, which does not exist in this database.\n` +
          `This database already contains a different project:\n\n` +
          `  ${other!.id}  ${other!.name}\n\n` +
          'Bootstrap will not create a second project because an environment variable changed.\n' +
          `Either set BACKENLY_PROJECT_ID=${other!.id}, or point this deployment at an empty database.`
      )
    }

    return { id: pinned, existed: false }
  }

  if (count === 1) {
    const only = await prisma.project.findFirst({ select: { id: true } })
    return { id: only!.id, existed: true }
  }

  return { id: randomUUID(), existed: false }
}

async function resolveOwnerId(): Promise<string | null> {
  if (ownerEmail) {
    const u = await prisma.user.findUnique({ where: { email: ownerEmail }, select: { id: true } })
    if (!u) {
      throw new BootstrapRefusal(
        'BACKENLY_OWNER_NOT_FOUND',
        `No user with email ${ownerEmail}. Sign up first, then rerun with --owner.`
      )
    }
    return u.id
  }
  // Oldest account, if any. An owner-less project is valid here: the
  // single-tenant resolver authorizes on the deployment, not on Project.userId.
  const first = await prisma.user.findFirst({ orderBy: { createdAt: 'asc' }, select: { id: true } })
  return first?.id ?? null
}

async function ensureProject(id: string, existed: boolean, ownerId: string | null): Promise<string> {
  if (existed) {
    step('project row', 'already present')
    return id
  }
  await prisma.project.create({
    data: { id, name: 'Backenly', description: 'Self-hosted Backenly project', userId: ownerId },
  })
  step('project row', 'created')
  return id
}

async function ensureBackendGraph(projectId: string): Promise<void> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { activeGraphId: true },
  })
  if (project?.activeGraphId) {
    const graph = await prisma.backendGraph.findUnique({
      where: { id: project.activeGraphId },
      select: { id: true },
    })
    if (graph) return step('backend graph', 'already present')
  }

  // A graph may already exist while activeGraphId points nowhere: the pointer
  // is what breaks, not the history. Adopt the newest rather than inserting,
  // both because BackendGraph is unique on (projectId, sequenceNumber) so a
  // second row at sequence 0 collides, and because replacing a project's graph
  // during a REPAIR would discard the state the brain and autonomy reconcile
  // against.
  const existing = await prisma.backendGraph.findFirst({
    where: { projectId },
    orderBy: { sequenceNumber: 'desc' },
    select: { id: true, sequenceNumber: true },
  })

  if (existing) {
    await prisma.project.update({ where: { id: projectId }, data: { activeGraphId: existing.id } })
    return step('backend graph', 'repaired')
  }

  const created = await prisma.backendGraph.create({
    data: { projectId, graphData: createEmptyGraph(projectId) as any, sequenceNumber: 0 },
    select: { id: true },
  })
  await prisma.project.update({ where: { id: projectId }, data: { activeGraphId: created.id } })
  step('backend graph', 'created')
}

async function ensureWorkspaceSchema(projectId: string, ownerId: string | null): Promise<void> {
  const schema = workspaceSchemaName(projectId) // validates the uuid shape
  const before = await prisma.$queryRaw<Array<{ exists: boolean }>>`
    SELECT EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = ${schema}) AS exists
  `
  const schemaExisted = before[0]?.exists === true
  await prisma.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "${schema.replace(/"/g, '""')}"`)
  step(`postgres schema ${schema}`, schemaExisted ? 'already present' : 'created')

  const row = await prisma.workspace.findFirst({ where: { projectId }, select: { id: true, postgresSchema: true } })
  if (!row) {
    await prisma.workspace.create({
      data: {
        name: 'Backenly Workspace',
        projectId,
        userId: ownerId,
        postgresSchema: schema,
        databaseProvisioned: true,
        databaseProvisionedAt: new Date(),
      },
    })
    step('workspace record', schemaExisted ? 'repaired' : 'created')
  } else if (row.postgresSchema !== schema) {
    await prisma.workspace.update({
      where: { id: row.id },
      data: { postgresSchema: schema, databaseProvisioned: true },
    })
    step('workspace record', 'repaired')
  } else {
    step('workspace record', 'already present')
  }
}

async function ensurePostgrestRegistration(projectId: string): Promise<void> {
  // RegistrationResult reports success, not whether anything CHANGED, so ask
  // the registry first. Without this the step said "created" on every run,
  // which quietly contradicts the property this script is built around: a
  // rerun should visibly change nothing.
  //
  // Guarded, because the registry helpers may not be installed yet — that is
  // the very condition this function exists to report.
  const schema = workspaceSchemaName(projectId)
  let alreadyRegistered = false
  try {
    const rows = await prisma.$queryRaw<Array<{ schemas: string | null }>>`
      SELECT public.backenly_pgrst_current_schemas() AS schemas
    `
    alreadyRegistered = (rows[0]?.schemas ?? '').split(',').map(x => x.trim()).includes(schema)
  } catch {
    alreadyRegistered = false
  }

  const result = await ensureSchemaRegistered(projectId)
  if (!result.registered) {
    console.warn(
      `  ! PostgREST registration could not be completed: ${result.error ?? 'unknown error'}\n` +
        '    The data plane will answer PGRST106 until this succeeds. If PostgREST is not\n' +
        '    installed yet, see scripts/postgrest-install.sh and rerun bootstrap.'
    )
    // The message names the WHOLE chain, because pointing only at
    // postgrest-install.sh sent an operator in a circle: running it alone still
    // failed, first on a function defined in a different SQL file and then on
    // roles nothing had created yet. Measured by installing them one at a time
    // against an empty database until registration succeeded.
    //
    // Step 1 now creates the PostgREST roles itself, because its event triggers
    // grant to them and a fresh cluster could otherwise never reach step 2 to
    // create the schema step 2 requires. Step 2 keeps passwords, role
    // membership and per-schema grants.
    //
    // The ordering is not arbitrary and cannot be collapsed into one step:
    // setup-postgrest-roles.ts grants per workspace schema, so it needs the
    // project to already exist. Bootstrap therefore runs, reports NOT ready,
    // and is rerun — which is exactly what a reconciler is for.
    needs(
      'PostgREST cannot register the workspace schema, so the data plane is not available',
      'As a superuser, in order:\n' +
        '         0. if the role in your DATABASE_URL is NOT `backenly_user`:\n' +
        "            psql -c \"ALTER DATABASE <db> SET backenly.app_role = '<your role>'\"\n" +
        '         1. bash scripts/postgrest-install.sh\n' +
        '            (or: psql -f scripts/sql/postgrest-schema-registry.sql, then postgrest-ddl-sync.sql)\n' +
        `         2. npx tsx scripts/setup-postgrest-roles.ts --project ${projectId} --apply\n` +
        '         3. start PostgREST against the connection string step 2 prints\n' +
        '       then rerun: npm run bootstrap'
    )
    step('postgrest registration', 'skipped (see warning)')
    return
  }
  step('postgrest registration', alreadyRegistered ? 'already present' : 'created')
}

async function ensureJwtSecret(projectId: string): Promise<void> {
  const before = await prisma.project.findUnique({ where: { id: projectId }, select: { jwtSecret: true } })
  await JWTSecretManager.getOrCreateSecret(projectId)
  step('project jwt secret', before?.jwtSecret ? 'already present' : 'created')
}

async function ensureAnonKey(projectId: string): Promise<void> {
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { anonKey: true } })
  if (project?.anonKey) return step('anon key', 'already present')

  const anonKey = `sk_live_${randomBytes(32).toString('hex')}`
  const keyHash = createHash('sha256').update(anonKey).digest('hex')
  await prisma.$transaction([
    prisma.apiKey.create({
      data: {
        name: 'Anon Key',
        keyHash,
        keyPrefix: anonKey.substring(0, 16),
        keyType: 'public',
        role: 'client',
        permissions: ['read', 'write'],
        capabilities: ['database', 'auth', 'storage', 'functions'],
        serviceRole: false,
        projectId,
        userId: (await prisma.project.findUnique({ where: { id: projectId }, select: { userId: true } }))!.userId!,
        rateLimit: 1000,
      },
    }),
    prisma.project.update({ where: { id: projectId }, data: { anonKey } }),
  ])
  step('anon key', 'created')
}

async function ensureDirectAccessRoles(projectId: string): Promise<void> {
  const status = await getDirectAccessStatus(projectId)
  const modes = new Set(status.credentials.map(c => c.mode))
  for (const mode of ['READ_ONLY', 'READ_WRITE'] as const) {
    if (modes.has(mode)) {
      step(`direct access role (${mode})`, 'already present')
      continue
    }
    // Rotating an existing credential on every rerun would invalidate
    // connection strings the operator is already using, so this only ever
    // provisions what is missing.
    //
    // Best effort, because this is the one step bootstrap CANNOT perform on
    // its own: role creation is delegated to SECURITY DEFINER functions that a
    // superuser installs once via scripts/setup-direct-access.sql. Backenly is
    // fully operational without them — they exist so an operator can hand out
    // a psql connection string — so a missing installer must not fail the
    // whole bootstrap and leave the project half provisioned.
    try {
      await provisionDirectAccess(projectId, mode)
      step(`direct access role (${mode})`, 'created')
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const missingInstaller = /backenly_direct_create_role.*does not exist/s.test(message)
      console.warn(
        `  ! direct access role (${mode}) not provisioned: ` +
          (missingInstaller
            ? 'the privileged helpers are not installed.\n' +
              '    Run as a superuser, then rerun bootstrap:\n' +
              '      psql -d <database> -f scripts/setup-direct-access.sql\n' +
              '    Everything else below is provisioned and the deployment is usable.'
            : message.split('\n')[0])
      )
      needs(
        `privileged role helpers are not installed, so ${mode} database access is unavailable`,
        'psql -d <database> -f scripts/setup-direct-access.sql   (as a superuser), then rerun: npm run bootstrap'
      )
      step(`direct access role (${mode})`, 'skipped (see warning)')
    }
  }
}

async function main(): Promise<void> {
  console.log('')
  console.log('  Backenly bootstrap — provisioning THE project for this deployment')
  console.log('')

  const { id, existed } = await resolveTheProjectId()
  const ownerId = await resolveOwnerId()

  await ensureProject(id, existed, ownerId)
  await ensureBackendGraph(id)
  await ensureWorkspaceSchema(id, ownerId)
  await ensurePostgrestRegistration(id)
  await ensureJwtSecret(id)
  if (ownerId) await ensureAnonKey(id)
  await ensureDirectAccessRoles(id)

  // Postcondition. If anything above created a second project this must fail
  // here rather than at the first request, which is where the old code would
  // have discovered it.
  const finalCount = await prisma.project.count()
  if (finalCount !== 1) {
    throw new BootstrapRefusal(
      'BACKENLY_SINGLE_TENANT_INVALID_DATABASE',
      `Expected exactly one project after bootstrap but found ${finalCount}.`
    )
  }

  const width = Math.max(...log.map(([w]) => w.length))
  for (const [what, outcome] of log) console.log(`  ${what.padEnd(width)}   ${outcome}`)
  console.log('')
  console.log(`  Project: ${id}`)

  // Readiness is a state machine with two terminal states, and they are not the
  // same thing. Bootstrapping the core while PostgREST or the privileged role
  // helpers are absent leaves a deployment whose data plane answers PGRST106,
  // which is emphatically not "installed and ready". Saying so, and exiting
  // non-zero, is what stops deployment automation reading a warning-laden
  // success as a green light.
  if (pending.length > 0) {
    console.log('')
    console.log('  Backenly core bootstrapped. NOT yet ready — unmet prerequisites:')
    console.log('')
    for (const p of pending) {
      console.log(`    x  ${p.what}`)
      console.log(`       ${p.fix}`)
    }
    console.log('')
    console.log('  Rerun `npm run bootstrap` afterwards. It is idempotent and will')
    console.log('  provision only what is still missing.')
    console.log('')
    process.exitCode = 3 // BACKENLY_BOOTSTRAP_INCOMPLETE
    return
  }
  if (!process.env.BACKENLY_PROJECT_ID) {
    console.log('')
    console.log('  Pin this in .env so the identity of this deployment cannot drift:')
    console.log('')
    console.log(`    BACKENLY_EDITION=single-tenant`)
    console.log(`    BACKENLY_PROJECT_ID=${id}`)
  }
  if (!ownerId) {
    console.log('')
    console.log('  No user account exists yet. Sign up, then rerun bootstrap to issue')
    console.log('  the anon key your frontend embeds.')
    console.log('')
    return
  }

  console.log('')
  console.log('  Backenly is ready.')
  console.log('')
}

main()
  .then(() => prisma.$disconnect())
  .catch(async err => {
    await prisma.$disconnect().catch(() => {})
    if (err instanceof BootstrapRefusal) {
      console.error('')
      console.error(`  ${err.message}`)
      console.error('')
      process.exit(2)
    }
    console.error(err)
    process.exit(1)
  })
