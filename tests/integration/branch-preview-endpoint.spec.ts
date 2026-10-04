/**
 * A PREVIEW BRANCH HAS A WORKING ENDPOINT, AND ITS TRAFFIC STAYS ITS OWN
 * =====================================================================
 *
 * A branch is served at the project's own base URL to a key bound to it. This
 * drives that end to end against a real database and the real runtime:
 *
 *   - the agent tool issues a preview key and describes the endpoint;
 *   - that key reaches the branch's data API, says so in the response header,
 *     and is refused off the data plane;
 *   - its requests are logged against the branch, at both doors, and every
 *     production health reader ignores them while the branch view sees them;
 *   - the branch's OpenAPI spec describes the branch's schema, not main's.
 *
 * Schemas and rows are created directly: the engine's createBranch also needs
 * the PostgREST registry installed, which is not what is under test here.
 */
import '@/tests/helpers/real-web-standard'

import http from 'http'
import type { AddressInfo } from 'net'
import { randomUUID } from 'crypto'

import app from '@/server/app'
import { prisma } from '@/lib/db/prisma'
import { dispatchTool } from '@/lib/ai/brain/tools'
import { clearBranchKeyCache, BRANCH_SURFACE_UNAVAILABLE } from '@/lib/branches/key-scope'
import { mintPreviewKey, previewEndpoint, previewSdkSnippet } from '@/lib/branches/preview'
import { flushRecordedRequests } from '@/lib/traffic/request-recorder'
import { recordedV1 } from '@/lib/traffic/recorded-v1'
import { computeHealthSignal } from '@/lib/autonomy/telemetry'
import { getRuntimeWindowStats } from '@/lib/services/metrics'
import { queryRequestLogs } from '@/lib/monitoring/request-log-query'
import { generateOpenApiSpec } from '@/lib/services/openapi-generator'
import { listExposedTables } from '@/lib/mcp/schema-introspection'

let server: http.Server
let base: string
let ownerId: string
let projectId: string
let branchId: string
let mergedBranchId: string
let mainSchema: string
let branchSchema: string

async function waitForRows(where: Record<string, unknown>, atLeast: number) {
  for (let i = 0; i < 40; i++) {
    await flushRecordedRequests()
    const rows = await prisma.apiRequestLog.findMany({ where: { projectId, ...where } })
    if (rows.length >= atLeast) return rows
    await new Promise(r => setTimeout(r, 100))
  }
  return prisma.apiRequestLog.findMany({ where: { projectId, ...where } })
}

beforeAll(async () => {
  const owner = await prisma.user.create({
    data: { email: `branch-preview-${randomUUID()}@example.test` },
    select: { id: true },
  })
  ownerId = owner.id
  const project = await prisma.project.create({
    data: { name: `branch-preview-${randomUUID().slice(0, 8)}`, userId: ownerId },
    select: { id: true },
  })
  projectId = project.id
  mainSchema = `workspace_${projectId}`
  branchSchema = `${mainSchema}_br_preview`

  await prisma.$executeRawUnsafe(`CREATE SCHEMA "${mainSchema}"`)
  await prisma.$executeRawUnsafe(`CREATE TABLE "${mainSchema}"."things" (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), title text)`)
  await prisma.$executeRawUnsafe(`CREATE SCHEMA "${branchSchema}"`)
  await prisma.$executeRawUnsafe(`CREATE TABLE "${branchSchema}"."things" (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), title text)`)
  await prisma.$executeRawUnsafe(`CREATE TABLE "${branchSchema}"."invoices" (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), amount integer NOT NULL)`)

  const branch = await prisma.workspaceBranch.create({
    data: { projectId, name: 'preview', schemaName: branchSchema, status: 'active', createdBy: ownerId },
  })
  branchId = branch.id
  const merged = await prisma.workspaceBranch.create({
    data: {
      projectId, name: 'shipped', schemaName: `${mainSchema}_br_shipped`,
      status: 'merged', createdBy: ownerId, mergedAt: new Date(),
    },
  })
  mergedBranchId = merged.id
  clearBranchKeyCache()

  server = http.createServer(app)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}, 120_000)

