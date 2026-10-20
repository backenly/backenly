/**
 * Every "fixed" claim comes from a recorded, re-checked outcome — proven at the
 * routes that make the claims, against a real database.
 *
 *   GET  /health                     recentlyResolved, autoFixedThisWeek, sensors
 *   POST /health                     dismisses only; never marks anything fixed
 *   GET  /autonomy/since-last-visit  counts confirmed fixes, not every change
 *   GET  /autonomy/events            unconfirmed changes say so
 *
 * Only the platform-session check is replaced, so each route receives this
 * suite's project. The data and every query are real.
 */
let currentProjectId = ''
jest.mock('@/lib/middleware/projectValidation', () => ({
  withProjectValidation: (_req: any, handler: any) =>
    handler({ projectId: currentProjectId, userId: 'test-user' }),
}))

import '../helpers/next-request-polyfill'
import crypto from 'crypto'
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db/prisma'
import { GET as healthGET, POST as healthPOST } from '@/app/api/projects/[id]/health/route'
import { GET as awayGET } from '@/app/api/projects/[id]/autonomy/since-last-visit/route'
import { GET as eventsGET } from '@/app/api/projects/[id]/autonomy/events/route'
import { recordSensorState, loadSensorState } from '@/lib/autonomy/sensor-state'

let ownerId: string
const params = () => ({ params: Promise.resolve({ id: currentProjectId }) })
const req = (path: string, init?: RequestInit) =>
  new NextRequest(`https://backenly.test/api/projects/${currentProjectId}${path}`, init as any)

async function finding(status: string, details: Record<string, unknown>, fixAppliedAt: Date | null = null) {
  return prisma.healthFinding.create({
    data: { projectId: currentProjectId, type: 'missing_fk_index', severity: 'warning', status, details: details as any, fixAppliedAt },
  })
}

async function audit(action: string, details: Record<string, unknown>) {
  await prisma.auditLog.create({
    data: { projectId: currentProjectId, action, type: 'autonomy', details: JSON.stringify(details), timestamp: new Date() },
  })
}

beforeAll(async () => {
  ownerId = (await prisma.user.create({
    data: { email: `claims-${crypto.randomBytes(6).toString('hex')}@example.test`, password: 'not-a-real-hash', name: 'claims' },
  })).id
  // lastObservedAt set so GET /health does not start a background observer
  // scan of this project mid-suite.
  currentProjectId = (await prisma.project.create({
    data: { name: 'fixed-claims', userId: ownerId, lastObservedAt: new Date() },
  })).id
}, 60_000)

afterAll(async () => {
  await prisma.healthFinding.deleteMany({ where: { projectId: currentProjectId } }).catch(() => {})
  await prisma.auditLog.deleteMany({ where: { projectId: currentProjectId } }).catch(() => {})
  await prisma.projectPreference.deleteMany({ where: { projectId: currentProjectId } }).catch(() => {})
  await prisma.project.deleteMany({ where: { userId: ownerId } }).catch(() => {})
  await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
}, 60_000)

describe('POST /health', () => {
  it('refuses to mark a finding fixed without a repair running', async () => {
    const f = await finding('pending_approval', { tableName: 'orders' })
    const res = await healthPOST(req('/health', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ findingId: f.id, action: 'approve' }),
    }), params())
    expect(res.status).toBe(400)
    const after = await prisma.healthFinding.findUnique({ where: { id: f.id } })
    expect(after).toMatchObject({ status: 'pending_approval', autoFixed: false })
  }, 30_000)

  it('dismisses with a recorded time, and the dismissal is never a repair', async () => {
    const f = await finding('open', { tableName: 'orders' })
    const res = await healthPOST(req('/health', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ findingId: f.id }),
    }), params())
    expect(res.status).toBe(200)
    const after = await prisma.healthFinding.findUnique({ where: { id: f.id } })
    expect(after?.status).toBe('dismissed')
    expect(typeof (after?.details as any)?.dismissedAt).toBe('string')

    const body = await (await healthGET(req('/health'), params())).json()
    const row = body.data.recentlyResolved.find((r: any) => r.id === f.id)
    expect(row?.closedBy).toBe('dismissed')
  }, 30_000)
})

describe('GET /health', () => {
  it('says how each finding closed, and counts only confirmed repairs as fixed', async () => {
    const now = new Date()
    const verified = await finding('auto_fixed', { rollbackData: { verification: 'confirmed' } }, now)
    const approved = await finding('auto_fixed', { rollbackData: { verification: 'confirmed', approvedBy: ownerId } }, now)
    const unverified = await finding('auto_fixed', { rollbackData: { verification: 'unverified' } }, now)
    const withdrawn = await finding('dismissed', { withdrawnBy: 'workflow_reaper', withdrawnAt: now.toISOString() })
    const stillOpen = await finding('open', {})

    const body = await (await healthGET(req('/health'), params())).json()
    const byId = new Map(body.data.recentlyResolved.map((r: any) => [r.id, r.closedBy]))
    expect(byId.get(verified.id)).toBe('autonomy_verified')
    expect(byId.get(approved.id)).toBe('approved_verified')
    expect(byId.get(unverified.id)).toBe('applied_unverified')
    expect(byId.get(withdrawn.id)).toBe('condition_cleared')
    expect(byId.has(stillOpen.id)).toBe(false)

    expect(body.data.autoFixedThisWeek).toBe(2)
    expect(body.data.unverifiedRepairsThisWeek).toBe(1)
  }, 30_000)

  it('reports which checks the last pass could run', async () => {
    await recordSensorState(currentProjectId, {
      projectId: currentProjectId,
      evaluatedAt: new Date().toISOString(),
      satisfied: true,
      invariants: [
        { id: 'a', title: 'Row security', satisfied: true, gaps: [] },
        { id: 'b', title: 'Indexes', satisfied: true, gaps: [] },
      ],
      violations: [],
      tierCounts: {} as any,
      errors: ['[b] permission denied'],
      disabled: [],
    } as any)
    expect((await loadSensorState(currentProjectId))?.ran).toBe(1)
    const body = await (await healthGET(req('/health'), params())).json()
    expect(body.data.sensors).toMatchObject({ total: 2, ran: 1, errored: [{ id: 'b', title: 'Indexes' }] })
  }, 30_000)
})

