/**
 * EACH GAP KEEPS ITS OWN FINDING, AND ITS OWN EXPLANATION
 * =======================================================
 * Production QA (2026-11-16): a card titled "orders has a relation with no
 * foreign key constraint" carried the AI explanation written about
 * reviews.user_id.
 *
 * The observer wrote every `missing_fk` gap to the one open row of that type:
 * its upsert was keyed by type alone, while the reaper and the repair loop key
 * a gap by gapIdentity (table and column). The orders gap's details were merged
 * over the reviews row waiting for approval, and the reviews diagnosis stayed
 * on it. A diagnosis is also served now only while it was made from the
 * evidence its finding carries.
 *
 * Real PostgreSQL and the real observer.
 */

import { PrismaClient } from '@prisma/client'
import { randomUUID } from 'crypto'
import { runObserverForProject } from '@/lib/services/workspace-observer'
import { evidenceFingerprint } from '@/lib/autonomy/finding-fingerprint'
import { buildTrustReport } from '@/lib/autonomy/trust-report'
import { gapIdentity } from '@/lib/autonomy/desired-state'

const prisma = new PrismaClient()
const userId = randomUUID()
const projectId = randomUUID()
const schema = `workspace_${projectId}`
const raw = (sql: string) => prisma.$executeRawUnsafe(sql)

const fkRows = () =>
  prisma.healthFinding.findMany({
    where: { projectId, type: 'missing_fk', status: { in: ['open', 'pending_approval'] } },
    select: { id: true, status: true, details: true },
  })
const tableOf = (row: { details: unknown }) => (row.details as Record<string, unknown>).tableName

/** A diagnosis as escalation-diagnosis.ts writes it, made from `details`. */
function diagnosisFor(details: Record<string, unknown>, rootCause: string, fingerprint = evidenceFingerprint('missing_fk', details)) {
  return { rootCause, recommendation: 'Keep it.', confidence: 'medium', model: 'claude', fingerprint, at: new Date().toISOString() }
}

beforeAll(async () => {
  await prisma.user.create({ data: { id: userId, email: `gaps+${userId.slice(0, 8)}@backenly.test`, name: 'gaps', password: 'x' } })
  await prisma.project.create({ data: { id: projectId, name: 'each-gap', userId, jwtSecret: 'a'.repeat(64) } })
  // A registered table is what makes a project watchable by the observer.
  for (const name of ['users', 'reviews', 'orders']) await prisma.table.create({ data: { name, projectId } })
  await raw(`CREATE SCHEMA "${schema}"`)
  await raw(`CREATE TABLE "${schema}".users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text)`)
  // Two relations nothing enforces: two gaps.
  await raw(`CREATE TABLE "${schema}".reviews (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, body text)`)
  await raw(`CREATE TABLE "${schema}".orders (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, total numeric)`)
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

describe('two relations with no foreign key', () => {
  test('are two findings, each waiting on a person', async () => {
    await runObserverForProject(projectId)
    const rows = await fkRows()
    expect(rows.map(tableOf).sort()).toEqual(['orders', 'reviews'])
    for (const row of rows) expect(row.status).toBe('pending_approval')
  }, 120_000)

  test('a diagnosis stays on the gap it was written about', async () => {
    const reviews = (await fkRows()).find((r) => tableOf(r) === 'reviews')!
    const details = reviews.details as Record<string, unknown>
    await prisma.healthFinding.update({
      where: { id: reviews.id },
      data: { details: { ...details, diagnosis: diagnosisFor(details, 'The single live review row points at a user.') } as any },
    })

    await runObserverForProject(projectId)

    const rows = await fkRows()
    expect(rows.map(tableOf).sort()).toEqual(['orders', 'reviews'])
    const diagnosisOn = (table: string) =>
      (rows.find((r) => tableOf(r) === table)!.details as Record<string, any>).diagnosis?.rootCause
    expect(diagnosisOn('reviews')).toBe('The single live review row points at a user.')
    expect(diagnosisOn('orders')).toBeUndefined()

    // And as the Review Queue is served it.
    const pending = (await buildTrustReport(projectId, 30)).pendingApprovals.filter((p) => p.type === 'missing_fk')
    const served = (table: string) =>
      (pending.find((p) => (p.details as Record<string, any>)?.tableName === table)?.details as Record<string, any>)?.diagnosis?.rootCause
    expect(served('reviews')).toBe('The single live review row points at a user.')
    expect(served('orders')).toBeUndefined()
  }, 120_000)
})

describe('a diagnosis made from other evidence', () => {
  test('is not served', async () => {
    const orders = (await fkRows()).find((r) => tableOf(r) === 'orders')!
    const details = orders.details as Record<string, unknown>
    // Written about reviews' evidence, then sitting on the orders row: what the
    // re-test's card showed.
    const elsewhere = { ...details, tableName: 'reviews' }
    await prisma.healthFinding.update({
      where: { id: orders.id },
      data: { details: { ...details, diagnosis: diagnosisFor(elsewhere, 'About reviews, not orders.') } as any },
    })
    const pending = (await buildTrustReport(projectId, 30)).pendingApprovals.find((p) => p.id === orders.id)
    expect(pending).toBeDefined()
    expect((pending!.details as Record<string, any>).diagnosis).toBeUndefined()
  }, 120_000)

  test('one written before diagnoses carried a fingerprint is still served', async () => {
    const orders = (await fkRows()).find((r) => tableOf(r) === 'orders')!
    const details = orders.details as Record<string, unknown>
    const { fingerprint: _none, ...legacy } = diagnosisFor(details, 'Written before fingerprints.')
    await prisma.healthFinding.update({ where: { id: orders.id }, data: { details: { ...details, diagnosis: legacy } as any } })
    const pending = (await buildTrustReport(projectId, 30)).pendingApprovals.find((p) => p.id === orders.id)
    expect((pending!.details as Record<string, any>).diagnosis?.rootCause).toBe('Written before fingerprints.')
  }, 120_000)
})

describe('a broken webhook', () => {
  test('is one gap per trigger', () => {
    expect(gapIdentity('broken_webhook', { triggerId: 't1' })).not.toBe(gapIdentity('broken_webhook', { triggerId: 't2' }))
  })
})