afterAll(async () => {
  await flushRecordedRequests()
  await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${branchSchema}" CASCADE`).catch(() => {})
  await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${mainSchema}" CASCADE`).catch(() => {})
  if (ownerId) await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
  server.closeAllConnections()
  await new Promise<void>(resolve => server.close(() => resolve()))
}, 120_000)

describe('the agent tool issues a preview endpoint', () => {
  it('connect_branch returns a branch key and how to use it', async () => {
    const res = await dispatchTool('connect_branch', { branchId }, { projectId, userId: ownerId })
    expect(res.ok).toBe(true)
    const preview = (res.data as any).preview
    expect(preview.key).toMatch(/^proj_preview_[0-9a-f]{64}$/)
    expect(preview.baseUrl).toMatch(new RegExp(`/api/v1/${projectId}$`))
    expect(preview.environmentHeader).toEqual({ name: 'X-Backenly-Environment', value: 'branch:preview' })
    expect(preview.openapiUrl).toContain(`branch=${branchId}`)
    expect(preview.instructions).toMatch(/BRANCH_SURFACE_UNAVAILABLE/)
    expect(res.summary).toContain(preview.key)

    const row = await prisma.apiKey.findFirst({ where: { projectId, branchId, keyPrefix: preview.key.slice(0, 16) } })
    expect(row?.serviceRole).toBe(false)
    expect(row?.key ?? null).toBeNull() // the plaintext is never stored
  })

  it('issues a server-side key only when asked', async () => {
    const res = await dispatchTool('connect_branch', { branchId, serviceRole: true }, { projectId, userId: ownerId })
    expect((res.data as any).preview.key).toMatch(/^svc_preview_/)
  })

  it('refuses a merged branch, and a branch of another project', async () => {
    const merged = await dispatchTool('connect_branch', { branchId: mergedBranchId }, { projectId, userId: ownerId })
    expect(merged.ok).toBe(false)
    expect(merged.code).toBe('BRANCH_NOT_FOUND')
    const foreign = await mintPreviewKey(randomUUID(), branchId)
    expect(foreign.ok).toBe(false)
  })

  it('guards the SDK snippet against falling back to the production anon key', () => {
    expect(previewSdkSnippet(projectId)).toMatch(/if \(!apiKey\) throw/)
  })
})

