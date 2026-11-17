/**
 * WHAT THE LOOP FLAGS ABOUT WHO CAN READ AND WRITE A TABLE
 * ========================================================
 * Production QA (2026-11-16): `product_views` had RLS on and one policy,
 * SELECT USING (true), so anyone holding the publishable key read its session
 * ids and referrers. The loop said nothing: its only check for an always-true
 * policy looked at tables with a user_id/owner_id column.
 *
 * Two additions, after Supabase's database linter (supabase/splinter, Apache-2.0):
 *   - 0023 sensitive_columns_exposed: a table the publishable key can read in
 *     full that holds a column named like a credential or personal data. Told
 *     to the owner, never repaired: who may read a table is theirs to decide.
 *   - 0024 rls_policy_always_true: an INSERT, UPDATE, DELETE or ALL policy whose
 *     condition is always true opens writes to everyone it covers, whatever
 *     the table holds, so it is flagged on tables with no owner column too. A
 *     SELECT USING (true) alone stays unflagged there: public reads are usually
 *     meant.
 *
 * Real PostgreSQL and the real observer.
 */

import { PrismaClient } from '@prisma/client'
import { randomUUID } from 'crypto'
import { detectOverPermissiveRls, detectSensitiveColumnsAnyoneCanRead } from '@/lib/core/drift-detector'
import { runObserverForProject } from '@/lib/services/workspace-observer'
import { classifyFix } from '@/lib/core/fix-classifier'
import { buildFixAction, getManualRemediationHint } from '@/lib/core/fix-actions'
import { summariseFinding } from '@/lib/core/finding-summaries'
import { categoryOf } from '@/lib/core/finding-groups'

const prisma = new PrismaClient()
const userId = randomUUID()
const projectId = randomUUID()
const schema = `workspace_${projectId}`
const raw = (sql: string) => prisma.$executeRawUnsafe(sql)

/** A table with RLS on and the given policies, readable by the publishable key's role. */
async function table(name: string, columns: string, policies: string[]) {
  await raw(`CREATE TABLE "${schema}"."${name}" (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), ${columns})`)
  await raw(`ALTER TABLE "${schema}"."${name}" ENABLE ROW LEVEL SECURITY`)
  for (const p of policies) await raw(p.replace('$T', `"${schema}"."${name}"`))
  await raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON "${schema}"."${name}" TO anon, authenticated`)
  await prisma.table.create({ data: { name, projectId } })
}

beforeAll(async () => {
  await prisma.user.create({ data: { id: userId, email: `exposed+${userId.slice(0, 8)}@backenly.test`, name: 'exposed', password: 'x' } })
  await prisma.project.create({ data: { id: projectId, name: 'exposed', userId, jwtSecret: 'a'.repeat(64) } })
  await raw(`CREATE SCHEMA "${schema}"`)
  // The re-test's table: analytics, public read, session ids in it.
  await table('product_views', 'session_id text, referrer text, product_id uuid', [
    'CREATE POLICY backenly_public_read_select ON $T FOR SELECT USING (true)',
  ])
  // Public on purpose and nothing sensitive in it.
  await table('products', 'name text, price numeric', [
    'CREATE POLICY backenly_public_read_select ON $T FOR SELECT USING (true)',
  ])
  // Sensitive, but its read policy is a real condition.
  await table('devices', 'imei text, label text', [
    'CREATE POLICY only_labelled ON $T FOR SELECT USING (label IS NOT NULL)',
  ])
  // Anyone may change any row, and no column says whose a row is.
  await table('guestbook', 'message text', [
    'CREATE POLICY anyone_reads ON $T FOR SELECT USING (true)',
    'CREATE POLICY anyone_edits ON $T FOR UPDATE USING (true)',
  ])
}, 60_000)

afterAll(async () => {
  await raw(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
  await prisma.healthFinding.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.auditLog.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.table.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.project.delete({ where: { id: projectId } }).catch(() => {})
  await prisma.user.delete({ where: { id: userId } }).catch(() => {})
  await prisma.$disconnect()
}, 60_000)

describe('a sensitive column anyone with the publishable key can read', () => {
  test('is found on the table that holds one, and only there', async () => {
    const found = await detectSensitiveColumnsAnyoneCanRead(projectId)
    expect(found.map((f) => f.details.tableName)).toEqual(['product_views'])
    expect(found[0]).toMatchObject({
      type: 'sensitive_columns_exposed',
      severity: 'critical',
      autoFixable: false,
      details: { tableName: 'product_views', columnNames: ['session_id'], policyNames: ['backenly_public_read_select'] },
    })
  })

  test('is told to the owner with what to ask their coding agent, and never repaired', async () => {
    const [f] = await detectSensitiveColumnsAnyoneCanRead(projectId)
    expect(classifyFix(f.type, f.details).decision).toBe('notify_only')
    expect(buildFixAction(f.type, f.details)).toBeNull()
    expect(summariseFinding(f.type, f.details)).toBe('Anyone with the publishable key can read session_id in `product_views`')
    expect(categoryOf({ type: f.type, details: f.details } as never)).toBe('security')
    const hint = getManualRemediationHint(f.type, f.details) ?? ''
    expect(hint).toContain('set_rls on product_views')
    expect(hint).toContain('session_id')
  })
})

describe('an always-true policy', () => {
  test('that opens writes is flagged on a table with no owner column, for the owner to decide', async () => {
    const found = await detectOverPermissiveRls(projectId)
    const guestbook = found.find((f) => f.details.tableName === 'guestbook')
    expect(guestbook).toMatchObject({
      type: 'rls_expression_invalid',
      autoFixable: false,
      details: { policyName: 'anyone_edits', policyCommand: 'UPDATE', rlsBasis: 'undecidable' },
    })
    expect(classifyFix(guestbook!.type, guestbook!.details).decision).toBe('notify_only')
    expect(buildFixAction(guestbook!.type, guestbook!.details)).toBeNull()
    expect(getManualRemediationHint(guestbook!.type, guestbook!.details)).toContain('"anyone_edits" lets anyone it covers UPDATE any row of "guestbook"')
  })

  test('that only opens reads is not flagged on a table with no owner column', async () => {
    const tables = (await detectOverPermissiveRls(projectId)).map((f) => f.details.tableName)
    expect(tables).not.toContain('products')
    expect(tables).not.toContain('product_views')
  })
})

describe('the observer', () => {
  test('records both for a person, since the loop never repairs either', async () => {
    await runObserverForProject(projectId)
    const rows = await prisma.healthFinding.findMany({
      where: { projectId, type: { in: ['sensitive_columns_exposed', 'rls_expression_invalid'] }, status: { in: ['open', 'pending_approval'] } },
      select: { type: true, status: true, details: true },
    })
    const at = (type: string, table: string) =>
      rows.find((r) => r.type === type && (r.details as Record<string, unknown>).tableName === table)
    expect(at('sensitive_columns_exposed', 'product_views')?.status).toBe('pending_approval')
    expect(at('rls_expression_invalid', 'guestbook')?.status).toBe('pending_approval')
  }, 120_000)
})
