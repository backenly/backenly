/**
 * POST /api/import/worker/{action} — the control plane's answer to a sandbox
 * task (lib/import/worker/main.ts). See lib/import/worker/protocol.ts.
 *
 * A task is untrusted the moment it has read its source, so everything it
 * sends is checked here before anything runs, and runs with Backenly's own code
 * against its own job's project only:
 *
 *   - the job is proven by its token (only the SHA-256 is stored), and, where
 *     the job's task is known, by the task's ARN as well; a job that ended
 *     answers nothing but 409 IMPORT_ENDED;
 *   - every body is read within a cap, gzip included, before it is parsed;
 *   - every op's arguments are checked against a closed schema: names are
 *     PostgreSQL names, types come from closed lists, sizes are capped; rows go
 *     only into tables of the job's own project that exist, through the columns
 *     they have, never into Backenly's own (users, or a name starting with _);
 *   - schema work happens once per job, and only what the person chose moves
 *     (users, files);
 *   - every write is measured against the plan's room HERE, whatever the task
 *     counted (ROOM_REFUSED when it would not fit), one write at a time per job;
 *   - everything is attributed to the import in History, as when it ran in one
 *     process.
 */

import { promisify } from 'util'
import { gunzip } from 'zlib'
import { NextResponse } from 'next/server'

const gunzipAsync = promisify(gunzip)
import type { BackgroundJob } from '@prisma/client'
import { z } from 'zod'
import { prisma } from '@/lib/db/prisma'
import { isDeclaredForeignKey } from '@/lib/db/declared-foreign-key'
import { MAX_BUFFERED_UPLOAD_FILE_BYTES } from '@/lib/storage/body-limits'
import { isFirebaseHash, parseFirebaseHash } from '@/lib/auth/firebase-scrypt'
import { ROOM_REFUSED } from './destination'
import { IMPORT_JOB_TYPE, ImportRefusedError, JOB_STATUS } from './jobs'
import { localPgDestination } from './local-destination'
import { MAX_IMPORT_TABLES, PAGE_SLACK_BYTES, STORED_PER_COUNTED, roomRefusal } from './limits'
import { measureProjectRows, rowCost } from './pg-engine'
import { KEPT_BCRYPT_HASH, keptAuthUser, userCost } from './supabase-auth'
import type { ImportedUser } from './drivers/firebase-users'
import { tokenMatches } from './sandbox'
import {
  LOOK_JOB_TYPE,
  extendLease,
  lapsed,
  closeLapsed,
  sandboxOf,
  takeOnce,
  workerChecked,
  workerFail,
  workerFinish,
  workerPreview,
  workerProgress,
  workerSpec,
  type ImportPayload,
  type OnceStep,
} from './sandbox-jobs'
import {
  BODY_LIMITS,
  FIREBASE_OPS,
  HEADER_BUCKET,
  HEADER_FILE_NAME,
  HEADER_FILE_TYPE,
  HEADER_JOB,
  HEADER_TASK,
  PG_OPS,
  PROTOCOL,
  WORKER_ACTIONS,
  type DestinationOp,
  type WorkerAction,
} from './worker/protocol'

const NO_STORE = { 'Cache-Control': 'no-store' }

function answer(status: number, body: Record<string, unknown>): NextResponse {
  return NextResponse.json(status < 400 ? { ok: true, ...body } : { ok: false, ...body }, { status, headers: NO_STORE })
}

const notFound = () => answer(404, { error: 'Not found' })
const ended = () => answer(409, { error: 'This import has ended.', code: 'IMPORT_ENDED' })

class Refused extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message)
  }
}

// ── Bodies ────────────────────────────────────────────────────────────────────

async function readBody(request: Request, max: number): Promise<Buffer> {
  const declared = Number(request.headers.get('content-length') ?? 'NaN')
  if (Number.isFinite(declared) && declared > max) throw new Refused(413, 'The body is too large.')
  const reader = request.body?.getReader()
  const parts: Buffer[] = []
  let size = 0
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > max) {
        await reader.cancel().catch(() => {})
        throw new Refused(413, 'The body is too large.')
      }
      parts.push(Buffer.from(value))
    }
  }
  return Buffer.concat(parts)
}

