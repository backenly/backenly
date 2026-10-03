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
      await fetch(`http://127.0.0.1:${port}/api/v1/${p.projectId}/db/todos`)
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
