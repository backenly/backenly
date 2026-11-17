/**
 * The failed-sign-in signal counts failed sign-ins, against the sign-ins that
 * worked, and raises a warning with nothing to approve. Production QA
 * (2026-11-16): an agent's ordinary negative tests (wrong passwords, a
 * duplicate sign-up, signed-out checkouts) raised "Critical · Security —
 * Unusual auth error rate — 17 failures … possible brute-force", pending
 * approval with "Approve & fix".
 */
import { randomUUID } from 'crypto'
import { prisma } from '@/lib/db/prisma'
import { detectAuthSpike } from '@/lib/services/workspace-observer'
import { classifyFix } from '@/lib/core/fix-classifier'
import { hasExecutableFix } from '@/lib/core/fix-actions'

let userId: string

interface Shape { path: string; statusCode: number; method?: string; minutesAgo?: number; branchId?: string }

async function projectWith(requests: Array<Shape & { n: number }>): Promise<string> {
  const projectId = (await prisma.project.create({ data: { name: 'signins', userId }, select: { id: true } })).id
  const now = Date.now()
  await prisma.apiRequestLog.createMany({
    data: requests.flatMap((r) =>
      Array.from({ length: r.n }, (_, i) => ({
        projectId,
        userId,
        method: r.method ?? 'POST',
        path: r.path,
        statusCode: r.statusCode,
        duration: 40,
        // Spread over the minute before `minutesAgo`.
        timestamp: new Date(now - (r.minutesAgo ?? 1) * 60_000 - (i % 60) * 1000),
        branchId: r.branchId ?? null,
      })),
    ),
  })
  return projectId
}

beforeAll(async () => {
  userId = (await prisma.user.create({
    data: { email: `signins-${randomUUID().slice(0, 8)}@backenly.test`, name: 'signins', password: 'not-a-real-hash' },
  })).id
})

afterAll(async () => {
  const projects = await prisma.project.findMany({ where: { userId }, select: { id: true } })
  await prisma.apiRequestLog.deleteMany({ where: { userId } })
  await prisma.project.deleteMany({ where: { id: { in: projects.map((p) => p.id) } } })
  await prisma.user.delete({ where: { id: userId } }).catch(() => {})
})

it('does not count an app working as designed', async () => {
  // The re-test's 17: refusals a test run asks for, beside sign-ins that worked.
  const projectId = await projectWith([
    { path: '/auth/signin', statusCode: 401, n: 4 },        // wrong passwords
    { path: '/auth/login', statusCode: 401, n: 1 },
    { path: '/auth/signup', statusCode: 409, n: 1 },        // already registered
    { path: '/auth/signup', statusCode: 400, n: 3 },        // weak password
    { path: '/auth/me', statusCode: 401, method: 'GET', n: 6 }, // signed out at checkout
    { path: '/auth/refresh-token', statusCode: 401, n: 2 }, // an expired session
    { path: '/auth/signin', statusCode: 200, n: 10 },
  ])
  expect(await detectAuthSpike(projectId)).toEqual([])
})

it('does not count a busy app’s typos', async () => {
  const projectId = await projectWith([
    { path: '/auth/signin', statusCode: 401, n: 30 },
    { path: '/auth/signin', statusCode: 200, n: 400 },
  ])
  expect(await detectAuthSpike(projectId)).toEqual([])
})

it('raises a warning when most sign-ins fail, with nothing to approve', async () => {
  // A stuffing run: wrong passwords, then the sign-in limits refusing the rest.
  const projectId = await projectWith([
    { path: '/auth/signin', statusCode: 401, n: 30 },
    { path: '/auth/signin', statusCode: 429, n: 12 },
    { path: '/auth/signin', statusCode: 200, n: 2 },
  ])
  const [finding, ...rest] = await detectAuthSpike(projectId)
  expect(rest).toEqual([])
  expect(finding).toMatchObject({
    type: 'auth_spike',
    severity: 'warning',
    details: { failedSignIns: 42, successfulSignIns: 2, windowMinutes: 10 },
  })
  expect(String(finding.details.reason)).not.toMatch(/brute/i)
  expect(classifyFix('auth_spike', finding.details).decision).toBe('notify_only')
  expect(hasExecutableFix('auth_spike', finding.details)).toBe(false)
})

it('is critical only when it has kept up for an hour', async () => {
  const projectId = await projectWith(
    [0, 10, 20, 30, 40, 50].map((ago) => ({ path: '/auth/signin', statusCode: 401, n: 25, minutesAgo: ago + 1 })),
  )
  const [finding] = await detectAuthSpike(projectId)
  expect(finding).toMatchObject({ type: 'auth_spike', severity: 'critical' })
})

it('leaves a preview branch’s traffic out', async () => {
  const projectId = await projectWith([{ path: '/auth/signin', statusCode: 401, n: 40, branchId: randomUUID() }])
  expect(await detectAuthSpike(projectId)).toEqual([])
})
