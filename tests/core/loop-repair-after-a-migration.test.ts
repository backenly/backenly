/**
 * A repair the loop makes right after a migration is a governed change of its
 * own, made by Backenly, and a person can restore both, newest first.
 *
 * apply_migration runs its steps inside the migration's governed change, and
 * an add_column step kicks the repair loop (a timer, 1.5 s later). The timer
 * inherited the migration's async context, so the loop's fix found the
 * migration's change still "open", joined it after it had closed, and was
 * recorded nowhere. The index it made then blocked restoring the migration
 * ("changed since"), with no change of its own to restore first. It also
 * inherited the agent's attribution.
 *
 * Real PostgreSQL, real migration dispatch, the real event kick and loop; only
 * the model call is stubbed, and it must never be reached.
 */
import crypto from 'crypto'
import { prisma } from '@/lib/db/prisma'
import { createProvisionedProject } from '@/lib/projects/provision'
import { applyMigrationToMain } from '@/lib/mcp/apply-migration'
import { withChangeAttribution } from '@/lib/changes/attribution'
import { recoverChange } from '@/lib/changes/recovery'

jest.mock('@/lib/ai/llm/chat', () => ({
  ...jest.requireActual('@/lib/ai/llm/chat'),
  chat: jest.fn(),
}))
import { chat } from '@/lib/ai/llm/chat'

process.env.ENABLE_AUTONOMY_RECONCILER = 'true'
process.env.ENABLE_AUTONOMY_LIVE_EXECUTION = 'true'

let ownerId: string
let planId: string
let projectId: string
let schema: string
let apiKeyId: string
const originalEngineMode = process.env.ENGINE_MODE
const originalEdition = process.env.BACKENLY_EDITION

/** As an agent's apply_migration runs: attributed to its key and its owner. */
const migrate = (sql: string) =>
  withChangeAttribution({ source: 'mcp', actorUserId: ownerId, apiKeyId }, () =>
    applyMigrationToMain(projectId, ownerId, sql, { workspaceSchema: schema, agentSurface: true }))

async function indexed(table: string, column: string): Promise<boolean> {
  const rows = await prisma.$queryRawUnsafe<Array<{ n: number }>>(
    `SELECT count(*)::int AS n
       FROM pg_index i
       JOIN pg_class c     ON c.oid = i.indrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = i.indkey[0]
      WHERE n.nspname = $1 AND c.relname = $2 AND a.attname = $3`,
    schema, table, column,
  )
  return rows[0].n > 0
}

