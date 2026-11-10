/**
 * RUNTIME TRAFFIC IS RECORDED
 * ===========================
 * Every traffic signal in autonomy reads `api_request_logs`: the change freeze,
 * the auth-spike detector, the 5xx harm signal behind restructuring, the
 * activity gate, the maintenance observation window, Monitoring. Its writer for
 * real end-user traffic went away with the move to PostgREST and nothing
 * replaced it, so all of them were reading an empty table.
 *
 * Real PostgreSQL, the real Express app on an ephemeral port, and the real
 * route files for the coverage guard.
 */

import fs from 'fs'
import path from 'path'
import http from 'http'
import type { AddressInfo } from 'net'
import { PrismaClient } from '@prisma/client'
import { randomUUID } from 'crypto'

import {
  recordRuntimeRequest,
  flushRecordedRequests,
  internalTrafficHeaders,
  INTERNAL_TRAFFIC_HEADER,
  projectRelativePath,
} from '@/lib/traffic/request-recorder'
import { recordedV1 } from '@/lib/traffic/recorded-v1'
import { computeHealthSignal } from '@/lib/autonomy/telemetry'
import app from '@/server/app'

const prisma = new PrismaClient()
const REPO = path.resolve(__dirname, '../..')

async function project() {
  const userId = randomUUID()
  const projectId = randomUUID()
  await prisma.user.create({
    data: { id: userId, email: `traffic+${userId.slice(0, 8)}@backenly.test`, name: 'traffic', password: 'x' },
  })
  await prisma.project.create({ data: { id: projectId, name: 'traffic', userId } })
  return { userId, projectId }
}

async function drop(p: { userId: string; projectId: string }) {
  await prisma.project.deleteMany({ where: { id: p.projectId } })
  await prisma.accountAiUsage.deleteMany({ where: { billingAccountId: p.userId } })
  await prisma.user.deleteMany({ where: { id: p.userId } })
}

const rows = (projectId: string) =>
  prisma.apiRequestLog.findMany({ where: { projectId }, select: { path: true, statusCode: true, userId: true, method: true } })

afterAll(async () => {
  await flushRecordedRequests()
  await prisma.$disconnect()
})

describe('the recorder', () => {
  it('writes one row per served request, relative to the project, owned by its owner', async () => {
    const p = await project()
    try {
      recordRuntimeRequest({
        projectId: p.projectId, method: 'get', pathname: `/api/v1/${p.projectId}/db/todos?limit=1`,
        statusCode: 200, durationMs: 12,
      })
      await flushRecordedRequests()
      expect(await rows(p.projectId)).toEqual([
        { path: '/db/todos', statusCode: 200, userId: p.userId, method: 'GET' },
      ])
    } finally {
      await drop(p)
    }
  })

  it("never records Backenly's own probes, and cannot be told to skip by a client", async () => {
    const p = await project()
    try {
      const token = internalTrafficHeaders()[INTERNAL_TRAFFIC_HEADER]
      expect(token).toBeTruthy()
      recordRuntimeRequest({
        projectId: p.projectId, method: 'POST', pathname: `/api/v1/${p.projectId}/auth/signup`,
        statusCode: 201, durationMs: 30, internalHeader: token,
      })
      recordRuntimeRequest({
        projectId: p.projectId, method: 'POST', pathname: `/api/v1/${p.projectId}/auth/signup`,
        statusCode: 201, durationMs: 30, internalHeader: 'please-do-not-log-me',
      })
      await flushRecordedRequests()
      expect(await rows(p.projectId)).toHaveLength(1)
    } finally {
      await drop(p)
    }
  })

  it('drops rows for a project that does not exist without failing the batch', async () => {
    const p = await project()
    try {
      recordRuntimeRequest({ projectId: randomUUID(), method: 'GET', pathname: '/x', statusCode: 404, durationMs: 1 })
      recordRuntimeRequest({ projectId: p.projectId, method: 'GET', pathname: '/api/v1/x/healthz', statusCode: 200, durationMs: 1 })
      await flushRecordedRequests()
      expect(await rows(p.projectId)).toHaveLength(1)
    } finally {
      await drop(p)
    }
  })

  it('keeps every stored path out of the /api/ namespace the readers exclude', () => {
    const id = randomUUID()
    expect(projectRelativePath(id, `/api/v2/${id}/todos`)).toBe('/todos')
    expect(projectRelativePath(id, `/api/v1/${id}`)).toBe('/')
    expect(projectRelativePath(id, '/api/ai/chat').startsWith('/api/')).toBe(false)
  })

  it("counts every served request toward the billing account's month, and never Backenly's own", async () => {
    // The Usage page's API request count. It used to be kept only by the
    // Next-owned v1 routes and MCP calls, so /db, /auth and /fn traffic that
    // the runtime serves never showed up in it. API requests are unlimited;
    // this only counts.
    const p = await project()
    try {
      const token = internalTrafficHeaders()[INTERNAL_TRAFFIC_HEADER]
      for (const pathname of ['db/todos', 'auth/signin', 'fn/hello']) {
        recordRuntimeRequest({
          projectId: p.projectId, method: 'POST', pathname: `/api/v1/${p.projectId}/${pathname}`,
          statusCode: 200, durationMs: 5,
        })
      }
      recordRuntimeRequest({
        projectId: p.projectId, method: 'GET', pathname: `/api/v1/${p.projectId}/db/todos`,
        statusCode: 200, durationMs: 5, internalHeader: token,
      })
      await flushRecordedRequests()
      recordRuntimeRequest({
        projectId: p.projectId, method: 'GET', pathname: `/api/v2/${p.projectId}/todos`,
        statusCode: 200, durationMs: 5,
      })
      await flushRecordedRequests()

      const month = new Date().toISOString().slice(0, 7)
      // The project has no organization, so its billing account is its owner.
      const usage = await prisma.accountAiUsage.findUnique({
        where: { billingAccountId_date: { billingAccountId: p.userId, date: month } },
        select: { apiRequestCount: true },
      })
      expect(usage?.apiRequestCount).toBe(BigInt(4))
    } finally {
      await drop(p)
    }
  })
})