async function readJson(request: Request, max: number): Promise<unknown> {
  const raw = await readBody(request, max)
  let text: Buffer = raw
  if ((request.headers.get('content-encoding') ?? '').toLowerCase() === 'gzip') {
    try {
      // Bounded: a small body that inflates past the cap is refused, not inflated. Off the
      // event loop: a large body inflates in libuv's pool, not in the request's turn.
      text = await gunzipAsync(raw, { maxOutputLength: max })
    } catch {
      throw new Refused(413, 'The body is too large or not gzip.')
    }
  }
  try {
    return JSON.parse(text.toString('utf8'))
  } catch {
    throw new Refused(400, 'The body is not JSON.')
  }
}

// ── Long ops ──────────────────────────────────────────────────────────────────

/**
 * Answer a long op: a space every 15 s while it runs, so the load balancer's
 * idle timeout never ends the request, then the JSON. The status is then
 * always 200; `ok: false` and `status` in the body say a refusal.
 */
function keepAlive(work: () => Promise<{ status: number; body: Record<string, unknown> }>, done: () => void = () => {}): Response {
  const encoder = new TextEncoder()
  let timer: ReturnType<typeof setInterval> | undefined
  let open = true
  // A client that went away closes the stream; writing to it then throws, and nothing more is sent.
  const send = (controller: ReadableStreamDefaultController<Uint8Array>, text: string) => {
    if (!open) return
    try {
      controller.enqueue(encoder.encode(text))
    } catch {
      open = false
    }
  }
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      timer = setInterval(() => send(controller, ' '), 15_000)
      try {
        const r = await work()
        send(controller, JSON.stringify(r.status < 400 ? { ok: true, ...r.body } : { ok: false, status: r.status, ...r.body }))
      } catch {
        send(controller, JSON.stringify({ ok: false, status: 500, error: 'Something went wrong on our side.' }))
      } finally {
        clearInterval(timer)
        done()
        if (open) {
          open = false
          try {
            controller.close()
          } catch {
            // Already closed by a client that went away.
          }
        }
      }
    },
    cancel() {
      open = false
      clearInterval(timer)
    },
  })
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'application/json', ...NO_STORE } })
}

// ── Room in this process ──────────────────────────────────────────────────────

/**
 * At most this many task ops and files in this process at once, each holding a
 * body of up to BODY_LIMITS.op (or a file) while it runs: what all the imports
 * together can make one web process hold. One import sends one at a time (its
 * write lease); a task that sends more is told to wait (IMPORT_BUSY), before
 * any of its body is read.
 */
const TASK_BODY_SLOTS = 4
let bodiesInFlight = 0

function takeBodySlot(): (() => void) | null {
  if (bodiesInFlight >= TASK_BODY_SLOTS) return null
  bodiesInFlight++
  let released = false
  return () => {
    if (released) return
    released = true
    bodiesInFlight--
  }
}

const busy = () =>
  answer(503, { error: 'Backenly is busy with other imports; send this again in a moment.', code: 'IMPORT_BUSY' })

// ── The job ───────────────────────────────────────────────────────────────────

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The job this call is for, proven; or the answer to give instead. */
async function provenJob(request: Request): Promise<{ row: BackgroundJob } | { refused: NextResponse }> {
  const jobId = request.headers.get(HEADER_JOB) ?? ''
  const bearer = /^Bearer ([A-Za-z0-9_-]{20,200})$/.exec(request.headers.get('authorization') ?? '')?.[1]
  if (!UUID.test(jobId) || !bearer) return { refused: notFound() }
  const row = await prisma.backgroundJob.findFirst({ where: { id: jobId, type: { in: [IMPORT_JOB_TYPE, LOOK_JOB_TYPE] } } })
  const s = row ? sandboxOf(row) : null
  // A job that ended has no token hash left, so its token proves nothing: 404 like a wrong one.
  if (!row || !s || !tokenMatches(bearer, s.tokenHash)) return { refused: notFound() }
  if (s.taskArn && request.headers.get(HEADER_TASK) !== s.taskArn) return { refused: answer(403, { error: 'Not this job’s task.' }) }
  if (row.status !== JOB_STATUS.running) return { refused: ended() }
  if (lapsed(row)) {
    await closeLapsed(row)
    return { refused: ended() }
  }
  return { row }
}

