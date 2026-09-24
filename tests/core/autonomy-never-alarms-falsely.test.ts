/**
 * AUTONOMY NEVER ALARMS FALSELY
 * =============================
 * A customer created a project, connected nothing, built nothing, and was
 * emailed a critical "contract surface broken" alert minutes later. The alert
 * read "runtime unreachable at http://127.0.0.1:3001": the monitor in the web
 * task was knocking on an empty port, and the platform's own fault was filed
 * against the customer's project and sent to their inbox.
 *
 * Each block below pins one of the rules that make that impossible, and each
 * was checked to fail with its fix reverted.
 */

import { probeOrigin } from '@/lib/services/contract-verifier'

describe('the probe enters where customer traffic enters', () => {
  it('uses an explicit CONTRACT_PROBE_ORIGIN verbatim', () => {
    expect(probeOrigin({ CONTRACT_PROBE_ORIGIN: 'http://web.internal:3000/' } as any)).toBe(
      'http://web.internal:3000',
    )
  })

  it('probes the web ingress when Next fronts a separate runtime (AWS, compose)', () => {
    // RUNTIME_API_URL is what makes Next rewrite /api/v1 to a runtime in
    // another task. The web process itself is the ingress, and :3001 is empty.
    expect(
      probeOrigin({ RUNTIME_API_URL: 'http://runtime.internal:3001', PORT: '3000', RUNTIME_PORT: '3001' } as any),
    ).toBe('http://127.0.0.1:3000')
  })

  it('probes the Express runtime on a single box where it fronts Next', () => {
    expect(probeOrigin({ RUNTIME_PORT: '4001' } as any)).toBe('http://127.0.0.1:4001')
    expect(probeOrigin({} as any)).toBe('http://127.0.0.1:3001')
  })
})

// ── An unbuilt project is never watched ──────────────────────────────────────

import { PrismaClient } from '@prisma/client'
import { randomUUID } from 'crypto'
import { watchableProjectsWhere, isWatchableProject } from '@/lib/projects/backend-presence'
import { runObserverForProject } from '@/lib/services/workspace-observer'

const prisma = new PrismaClient()

/** A project in exactly the state provisioning leaves it: named, never built. */
async function namedProject(): Promise<{ userId: string; projectId: string }> {
  const userId = randomUUID()
  const projectId = randomUUID()
  await prisma.user.create({
    data: { id: userId, email: `nafalse+${userId.slice(0, 8)}@backenly.test`, name: 'nafalse', password: 'x' },
  })
  await prisma.project.create({
    data: {
      id: projectId,
      name: 'To-do list',
      userId,
      // Seeded at creation so auth works from day zero. Not evidence of anything.
      jwtSecret: 'a'.repeat(64),
      anonKey: `anon_${projectId.replace(/-/g, '')}`,
    },
  })
  // The auth placeholder a fresh project carries. Not a built backend either.
  await prisma.table.create({ data: { name: 'users', projectId } })
  return { userId, projectId }
}

async function dropProject(p: { userId: string; projectId: string }) {
  await prisma.platformNotification.deleteMany({ where: { userId: p.userId } })
  await prisma.project.deleteMany({ where: { id: p.projectId } })
  await prisma.user.deleteMany({ where: { id: p.userId } })
}

describe('a project with nothing built is never watched', () => {
  const savedOrigin = process.env.CONTRACT_PROBE_ORIGIN
  // Nothing listens here: exactly what the web task saw at 127.0.0.1:3001.
  beforeAll(() => { process.env.CONTRACT_PROBE_ORIGIN = 'http://127.0.0.1:9' })
  afterAll(async () => {
    if (savedOrigin === undefined) delete process.env.CONTRACT_PROBE_ORIGIN
    else process.env.CONTRACT_PROBE_ORIGIN = savedOrigin
    await prisma.$disconnect()
  })

  it('files nothing and emails nothing for a named-only project', async () => {
    const p = await namedProject()
    try {
      expect(await isWatchableProject(p.projectId)).toBe(false)

      const result = await runObserverForProject(p.projectId)

      expect(result.findingsDetected).toBe(0)
      expect(await prisma.healthFinding.count({ where: { projectId: p.projectId } })).toBe(0)
      expect(await prisma.platformNotification.count({ where: { userId: p.userId } })).toBe(0)
      // "Never checked" is the truth, so the stamp stays empty.
      const row = await prisma.project.findUnique({ where: { id: p.projectId }, select: { lastObservedAt: true } })
      expect(row?.lastObservedAt).toBeNull()
    } finally {
      await dropProject(p)
    }
  }, 60_000)

  it('starts watching the moment something real is built', async () => {
    const p = await namedProject()
    try {
      await prisma.table.create({ data: { name: 'todos', projectId: p.projectId } })
      expect(await isWatchableProject(p.projectId)).toBe(true)
    } finally {
      await dropProject(p)
    }
  })

  it('counts genuinely enabled auth, and never a reserved table', async () => {
    const p = await namedProject()
    try {
      await prisma.table.create({ data: { name: '_email_verifications', projectId: p.projectId } })
      expect(await isWatchableProject(p.projectId)).toBe(false)

      const graph = await prisma.backendGraph.create({
        data: { projectId: p.projectId, graphData: { auth: { providers: { email: { enabled: true } } } } },
      })
      await prisma.project.update({ where: { id: p.projectId }, data: { activeGraphId: graph.id } })
      expect(await isWatchableProject(p.projectId)).toBe(true)
    } finally {
      await prisma.project.update({ where: { id: p.projectId }, data: { activeGraphId: null } }).catch(() => {})
      await dropProject(p)
    }
  })

  it('does not watch a locked-down project, which refuses traffic on purpose', async () => {
    const p = await namedProject()
    try {
      await prisma.table.create({ data: { name: 'todos', projectId: p.projectId } })
      await prisma.project.update({ where: { id: p.projectId }, data: { lockedDownAt: new Date() } })
      const selected = await prisma.project.findMany({
        where: { id: p.projectId, ...watchableProjectsWhere() },
        select: { id: true },
      })
      expect(selected).toEqual([])
    } finally {
      await dropProject(p)
    }
  })
})
