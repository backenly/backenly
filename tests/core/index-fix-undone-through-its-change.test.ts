/**
 * AN INDEX FIX IS UNDONE THROUGH THE CHANGE IT RECORDED
 * ----------------------------------------------------
 * Approving a slow-query index runs CREATE INDEX as a governed change, recorded
 * in History (lib/changes/ledger.ts), which History can restore. The fix's
 * card said "Backenly kept no earlier state for what this fix changed, so it
 * cannot be undone automatically", directly under the finding's own "Adding
 * the index changes no data and is reversible" (production QA, 2026-11-16):
 * Undo was decided by whether the finding type takes a schema snapshot, and
 * slow_query_missing_index does not.
 */
import { describe, test, expect, beforeAll, afterAll } from '@jest/globals'
import { randomUUID } from 'crypto'
import { prisma } from '@/lib/db/prisma'
import { executeApprovedFix, revertAutoFix, revertEligibility } from '@/lib/core/auto-fix-engine'

const q = (sql: string) => prisma.$executeRawUnsafe(sql)
const engineMode = process.env.ENGINE_MODE

let userId: string
let projectId: string
let schema: string
let findingId: string

async function indexed(table: string, column: string): Promise<boolean> {
  const rows = await prisma.$queryRawUnsafe<Array<{ n: number }>>(`
    SELECT count(*)::int AS n
      FROM pg_index i
      JOIN pg_class c     ON c.oid = i.indrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY(i.indkey)
     WHERE n.nspname = '${schema}' AND c.relname = '${table}' AND a.attname = '${column}'`)
  return rows[0].n > 0
}

beforeAll(async () => {
  // History records governed changes only when the engine runs for real.
  process.env.ENGINE_MODE = 'runtime'
  userId = randomUUID()
  await prisma.user.create({ data: { id: userId, email: `index-undo+${userId.slice(0, 8)}@backenly.test`, name: 'index undo', password: 'not-a-real-hash' } })
  projectId = randomUUID()
  schema = `workspace_${projectId}`
  await prisma.project.create({ data: { id: projectId, name: 'index-undo', userId } as any })
  await q(`CREATE SCHEMA "${schema}"`)
  await q(`CREATE TABLE "${schema}"."product_views" (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), referrer text)`)
  await q(`INSERT INTO "${schema}"."product_views" (referrer) SELECT 'https://ref' || (i % 60) || '.example.com' FROM generate_series(1, 1000) i`)
  await q(`ANALYZE "${schema}"."product_views"`)
  await prisma.table.create({ data: { projectId, name: 'product_views', schema } as any })
  findingId = (await prisma.healthFinding.create({
    data: {
      projectId,
      type: 'slow_query_missing_index',
      severity: 'warning',
      status: 'pending_approval',
      autoFixed: false,
      details: {
        reason: 'Queries filtering "product_views"."referrer" are averaging 180ms across 40 calls, and that column has no index. Adding the index changes no data and is reversible.',
        location: 'product_views.referrer',
        tableName: 'product_views',
        columnName: 'referrer',
        avgMs: 180,
        calls: 40,
        source: 'pg_stat_statements',
      } as any,
    },
  })).id
}, 120_000)

afterAll(async () => {
  process.env.ENGINE_MODE = engineMode
  await q(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
  await prisma.healthFinding.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.auditLog.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.table.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.workspaceSchemaSnapshot.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.project.deleteMany({ where: { id: projectId } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: userId } }).catch(() => {})
}, 120_000)

describe('an approved slow-query index', () => {
  test('is built, and the change it made is recorded', async () => {
    const applied = await executeApprovedFix(findingId, projectId)
    expect(applied.success).toBe(true)
    expect(await indexed('product_views', 'referrer')).toBe(true)
    // Kept on the finding as the approve route keeps it
    // (app/api/projects/[id]/health/approve/route.ts).
    const before = await prisma.healthFinding.findUniqueOrThrow({ where: { id: findingId } })
    await prisma.healthFinding.update({
      where: { id: findingId },
      data: {
        status: 'auto_fixed',
        autoFixed: true,
        fixAppliedAt: new Date(),
        details: { ...(before.details as Record<string, unknown>), rollbackData: { ...(applied.rollbackData ?? {}), approvedBy: userId } } as any,
      },
    })
    expect(applied.rollbackData).toMatchObject({ rollbackFormat: 3, schemaTouching: false })
    expect((applied.rollbackData!.changeIds as string[]).length).toBeGreaterThan(0)
  }, 120_000)

  test('can be undone, as its card says', async () => {
    const finding = await prisma.healthFinding.findUniqueOrThrow({ where: { id: findingId } })
    expect(revertEligibility(finding.type, finding.details as Record<string, unknown>)).toMatchObject({ revertible: true })
  })

  test('is undone through that change, and the index is gone', async () => {
    const res = await revertAutoFix(findingId, projectId)
    expect(res.success).toBe(true)
    expect(await indexed('product_views', 'referrer')).toBe(false)
  }, 120_000)
})