async function columns(table: string): Promise<string[]> {
  const rows = await prisma.$queryRawUnsafe<Array<{ column_name: string }>>(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY column_name`,
    schema, table,
  )
  return rows.map((r) => r.column_name)
}

/** The loop's confirmed repair of `column`, once it has recorded one. */
async function repairOf(column: string, byMs: number): Promise<Record<string, unknown>> {
  for (;;) {
    const rows = await prisma.auditLog.findMany({ where: { projectId, action: 'HEALTH_AUTO_FIXED' }, select: { details: true } })
    const found = rows.map((r) => JSON.parse(String(r.details))).find((d) => d.columnName === column)
    if (found) return found
    if (Date.now() > byMs) throw new Error(`the loop made no repair of ${column}`)
    await new Promise((r) => setTimeout(r, 500))
  }
}

beforeAll(async () => {
  process.env.ENGINE_MODE = 'runtime'
  process.env.BACKENLY_EDITION = 'cloud'
  ownerId = (await prisma.user.create({
    data: { email: `loop-after-migration-${crypto.randomUUID()}@example.test`, password: 'test-only-hash', name: 'loop after a migration' },
  })).id
  // What seed-billing gives every tier: 1-minute cadence, AGGRESSIVE ceiling.
  planId = (await prisma.plan.create({
    data: { name: `LOOP_AFTER_MIGRATION_${ownerId.slice(0, 8)}`, priceCents: 0, autonomyScanIntervalMin: 1, autonomyMaxLevel: 'AGGRESSIVE', autonomyMaxActionsPerWindow: null } as any,
  })).id
  await prisma.subscription.create({ data: { userId: ownerId, planId, status: 'ACTIVE' } as any })
  const project = await createProvisionedProject({ name: 'loop-after-migration', userId: ownerId })
  projectId = project.id
  schema = project.postgresSchema
  await prisma.project.update({ where: { id: projectId }, data: { protectedProduction: false, autonomyLevel: 'AGGRESSIVE' } as any })
  // The agent's key, as an MCP call carries it.
  apiKeyId = (await prisma.apiKey.create({
    data: { name: 'agent', keyPrefix: 'bk_test', userId: ownerId, projectId, scope: 'mcp', keyHash: crypto.randomBytes(16).toString('hex') },
    select: { id: true },
  })).id
  // Made directly, not by a migration: the only kick is the one under test, so
  // the loop's one-minute cadence floor cannot have been spent already.
  await prisma.$executeRawUnsafe(`CREATE TABLE "${schema}"."notes" (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), body text)`)
  await prisma.table.create({ data: { projectId, name: 'notes', schema, description: 'fixture' } })
}, 120_000)

afterAll(async () => {
  expect(jest.mocked(chat)).not.toHaveBeenCalled()
  if (schema) await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
  if (projectId) {
    await prisma.healthFinding.deleteMany({ where: { projectId } }).catch(() => {})
    await prisma.auditLog.deleteMany({ where: { projectId } }).catch(() => {})
    await prisma.table.deleteMany({ where: { projectId } }).catch(() => {})
  }
  if (ownerId) {
    await prisma.project.deleteMany({ where: { userId: ownerId } })
    await prisma.subscription.deleteMany({ where: { userId: ownerId } })
    await prisma.plan.deleteMany({ where: { id: planId } })
    await prisma.platformNotification.deleteMany({ where: { userId: ownerId } }).catch(() => {})
    await prisma.user.delete({ where: { id: ownerId } })
  }
  if (originalEngineMode === undefined) delete process.env.ENGINE_MODE
  else process.env.ENGINE_MODE = originalEngineMode
  if (originalEdition === undefined) delete process.env.BACKENLY_EDITION
  else process.env.BACKENLY_EDITION = originalEdition
}, 60_000)

describe('the loop, kicked by a migration', () => {
  let migration: { id: string; seq: number }
  let loopChanges: Array<{ id: string; seq: number }>

  it("records its repair as a change of its own, Backenly's, not the agent's", async () => {
    // With a DEFAULT, ADD COLUMN adds the column exactly as written, unindexed:
    // a reference-like column with no index (missing_fk_index, Tier 0).
    const added = await migrate('ALTER TABLE notes ADD COLUMN author_id uuid DEFAULT NULL')
    expect(added.ok).toBe(true)
    migration = (added as any).change
    expect(migration?.seq).toBeGreaterThan(0)

    const repair = await repairOf('author_id', Date.now() + 90_000)
    expect(repair).toMatchObject({ tableName: 'notes', verification: 'confirmed' })
    expect(await indexed('notes', 'author_id')).toBe(true)

    const later = await prisma.backendChange.findMany({
      where: { projectId, seq: { gt: migration.seq } },
      orderBy: { seq: 'desc' },
      select: { id: true, seq: true, kind: true, source: true, groupId: true, actorUserId: true, apiKeyId: true, status: true },
    })
    loopChanges = later.filter((c) => c.groupId?.startsWith(`fix:${repair.findingId}:`))
    expect(loopChanges.length).toBeGreaterThan(0)
    for (const c of loopChanges) {
      expect(c).toMatchObject({ kind: 'change', source: 'autonomy', actorUserId: null, apiKeyId: null, status: 'healthy' })
    }
    // And nothing else the loop did is folded into the migration's own record.
    const own = await prisma.backendChange.findUniqueOrThrow({ where: { id: migration.id }, select: { source: true, apiKeyId: true } })
    expect(own).toMatchObject({ source: 'mcp', apiKeyId })

    // Its record holds its own statements, not the migration's: the capture the
    // migration opened is not the repair's (lib/execution/sql-recorder.ts).
    const recorded = await prisma.backendChange.findMany({ where: { id: { in: loopChanges.map((c) => c.id) } }, select: { statements: true } })
    const sqls = recorded.flatMap((r) => ((r.statements as Array<{ sql: string }> | null) ?? []).map((s) => s.sql))
    expect(sqls.some((s) => /CREATE\s+INDEX/i.test(s))).toBe(true)
    expect(sqls.some((s) => /ADD\s+COLUMN\s+author_id/i.test(s))).toBe(false)
    expect(JSON.stringify(repair)).not.toMatch(/ADD\s+COLUMN\s+author_id/i)
  }, 180_000)

  it('a person restores the migration after the repair, newest first', async () => {
    // The repair is a later change to the table: the migration is not restored under it.
    const refused = await recoverChange(projectId, migration.id, { mode: 'manual', actorUserId: ownerId })
    expect(refused.ok).toBe(false)
    expect(await columns('notes')).toContain('author_id')

    for (const c of loopChanges) {
      expect(await recoverChange(projectId, c.id, { mode: 'manual', actorUserId: ownerId })).toMatchObject({ ok: true })
    }
    expect(await indexed('notes', 'author_id')).toBe(false)
    expect(await recoverChange(projectId, migration.id, { mode: 'manual', actorUserId: ownerId })).toMatchObject({ ok: true })
    expect(await columns('notes')).toEqual(['body', 'id'])
  }, 180_000)
})
