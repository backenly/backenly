/**
 * Probe fixtures — prove each detector can FIRE.
 *
 * These are the three probes that could not be verified against a live project,
 * each for a structural reason:
 *
 *   growing_tables_have_archival_plan    gated at 1000 rows via pg_class.reltuples
 *   api_coverage_is_complete             needs a deliberately broken API definition
 *   external_schema_changes_are_adopted  needs a pending schema-drift event
 *
 * Rather than leave them "unverified" forever, each fixture constructs the
 * violating state directly, asserts the probe fires, then asserts it goes quiet
 * once the violation is removed. Both halves matter: a detector that always
 * fires is as useless as one that never does.
 *
 * Requires a real PostgreSQL — CI provides one as a service container. Per
 * CLAUDE.md the database is never mocked; mocks here would defeat the entire
 * purpose, since what is being tested IS the SQL.
 */

import { PrismaClient } from '@prisma/client'
import { randomUUID } from 'crypto'

import { detectStaleDataOverflow } from '@/lib/autonomy/invariant-probes'
import { detectApiCoverageGaps, detectTablesWithNoApiDefinition } from '@/lib/core/drift-detector'
import { detectPendingSchemaDrift } from '@/lib/autonomy/drift-watch'

const prisma = new PrismaClient()

// A real project row + its workspace schema, torn down afterwards.
let projectId: string
let userId: string
let schema: string

const q = (sql: string) => prisma.$executeRawUnsafe(sql)

beforeAll(async () => {
  userId = randomUUID()
  projectId = randomUUID()
  schema = `workspace_${projectId}`

  await prisma.user.create({
    data: {
      id: userId,
      email: `probe-fixtures+${userId.slice(0, 8)}@backenly.test`,
      name: 'probe fixtures',
      password: 'not-a-real-hash',
    },
  })
  await prisma.project.create({
    data: { id: projectId, name: 'probe-fixtures', userId },
  })
  await q(`CREATE SCHEMA IF NOT EXISTS "${schema}"`)
}, 60_000)

afterAll(async () => {
  await q(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
  await prisma.project.deleteMany({ where: { id: projectId } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: userId } }).catch(() => {})
  await prisma.$disconnect()
}, 60_000)

// ── growing_tables_have_archival_plan ────────────────────────────────────────

describe('detectStaleDataOverflow', () => {
  // Name must match ARCHIVAL_PATTERNS (session|log|audit|event|notification|message).
  const table = 'activity_logs'

  it('FIRES for a large log-shaped table with no archival cron', async () => {
    await q(`CREATE TABLE "${schema}"."${table}" (id serial PRIMARY KEY, body text)`)
    // The probe reads pg_class.reltuples, which is populated by ANALYZE — not
    // by the insert itself. Seeding without analysing would leave reltuples at
    // 0 and the probe correctly silent, which would look like a dead probe.
    await q(
      `INSERT INTO "${schema}"."${table}" (body)
       SELECT 'row ' || g FROM generate_series(1, 1500) g`,
    )
    await q(`ANALYZE "${schema}"."${table}"`)

    const findings = await detectStaleDataOverflow(projectId)
    const hit = findings.find((f) => (f.details as any)?.tableName === table)

    expect(hit).toBeDefined()
    expect(hit!.type).toBe('missing_archival_job')
    expect((hit!.details as any).rowCount).toBeGreaterThanOrEqual(1000)
  }, 120_000)

  it('goes QUIET once an archival cron exists for that table', async () => {
    await prisma.appTrigger.create({
      data: {
        projectId,
        name: `archive_${table}`,
        sourceTable: table,
        event: 'schedule',
        actionType: 'cron',
        enabled: true,
      },
    })

    const findings = await detectStaleDataOverflow(projectId)
    expect(findings.find((f) => (f.details as any)?.tableName === table)).toBeUndefined()
  }, 120_000)

  it('stays silent for a small table even without a cron', async () => {
    const small = 'session_events'
    await q(`CREATE TABLE "${schema}"."${small}" (id serial PRIMARY KEY)`)
    await q(`ANALYZE "${schema}"."${small}"`)

    const findings = await detectStaleDataOverflow(projectId)
    expect(findings.find((f) => (f.details as any)?.tableName === small)).toBeUndefined()
  }, 60_000)
})

// ── every_table_has_an_api / api_coverage_is_complete ────────────────────────