// ── Op arguments ──────────────────────────────────────────────────────────────

const IDENT = /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/
const ident = z.string().regex(IDENT)
/**
 * The exact types a planned column may declare (lib/ai/minimal-executor.ts
 * DECLARED_SQL_TYPE, which the executor checks again): the spellings the
 * planners emit, and their arrays.
 */
const DECLARED_SQL_TYPE =
  /^(?:text|varchar(?:\(\d{1,5}\))?|char(?:\(\d{1,4}\))?|smallint|integer|bigint|boolean|timestamp(?:\([0-6]\))?|timestamptz(?:\([0-6]\))?|date|time(?:\([0-6]\))?|uuid|json|jsonb|numeric(?:\(\d{1,4}(?:,\d{1,4})?\))?|real|double precision|money)(?:\[\])?$/
/** Backenly's own tables in a project: its users table and the teams tables (lib/services/rls-ownership.ts). */
const RESERVED_TABLES = new Set(['users', 'organizations', 'organization_members', 'organization_invitations'])
/** A table the import may fill: never one of Backenly's own, nor one of its underscore tables. */
const tableName = ident.refine((n) => !RESERVED_TABLES.has(n.toLowerCase()) && !n.startsWith('_'), 'reserved table')
const declaredFk = z.unknown().refine((v) => isDeclaredForeignKey(v), 'not a declared foreign key')

const pgColumn = z
  .object({
    name: ident,
    // The planner's own words for a type with no exact spelling (lib/import/pg-plan.ts); no other value is taken.
    type: z.enum(['TEXT', 'UUID', 'BYTEA', 'INTERVAL', 'TIMETZ']),
    // An exact type, in the spellings the executor accepts as declared (minimal-executor.ts DECLARED_SQL_TYPE).
    sqlType: z.string().max(60).regex(DECLARED_SQL_TYPE).optional(),
    notNull: z.boolean().optional(),
    unique: z.boolean().optional(),
    default: z.string().max(500).optional(),
    references: declaredFk.optional(),
  })
  .strict()

const bucket = z
  .object({
    id: z.string().min(1).max(100),
    name: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,62}$/i),
    public: z.boolean(),
    fileSizeLimit: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
    allowedMimeTypes: z.array(z.string().max(200)).max(100).nullable(),
  })
  .strict()

const ruleCommand = z.union([z.string().max(4000), z.object({ using: z.string().max(4000).optional(), check: z.string().max(4000).optional() }).strict()])
const ruleProposal = z
  .object({
    table: tableName,
    sourceTable: z.string().max(300),
    summary: z.string().max(1000),
    definition: z.string().max(20_000),
    action: z
      .object({
        template: z.enum(['own_rows', 'public_read', 'custom']),
        userIdColumn: ident.optional(),
        commands: z.object({ select: ruleCommand.optional(), insert: ruleCommand.optional(), update: ruleCommand.optional(), delete: ruleCommand.optional() }).strict().optional(),
      })
      .strict()
      .nullable(),
    untranslated: z.string().max(1000).nullable(),
  })
  .strict()

const FB_TYPES = ['text', 'bigint', 'double precision', 'boolean', 'timestamptz', 'jsonb', 'uuid'] as const
const fbCreateColumn = z.object({ name: ident, type: z.enum(FB_TYPES), unique: z.boolean().optional() }).strict()
const fbInsertColumn = z.object({ name: ident, type: z.enum(FB_TYPES), source: z.object({ kind: z.string().max(40) }).strict() }).strict()
const fbUser = z
  .object({
    email: z.string().min(3).max(320),
    name: z.string().max(512).nullable(),
    emailVerified: z.boolean(),
    disabled: z.boolean(),
    createdAt: z.string().max(40).nullable(),
    lastLoginAt: z.string().max(40).nullable(),
    avatarUrl: z.string().max(2048).nullable(),
    oauthProvider: z.string().max(64).nullable(),
    oauthId: z.string().max(512).nullable(),
    firebaseUid: z.string().min(1).max(128),
    password: z.string().max(2048).nullable(),
  })
  .strict()