describe('both serving processes record', () => {
  it('the Next wrapper records the status, and a thrown handler as 500', async () => {
    const p = await project()
    try {
      const ctx = { params: Promise.resolve({ projectId: p.projectId }) }
      const ok = recordedV1(async () => new Response('{}', { status: 201 }))
      const boom = recordedV1(async () => {
        throw new Error('boom')
      })
      await ok(new Request(`http://x/api/v1/${p.projectId}/storage/upload`, { method: 'POST' }), ctx)
      await expect(boom(new Request(`http://x/api/v1/${p.projectId}/storage/files`), ctx)).rejects.toThrow('boom')
      await new Promise(r => setImmediate(r))
      await flushRecordedRequests()
      const got = (await rows(p.projectId)).map(r => `${r.path}:${r.statusCode}`).sort()
      expect(got).toEqual(['/storage/files:500', '/storage/upload:201'])
    } finally {
      await drop(p)
    }
  })

  it('the Express runtime records a request it answered', async () => {
    const p = await project()
    const server = http.createServer(app)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    try {
      const { port } = server.address() as AddressInfo
      // A request with a key, even a wrong one, is the project's traffic.
      await fetch(`http://127.0.0.1:${port}/api/v1/${p.projectId}/db/todos`, { headers: { 'x-api-key': 'proj_live_wrong' } })
      // A refused request that presented no credential at all is not.
      const keyless = await fetch(`http://127.0.0.1:${port}/api/v1/${p.projectId}/db/todos`)
      expect(keyless.status).toBe(401)
      await new Promise(r => setTimeout(r, 50))
      await flushRecordedRequests()
      const got = await rows(p.projectId)
      expect(got).toHaveLength(1)
      expect(got[0].path).toBe('/db/todos')
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
      await drop(p)
    }
  }, 60_000)
})