describe('autonomy digest and events', () => {
  beforeAll(async () => {
    await audit('HEALTH_AUTO_FIXED', { findingType: 'missing_fk_index', tableName: 'orders', columnName: 'user_id', verification: 'confirmed' })
    await audit('HEALTH_AUTO_FIXED', { findingType: 'missing_fk_index', tableName: 'items', columnName: 'order_id', verification: 'unverified' })
    await audit('AGENT_AUTO_FIXED', { title: 'Index on posts.author_id', category: 'missing_index', location: 'posts' })
    await audit('ROLLBACK_DEPLOY', { version: 3 })
  }, 30_000)

  it('counts confirmed fixes, reports unconfirmed changes as such, and claims no rollback', async () => {
    const since = new Date(Date.now() - 60 * 60 * 1000).toISOString()
    const body = await (await awayGET(req(`/autonomy/since-last-visit?since=${encodeURIComponent(since)}`), params())).json()
    expect(body.autonomousFixes).toBe(1)
    expect(body.unverifiedChanges).toBe(2)
    expect(body.headline).toMatch(/fixed 1 problem, each confirmed by a re-check/)
    expect(body.headline).toMatch(/made 2 changes it could not confirm/)
    expect(body.headline).not.toMatch(/rolled back/i)
    expect(body.examples.filter((e: any) => !e.verified).every((e: any) => /could not be confirmed/.test(e.what))).toBe(true)
  }, 30_000)

  it('marks unconfirmed changes in the event feed', async () => {
    const since = new Date(Date.now() - 60 * 60 * 1000).toISOString()
    const body = await (await eventsGET(req(`/autonomy/events?since=${encodeURIComponent(since)}`), params())).json()
    const confirmed = body.events.filter((e: any) => e.verified)
    const unconfirmed = body.events.filter((e: any) => !e.verified)
    expect(confirmed.length).toBe(1)
    expect(unconfirmed.length).toBe(2)
    for (const e of unconfirmed) expect(e.what).toMatch(/could not be confirmed/)
    for (const e of confirmed) expect(e.what).not.toMatch(/could not be confirmed/)
  }, 30_000)
})

describe('the event feed and an incident freeze', () => {
  beforeAll(async () => {
    // As the repair loop writes it when it holds a pass back (lib/autonomy/reconciler.ts).
    await audit('AUTONOMY_CHANGE_FREEZE', {
      reason: 'project is mid-incident — autonomous changes frozen this tick',
      health: ['Response time spiked to 480ms (p95).'],
      wouldHaveApplied: 1,
      loop: 'reconciler',
    })
    // As another path writes it when it holds back: the fix loop here
    // (lib/autonomy/change-freeze.ts).
    await audit('AUTONOMY_REPAIR_HELD', {
      reason: 'project is mid-incident — autonomous changes frozen this tick',
      health: ['Error rate rose to 12%.'],
      wouldHaveApplied: 3,
      loop: 'reconciler',
      via: 'agentic_fix_loop',
    })
  }, 30_000)

  it('shows a held-back pass only when asked, and never as a fix', async () => {
    const since = encodeURIComponent(new Date(Date.now() - 60 * 60 * 1000).toISOString())
    const plain = await (await eventsGET(req(`/autonomy/events?since=${since}`), params())).json()
    expect(plain.events.some((e: any) => e.kind === 'held_back')).toBe(false)

    const asked = await (await eventsGET(req(`/autonomy/events?since=${since}&include=held`), params())).json()
    const held = asked.events.filter((e: any) => e.action === 'AUTONOMY_CHANGE_FREEZE')
    expect(held).toHaveLength(1)
    expect(held[0]).toMatchObject({ kind: 'held_back', verified: false, tableName: null })
    expect(held[0].full).toMatch(/^Backenly held back a repair because the project is mid-incident/)
    expect(held[0].full).toMatch(/Response time spiked to 480ms \(p95\)\./)
    // Everything else in the feed is as it was.
    expect(asked.events.length - asked.events.filter((e: any) => e.kind === 'held_back').length).toBe(plain.events.length)
  }, 30_000)

  it("says which path held back, when it was not the repair loop's own pass", async () => {
    const since = encodeURIComponent(new Date(Date.now() - 60 * 60 * 1000).toISOString())
    const asked = await (await eventsGET(req(`/autonomy/events?since=${since}&include=held`), params())).json()
    const held = asked.events.filter((e: any) => e.action === 'AUTONOMY_REPAIR_HELD')
    expect(held).toHaveLength(1)
    expect(held[0]).toMatchObject({ kind: 'held_back', verified: false, tableName: null })
    expect(held[0].full).toMatch(/^Backenly held back its fixes for 3 failing checks because the project is mid-incident/)
    expect(held[0].full).toMatch(/Error rate rose to 12%\./)
  }, 30_000)
})