describe('the preview key on the runtime', () => {
  let key: string
  beforeAll(async () => {
    const minted = await mintPreviewKey(projectId, branchId)
    if (!minted.ok) throw new Error('mint failed')
    key = (minted as Extract<typeof minted, { ok: true }>).minted.key
  })

  it('reaches the branch on the data API and says so', async () => {
    const res = await fetch(`${base}/api/v1/${projectId}/db/things`, { headers: { 'x-api-key': key } })
    await res.text()
    expect(res.headers.get('x-backenly-environment')).toBe('branch:preview')
  }, 60_000)

  it('is refused off the data plane', async () => {
    // Sign-up is branch-scoped (tests/integration/branch-auth.spec.ts); a
    // function is not.
    const res = await fetch(`${base}/api/v1/${projectId}/fn/send-welcome`, {
      method: 'POST',
      headers: { 'x-api-key': key, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(403)
    expect((await res.json()).code).toBe(BRANCH_SURFACE_UNAVAILABLE)
  }, 60_000)

  it('is logged against the branch by the runtime', async () => {
    const rows = await waitForRows({ branchId, path: '/db/things' }, 1)
    expect(rows.length).toBeGreaterThanOrEqual(1)
  }, 60_000)

  it('is logged against the branch by the Next door too', async () => {
    const handler = recordedV1(async () => new Response('{}', { status: 200 }))
    await handler(
      new Request(`http://x/api/v1/${projectId}/db/invoices`, { headers: { 'x-api-key': key } }),
      { params: Promise.resolve({ projectId }) },
    )
    const rows = await waitForRows({ branchId, path: '/db/invoices' }, 1)
    expect(rows.length).toBe(1)
  }, 60_000)
})

describe('production health readers ignore branch traffic', () => {
  beforeAll(async () => {
    const now = Date.now()
    const at = (minsAgo: number) => new Date(now - minsAgo * 60_000)
    await prisma.apiRequestLog.createMany({
      data: [
        // Production: healthy.
        ...[1, 2, 3].map(m => ({ projectId, userId: ownerId, method: 'GET', path: '/db/things', statusCode: 200, duration: 12, timestamp: at(m), branchId: null })),
        // A branch's failure tests: every one a 500.
        ...[1, 2, 3, 4, 5, 6].map(m => ({ projectId, userId: ownerId, method: 'POST', path: '/db/things', statusCode: 500, duration: 900, timestamp: at(m), branchId })),
      ],
    })
  })

  it('keeps branch 5xx out of the window stats Monitoring and anomaly detection read', async () => {
    // A day either side: the stats query compares a timestamp column with a
    // timestamptz parameter, so a database whose session zone is not UTC shifts
    // the rows by its offset. A narrow window would pass here by excluding the
    // rows altogether, which is a test asserting nothing.
    const day = 24 * 3_600_000
    const stats = await getRuntimeWindowStats(projectId, new Date(Date.now() - day), new Date(Date.now() + day))
    expect(stats.count).toBe(3)
    expect(stats.serverErrorCount).toBe(0)
    expect(stats.reliabilityPct).toBe(100)
  })

  it('keeps branch traffic out of the autonomy health signal', async () => {
    const signal = await computeHealthSignal(projectId, 60)
    const branchRows = await prisma.apiRequestLog.count({ where: { projectId, branchId: { not: null } } })
    const mainRows = await prisma.apiRequestLog.count({ where: { projectId, branchId: null, NOT: { path: { startsWith: '/api/' } } } })
    expect(branchRows).toBeGreaterThan(0)
    expect(signal.sampleSize).toBe(mainRows)
  })

  it('shows production by default and the branch only when asked', async () => {
    const main = await queryRequestLogs(projectId, { limit: 200 })
    expect(main.every(r => r.status !== 500)).toBe(true)
    const branch = await queryRequestLogs(projectId, { branchId, minStatus: 500, limit: 200 })
    expect(branch.length).toBe(6)
  })
})

describe('the branch OpenAPI spec', () => {
  it('describes the branch schema, labels the server as the preview, and lists only the data API and auth', async () => {
    const spec = await generateOpenApiSpec(projectId, 'https://backenly.test', { name: 'preview', schemaName: branchSchema })
    expect(Object.keys(spec.paths)).toEqual(expect.arrayContaining(['/db/things', '/db/invoices', '/auth/signup', '/auth/signin']))
    expect(Object.keys(spec.paths).some(p => p.startsWith('/fn'))).toBe(false)
    // On a branch the key is what puts the user there, so sign-up declares it.
    expect(spec.paths['/auth/signup'].post.security).toEqual([{ ApiKeyAuth: [] }])
    expect(spec.servers[0].url).toBe(`https://backenly.test/api/v1/${projectId}`)
    expect(spec.servers[0].description).toMatch(/Preview branch "preview"/)
  })

  it('leaves the main spec on the main schema', async () => {
    const spec = await generateOpenApiSpec(projectId, 'https://backenly.test')
    expect(Object.keys(spec.paths)).toContain('/db/things')
    expect(Object.keys(spec.paths)).not.toContain('/db/invoices')
    expect(spec.servers[0].description).toBe('Production')
    expect(spec.paths['/auth/signup'].post.security).toEqual([])
  })

  it('refuses to read a schema that belongs to another project', async () => {
    await expect(listExposedTables(projectId, { branchSchema: `workspace_${randomUUID()}_br_preview` })).rejects.toThrow(
      /does not belong to project/,
    )
  })

  it('names the endpoint consistently with the dashboard', () => {
    const e = previewEndpoint(projectId, { id: branchId, name: 'preview' }, 'https://backenly.test/')
    expect(e.baseUrl).toBe(`https://backenly.test/api/v1/${projectId}`)
    expect(e.v2Url).toBe(`https://backenly.test/api/v2/${projectId}/{table}`)
  })
})
