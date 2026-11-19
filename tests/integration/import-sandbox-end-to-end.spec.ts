/**
 * The import sandbox, end to end, against a real PostgreSQL source.
 *
 * The task's own code (lib/import/worker/main.ts) runs here in the test's
 * process, and each call it makes goes to the control plane's real handler
 * (lib/import/worker-api.ts) as a Request, exactly as it would over https from
 * a sandbox task: the spec handed over once, the source checked and read by
 * the driver, every write asked of the control plane and run there. Then what a
 * task may NOT do: write Backenly's own tables or another project's, write past
 * the plan's room, speak for a job with the wrong token or from the wrong task,
 * or do anything at all once its job has ended.
 */

jest.mock('@cloud/entitlements', () => {
  const actual = jest.requireActual('@cloud/entitlements')
  const { selfHostedEntitlements } = jest.requireActual('@/lib/entitlements/self-hosted')
  return { ...actual, cloudEntitlements: async () => ({ ...selfHostedEntitlements(), planName: 'BUILDER' }) }
})
jest.mock('@/lib/postgrest/registration', () => {
  const actual = jest.requireActual('@/lib/postgrest/registration')
  return {
    ...actual,
    registerSchemaByName: async (schema: string) => ({ registered: true, schema }),
    ensureSchemaRegistered: async (projectId: string) => ({ registered: true, schema: `workspace_${projectId}` }),
    unregisterSchema: async () => {},
  }
})

// The task and the handler speak real Requests and Responses (bodies streamed,
// gzip, kept-alive answers): the runtime's own classes, not jest.setup.js's stand-ins.
import '@/tests/helpers/real-web-standard'
import crypto from 'crypto'
import { gzipSync } from 'zlib'
import { Client } from 'pg'
import type { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import { createProvisionedProject } from '@/lib/projects/provision'
import { closeChangeLockPool } from '@/lib/changes/lock'
import type { ImportConnection } from '@/lib/import/contract'
import type { ImportLimits } from '@/lib/import/driver'
import { IMPORT_JOB_TYPE, JOB_STATUS } from '@/lib/import/jobs'
import { limitsLeft } from '@/lib/import/limits'
import { initialProgress } from '@/lib/import/progress'
import { newJobToken, sealConnection } from '@/lib/import/sandbox'
import { LOOK_JOB_TYPE, readImportStart, readLook, type SandboxStage } from '@/lib/import/sandbox-jobs'
import { handleWorkerCall } from '@/lib/import/worker-api'
import { runWorker } from '@/lib/import/worker/main'
import { HEADER_JOB, HEADER_TASK } from '@/lib/import/worker/protocol'

const MB = 1024 * 1024
const suffix = crypto.randomBytes(4).toString('hex')
const SOURCE = `bkn_sbx_src_${suffix}`
const EGRESS = 'BACKENLY_IMPORT_EGRESS_ALLOW_PRIVATE'
const saved = { egress: process.env[EGRESS], edition: process.env.BACKENLY_EDITION, engine: process.env.ENGINE_MODE }

let admin: Client
let ownerId: string
let strangerId: string
let projectId: string
let schema: string

const connection: () => ImportConnection = () => ({ source: 'postgres', connectionString: process.env.TEST_DATABASE_URL!, schemas: [SOURCE] })
const roomy = (): ImportLimits => limitsLeft({ planRowBytes: 500 * MB, planFileBytes: null, usedRowBytes: 0, usedFileBytes: 0, planName: 'Pro' })

/** What sandbox-jobs.ts writes when it launches a task, for a project that exists already. */
async function job(kind: 'look' | 'import', opts: { stage?: SandboxStage; limits?: ImportLimits; taskArn?: string; handed?: boolean } = {}) {
  const jobId = crypto.randomUUID()
  const { token, hash } = newJobToken()
  const now = new Date()
  const sandbox = {
    kind,
    tokenHash: hash,
    sealed: await sealConnection(connection()),
    handed: opts.handed ?? false,
    taskArn: opts.taskArn ?? null,
    stage: opts.stage ?? 'launching',
    deadlineAt: new Date(now.getTime() + 30 * 60_000).toISOString(),
    limits: opts.limits ?? roomy(),
  }
  const payload =
    kind === 'look'
      ? { orgId: 'org-sbx', userId: ownerId, source: 'postgres', sandbox, preview: null, refusal: null }
      : {
          orgId: 'org-sbx',
          userId: ownerId,
          source: 'postgres',
          include: { users: false, files: false },
          progress: initialProgress({ jobId, projectId, projectName: 'sbx', region: 'ap-south-1', orgId: 'org-sbx', source: 'postgres', startedAt: now, phase: 'tables', status: 'running' }),
          name: 'sbx',
          region: 'ap-south-1',
          owner: { ownerId, organizationId: null },
          sandbox,
          refusal: null,
        }
  await prisma.backgroundJob.create({
    data: {
      id: jobId,
      type: kind === 'look' ? LOOK_JOB_TYPE : IMPORT_JOB_TYPE,
      status: JOB_STATUS.running,
      projectId: kind === 'import' ? projectId : null,
      payload: payload as unknown as Prisma.InputJsonValue,
      attempts: 1,
      maxAttempts: 1,
      runAt: now,
      startedAt: now,
      timeoutAt: new Date(now.getTime() + 4 * 60_000),
    },
  })
  return { jobId, token }
}

/** The task's https calls, delivered to the control plane's handler as Requests. */
const toHandler: typeof fetch = async (input, init) => {
  const url = new URL(input instanceof URL ? input.href : String(input))
  const body = init?.body as unknown as Uint8Array | undefined
  return handleWorkerCall(url.pathname.split('/').pop()!, new Request(url, { method: 'POST', headers: init?.headers as HeadersInit, body: body ? Buffer.from(body) : undefined }))
}

/** One call as a task would make it; the answer's status (a kept-alive answer carries it inside) and body. */
async function call(j: { jobId: string; token: string }, action: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await handleWorkerCall(
    action,
    new Request(`http://127.0.0.1/api/import/worker/${action}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${j.token}`, [HEADER_JOB]: j.jobId, 'content-type': 'application/json', 'content-encoding': 'gzip', ...headers },
      body: gzipSync(Buffer.from(JSON.stringify(body))),
    }),
  )
  const text = (await res.text()).trim()
  const json = text ? JSON.parse(text) : {}
  return { status: typeof json.status === 'number' ? json.status : res.status, json }
}

