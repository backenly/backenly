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

// ── A platform fault is never a tenant finding ───────────────────────────────

import http from 'http'
import type { AddressInfo } from 'net'
import { runContractSweep } from '@/lib/services/workspace-observer'
import { attributeContractFailures, type ProbeResult } from '@/lib/services/contract-verifier'
import { reapUnattributableFindings } from '@/lib/core/finding-reaper'

/** A built project with the anon key the key-authed probes need. */
async function builtProject(): Promise<{ userId: string; projectId: string }> {
  const p = await namedProject()
  await prisma.table.create({ data: { name: 'todos', projectId: p.projectId } })
  return p
}

/**
 * A stand-in ingress. Every surface answers the way a healthy platform does,
 * except the ones a test breaks: `fail.storage` / `fail.db` are project ids.
 */
function stubIngress(fail: { storage?: Set<string>; db?: Set<string> } = {}) {
  const server = http.createServer((req, res) => {
    const url = req.url ?? ''
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (url.startsWith('/api/health')) return json(200, { healthy: true })
    const m = url.match(/^\/api\/v1\/([^/]+)\/([^/?]+)/)
    if (!m) return json(404, { error: 'not found' })
    const [, projectId, surface] = m
    if (surface === 'healthz') return json(200, { status: 'healthy' })
    if (surface === 'fn') return json(404, { code: 'FUNCTION_NOT_FOUND' })
    if (surface === 'storage') {
      return fail.storage?.has(projectId)
        ? json(500, { error: { message: 'storage handler crashed' } })
        : json(200, { data: [] })
    }
    if (surface === 'db') {
      return fail.db?.has(projectId)
        ? json(404, { error: { message: 'No API definition for "todos"' } })
        : json(200, { data: [] })
    }
    return json(404, { error: 'not found' })
  })
  return new Promise<{ origin: string; close: () => Promise<void> }>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      resolve({
        origin: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      })
    })
  })
}

async function heartbeat(projectId: string) {
  return prisma.projectPreference.findFirst({ where: { projectId, type: 'contract_liveness' } })
}

