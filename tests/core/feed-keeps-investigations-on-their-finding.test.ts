/**
 * The activity feed says what Backenly did in words, never by an action's
 * machine name. Production QA (2026-11-09): the feed showed the bare
 * "autonomy investigation", the investigator's own bookkeeping row. What an
 * investigation found is written on the finding it looked into, and shown
 * there; the row stays for the investigator's daily cap.
 */
import { randomUUID } from 'crypto'
import { prisma } from '@/lib/db/prisma'
import { buildTrustReport } from '@/lib/autonomy/trust-report'

let userId: string
let projectId: string

beforeAll(async () => {
  userId = (await prisma.user.create({
    data: { email: `feed-${randomUUID().slice(0, 8)}@backenly.test`, name: 'feed', password: 'not-a-real-hash' },
  })).id
  projectId = (await prisma.project.create({ data: { name: 'feed', userId }, select: { id: true } })).id
  const at = new Date()
  // As lib/autonomy/escalation-diagnosis.ts writes it.
  await prisma.auditLog.create({
    data: {
      projectId,
      action: 'AUTONOMY_INVESTIGATION',
      type: 'autonomy',
      details: JSON.stringify({ findingId: randomUUID(), findingType: 'slow_query_missing_index_orders', verdict: 'confirmed', valid: true, problems: [], toolCalls: 3, model: 'claude' }),
      timestamp: at,
    },
  })
  await prisma.auditLog.create({
    data: { projectId, action: 'HEALTH_FINDING_DISMISSED', type: 'autonomy', details: JSON.stringify({}), timestamp: at },
  })
})

afterAll(async () => {
  await prisma.auditLog.deleteMany({ where: { projectId } })
  await prisma.project.delete({ where: { id: projectId } }).catch(() => {})
  await prisma.user.delete({ where: { id: userId } }).catch(() => {})
})

it('keeps the investigator’s bookkeeping out of the feed, and still says what a person did', async () => {
  const lines = (await buildTrustReport(projectId, 30)).recentActivity.map((a) => a.summary)
  expect(lines).toContain('You dismissed a finding')
  expect(lines.some((s) => /investigation/i.test(s))).toBe(false)
})

it('still counts each investigation against the investigator’s daily cap', async () => {
  // escalation-diagnosis.ts reads these rows to cap the day's investigations.
  const since = new Date(Date.now() - 24 * 3_600_000)
  expect(await prisma.auditLog.count({ where: { projectId, action: 'AUTONOMY_INVESTIGATION', timestamp: { gte: since } } })).toBe(1)
})
