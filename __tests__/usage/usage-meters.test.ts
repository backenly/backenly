/**
 * EVERY METER MEASURES WHAT ITS DEFINITION SAYS
 * =============================================
 * lib/usage/axes.ts defines each metered axis. These tests hold each meter to
 * its definition against a real database, through the same process-wide ledger
 * production uses:
 *
 *   egress_bytes  bytes of the response bodies a project sends, counted once,
 *                 never for Backenly's own synthetic traffic
 *   mau           each end user once per month, however many sign-ins,
 *                 refreshes and requests; never verifier accounts
 *   db_bytes      the workspace schema AND its branch schemas, not a neighbour
 *   file_bytes    the storage metadata sum of files not deleted
 *   fn_runs       every invocation that executes, success or failure; not a
 *                 call to a function that does not exist
 */

// The real Request/Response/ReadableStream: egress is measured on real streams,
// not on jest.setup.js's stand-ins. Must come before anything importing next/server.
import '../../tests/helpers/real-web-standard'
import { randomUUID } from 'crypto'
import { prisma } from '@/lib/db/prisma'
import { usageLedger } from '@/lib/usage/ledger'
import { meterResponseBody, meterNodeResponse } from '@/lib/usage/egress'
import { recordedV1 } from '@/lib/traffic/recorded-v1'
import { internalTrafficHeaders } from '@/lib/traffic/request-recorder'
import { trackEndUserActive, noteEndUserActivity } from '@/lib/quota/kernel'
import { measureProjectDbBytes, snapshotProjectDbStorage } from '@/lib/usage/db-storage'
import { reconcileFileStorage } from '@/lib/usage/file-storage'
import { executeAiFunction } from '@/lib/services/ai-functions/executor'

const DB_URL = process.env.TEST_DATABASE_URL ?? ''
const users: string[] = []
const projects: string[] = []
const schemas: string[] = []

function assertSafeTestDatabase(): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('Refusing: NODE_ENV is not test')
  if (!DB_URL) throw new Error('Refusing: TEST_DATABASE_URL is not set')
  const dbName = DB_URL.split('/').pop()?.split('?')[0] ?? ''
  if (!/test/i.test(dbName)) throw new Error(`Refusing: "${dbName}" is not a test database`)
  if (process.env.DATABASE_URL !== DB_URL) throw new Error('Refusing: DATABASE_URL is not the test database')
}

async function makeProject() {
  const user = await prisma.user.create({
    data: { email: `meters-${randomUUID()}@test.invalid`, name: 'Meters Test' },
    select: { id: true },
  })
  users.push(user.id)
  const p = await prisma.project.create({ data: { name: `meters-${randomUUID().slice(0, 8)}`, userId: user.id }, select: { id: true } })
  projects.push(p.id)
  return { userId: user.id, projectId: p.id }
}

async function quantity(projectId: string, axis: string, source: string): Promise<bigint> {
  await usageLedger().flush()
  const rows = await prisma.usageDaily.findMany({ where: { projectId, axis, source } })
  return rows.reduce((s, r) => s + r.quantity, BigInt(0))
}

async function drain(res: Response): Promise<number> {
  const buf = await res.arrayBuffer()
  return buf.byteLength
}

beforeAll(() => assertSafeTestDatabase())

afterAll(async () => {
  await usageLedger().flush().catch(() => {})
  for (const s of schemas) await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${s}" CASCADE`)
  await prisma.usageDaily.deleteMany({ where: { projectId: { in: projects } } })
  await prisma.project.deleteMany({ where: { id: { in: projects } } })
  await prisma.user.deleteMany({ where: { id: { in: users } } })
})

// ============================================================================
// EGRESS
// ============================================================================

describe('egress_bytes', () => {
  it('counts exactly the bytes of a streamed body, chunk by chunk', async () => {
    const { projectId } = await makeProject()
    const chunks = [new Uint8Array(10), new Uint8Array(2000), new TextEncoder().encode('héllo')] // 5 chars, 6 bytes
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        for (const ch of chunks) c.enqueue(ch)
        c.close()
      },
    })
    const metered = meterResponseBody(new Response(body, { status: 200, headers: { 'x-kept': 'yes' } }), projectId)
    expect(metered.status).toBe(200)
    expect(metered.headers.get('x-kept')).toBe('yes')
    expect(await drain(metered)).toBe(2016)
    expect(await quantity(projectId, 'egress_bytes', 'app')).toBe(BigInt(2016))
  })

  it('meters every /api/v1 route through recordedV1, and not Backenly\'s own traffic', async () => {
    const { projectId } = await makeProject()
    const handler = recordedV1(async () => new Response('x'.repeat(4096), { status: 200 }))
    const context = { params: Promise.resolve({ projectId }) }

    const external = new Request(`http://localhost/api/v1/${projectId}/db/items`)
    expect(await drain(await handler(external, context))).toBe(4096)

    const internal = new Request(`http://localhost/api/v1/${projectId}/db/items`, { headers: internalTrafficHeaders() })
    expect(await drain(await handler(internal, context))).toBe(4096)

    expect(await quantity(projectId, 'egress_bytes', 'app')).toBe(BigInt(4096))
  })

  it('meters a Node response (the single-box edge): strings by their UTF-8 size, buffers by length', async () => {
    const { projectId } = await makeProject()
    const res = { write: (..._a: any[]) => true, end: (..._a: any[]) => undefined }
    meterNodeResponse(res, projectId)
    res.write('abc')
    res.write('€', 'utf8') // 3 bytes
    res.write(Buffer.alloc(100))
    res.end('done')
    expect(await quantity(projectId, 'egress_bytes', 'app')).toBe(BigInt(3 + 3 + 100 + 4))
  })
})