beforeAll(async () => {
  process.env.BACKENLY_EDITION = 'cloud'
  process.env.ENGINE_MODE = 'runtime'
  process.env[EGRESS] = 'true'
  admin = new Client({ connectionString: process.env.TEST_DATABASE_URL })
  await admin.connect()
  await admin.query(`CREATE SCHEMA "${SOURCE}"`)
  await admin.query(`CREATE TABLE "${SOURCE}".authors (id uuid PRIMARY KEY, name text NOT NULL)`)
  await admin.query(`CREATE TABLE "${SOURCE}".posts (id bigint PRIMARY KEY, author_id uuid REFERENCES "${SOURCE}".authors(id), title text, published boolean NOT NULL DEFAULT false)`)
  await admin.query(`INSERT INTO "${SOURCE}".authors SELECT md5(g::text)::uuid, 'author ' || g FROM generate_series(1, 12) g`)
  await admin.query(`INSERT INTO "${SOURCE}".posts SELECT g, md5((g % 12 + 1)::text)::uuid, 'post ' || g, g % 2 = 0 FROM generate_series(1, 240) g`)

  const mk = (tag: string) =>
    prisma.user.create({ data: { email: `sbx-${tag}-${crypto.randomBytes(6).toString('hex')}@example.test`, password: 'not-a-real-hash', name: tag } })
  ownerId = (await mk('owner')).id
  strangerId = (await mk('stranger')).id
  const project = await createProvisionedProject({ name: 'import-sandbox', userId: ownerId })
  projectId = project.id
  schema = project.postgresSchema
}, 240_000)

afterAll(async () => {
  await prisma.backgroundJob.deleteMany({ where: { payload: { path: ['orgId'], equals: 'org-sbx' } } }).catch(() => {})
  await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
  await prisma.project.deleteMany({ where: { id: projectId } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: { in: [ownerId, strangerId] } } }).catch(() => {})
  await admin.query(`DROP SCHEMA IF EXISTS "${SOURCE}" CASCADE`).catch(() => {})
  await admin.end()
  await closeChangeLockPool().catch(() => {})
  for (const [k, v] of [
    [EGRESS, saved.egress],
    ['BACKENLY_EDITION', saved.edition],
    ['ENGINE_MODE', saved.engine],
  ] as const) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

it('reads a source for the Review step in the sandbox, and keeps the preview for the person who asked', async () => {
  const look = await job('look')
  await expect(runWorker({ origin: 'http://127.0.0.1', ...look }, { taskArn: null, fetchImpl: toHandler })).resolves.toBe(0)

  const answer = await readLook(look.jobId, ownerId)
  expect(answer?.state).toBe('done')
  const preview = (answer as Extract<typeof answer, { state: 'done' }>).preview
  expect(preview.tables.map((t) => t.name).sort()).toEqual(['authors', 'posts'])
  // Nobody else may read it, and the connection is gone from the row.
  expect(await readLook(look.jobId, strangerId)).toBeNull()
  const row = await prisma.backgroundJob.findUnique({ where: { id: look.jobId } })
  expect((row?.payload as any).sandbox).toMatchObject({ sealed: null, tokenHash: null, stage: 'ended' })
}, 240_000)

it('moves a source into the project through the sandbox, every write run by the control plane', async () => {
  const run = await job('import')
  await expect(runWorker({ origin: 'http://127.0.0.1', ...run }, { taskArn: null, fetchImpl: toHandler })).resolves.toBe(0)

  const row = await prisma.backgroundJob.findUnique({ where: { id: run.jobId } })
  expect(row?.status).toBe(JOB_STATUS.done)
  expect((row?.payload as any).progress).toMatchObject({ status: 'done', phase: 'finished' })
  expect((row?.payload as any).sandbox).toMatchObject({ sealed: null, tokenHash: null, stage: 'ended' })
  const counts = await prisma.$queryRawUnsafe<Array<{ a: string; p: string; pub: string }>>(
    `SELECT (SELECT count(*) FROM "${schema}".authors)::text AS a, (SELECT count(*) FROM "${schema}".posts)::text AS p,
            (SELECT count(*) FROM "${schema}".posts WHERE published)::text AS pub`,
  )
  expect(counts[0]).toEqual({ a: '12', p: '240', pub: '120' })
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { importedFrom: true } })
  expect(project?.importedFrom).toMatchObject({ source: 'postgres', tables: 2, rows: 252 })

  // Its start is answered to the person who started it, and to nobody else.
  expect(await readImportStart(run.jobId, ownerId)).toEqual({ state: 'started', projectId })
  expect(await readImportStart(run.jobId, strangerId)).toBeNull()
  // The job ended: its token proves nothing any more.
  expect((await call(run, 'progress', { patch: {} })).status).toBe(404)
}, 300_000)