const OP_ARGS: Record<DestinationOp, z.ZodTypeAny> = {
  'pg.createTables': z
    .object({
      tables: z.array(z.object({ name: tableName, columns: z.array(pgColumn).max(1600) }).strict()).min(1).max(MAX_IMPORT_TABLES),
      title: z.string().max(300),
      usersTable: z.object({ social: z.boolean() }).strict().nullable(),
    })
    .strict(),
  'pg.measure': z.object({}).strict(),
  'pg.insertRows': z
    .object({ table: tableName, columns: z.array(ident).min(1).max(1600), rows: z.array(z.array(z.string().nullable())).max(60_000) })
    .strict(),
  'pg.insertUsers': z.object({ users: z.array(z.unknown()).max(5_000) }).strict(),
  'pg.countRows': z.object({ tables: z.array(tableName).max(MAX_IMPORT_TABLES) }).strict(),
  'pg.finishSchema': z
    .object({
      title: z.string().max(300),
      keys: z
        .array(
          z
            .object({
              name: tableName,
              deferredForeignKeys: z.array(z.object({ column: ident, references: declaredFk }).strict()).max(1600),
            })
            .strict(),
        )
        .max(MAX_IMPORT_TABLES),
      buckets: z.array(bucket).max(100).nullable(),
    })
    .strict(),
  'pg.recordRules': z.object({ proposals: z.array(ruleProposal).max(MAX_IMPORT_TABLES), sourceLabel: z.string().max(200) }).strict(),
  'fb.createTables': z
    .object({
      plans: z
        .array(z.object({ name: tableName, parentTable: tableName.nullable(), createColumns: z.array(fbCreateColumn).max(1600) }).strict())
        .max(MAX_IMPORT_TABLES),
      title: z.string().max(300),
    })
    .strict(),
  'fb.addExtraColumn': z.object({ table: tableName }).strict(),
  'fb.insertRows': z.object({ table: tableName, columns: z.array(fbInsertColumn).min(1).max(1600), rows: z.array(z.array(z.unknown())).max(60_000) }).strict(),
  'fb.countRows': z.object({ table: tableName }).strict(),
  'fb.measureRows': z.object({}).strict(),
  'fb.prepareUsers': z.object({}).strict(),
  'fb.insertUsers': z.object({ users: z.array(fbUser).max(5_000) }).strict(),
  'fb.countImportedUsers': z.object({}).strict(),
  'fb.prepareFilesBucket': z.object({ maxFileBytes: z.number().int().positive().max(MAX_BUFFERED_UPLOAD_FILE_BYTES) }).strict(),
}

/** Whether a task's arguments for `op` pass its schema: the first check every op meets. */
export function opArgsAccepted(op: DestinationOp, args: unknown): boolean {
  return OP_ARGS[op]?.safeParse(args).success ?? false
}

const ONCE: Partial<Record<DestinationOp, OnceStep>> = {
  'pg.createTables': 'tables',
  'pg.finishSchema': 'schema',
  'pg.recordRules': 'rules',
  'fb.prepareUsers': 'users',
  'fb.prepareFilesBucket': 'bucket',
}

/** The columns a table of the project has: it must be an ordinary table of the project's own schema. */
async function tableColumns(projectId: string, table: string): Promise<Set<string> | null> {
  const { projectPool } = await import('@/lib/data-plane/regional')
  const { workspaceSchemaName } = await import('@/lib/security/workspace-schema')
  const pool = await projectPool(projectId, 'import', { max: 4 })
  const r = await pool.query<{ attname: string }>(
    `SELECT a.attname
       FROM pg_catalog.pg_class c
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
      WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind = 'r'`,
    [workspaceSchemaName(projectId), table],
  )
  return r.rows.length ? new Set(r.rows.map((x) => x.attname)) : null
}

/**
 * Whether `cost` more counted bytes fit the job's room now, measured: the same
 * rule as lib/import/limits.ts RowRoom, with a fresh measurement every time.
 */
async function assertRoom(projectId: string, payload: ImportPayload, cost: number): Promise<void> {
  const limits = payload.sandbox.limits
  const held = await measureProjectRows(projectId)
  const room = limits?.maxRowBytes ?? 0
  if (held + PAGE_SLACK_BYTES + STORED_PER_COUNTED * cost > room) throw new Refused(409, roomRefusal(held, limits), ROOM_REFUSED)
}

