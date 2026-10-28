/**
 * An architecture change Backenly prepared is an approval request, not a
 * broken guarantee, and it is decided where approving it is.
 *
 * The health summary feeds Workspace Home's loop rail ("N broken guarantees",
 * "N waiting on you", a subset of the first) and the top bar's inbox. An
 * `architecture_evolution` request is waiting on the person, so the inbox
 * counts it, on its own (`architectureRequestsPending`); it is not a guarantee
 * the backend is failing, so neither loop count includes it, and it is not in
 * the findings preview that the Detected panel lists with its generic dismiss.
 * That dismiss (POST /health, floor `write`) refuses the type: declining is
 * POST /architecture { action: 'dismiss' }, at the admin floor of approving.
 *
 * Real finding rows; the project-access check on the route is delegated
 * (pinned in tests/core/architecture-consent-is-human.test.ts and the route's
 * own authorization audit).
 */

let currentProjectId = ''
jest.mock('@/lib/middleware/projectValidation', () => ({
  withProjectValidation: (_req: any, handler: any) => handler({ projectId: currentProjectId, userId: 'test-user' }),
}))

import '../helpers/real-web-standard'
import { randomUUID } from 'crypto'
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db/prisma'
import { EVOLUTION_FINDING_TYPE } from '@/lib/core/types'
import { GET as healthGET, POST as healthPOST } from '@/app/api/projects/[id]/health/route'

let ownerId = ''
let projectId = ''
let requestId = ''
let indexId = ''

const params = () => ({ params: Promise.resolve({ id: projectId }) }) as any

async function summary() {
  const res = await healthGET(new NextRequest(`http://localhost:3000/api/projects/${projectId}/health`), params())
  return (await res.json()).data as any
}

async function dismiss(findingId: string) {
  const res = await healthPOST(
    new NextRequest(`http://localhost:3000/api/projects/${projectId}/health`, {
      method: 'POST',
      body: JSON.stringify({ findingId }),
      headers: { 'content-type': 'application/json' },
    }),
    params(),
  )
  return { status: res.status, body: (await res.json()) as any }
}

beforeAll(async () => {
  ownerId = (await prisma.user.create({ data: { email: `arch-req-${randomUUID()}@test.invalid`, name: 'Architecture requests' }, select: { id: true } })).id
  projectId = (await prisma.project.create({ data: { name: 'architecture-requests', userId: ownerId, lastObservedAt: new Date() }, select: { id: true } })).id
  currentProjectId = projectId
  // One guarantee the loop is holding a repair for, and one architecture change waiting.
  indexId = (
    await prisma.healthFinding.create({
      data: { projectId, type: 'missing_index', severity: 'warning', status: 'pending_approval', details: {} },
      select: { id: true },
    })
  ).id
  requestId = (
    await prisma.healthFinding.create({
      data: {
        projectId,
        type: EVOLUTION_FINDING_TYPE,
        severity: 'info',
        category: 'reliability',
        source: 'evolution_engine',
        status: 'pending_approval',
        details: { evolution: { v: 1, decisionId: 'd-1', concernKey: 'orders:refund', ask: 'approve' } },
      },
      select: { id: true },
    })
  ).id
}, 60_000)

afterAll(async () => {
  await prisma.healthFinding.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.project.deleteMany({ where: { id: projectId } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: ownerId } }).catch(() => {})
}, 60_000)

describe('the health summary', () => {
  it('counts an architecture request for the inbox, and as no broken guarantee', async () => {
    const data = await summary()
    expect(data.architectureRequestsPending).toBe(1)
    // The loop's own readings: the held repair only.
    expect(data.needsAttention).toBe(1)
    expect(data.actionableTotal).toBe(1)
    expect(data.findings.map((f: any) => f.id)).toEqual([indexId])
  }, 60_000)
})

describe('the generic dismiss', () => {
  it('refuses an architecture request, which stays waiting for its own decision', async () => {
    const r = await dismiss(requestId)
    expect(r.status).toBe(409)
    expect(r.body.error).toMatch(/decided on the Autonomy page, by an organization admin/)
    expect((await prisma.healthFinding.findUnique({ where: { id: requestId } }))?.status).toBe('pending_approval')
  }, 60_000)

  it('still dismisses an ordinary finding', async () => {
    const r = await dismiss(indexId)
    expect(r.status).toBe(200)
    expect((await prisma.healthFinding.findUnique({ where: { id: indexId } }))?.status).toBe('dismissed')
  }, 60_000)
})