// Production QA (2026-11-09): a brand-new project's Monitoring showed the
// console's own Realtime connection as its first request, and requests from
// strangers with no key lowered its success rate. Neither is the project's
// traffic (isProjectTraffic); a wrong key, a 403 and the project's own app are.
describe("what is not the project's traffic", () => {
  const originalAppUrl = process.env.NEXT_PUBLIC_APP_URL
  beforeAll(() => { process.env.NEXT_PUBLIC_APP_URL = 'https://backenly.test' })
  afterAll(() => {
    if (originalAppUrl === undefined) delete process.env.NEXT_PUBLIC_APP_URL
    else process.env.NEXT_PUBLIC_APP_URL = originalAppUrl
  })
  const headers = (h: Record<string, string>) => new Headers(h)

  it("leaves out the console calling the API from its own pages, and keeps the project's own app", async () => {
    const p = await project()
    try {
      const at = (h: Record<string, string>, status = 200) => recordRuntimeRequest({
        projectId: p.projectId, method: 'GET', pathname: `/api/v1/${p.projectId}/realtime`,
        statusCode: status, durationMs: 3, headers: headers(h),
      })
      at({ referer: `https://backenly.test/app/projects/${p.projectId}/realtime` })
      at({ referer: 'https://shop.example/checkout', 'x-api-key': 'proj_live_k' })
      // The platform's origin outside the console, and a look-alike host: still counted.
      at({ referer: 'https://backenly.test/pricing', 'x-api-key': 'proj_live_k' })
      at({ referer: `https://backenly.test.evil.example/app/projects/${p.projectId}`, 'x-api-key': 'proj_live_k' })
      await flushRecordedRequests()
      expect((await rows(p.projectId)).length).toBe(3)
    } finally {
      await drop(p)
    }
  })

  it('leaves out a refused request with no credential, and keeps a wrong key, a ticket, a 403 and a public read', async () => {
    const p = await project()
    try {
      const at = (status: number, h: Record<string, string> = {}, search = '') => recordRuntimeRequest({
        projectId: p.projectId, method: 'GET', pathname: `/api/v1/${p.projectId}/db/todos`,
        statusCode: status, durationMs: 3, headers: headers(h), search,
      })
      at(401)                                     // no credential at all: not the project's
      at(401, { 'x-api-key': 'proj_live_wrong' }) // a wrong key: often the project's own app
      at(401, {}, '?apiKey=proj_live_wrong')
      at(401, {}, '?ticket=t1')
      at(403)
      at(200)
      await flushRecordedRequests()
      expect((await rows(p.projectId)).map(r => r.statusCode).sort()).toEqual([200, 401, 401, 401, 403])
    } finally {
      await drop(p)
    }
  })

  it("the Next wrapper leaves out the console's own request", async () => {
    const p = await project()
    try {
      const ctx = { params: Promise.resolve({ projectId: p.projectId }) }
      const stream = recordedV1(async () => new Response('', { status: 200 }))
      await stream(new Request(`http://x/api/v1/${p.projectId}/realtime?ticket=t1`, {
        headers: { referer: `https://backenly.test/app/projects/${p.projectId}/realtime` },
      }), ctx)
      await stream(new Request(`http://x/api/v1/${p.projectId}/realtime?apiKey=proj_live_k`, {
        headers: { referer: 'https://shop.example/' },
      }), ctx)
      await new Promise(r => setImmediate(r))
      await flushRecordedRequests()
      expect(await rows(p.projectId)).toHaveLength(1)
    } finally {
      await drop(p)
    }
  })
})

describe('the signals that read traffic can now see it', () => {
  it('moves the health signal off "unknown" once traffic exists', async () => {
    const p = await project()
    try {
      expect((await computeHealthSignal(p.projectId)).state).toBe('unknown')
      for (let i = 0; i < 20; i++) {
        recordRuntimeRequest({
          projectId: p.projectId, method: 'GET', pathname: `/api/v1/${p.projectId}/db/todos`,
          statusCode: 200, durationMs: 15,
        })
      }
      await flushRecordedRequests()
      expect((await computeHealthSignal(p.projectId)).state).not.toBe('unknown')
    } finally {
      await drop(p)
    }
  })
})

describe('no Next /api/v1/{projectId} route escapes the recorder', () => {
  it('exports every method through recordedV1 or re-exports one that does', () => {
    const base = path.join(REPO, 'app', 'api', 'v1', '[projectId]')
    const offenders: string[] = []
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name)
        if (e.isDirectory()) walk(full)
        else if (e.name === 'route.ts') {
          const src = fs.readFileSync(full, 'utf8')
          const rel = path.relative(REPO, full)
          if (/^export async function (GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/m.test(src)) offenders.push(`${rel}: bare export`)
          for (const m of src.matchAll(/^export const (GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) = (.+)$/gm)) {
            if (!m[2].startsWith('recordedV1(')) offenders.push(`${rel}: ${m[1]} not wrapped`)
          }
        }
      }
    }
    walk(base)
    expect(offenders).toEqual([])
  })
})