/**
 * Take the job's lease: one op or file at a time per job, whichever web task
 * serves it, from before its body is read until its answer is sent. A lease in
 * the job's row rather than a lock held on a connection, so a slow op pins no
 * connection of the platform's pool; one left by a web task that died lapses
 * on its own.
 */
async function takeJobLease(jobId: string): Promise<boolean> {
  const until = new Date(Date.now() + 15 * 60_000).toISOString()
  const took = await prisma.$executeRaw`UPDATE background_jobs
       SET payload = jsonb_set(payload, '{sandbox,writing}', to_jsonb(${until}::text), true), "updatedAt" = now()
     WHERE id = ${jobId} AND status = ${JOB_STATUS.running}
       AND (payload->'sandbox'->>'writing' IS NULL OR (payload->'sandbox'->>'writing')::timestamptz < now())`
  return took === 1
}

async function releaseJobLease(jobId: string): Promise<void> {
  await prisma.$executeRaw`UPDATE background_jobs SET payload = payload #- '{sandbox,writing}', "updatedAt" = now() WHERE id = ${jobId}`.catch(() => {})
}

/**
 * What an access rule does, in Backenly's words, from its action alone. The
 * person approving reads this, so it never comes from the task: a source's own
 * description of a rule could say anything.
 */
function ruleSummary(action: { template: string; userIdColumn?: string } | null): string {
  if (!action) return 'Not translated; the table stays closed to all but the server key'
  if (action.template === 'own_rows') return `Signed-in users read and change only their own rows (matched on ${action.userIdColumn ?? 'user_id'})`
  if (action.template === 'public_read') return 'Anyone can read the rows; only the server key changes them'
  return 'A custom rule translated from the source: read its expressions before approving'
}