// ============================================================================
// MAU
// ============================================================================

describe('mau', () => {
  it('counts each end user once a month, however they show up', async () => {
    const { projectId } = await makeProject()
    const alice = randomUUID()
    const bob = randomUUID()
    await trackEndUserActive(projectId, alice, 'alice@example.com') // sign-in
    await trackEndUserActive(projectId, alice, 'alice@example.com') // refresh
    noteEndUserActivity(projectId, alice, 'alice@example.com') // data request
    noteEndUserActivity(projectId, alice, 'alice@example.com')
    await trackEndUserActive(projectId, bob, 'bob@example.com')
    await new Promise((r) => setTimeout(r, 200)) // noteEndUserActivity does not await
    expect(await quantity(projectId, 'mau', 'auth')).toBe(BigInt(2))
  })

  it('counts concurrent first requests of the same user once', async () => {
    const { projectId } = await makeProject()
    const carol = randomUUID()
    await Promise.all(Array.from({ length: 8 }, () => trackEndUserActive(projectId, carol, 'carol@example.com')))
    expect(await quantity(projectId, 'mau', 'auth')).toBe(BigInt(1))
  })

  it('never counts a verifier account', async () => {
    const { projectId } = await makeProject()
    await trackEndUserActive(projectId, randomUUID(), 'probe-123@backenly.internal')
    expect(await quantity(projectId, 'mau', 'auth')).toBe(BigInt(0))
  })
})

// ============================================================================
// DATABASE STORAGE
// ============================================================================

describe('db_bytes', () => {
  async function schemaWithRows(name: string, rows: number) {
    schemas.push(name)
    await prisma.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "${name}"`)
    await prisma.$executeRawUnsafe(`CREATE TABLE "${name}".t (id serial primary key, payload text)`)
    await prisma.$executeRawUnsafe(`INSERT INTO "${name}".t (payload) SELECT repeat('x', 500) FROM generate_series(1, ${rows})`)
    const r = await prisma.$queryRawUnsafe<Array<{ b: bigint }>>(`SELECT pg_total_relation_size('"${name}".t')::bigint AS b`)
    return BigInt(r[0].b)
  }

  it('includes the project\'s branch schemas and nothing of another project', async () => {
    const { userId, projectId } = await makeProject()
    const { projectId: neighbour } = await makeProject()
    const main = await schemaWithRows(`workspace_${projectId}`, 200)
    const branch = await schemaWithRows(`workspace_${projectId}_br_feature_x`, 100)
    await schemaWithRows(`workspace_${neighbour}`, 300)

    expect(await measureProjectDbBytes(projectId)).toBe(main + branch)

    await snapshotProjectDbStorage(projectId, userId)
    expect(await quantity(projectId, 'db_bytes', 'pg')).toBe(main + branch)
  })
})

// ============================================================================
// FILE STORAGE
// ============================================================================

describe('file_bytes', () => {
  it('is the metadata sum of files that are not deleted, whatever the counter says', async () => {
    const { userId, projectId } = await makeProject()
    // The drifting counter the old code trusted says something else entirely.
    await prisma.project.update({ where: { id: projectId }, data: { storageUsed: BigInt(999_999) } })
    const bucket = await prisma.storageBucket.create({ data: { name: `b-${randomUUID().slice(0, 6)}`, projectId } })
    const file = (size: number, deleted = false) =>
      prisma.storageFile.create({
        data: {
          bucketId: bucket.id,
          projectId,
          name: `${randomUUID()}.txt`,
          path: `${projectId}/${bucket.id}/${randomUUID()}.txt`,
          size: BigInt(size),
          ...(deleted ? { deletedAt: new Date() } : {}),
        },
      })
    await file(1000)
    await file(2500)
    await file(7777, true)

    await reconcileFileStorage([{ id: projectId, userId }])
    expect(await quantity(projectId, 'file_bytes', 'metadata')).toBe(BigInt(3500))
  })
})

// ============================================================================
// FUNCTION RUNS
// ============================================================================

describe('fn_runs', () => {
  it('counts runs that executed, successful or not, and not a missing function', async () => {
    const { projectId } = await makeProject()
    const fn = (name: string, code: string) =>
      prisma.aiFunction.create({ data: { projectId, name, description: name, generatedCode: code, triggerType: 'manual', status: 'active' } })
    const ok = await fn('meter-ok', 'return { ok: true }')
    const bad = await fn('meter-bad', "throw new Error('broken on purpose')")

    expect((await executeAiFunction(ok.id, projectId, { type: 'manual', data: {} }, { selfHeal: false })).success).toBe(true)
    expect((await executeAiFunction(bad.id, projectId, { type: 'manual', data: {} }, { selfHeal: false })).success).toBe(false)
    const missing = await executeAiFunction(randomUUID(), projectId, { type: 'manual', data: {} }, { selfHeal: false })
    expect(missing.success).toBe(false)

    expect(await quantity(projectId, 'fn_runs', 'executor')).toBe(BigInt(2))
  }, 60_000)
})