describe('a platform fault is never filed against a tenant', () => {
  const savedOrigin = process.env.CONTRACT_PROBE_ORIGIN
  afterEach(() => {
    if (savedOrigin === undefined) delete process.env.CONTRACT_PROBE_ORIGIN
    else process.env.CONTRACT_PROBE_ORIGIN = savedOrigin
  })

  it('files nothing when the ingress itself does not answer', async () => {
    // The production incident: the web task probed an empty port.
    process.env.CONTRACT_PROBE_ORIGIN = 'http://127.0.0.1:9'
    const a = await builtProject()
    const b = await builtProject()
    try {
      const sweep = await runContractSweep({ projectIds: [a.projectId, b.projectId] })

      expect(sweep.platformFaults.map(f => f.kind)).toEqual(['ingress_unreachable'])
      for (const p of [a, b]) {
        expect(await prisma.healthFinding.count({ where: { projectId: p.projectId } })).toBe(0)
        expect(await prisma.platformNotification.count({ where: { userId: p.userId } })).toBe(0)
        // Unknown is not healthy: no heartbeat claims the surfaces answered.
        expect(await heartbeat(p.projectId)).toBeNull()
      }
    } finally {
      await dropProject(a)
      await dropProject(b)
    }
  }, 60_000)

  it('reports a surface failing the same way everywhere once, to the operator', async () => {
    const ps = [await builtProject(), await builtProject(), await builtProject()]
    const ingress = await stubIngress({ storage: new Set(ps.map(p => p.projectId)) })
    process.env.CONTRACT_PROBE_ORIGIN = ingress.origin
    try {
      const sweep = await runContractSweep({ projectIds: ps.map(p => p.projectId) })

      const storage = sweep.platformFaults.filter(f => f.surface === 'storage')
      expect(storage).toHaveLength(1)
      expect(storage[0].kind).toBe('surface_failing_fleetwide')
      for (const p of ps) {
        expect(await prisma.healthFinding.count({ where: { projectId: p.projectId } })).toBe(0)
        expect(await heartbeat(p.projectId)).toBeNull()
      }
    } finally {
      await ingress.close()
      for (const p of ps) await dropProject(p)
    }
  }, 60_000)

  it("still files a failure that is genuinely one project's own", async () => {
    // The guard must not blind the detector: one project's broken db surface,
    // while its neighbours answer, is that project's finding.
    const ps = [await builtProject(), await builtProject(), await builtProject()]
    const broken = ps[0]
    const ingress = await stubIngress({ db: new Set([broken.projectId]) })
    process.env.CONTRACT_PROBE_ORIGIN = ingress.origin
    try {
      const sweep = await runContractSweep({ projectIds: ps.map(p => p.projectId) })

      expect(sweep.platformFaults).toEqual([])
      const rows = await prisma.healthFinding.findMany({
        where: { projectId: { in: ps.map(p => p.projectId) }, type: 'contract_surface_broken' },
        select: { projectId: true, details: true },
      })
      expect(rows).toHaveLength(1)
      expect(rows[0].projectId).toBe(broken.projectId)
      expect((rows[0].details as any).surface).toBe('db')

      const beat = JSON.parse((await heartbeat(ps[1].projectId))!.value)
      expect(beat.ok).toBe(true)
    } finally {
      await ingress.close()
      for (const p of ps) await dropProject(p)
    }
  }, 60_000)

  it("treats a refused connection as the platform's, whoever it happened to", () => {
    const refused = (surface: ProbeResult['surface']): ProbeResult => ({
      surface, ok: false, critical: true, detail: 'probe error: fetch failed', transport: 'unreachable', durationMs: 1,
    })
    const passed = (surface: ProbeResult['surface']): ProbeResult => ({
      surface, ok: true, critical: true, detail: 'ok', durationMs: 1,
    })
    const out = attributeContractFailures([
      { projectId: 'only', results: [passed('healthz'), refused('db')] },
    ])
    expect(out.tenantBroken.size).toBe(0)
    expect(out.platformFaults.map(f => f.kind)).toEqual(['surface_unreachable'])
    expect([...(out.unknown.get('only') ?? [])]).toEqual(['db'])
  })

  it('withdraws rows that never described a tenant fault', async () => {
    const built = await builtProject()
    const named = await namedProject()
    try {
      const legacy = await prisma.healthFinding.create({
        data: {
          projectId: built.projectId, type: 'contract_surface_broken', severity: 'critical',
          status: 'pending_approval',
          details: { surface: 'runtime', detail: 'runtime unreachable at http://127.0.0.1:3001' },
        },
      })
      const onUnbuilt = await prisma.healthFinding.create({
        data: {
          projectId: named.projectId, type: 'workflow_broken', severity: 'warning',
          status: 'pending_approval', details: { workflow: 'user_auth_flow' },
        },
      })

      await reapUnattributableFindings()

      const after = await prisma.healthFinding.findMany({
        where: { id: { in: [legacy.id, onUnbuilt.id] } },
        select: { id: true, status: true, details: true },
      })
      const byId = new Map(after.map(r => [r.id, r]))
      expect(byId.get(legacy.id)?.status).toBe('dismissed')
      expect((byId.get(legacy.id)?.details as any).withdrawnBy).toBe('platform_fault')
      expect(byId.get(onUnbuilt.id)?.status).toBe('dismissed')
      expect((byId.get(onUnbuilt.id)?.details as any).withdrawnBy).toBe('not_built')
    } finally {
      await dropProject(built)
      await dropProject(named)
    }
  })

  it('never probes the contract from the per-project observer', async () => {
    process.env.CONTRACT_PROBE_ORIGIN = 'http://127.0.0.1:9'
    const p = await builtProject()
    try {
      await runObserverForProject(p.projectId)
      expect(
        await prisma.healthFinding.count({ where: { projectId: p.projectId, type: 'contract_surface_broken' } }),
      ).toBe(0)
    } finally {
      await dropProject(p)
    }
  }, 60_000)
})

// ── Verifier accounts are never counted as people ────────────────────────────

import { trackEndUserActive } from '@/lib/quota/kernel'

describe("synthetic probe sign-ins never count toward a customer's active users", () => {
  it('records a real end user and ignores a verifier account', async () => {
    const p = await builtProject()
    try {
      await trackEndUserActive(p.projectId, randomUUID(), '__cv_abc123@backenly.internal')
      await trackEndUserActive(p.projectId, randomUUID(), 'selftest@backenly-selftest.com')
      expect(await prisma.projectActiveUser.count({ where: { projectId: p.projectId } })).toBe(0)

      await trackEndUserActive(p.projectId, randomUUID(), 'real.person@example.com')
      expect(await prisma.projectActiveUser.count({ where: { projectId: p.projectId } })).toBe(1)
    } finally {
      await dropProject(p)
    }
  })
})