/** Ordinary tables in the project's own schema now. */
async function tableCount(projectId: string): Promise<number> {
  const { projectPool } = await import('@/lib/data-plane/regional')
  const { workspaceSchemaName } = await import('@/lib/security/workspace-schema')
  const pool = await projectPool(projectId, 'import', { max: 4 })
  const r = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relkind = 'r'`,
    [workspaceSchemaName(projectId)],
  )
  return Number(r.rows[0]?.n ?? 0)
}

/** Tables a new project holds before an import adds any (users, the teams tables and the like), with room to spare. */
const TABLES_BESIDES_THE_IMPORT = 50

async function runOp(row: BackgroundJob, op: DestinationOp, args: any): Promise<Record<string, unknown>> {
  const payload = row.payload as unknown as ImportPayload
  const projectId = row.projectId!
  const userId = payload.userId
  const pg = () => localPgDestination({ projectId, userId, jobId: row.id })
  const fb = async () => (await import('./drivers/firebase-destination')).backenlyDestination({ projectId, userId })

  switch (op) {
    case 'pg.createTables':
      if (args.usersTable && !payload.include.users) throw new Refused(403, 'Users are not moving in this import.')
      await pg().createTables(args.tables, { title: args.title, usersTable: args.usersTable })
      return {}
    case 'pg.measure':
    case 'fb.measureRows':
      return { bytes: await measureProjectRows(projectId) }
    case 'pg.insertRows': {
      const cols = await tableColumns(projectId, args.table)
      if (!cols) throw new Refused(404, `There is no table ${args.table} to fill.`)
      for (const c of args.columns as string[]) if (!cols.has(c)) throw new Refused(400, `${args.table} has no column ${c}.`)
      const width = (args.columns as string[]).length
      const rows = args.rows as Array<Array<string | null>>
      if (rows.some((r) => r.length !== width)) throw new Refused(400, 'A row has the wrong number of values.')
      if (rows.length * width > 60_000) throw new Refused(400, 'Too many values in one batch.')
      await assertRoom(projectId, payload, rows.reduce((n, r) => n + rowCost(r), 0))
      return { written: await pg().insertRows(args.table, args.columns, rows) }
    }
    case 'pg.insertUsers': {
      if (!payload.include.users) throw new Refused(403, 'Users are not moving in this import.')
      const kept = (args.users as unknown[]).map(keptAuthUser).filter((u): u is NonNullable<ReturnType<typeof keptAuthUser>> => u !== null)
      await assertRoom(projectId, payload, kept.reduce((n, u) => n + userCost(u), 0))
      return { written: await pg().insertUsers(kept) }
    }
    case 'pg.countRows': {
      const counts: Record<string, number> = {}
      const existing = new Set<string>()
      for (const t of args.tables as string[]) if (await tableColumns(projectId, t)) existing.add(t)
      for (const [k, v] of await pg().countRows([...existing])) counts[k] = v
      return { counts }
    }
    case 'pg.finishSchema': {
      if (args.buckets?.length && !payload.include.files) throw new Refused(403, 'Files are not moving in this import.')
      const r = await pg().finishSchema(args)
      return { warnings: r.warnings, targets: r.targets ? Object.fromEntries(r.targets) : null }
    }
    case 'pg.recordRules': {
      // Only rules for tables this import made, each described by what its action does.
      const proposals = []
      for (const p of args.proposals as Array<Record<string, any>>) {
        if (!(await tableColumns(projectId, p.table))) continue
        proposals.push({ ...p, summary: ruleSummary(p.action) })
      }
      const label = String(args.sourceLabel).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 100)
      return { pending: await pg().recordRules(proposals as any, { sourceLabel: label }) }
    }

    case 'fb.createTables':
      // A Firestore import plans tables as collections turn up, so each call is
      // counted against the import's table cap by what the project now holds.
      if ((await tableCount(projectId)) + (args.plans as unknown[]).length > MAX_IMPORT_TABLES + TABLES_BESIDES_THE_IMPORT) {
        throw new Refused(409, `One import moves up to ${MAX_IMPORT_TABLES.toLocaleString('en-US')} tables.`)
      }
      return { unindexed: await (await fb()).createTables(args.plans, args.title) }
    case 'fb.addExtraColumn':
      if (!(await tableColumns(projectId, args.table))) throw new Refused(404, `There is no table ${args.table}.`)
      await (await fb()).addExtraColumn(args.table)
      return {}
    case 'fb.insertRows': {
      const cols = await tableColumns(projectId, args.table)
      if (!cols) throw new Refused(404, `There is no table ${args.table} to fill.`)
      for (const c of args.columns as Array<{ name: string }>) if (!cols.has(c.name)) throw new Refused(400, `${args.table} has no column ${c.name}.`)
      const width = (args.columns as unknown[]).length
      const rows = args.rows as unknown[][]
      if (rows.some((r) => r.length !== width)) throw new Refused(400, 'A row has the wrong number of values.')
      if (rows.length * width > 60_000) throw new Refused(400, 'Too many values in one batch.')
      await assertRoom(projectId, payload, rows.reduce((n, r) => n + rowCost(r), 0))
      return { written: await (await fb()).insertRows(args.table, args.columns, rows) }
    }
    case 'fb.countRows':
      if (!(await tableColumns(projectId, args.table))) return { count: 0 }
      return { count: await (await fb()).countRows(args.table) }
    case 'fb.prepareUsers':
      if (!payload.include.users) throw new Refused(403, 'Users are not moving in this import.')
      await (await fb()).prepareUsers()
      return {}
    case 'fb.insertUsers': {
      if (!payload.include.users) throw new Refused(403, 'Users are not moving in this import.')
      const users: ImportedUser[] = (args.users as Array<Record<string, any>>).map((u) => ({
        ...u,
        // A password only in a form Backenly's sign-in verifies; anything else: none, reset by its owner.
        password:
          u.password && ((isFirebaseHash(u.password) && parseFirebaseHash(u.password) !== null) || KEPT_BCRYPT_HASH.test(u.password)) ? u.password : null,
        createdAt: u.createdAt && Number.isFinite(Date.parse(u.createdAt)) ? new Date(u.createdAt) : null,
        lastLoginAt: u.lastLoginAt && Number.isFinite(Date.parse(u.lastLoginAt)) ? new Date(u.lastLoginAt) : null,
      })) as ImportedUser[]
      await assertRoom(projectId, payload, users.reduce((n, u) => n + rowCost(Object.values(u)), 0))
      return { written: await (await fb()).insertUsers(users) }
    }
    case 'fb.countImportedUsers':
      return { count: payload.include.users ? await (await fb()).countImportedUsers() : 0 }
    case 'fb.prepareFilesBucket':
      if (!payload.include.files) throw new Refused(403, 'Files are not moving in this import.')
      return { bucketId: await (await fb()).prepareFilesBucket(args.maxFileBytes) }
  }
}

async function handleOp(row: BackgroundJob, body: any): Promise<{ status: number; body: Record<string, unknown> }> {
  const payload = row.payload as unknown as ImportPayload
  const s = sandboxOf(row)!
  const op = body?.op as DestinationOp
  if (s.kind !== 'import' || s.stage !== 'running' || !row.projectId) return { status: 409, body: { error: 'This job has no project to write.', code: 'IMPORT_NOT_RUNNING' } }
  const family = payload.source === 'firebase' ? (FIREBASE_OPS as readonly string[]) : (PG_OPS as readonly string[])
  if (typeof op !== 'string' || !family.includes(op)) return { status: 400, body: { error: 'Not an op for this source.' } }
  const parsed = OP_ARGS[op].safeParse(body?.args ?? {})
  if (!parsed.success) return { status: 400, body: { error: `The ${op} arguments were refused.` } }
  try {
    const run = async () => {
      const step = ONCE[op]
      if (step && !(await takeOnce(row.id, step))) throw new Refused(409, `${op} already ran for this import.`)
      const { withChangeAttribution } = await import('@/lib/changes/attribution')
      return withChangeAttribution({ source: 'import', actorUserId: payload.userId, apiKeyId: null, groupId: `import:${row.id}` }, () =>
        runOp(row, op, parsed.data),
      )
    }
    const result = await run()
    await extendLease(row.id)
    return { status: 200, body: { result } }
  } catch (err) {
    if (err instanceof Refused) return { status: err.status, body: { error: err.message, ...(err.code ? { code: err.code } : {}) } }
    // The governed kernel's own sentence ("Backenly could not create posts: …") is the person's to read.
    const said = err instanceof Error && /^(Backenly|Copying|The )/.test(err.message) ? err.message.slice(0, 400) : 'Backenly could not write this part of the import.'
    if (said.startsWith('Backenly could not write')) console.error(`[Import] job ${row.id} ${op} failed:`, (err as Error)?.message?.slice(0, 300))
    return { status: 422, body: { error: said, code: 'IMPORT_WRITE_FAILED' } }
  }
}

async function handleFile(row: BackgroundJob, request: Request): Promise<NextResponse> {
  const payload = row.payload as unknown as ImportPayload
  const s = sandboxOf(row)!
  if (s.kind !== 'import' || s.stage !== 'running' || !row.projectId) return answer(409, { error: 'This job has no project to write.' })
  if (!payload.include.files) return answer(403, { error: 'Files are not moving in this import.' })
  const bucketId = request.headers.get(HEADER_BUCKET) ?? ''
  const nameB64 = request.headers.get(HEADER_FILE_NAME) ?? ''
  const mimeType = (request.headers.get(HEADER_FILE_TYPE) ?? '').slice(0, 200) || undefined
  const name = /^[A-Za-z0-9_-]{1,2800}$/.test(nameB64) ? Buffer.from(nameB64, 'base64url').toString('utf8') : ''
  if (!bucketId || bucketId.length > 64 || !name || name.length > 1024 || name.includes('\u0000')) return answer(400, { error: 'The file was not named.' })
  // Its length first: a file is read only up to what it said it was, and never past the cap.
  const declared = Number(request.headers.get('content-length') ?? 'NaN')
  if (!Number.isFinite(declared) || declared < 0) return answer(411, { error: 'Send the file with its length.' })
  const buffer = await readBody(request, Math.min(declared, MAX_BUFFERED_UPLOAD_FILE_BYTES))
  const { uploadImportFile } = await import('./drivers/firebase-destination')
  const outcome = await uploadImportFile({ projectId: row.projectId, userId: payload.userId }, bucketId, { name, buffer, mimeType: mimeType ?? null })
  await extendLease(row.id)
  return answer(200, { outcome })
}

/** One task call. */
export async function handleWorkerCall(action: string, request: Request): Promise<Response> {
  if (!(WORKER_ACTIONS as readonly string[]).includes(action)) return notFound()
  const proven = await provenJob(request)
  if ('refused' in proven) return proven.refused
  const { row } = proven
  const s = sandboxOf(row)!
  try {
    switch (action as WorkerAction) {
      case 'spec': {
        const body = (await readJson(request, BODY_LIMITS.json)) as { protocol?: unknown }
        if (body?.protocol !== PROTOCOL) return answer(409, { error: `This control plane speaks protocol ${PROTOCOL}.`, code: 'IMPORT_PROTOCOL' })
        return answer(200, { spec: await workerSpec(row) })
      }
      case 'preview': {
        if (s.kind !== 'look' || s.stage !== 'reading') return ended()
        const body = (await readJson(request, BODY_LIMITS.preview)) as { preview?: any }
        const preview = body?.preview
        if (!preview || typeof preview.source !== 'string' || !Array.isArray(preview.tables) || !Array.isArray(preview.rules) || !Array.isArray(preview.warnings)) {
          return answer(400, { error: 'Not a preview.' })
        }
        if (preview.tables.length > MAX_IMPORT_TABLES * 2) return answer(400, { error: 'The preview is too long.' })
        await workerPreview(row, preview)
        return answer(200, {})
      }
      case 'checked': {
        if (s.kind !== 'import') return ended()
        // Creating the project can outlast the load balancer's idle timeout: keep the answer alive.
        return keepAlive(async () => {
          try {
            const projectId = await workerChecked(row)
            return { status: 200, body: projectId ? { projectId } : { pending: true } }
          } catch (err) {
            // The project was refused (its plan, its region): the job ended with the refusal for the person.
            if (err instanceof ImportRefusedError) return { status: 409, body: { error: err.message, code: 'IMPORT_ENDED' } }
            throw err
          }
        })
      }
      case 'next': {
        if (s.kind !== 'import') return ended()
        await extendLease(row.id)
        return answer(200, row.projectId && s.stage === 'running' ? { projectId: row.projectId } : { pending: true })
      }
      case 'progress': {
        if (s.kind !== 'import' || !row.projectId) return answer(200, { cancel: false })
        const body = (await readJson(request, BODY_LIMITS.json)) as { patch?: any }
        return answer(200, await workerProgress(row, body?.patch && typeof body.patch === 'object' ? body.patch : {}))
      }
      case 'op': {
        if (s.kind !== 'import' || s.stage !== 'running' || !row.projectId) {
          return answer(409, { error: 'This job has no project to write.', code: 'IMPORT_NOT_RUNNING' })
        }
        const release = takeBodySlot()
        if (!release) return busy()
        if (!(await takeJobLease(row.id))) {
          release()
          return busy()
        }
        let body: unknown
        try {
          body = await readJson(request, BODY_LIMITS.op)
        } catch (err) {
          release()
          await releaseJobLease(row.id)
          throw err
        }
        return keepAlive(
          () => handleOp(row, body),
          () => {
            release()
            void releaseJobLease(row.id)
          },
        )
      }
      case 'file': {
        const release = takeBodySlot()
        if (!release) return busy()
        if (!(await takeJobLease(row.id))) {
          release()
          return busy()
        }
        try {
          return await handleFile(row, request)
        } finally {
          release()
          await releaseJobLease(row.id)
        }
      }
      case 'finish': {
        if (s.kind !== 'import' || s.stage !== 'running' || !row.projectId) return ended()
        const body = (await readJson(request, BODY_LIMITS.json)) as any
        if (!body?.importedFrom || typeof body.importedFrom !== 'object') return answer(400, { error: 'Not a result.' })
        await workerFinish(row, { importedFrom: body.importedFrom, warnings: Array.isArray(body.warnings) ? body.warnings : [] })
        return answer(200, {})
      }
      case 'fail': {
        const body = (await readJson(request, BODY_LIMITS.json)) as any
        await workerFail(row, body && typeof body === 'object' ? body : { message: '' })
        return answer(200, {})
      }
    }
  } catch (err) {
    if (err instanceof Refused) return answer(err.status, { error: err.message, ...(err.code ? { code: err.code } : {}) })
    if (err instanceof ImportRefusedError) return answer(err.status, { error: err.message, ...(err.code ? { code: err.code } : {}) })
    console.error(`[Import] job ${row.id} ${action} failed:`, (err as Error)?.message?.slice(0, 300))
    return answer(500, { error: 'Something went wrong on our side.' })
  }
  return notFound()
}
