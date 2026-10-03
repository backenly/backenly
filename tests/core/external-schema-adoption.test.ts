/**
 * ADOPTION MUST NOT DESTROY WHAT IT CANNOT SEE
 * =============================================
 *
 * `adoptExternalSchema` reconciles platform metadata against the live schema
 * after somebody changes the database directly over psql. Step 3 prunes
 * `Table` rows whose physical table is gone, and `ApiDefinition` cascades from
 * `Table`.
 *
 * The live set it prunes against comes from:
 *
 *     .catch(() => [] as Array<{ table_name: string }>)
 *
 * So a failed catalog read is indistinguishable from "this schema contains no
 * tables", and the prune loop then deletes the metadata and generated APIs for
 * every table the project has. Same for step 0: `syncDirectAccessGrants` is
 * wrapped in a bare catch, and it is the step that makes externally-created
 * tables VISIBLE to `backenly_user` at all — `information_schema` filters by
 * privilege, so failing it silently shrinks the live set the prune trusts.
 *
 * That is the fabricated-evidence pattern this audit has found everywhere
 * else, except here the consequence is destructive rather than merely
 * untruthful: an empty observation is being read as an authoritative absence.
 *
 * These tests run against a real database because the claim is about what
 * rows survive.
 */

import { PrismaClient } from '@prisma/client'
import { randomUUID } from 'crypto'

import { adoptExternalSchema } from '@/lib/autonomy/drift-watch'

// The autonomous path now enforces the deployment's live-execution flag at the
// mutation boundary. `runAutoFix` never checked it before — only `runReconciler`
// did — so a test calling `runReconcilerLive` directly could execute while the
// operator's emergency lever was off. Setting it here keeps these suites testing
// what they are for (executor and verification semantics) rather than the flag.
process.env.ENABLE_AUTONOMY_RECONCILER = 'true'
process.env.ENABLE_AUTONOMY_LIVE_EXECUTION = 'true'

const prisma = new PrismaClient()
const q = (sql: string) => prisma.$executeRawUnsafe(sql)

let userId: string
let projectId: string
let schema: string

const tableNames = async () =>
  (await prisma.table.findMany({ where: { projectId }, select: { name: true } }))
    .map(t => t.name)
    .sort()

beforeAll(async () => {
  userId = randomUUID()
  projectId = randomUUID()
  schema = `workspace_${projectId}`

  await prisma.user.create({
    data: {
      id: userId,
      email: `adopt+${userId.slice(0, 8)}@backenly.test`,
      name: 'adoption fixture',
      password: 'not-a-real-hash',
    },
  })
  await prisma.project.create({ data: { id: projectId, name: 'adoption-fixture', userId } as any })
  await prisma.workspace.create({
    data: { name: 'adoption-fixture', projectId, postgresSchema: schema } as any,
  })
}, 240_000)

afterAll(async () => {
  await q(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
  await prisma.schemaDriftEvent.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.auditLog.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.table.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.workspace.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.project.deleteMany({ where: { id: projectId } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: userId } }).catch(() => {})
  await prisma.$disconnect()
}, 240_000)

afterEach(async () => {
  await prisma.table.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.schemaDriftEvent.deleteMany({ where: { projectId } }).catch(() => {})
})

describe('an unreadable schema is not an empty one', () => {
  it('does not prune every table when the live set cannot be established', async () => {
    // The project has real metadata and real generated APIs...
    for (const n of ['orders', 'invoices', 'customers']) {
      await prisma.table.create({ data: { projectId, name: n, schema, description: 'fixture' } })
    }
    expect(await tableNames()).toEqual(['customers', 'invoices', 'orders'])

    // ...and the workspace schema does not exist, which is exactly what a
    // failed catalog read looks like from inside the prune loop: an empty
    // live set. No DROP SCHEMA is needed to stage this - it has simply never
    // been created, which is a real state for a project mid-provisioning.
    await q(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})

    const r = await adoptExternalSchema(projectId)

    // THE assertion. Before the fix this deleted all three, and their
    // ApiDefinition rows with them, because "I saw nothing" was read as
    // "there is nothing".
    expect(await tableNames()).toEqual(['customers', 'invoices', 'orders'])
    expect(r.prunedTables).toEqual([])
    expect(r.outcome).not.toBe('adopted')
  }, 300_000)

  it('still prunes a table that genuinely went away', async () => {
    // The inverse, so the guard above cannot be a detector that never fires.
    await q(`CREATE SCHEMA IF NOT EXISTS "${schema}"`)
    await q(`CREATE TABLE "${schema}"."kept" (id uuid PRIMARY KEY)`)
    for (const n of ['kept', 'dropped_outside']) {
      await prisma.table.create({ data: { projectId, name: n, schema, description: 'fixture' } })
    }

    const r = await adoptExternalSchema(projectId)

    expect(r.prunedTables).toEqual(['dropped_outside'])
    expect(await tableNames()).toEqual(['kept'])
  }, 300_000)

  it('DOES prune when the schema is readable and genuinely empty', async () => {
    // The semantic boundary the whole patch rests on.
    //
    //   readable schema + zero tables      -> a legitimate empty live set
    //   unreadable / missing / indeterminate -> destructive prune forbidden
    //
    // Without this case the guard could be "never prune when the set is
    // empty", which would leave a project that really did drop everything
    // externally with metadata and generated APIs for tables that are gone.
    await q(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
    await q(`CREATE SCHEMA "${schema}"`)
    await prisma.table.create({ data: { projectId, name: 'all_gone', schema, description: 'fixture' } })

    const r = await adoptExternalSchema(projectId)

    expect(r.outcome).toBe('adopted')
    expect(r.prunedTables).toEqual(['all_gone'])
    expect(await tableNames()).toEqual([])
  }, 300_000)
})

describe('adoption reports what it actually achieved', () => {
  it('does not mark events adopted when a required step could not run', async () => {
    await q(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
    await prisma.schemaDriftEvent.create({
      data: {
        projectId,
        roleName: 'external_rw',
        commandTag: 'CREATE TABLE',
        objectIdentity: `${schema}.late_arrival`,
        schemaName: schema,
        status: 'pending',
      } as any,
    })

    const r = await adoptExternalSchema(projectId)

    // The event stays pending. Marking it adopted would retire the only
    // record that this drift was ever noticed.
    const pending = await prisma.schemaDriftEvent.count({
      where: { projectId, status: 'pending' },
    })
    expect(pending).toBe(1)
    expect(r.adoptedEvents).toBe(0)
    expect(r.outcome).toBe('unverified')
    expect(r.reason).toMatch(/could not establish/i)
  }, 300_000)

  it('marks them adopted when the reconciliation really completed', async () => {
    await q(`CREATE SCHEMA IF NOT EXISTS "${schema}"`)
    await q(`CREATE TABLE "${schema}"."settled" (id uuid PRIMARY KEY)`)
    await prisma.table.create({ data: { projectId, name: 'settled', schema, description: 'fixture' } })
    await prisma.schemaDriftEvent.create({
      data: {
        projectId,
        roleName: 'external_rw',
        commandTag: 'CREATE TABLE',
        objectIdentity: `${schema}.settled`,
        schemaName: schema,
        status: 'pending',
      } as any,
    })

    const r = await adoptExternalSchema(projectId)

    expect(r.outcome).toBe('adopted')
    expect(r.adoptedEvents).toBe(1)
    expect(
      await prisma.schemaDriftEvent.count({ where: { projectId, status: 'pending' } }),
    ).toBe(0)
  }, 300_000)
})