describe('what a task may not do', () => {
  it('speaks for no job with the wrong token, and for a job only from its own task', async () => {
    const j = await job('import', { stage: 'running', handed: true })
    expect((await call({ ...j, token: newJobToken().token }, 'next', {})).status).toBe(404)
    const pinned = await job('import', { stage: 'running', handed: true, taskArn: 'arn:aws:ecs:ap-south-1:111122223333:task/c/abc' })
    expect((await call(pinned, 'next', {})).status).toBe(403)
    expect((await call(pinned, 'next', {}, { [HEADER_TASK]: 'arn:aws:ecs:ap-south-1:111122223333:task/c/abc' })).status).toBe(200)
  })

  it("writes neither Backenly's own tables nor a table the project does not have", async () => {
    const j = await job('import', { stage: 'running', handed: true })
    const users = await call(j, 'op', { op: 'pg.insertRows', args: { table: 'users', columns: ['email'], rows: [['x@example.test']] } })
    expect(users.status).toBe(400)
    const ghost = await call(j, 'op', { op: 'pg.insertRows', args: { table: `t_${suffix}`, columns: ['id'], rows: [['1']] } })
    expect(ghost.status).toBe(404)
    // Not a Firestore op, for a Postgres import.
    expect((await call(j, 'op', { op: 'fb.prepareUsers', args: {} })).status).toBe(400)
    // Users and files move only when the person chose them.
    expect((await call(j, 'op', { op: 'pg.insertUsers', args: { users: [] } })).status).toBe(403)
  })

  it('writes nothing past the plan’s room, measured where it writes', async () => {
    const limits = limitsLeft({ planRowBytes: 2 * MB, planFileBytes: null, usedRowBytes: 0, usedFileBytes: 0, planName: 'Free' })
    const j = await job('import', { stage: 'running', handed: true, limits })
    const created = await call(j, 'op', {
      op: 'pg.createTables',
      args: {
        tables: [{ name: `blobs_${suffix}`, columns: [{ name: 'id', type: 'UUID', sqlType: 'uuid', notNull: true, unique: true }, { name: 'body', type: 'TEXT', sqlType: 'text' }] }],
        title: 'Move in from Postgres: 1 table',
        usersTable: null,
      },
    })
    expect(created.status).toBe(200)
    // Creating twice is refused: schema work happens once per import.
    expect((await call(j, 'op', { op: 'pg.createTables', args: { tables: [{ name: `again_${suffix}`, columns: [] }], title: 'x', usersTable: null } })).status).toBe(409)
    const rows = Array.from({ length: 40 }, () => [crypto.randomUUID(), crypto.randomBytes(64 * 1024).toString('hex')])
    const refused = await call(j, 'op', { op: 'pg.insertRows', args: { table: `blobs_${suffix}`, columns: ['id', 'body'], rows } })
    expect(refused.status).toBe(409)
    expect(refused.json.code).toBe('IMPORT_ROOM')
    expect(refused.json.error).toMatch(/^Backenly stopped the import after /)
  })

  it('does nothing at all once its job has ended', async () => {
    const j = await job('import', { stage: 'running', handed: true })
    expect((await call(j, 'fail', { message: 'stopped' })).status).toBe(200)
    expect((await call(j, 'op', { op: 'pg.measure', args: {} })).status).toBe(404)
    expect((await call(j, 'spec', { protocol: 1 })).status).toBe(404)
  })
})