/**
 * missing_api_definition is RETIRED and must stay silent.
 *
 * These used to assert the probe fires for a table with no ApiDefinition. That
 * contract is gone: executeGenerateAPI no longer writes ApiDefinition rows, and
 * exposure is decided by the catalog and the grants (lib/postgrest/exposure.ts),
 * so a probe keyed on their absence would flag every table on every healthy
 * project forever — exactly what the finding-evidence policy forbids. See the
 * block comment on detectTablesWithNoApiDefinition for the full history.
 *
 * The probe has already been stubbed → revived → stubbed again, so these are
 * kept as a revival guard rather than deleted, and are deliberately built from
 * the exact fixture that used to fire.
 */
describe('detectTablesWithNoApiDefinition (retired — silence is the contract)', () => {
  it('stays silent for a table with no ApiDefinition, the shape that used to fire', async () => {
    await q(`CREATE TABLE "${schema}"."widgets" (id serial PRIMARY KEY, name text)`)

    // Precondition: if the probe were live, the absence of a definition for
    // this table is precisely what it would key on.
    await expect(
      prisma.apiDefinition.count({ where: { projectId, name: 'widgets' } }),
    ).resolves.toBe(0)

    expect(await detectTablesWithNoApiDefinition(projectId)).toEqual([])
  }, 60_000)

  it('stays silent for the platform-managed users table', async () => {
    await q(`CREATE TABLE "${schema}"."users" (id uuid PRIMARY KEY, email text)`)

    expect(await detectTablesWithNoApiDefinition(projectId)).toEqual([])
  }, 60_000)
})

describe('detectApiCoverageGaps', () => {
  it('FIRES for an API definition missing CRUD operations', async () => {
    const table = await prisma.table.create({
      data: { projectId, name: 'partials', schema, description: 'fixture' },
    })
    await prisma.apiDefinition.create({
      data: {
        projectId,
        tableId: table.id,
        name: 'partials',
        basePath: '/partials',
        enabled: true,
        // Read-only: no create/update/delete — a real coverage gap.
        operations: { get: true, list: true },
        endpoints: [{ method: 'GET', path: '/partials' }],
      },
    })

    const findings = await detectApiCoverageGaps(projectId)
    expect(findings.length).toBeGreaterThan(0)
    expect(JSON.stringify(findings)).toContain('partials')
  }, 60_000)

  it('goes QUIET for a definition with complete CRUD', async () => {
    const table = await prisma.table.create({
      data: { projectId, name: 'complete', schema, description: 'fixture' },
    })
    await prisma.apiDefinition.create({
      data: {
        projectId,
        tableId: table.id,
        name: 'complete',
        basePath: '/complete',
        enabled: true,
        operations: { get: true, list: true, create: true, update: true, delete: true },
        endpoints: [
          { method: 'GET', path: '/complete' },
          { method: 'POST', path: '/complete' },
          { method: 'PUT', path: '/complete/:id' },
          { method: 'DELETE', path: '/complete/:id' },
        ],
      },
    })

    const findings = await detectApiCoverageGaps(projectId)
    expect(findings.find((f) => (f.details as any)?.tableName === 'complete')).toBeUndefined()
  }, 60_000)
})

// ── external_schema_changes_are_adopted ──────────────────────────────────────

describe('detectPendingSchemaDrift', () => {
  it('stays silent when there is no pending drift', async () => {
    expect(await detectPendingSchemaDrift(projectId)).toHaveLength(0)
  }, 60_000)

  it('FIRES when DDL ran outside the platform and is still unadopted', async () => {
    await prisma.schemaDriftEvent.create({
      data: {
        projectId,
        roleName: `backenly_rw_${projectId.slice(0, 8)}`,
        commandTag: 'CREATE TABLE',
        objectIdentity: `${schema}.made_by_psql`,
        status: 'pending',
      },
    })

    const findings = await detectPendingSchemaDrift(projectId)
    expect(findings.length).toBeGreaterThan(0)
    expect(JSON.stringify(findings)).toMatch(/CREATE TABLE|made_by_psql/)
  }, 60_000)

  it('goes QUIET once the drift is adopted', async () => {
    await prisma.schemaDriftEvent.updateMany({
      where: { projectId, status: 'pending' },
      data: { status: 'adopted' },
    })

    expect(await detectPendingSchemaDrift(projectId)).toHaveLength(0)
  }, 60_000)
})
