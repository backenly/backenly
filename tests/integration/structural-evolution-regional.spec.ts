/**
 * AN EXTRACTION OF A PROJECT KEPT IN ANOTHER REGION HAPPENS IN THAT REGION
 * ========================================================================
 * Backenly Cloud keeps each project's workspace schema in its own region's
 * database (lib/data-plane/regional.ts). Postgres accepts a schema missing from
 * the search path without complaint, so an extraction that sent a statement to
 * the home database instead would not fail: it would read an empty catalog, or
 * worse. This suite creates a second database as the stand-in for us-east-1,
 * puts one project's tables ONLY there, and runs an extraction end to end:
 *
 *   analysis, the plan, the rehearsal, every rung, the backfill, reconciliation
 *   and undo                 read and write the regional database; the home
 *                            database never holds the project's schema
 *   the start of a change    a regional job the region's own worker runs once a
 *   a person approved, and   person approves or undoes it at home: the request
 *   a person's undo          runs nothing there (across regions its statements
 *                            outlast it)
 *   the backfill             regional jobs, run by the region's own worker
 *                            (processRegionalJobs), never by the home queue;
 *                            each batch's starting key is kept in the region,
 *                            and no row at home quotes one
 *   every schema change      a governed change (lib/changes/ledger.ts) whose
 *                            record at home keeps the catalog's structure and
 *                            digests, never its definitions or the SQL that
 *                            ran; the definitions are kept in the region
 *
 * A second project there goes through the engine's own path, proposal to undo,
 * and every record the platform keeps of it at home is then searched: names,
 * kinds, counts and ids, never a statement, a definition, or a row's value
 * (lib/structural-evolution/residency.ts).
 */

import { randomBytes, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { Client } from 'pg'
import { prisma } from '@/lib/db'
import { jwtClaimFunctionSql } from '@/lib/postgrest/rls-translation'
import { disconnectRegionalClients } from '@/lib/data-plane/regional'
import { closeMaintenanceLockPool, withMaintenanceSingleFlight } from '@/lib/autonomy/maintenance/single-flight'
import { closeChangeLockPool } from '@/lib/changes/lock'
import { closeAllWorkspacePools } from '@/lib/services/workspace-pool'
import { getWorkspaceDatabaseNames } from '@/lib/services/databaseProvisioning'
import { analyzeStructuralEvolution } from '@/lib/structural-evolution'
import { resolveExtractionPlan, isResolveRefusal } from '@/lib/structural-evolution/resolve'
import { grantEvolutionApproval, isGrantRefusal } from '@/lib/structural-evolution/consent'
import { executeExtraction } from '@/lib/structural-evolution/execute'
import { processRegionalJobs } from '@/lib/queue/worker'
import { queueEvolutionBackfill } from '@/lib/structural-evolution/backfill-job'
import { reconcileExtraction } from '@/lib/structural-evolution/reconcile'
import { rollbackExtraction } from '@/lib/structural-evolution/rollback'
import { readTableFacts } from '@/lib/structural-evolution/facts'
import { workspaceAt } from '@/lib/structural-evolution/workspace'
import { ladderNames, type ExtractionSpec } from '@/lib/structural-evolution/sql'
import {
  advance,
  approveRequest,
  dismissRequest,
  isActionRefusal,
  isApprovalRefusal,
  liveStatements,
  observe,
  pause,
  proposeWhereTheTablesAre,
  reRequestDecision,
  resume,
  startWhereTheTablesAre,
  undoWhereTheTablesAre,
} from '@/lib/evolution-engine/engine'
import { withBuildLock } from '@/lib/ai/build-runtime/build-lock'
import { ordersSql, proposeWhereItRuns, recordHistory, requestsOf, stateOf } from '../helpers/evolution-engine-fixture'

jest.setTimeout(300_000)

const REGION_VARIABLE = 'DATABASE_URL_US_EAST_1'
const REGIONAL_DB = `backenly_evo_region_${randomBytes(4).toString('hex')}`
const ROLE = `bkn_evo_rg_${randomBytes(4).toString('hex')}`
const USER_A = randomUUID()
const SPEC: ExtractionSpec = { host: 'orders', members: ['refund_amount', 'refund_reason'], satellite: 'order_refunds', label: 'refund' }

let regionalUrl = ''
let regionalDbCreated = false
let ownerId = ''
let projectId = ''
let schema = ''
let planId = ''
const saved = { mutations: process.env.ENABLE_EVOLUTION_MUTATIONS, engineMode: process.env.ENGINE_MODE }

const homeUrl = () => process.env.DATABASE_URL as string

function urlFor(database: string): string {
  const url = new URL(homeUrl())
  url.pathname = `/${database}`
  return url.toString()
}

async function on<T = any>(connectionString: string, sql: string, params: unknown[] = []): Promise<T[]> {
  const client = new Client({ connectionString })
  await client.connect()
  try {
    return (await client.query(sql, params)).rows as T[]
  } finally {
    await client.end().catch(() => {})
  }
}
const inRegion = <T = any>(sql: string, params: unknown[] = []) => on<T>(regionalUrl, sql, params)
const atHome = <T = any>(sql: string, params: unknown[] = []) => on<T>(homeUrl(), sql, params)
const t = (name: string) => `"${schema}"."${name}"`

/** The region's own worker, as its scheduler runs it every minute, until the chain ends. */
async function drainInRegion(): Promise<number> {
  let ran = 0
  for (let i = 0; i < 20; i++) {
    const { processed } = await processRegionalJobs('us-east-1')
    if (processed === 0) break
    ran += processed
  }
  return ran
}

beforeAll(async () => {
  if (process.env.NODE_ENV !== 'test') throw new Error('Refusing: NODE_ENV is not test')
  // Schema changes are governed changes, which jest.setup.js switches off.
  process.env.ENGINE_MODE = 'runtime'
  process.env.ENABLE_EVOLUTION_MUTATIONS = 'true'

  regionalUrl = urlFor(REGIONAL_DB)
  await atHome(`CREATE DATABASE "${REGIONAL_DB}"`)
  regionalDbCreated = true
  process.env[REGION_VARIABLE] = regionalUrl
  // What the region's database procedure installs, as project-region.spec.ts
  // sets it up: the table a region keeps its projects' bodies in, a governed
  // change's catalogs among them.
  await inRegion(`CREATE FUNCTION public.backenly_app_role() RETURNS text LANGUAGE sql AS $$ SELECT current_user::text $$`)
  await inRegion(fs.readFileSync('scripts/sql/regional-bodies.sql', 'utf8'))

  ownerId = (await prisma.user.create({
    data: { email: `evo-rg-${randomBytes(6).toString('hex')}@example.test`, password: 'not-a-real-hash', name: 'evo region' },
  })).id
  projectId = (await prisma.project.create({ data: { name: 'evolution-regional', userId: ownerId, region: 'us-east-1' } })).id
  schema = getWorkspaceDatabaseNames(projectId).postgresSchema
  await prisma.workspace.create({ data: { name: 'evolution regional', projectId, postgresSchema: schema, databaseProvisioned: true } })

  const svc = `${t('backenly_jwt_claim')}('role') = 'service_role'`
  const sub = `${t('backenly_jwt_claim')}('sub')`
  await inRegion(`CREATE SCHEMA "${schema}"`)
  await inRegion(jwtClaimFunctionSql(schema))
  await inRegion(`CREATE TABLE ${t('orders')} (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL,
    total numeric NOT NULL,
    refund_amount numeric CHECK (refund_amount >= 0),
    refund_reason text
  )`)
  await inRegion(
    `INSERT INTO ${t('orders')} (user_id, total, refund_amount, refund_reason)
     SELECT $1::uuid, i, CASE WHEN i % 4 = 0 THEN i END, CASE WHEN i % 4 = 0 THEN 'late' END FROM generate_series(1, 2400) i`,
    [USER_A],
  )
  await inRegion(`ALTER TABLE ${t('orders')} ENABLE ROW LEVEL SECURITY`)
  await inRegion(`ALTER TABLE ${t('orders')} FORCE ROW LEVEL SECURITY`)
  await inRegion(`CREATE POLICY orders_rw ON ${t('orders')} FOR ALL USING (${svc} OR user_id::text = ${sub}) WITH CHECK (${svc} OR user_id::text = ${sub})`)
  await atHome(`CREATE ROLE "${ROLE}" NOLOGIN NOSUPERUSER`)
  await inRegion(`GRANT USAGE ON SCHEMA "${schema}" TO "${ROLE}"`)
  await inRegion(`GRANT SELECT, UPDATE ON ${t('orders')} TO "${ROLE}"`)
}, 120_000)

/** Every row the platform keeps at home for a project of this suite. */
async function forgetAtHome(id: string, owner: string): Promise<void> {
  await prisma.backendChange.deleteMany({ where: { projectId: id } }).catch(() => {})
  await prisma.maintenanceStepExecution.deleteMany({ where: { execution: { projectId: id } } }).catch(() => {})
  await prisma.maintenanceExecution.deleteMany({ where: { projectId: id } }).catch(() => {})
  await prisma.maintenanceApproval.deleteMany({ where: { projectId: id } }).catch(() => {})
  await prisma.backgroundJob.deleteMany({ where: { projectId: id } }).catch(() => {})
  await prisma.healthFinding.deleteMany({ where: { projectId: id } }).catch(() => {})
  await prisma.auditLog.deleteMany({ where: { projectId: id } }).catch(() => {})
  await prisma.apiRequestLog.deleteMany({ where: { projectId: id } }).catch(() => {})
  await prisma.workspaceSchemaSnapshot.deleteMany({ where: { projectId: id } }).catch(() => {})
  await prisma.table.deleteMany({ where: { projectId: id } }).catch(() => {})
  await prisma.workspace.deleteMany({ where: { projectId: id } }).catch(() => {})
  await prisma.project.deleteMany({ where: { id } }).catch(() => {})
  await prisma.user.delete({ where: { id: owner } }).catch(() => {})
}

afterAll(async () => {
  for (const [k, v] of [['ENABLE_EVOLUTION_MUTATIONS', saved.mutations], ['ENGINE_MODE', saved.engineMode]] as const) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  if (ownerId) await forgetAtHome(projectId, ownerId)
  await closeChangeLockPool()
  await closeMaintenanceLockPool()
  await closeAllWorkspacePools()
  await disconnectRegionalClients()
  delete process.env[REGION_VARIABLE]
  if (regionalDbCreated) await atHome(`DROP DATABASE IF EXISTS "${REGIONAL_DB}" WITH (FORCE)`).catch(() => {})
  await atHome(`DROP ROLE IF EXISTS "${ROLE}"`).catch(() => {})
}, 120_000)

describe('a project kept in us-east-1', () => {
  it('has no schema at home: anything sent there would find nothing', async () => {
    expect(await atHome(`SELECT to_regnamespace($1) AS ns`, [schema])).toEqual([{ ns: null }])
    expect(await inRegion(`SELECT to_regnamespace($1)::text AS ns`, [schema])).toEqual([{ ns: `"${schema}"` }])
  })

  it('is analysed from its own region', async () => {
    const report = await analyzeStructuralEvolution(projectId)
    expect(report.tables.map(x => x.table)).toEqual(['orders'])
  })

  it('is planned, rehearsed and approved from its own catalog', async () => {
    const resolved = await resolveExtractionPlan(projectId, SPEC)
    if (isResolveRefusal(resolved)) throw new Error(resolved.refusal)
    expect(resolved.plan.validity).toBe('executable')
    expect(resolved.plan.schema).toBe(schema)
    planId = resolved.plan.planId
    const granted = await grantEvolutionApproval({
      projectId, spec: SPEC, planVersion: resolved.plan.planVersion, approvedBy: ownerId, resolve: resolveExtractionPlan,
    })
    if (isGrantRefusal(granted)) throw new Error(granted.error)
  })

  it('runs every rung in the region, and nothing at home', async () => {
    const first = await executeExtraction({ projectId, planId })
    expect(first.status).toBe('awaiting_background_work')
    expect(first.steps.map(s => [s.kind, s.status])).toEqual([
      ['rehearse', 'completed'],
      ['create_satellite', 'completed'],
      ['sync_forward', 'completed'],
      ['backfill', 'dispatched'],
    ])
    // Asked of the region, never of the home queue's generic workers.
    const queued = await prisma.backgroundJob.findMany({ where: { projectId, type: 'evolution_backfill' } })
    expect(queued.map(j => [j.status, (j.payload as any).region])).toEqual([['regional_pending', 'us-east-1']])
    expect(await drainInRegion()).toBe(3)
    const done = await executeExtraction({ projectId, planId })
    expect(done.status).toBe('completed')

    const [{ n }] = await inRegion<{ n: string }>(`SELECT count(*)::text AS n FROM ${t('order_refunds')}`)
    expect(n).toBe('600')
    const fwd = await inRegion(`SELECT tgname FROM pg_trigger WHERE tgrelid = $1::regclass AND tgname = $2`, [t('orders'), ladderNames(SPEC).forward])
    expect(fwd).toHaveLength(1)
    expect(await atHome(`SELECT to_regnamespace($1) AS ns`, [schema])).toEqual([{ ns: null }])

    const at = await workspaceAt(projectId)
    const r = await reconcileExtraction(projectId, (await readTableFacts(at, 'orders'))!, SPEC)
    expect(r).toMatchObject({ consistent: true, complete: true, present: 600, satelliteRows: 600 })
  })

  it("kept every batch's starting key in the region, and quoted none at home", async () => {
    const jobs = await prisma.backgroundJob.findMany({ where: { projectId, type: 'evolution_backfill' }, orderBy: { createdAt: 'asc' } })
    expect(jobs.map(j => j.status)).toEqual(['completed', 'completed', 'completed'])
    for (const j of jobs) {
      expect((j.payload as any).cursor).toBeNull()
      expect((j.result as any).cursor).toBeNull()
    }
    // The second and third batches start where the one before stopped: kept there.
    const keys = jobs.map(j => (j.payload as any).cursorKey).filter(Boolean)
    expect(keys).toHaveLength(2)
    const kept = await inRegion<{ id: string; cursor: string }>(
      `SELECT id, payload->>'cursor' AS cursor FROM public.regional_bodies WHERE kind = 'backfill_cursor' AND "projectId" = $1`,
      [projectId],
    )
    expect(kept.map(k => k.id).sort()).toEqual([...keys].sort())
    // Whatever those keys are, no row at home carries one.
    const home = JSON.stringify(await prisma.backgroundJob.findMany({ where: { projectId } })) +
      JSON.stringify(await prisma.maintenanceStepExecution.findMany({ where: { execution: { projectId } } }))
    for (const k of kept) expect(home).not.toContain(k.cursor)
  })

  it('re-queues a batch stopped by a withdrawn consent exactly where it stopped, in the region', async () => {
    // A paused chain's last payload names its cursor in the region; resuming
    // queues that payload again (execute.ts) and must not lose the key.
    await inRegion(
      `INSERT INTO public.regional_bodies (kind, id, "projectId", payload) VALUES ('backfill_cursor', 'resume-probe', $1, '{"cursor": "k"}')`,
      [projectId],
    )
    const job = await queueEvolutionBackfill({
      projectId, planId, planVersion: 'v-probe', basisFingerprint: 'x', spec: SPEC, cursor: null, cursorKey: 'resume-probe',
    })
    const row = await prisma.backgroundJob.findUnique({ where: { id: job.id } })
    expect(row).toMatchObject({ status: 'regional_pending' })
    expect(row!.payload).toMatchObject({ region: 'us-east-1', cursor: null, cursorKey: 'resume-probe' })
    await prisma.backgroundJob.delete({ where: { id: job.id } })
  })

  it('records every schema change at home by its structure, with the definitions kept in the region', async () => {
    const changes = await prisma.backendChange.findMany({
      where: { projectId },
      orderBy: { seq: 'asc' },
      select: { id: true, title: true, status: true, source: true, statements: true, checkpoint: true },
    })
    expect(changes.map(c => c.status)).toEqual(['healthy', 'healthy', 'healthy', 'healthy'])
    for (const c of changes) {
      expect(c.source).toBe('approval')
      // Names only in the title; no SQL kept at home; the definitions in the region.
      expect(c.title).toMatch(/^Architecture change \(refund of orders\), step \d+: /)
      expect(c.statements).toEqual([])
      expect((c.checkpoint as { definitionsInRegion?: boolean }).definitionsInRegion).toBe(true)
      expect(JSON.stringify(c.checkpoint)).not.toMatch(/refund_amount >= 0|backenly_jwt_claim\(/)
    }
    const kept = await inRegion<{ id: string }>(
      `SELECT id FROM public.regional_bodies WHERE kind = 'change_catalog' AND "projectId" = $1 ORDER BY id`,
      [projectId],
    )
    expect(kept.map(k => k.id).sort()).toEqual(changes.map(c => c.id).sort())
  })

  it('is undone in the region, as one governed change', async () => {
    const out = await rollbackExtraction({ projectId, planId, requestedBy: ownerId })
    expect(out.status).toBe('rolled_back')
    expect(await inRegion(`SELECT to_regclass($1) AS r`, [t('order_refunds')])).toEqual([{ r: null }])
    expect(await inRegion(`SELECT tgname FROM pg_trigger WHERE tgrelid = $1::regclass AND NOT tgisinternal`, [t('orders')])).toEqual([])
    const undo = await prisma.backendChange.findFirst({
      where: { projectId, title: { startsWith: 'Undo architecture change' } },
      select: { status: true, source: true, actorUserId: true, statements: true },
    })
    expect(undo).toMatchObject({ status: 'healthy', source: 'dashboard', actorUserId: ownerId, statements: [] })
  })
})

/** Every string in `value` that `quotes` matches, with where it is: `findings[0].details.evolution...`. */
function leaks(value: unknown, quotes: (text: string) => boolean, path = ''): string[] {
  if (typeof value === 'string') return quotes(value) ? [`${path}: ${value.slice(0, 160)}`] : []
  if (value instanceof Date || value === null || typeof value !== 'object') return []
  return Object.entries(value).flatMap(([k, v]) => leaks(v, quotes, Array.isArray(value) ? `${path}[${k}]` : path ? `${path}.${k}` : k))
}

describe('the engine, for a project kept in us-east-1', () => {
  const p = { ownerId: '', projectId: '', schema: '' }
  let findingId = ''
  let decisionId = ''
  let planVersion = ''
  /** Every id and user id in the project's rows: values no record at home may carry. */
  let rowValues: string[] = []

  beforeAll(async () => {
    p.ownerId = (await prisma.user.create({
      data: { email: `evo-rg-engine-${randomBytes(6).toString('hex')}@example.test`, password: 'not-a-real-hash', name: 'evo region engine' },
    })).id
    p.projectId = (await prisma.project.create({ data: { name: 'evolution-regional-engine', userId: p.ownerId, region: 'us-east-1' } })).id
    p.schema = getWorkspaceDatabaseNames(p.projectId).postgresSchema
    await prisma.workspace.create({ data: { name: 'evolution regional engine', projectId: p.projectId, postgresSchema: p.schema, databaseProvisioned: true } })
    await inRegion(`CREATE SCHEMA "${p.schema}"`)
    await inRegion(jwtClaimFunctionSql(p.schema))
    for (const sql of ordersSql(p.schema)) await inRegion(sql)
    await recordHistory(p.projectId, p.ownerId)
    const rows = await inRegion<{ id: string; user_id: string }>(`SELECT id::text, user_id::text FROM "${p.schema}"."orders"`)
    rowValues = rows.flatMap(r => [r.id, r.user_id])
    expect(rowValues).toHaveLength(600)
  }, 120_000)
  afterAll(async () => {
    if (p.ownerId) await forgetAtHome(p.projectId, p.ownerId)
  }, 60_000)

  it('proposes from the region, and the request at home carries no statement', async () => {
    const pass = await proposeWhereItRuns(p.projectId)
    expect(pass.requested).toBe(1)
    const [req] = await requestsOf(p.projectId)
    expect(req.ev).toMatchObject({ ask: 'approve', subject: 'orders', level: 'executable_proposal' })
    expect(req.ev.rehearsal).toMatchObject({ passed: true })
    expect(req.ev.technical.sqlWithheld).toBe(true)
    expect(req.ev.technical.steps.length).toBeGreaterThan(0)
    expect(req.ev.technical.steps.every(st => st.sql.length === 0)).toBe(true)
    findingId = req.id
    decisionId = req.ev.decisionId
    planVersion = req.ev.planVersion
  })

  it('shows the exact statements to a person who opens them, rendered in the region, of the version they approve', async () => {
    const live = await liveStatements(p.projectId, findingId)
    expect(live).toMatchObject({ planVersion, current: true })
    const sql = live!.steps.flatMap(st => st.sql).join('\n')
    expect(sql).toMatch(/CREATE TABLE/)
    expect(sql).toContain(`"${p.schema}"`)
  })

  it('answers at once what home can tell, and queues nothing for it', async () => {
    expect(await startWhereTheTablesAre({ projectId: p.projectId, decisionId: 'no-such-change' })).toEqual({ state: null, message: 'No such change.' })
    const waiting = await startWhereTheTablesAre({ projectId: p.projectId, decisionId })
    expect(waiting.state).toBe('awaiting_approval')
    expect(waiting.message).toMatch(/^Nothing to run: the change is /)
    expect(await prisma.backgroundJob.count({ where: { projectId: p.projectId, type: { startsWith: 'evolution_' } } })).toBe(0)
  })

  it('is rehearsed again in the region when its table moved before the approval', async () => {
    await inRegion(`ALTER TABLE "${p.schema}"."orders" ADD COLUMN note text`)
    const press = () => approveRequest({ projectId: p.projectId, findingId, planVersion, userId: p.ownerId })
    const r = await press()
    expect(isApprovalRefusal(r) && r.status).toBe(409)
    expect(isApprovalRefusal(r) && r.error).toMatch(/^The table changed since this was prepared\. Backenly is checking it again in .*us-east-1.*, where this project's tables are/)
    // While it is checked again, a second press and a decline are answered, and nothing more is queued.
    const checking = /^Backenly is checking this change again in .*us-east-1.*, where this project's tables are; the updated version will be in your queue/
    const again = await press()
    expect(isApprovalRefusal(again) && again.error).toMatch(checking)
    expect(await dismissRequest({ projectId: p.projectId, findingId, userId: p.ownerId })).toMatchObject({ ok: false, status: 409, error: expect.stringMatching(checking) })
    const queued = await prisma.backgroundJob.findMany({ where: { projectId: p.projectId, type: 'evolution_rerequest' } })
    expect(queued).toHaveLength(1)
    expect(queued[0].payload).toMatchObject({ region: 'us-east-1', projectId: p.projectId, decisionId, from: 'awaiting_approval', planVersion })

    expect(await drainInRegion()).toBe(1)
    const [done] = await prisma.backgroundJob.findMany({ where: { projectId: p.projectId, type: 'evolution_rerequest' } })
    expect(done.status).toBe('completed')
    expect(done.result).toMatchObject({ outcome: 'requested', state: 'awaiting_approval' })
    const [req] = await requestsOf(p.projectId)
    expect(req.id).toBe(findingId)
    expect(req.ev.planVersion).not.toBe(planVersion)
    expect(req.ev.rehearsal).toMatchObject({ passed: true, planVersion: req.ev.planVersion })
    // A check queued against the version the person was shown leaves a change that moved on since as it is.
    expect(await reRequestDecision(p.projectId, decisionId, { from: 'awaiting_approval', planVersion })).toEqual({ state: 'awaiting_approval', outcome: 'moved on' })
    expect((await requestsOf(p.projectId))[0].ev.planVersion).toBe(req.ev.planVersion)
    planVersion = req.ev.planVersion
  })

  it('is not approved while a repair holds the build lock, and approves once it is done', async () => {
    const gate: { release?: () => void } = {}
    const repair = withBuildLock(p.projectId, 'modify', () => new Promise<void>(resolve => { gate.release = resolve }), { skipCooldown: true })
    for (let i = 0; i < 100 && !gate.release; i++) await new Promise(resolve => setTimeout(resolve, 20))
    try {
      const r = await approveRequest({ projectId: p.projectId, findingId, planVersion, userId: p.ownerId })
      expect(isApprovalRefusal(r) && r.error).toBe('Backenly is changing this project right now (a repair or a build). Approve again in a few seconds.')
    } finally {
      gate.release!()
      await repair
    }
    expect((await requestsOf(p.projectId))[0].status).toBe('pending_approval')
    expect((await stateOf(p.projectId, decisionId)).state).toBe('awaiting_approval')
  })

  it('is approved at home and started by the region, never from the request that approved it', async () => {
    // Across regions every statement of a rung is a round trip, and the rungs
    // outlast the request (on staging the person saw a timeout and the change
    // stopped at its rehearsal): the region's own worker starts it.
    const r = await approveRequest({ projectId: p.projectId, findingId, planVersion, userId: p.ownerId })
    if (isApprovalRefusal(r)) throw new Error(r.error)
    expect(r.state).toBe('approved')
    expect(r.message).toMatch(/^Approved\. It runs in .*us-east-1.*, where this project's tables are, starting within a minute\./)
    expect(await inRegion(`SELECT to_regclass($1) AS r`, [`"${p.schema}"."order_refunds"`])).toEqual([{ r: null }])
    const started = await prisma.backgroundJob.findMany({ where: { projectId: p.projectId, type: 'evolution_advance' } })
    expect(started).toHaveLength(1)
    expect(started[0].status).toBe('regional_pending')
    expect(started[0].payload).toMatchObject({ region: 'us-east-1', projectId: p.projectId, decisionId })
    // A second press finds it queued.
    expect((await startWhereTheTablesAre({ projectId: p.projectId, decisionId, actor: p.ownerId })).state).toBe('approved')
    expect(await prisma.backgroundJob.count({ where: { projectId: p.projectId, type: 'evolution_advance' } })).toBe(1)
  })

  it('is paused and resumed at home, and the start still waiting carries the resumed change', async () => {
    expect(await pause({ projectId: p.projectId, decisionId, userId: p.ownerId })).toMatchObject({ ok: true, state: 'blocked' })
    const r = await resume({ projectId: p.projectId, decisionId, userId: p.ownerId })
    if (isActionRefusal(r)) throw new Error(r.error)
    expect(r.state).toBe('approved')
    expect(r.message).toMatch(/^It runs in .*us-east-1.*, where this project's tables are, starting within a minute\./)
    expect(await prisma.backgroundJob.count({ where: { projectId: p.projectId, type: 'evolution_advance' } })).toBe(1)
  })

  it('waits out another change running on the project, then starts', async () => {
    // The project's single-flight lock, held as another change would hold it.
    const gate: { release?: () => void } = {}
    const other = withMaintenanceSingleFlight(p.projectId, () => new Promise<void>(resolve => { gate.release = resolve }))
    for (let i = 0; i < 100 && !gate.release; i++) await new Promise(resolve => setTimeout(resolve, 20))
    expect(gate.release).toBeDefined()
    try {
      expect(await drainInRegion()).toBe(1)
    } finally {
      gate.release!()
      await other
    }
    const [waited] = await prisma.backgroundJob.findMany({ where: { projectId: p.projectId, type: 'evolution_advance' } })
    expect(waited).toMatchObject({ status: 'regional_pending', attempts: 1, error: 'Another change was running on this project, so the change waited.' })
    expect((await stateOf(p.projectId, decisionId)).state).toBe('approved')
    // The backoff, passed.
    await prisma.backgroundJob.update({ where: { id: waited.id }, data: { runAt: new Date() } })
  })

  it('is expanded and backfilled in the region, and its step ledger at home keeps no statement', async () => {
    // The region's worker starts it, then copies the rows, as its scheduler runs it every minute.
    expect(await drainInRegion()).toBeGreaterThan(1)
    const [started] = await prisma.backgroundJob.findMany({ where: { projectId: p.projectId, type: 'evolution_advance' } })
    expect(started.status).toBe('completed')
    expect(started.result).toMatchObject({ state: 'backfilling' })
    const steps = await prisma.maintenanceStepExecution.findMany({ where: { execution: { projectId: p.projectId } } })
    expect(steps.length).toBeGreaterThan(0)
    for (const st of steps) {
      expect(st.preconditionEvidence).toMatchObject({ sql: [], sqlWithheld: true })
      if (st.rollback) expect(st.rollback).toMatchObject({ sql: [] })
    }
    expect((await advance({ projectId: p.projectId, decisionId })).state).toBe('observing')
    const [{ n }] = await inRegion<{ n: string }>(`SELECT count(*)::text AS n FROM "${p.schema}"."order_refunds"`)
    expect(n).toBe('60')
  })

  it('is watched from the region until it is stable', async () => {
    const cutoverAt = (await stateOf(p.projectId, decisionId)).cutoverAt!
    const at = (h: number) => new Date(cutoverAt.getTime() + h * 3_600_000)
    expect((await observe({ projectId: p.projectId, decisionId, now: at(1) })).verdict).toBe('continue')
    await observe({ projectId: p.projectId, decisionId, now: at(12) })
    expect((await observe({ projectId: p.projectId, decisionId, now: at(25) })).verdict).toBe('stable')
  })

  it('is undone by the region, never from the request that asked for it', async () => {
    // An undo is some 160 statements to the region's database: from home, half a
    // minute to over a minute, at or past the load balancer's 60 s.
    const satellite = () => inRegion<{ r: string | null }>(`SELECT to_regclass($1)::text AS r`, [`"${p.schema}"."order_refunds"`])
    const r = await undoWhereTheTablesAre({ projectId: p.projectId, decisionId, userId: p.ownerId })
    if (isActionRefusal(r)) throw new Error(r.error)
    expect(r.state).toBe('stable')
    expect(r.message).toMatch(/^Undo runs in .*us-east-1.*, where this project's tables are, starting within a minute\./)
    expect((await satellite())[0].r).not.toBeNull()
    const queued = await prisma.backgroundJob.findMany({ where: { projectId: p.projectId, type: 'evolution_undo' } })
    expect(queued).toHaveLength(1)
    expect(queued[0].status).toBe('regional_pending')
    expect(queued[0].payload).toMatchObject({ region: 'us-east-1', projectId: p.projectId, decisionId, userId: p.ownerId })
    // While it is undone, a second press and a resume are answered, and nothing more is queued.
    const undoing = /^Backenly is undoing this change in .*us-east-1.*, where this project's tables are\./
    expect(await undoWhereTheTablesAre({ projectId: p.projectId, decisionId, userId: p.ownerId })).toMatchObject({ ok: false, status: 409, error: expect.stringMatching(undoing) })
    expect(await resume({ projectId: p.projectId, decisionId, userId: p.ownerId })).toMatchObject({ ok: false, status: 409, error: expect.stringMatching(undoing) })
    expect(await prisma.backgroundJob.count({ where: { projectId: p.projectId, type: { startsWith: 'evolution_' }, status: 'regional_pending' } })).toBe(1)

    expect(await drainInRegion()).toBeGreaterThan(0)
    const [done] = await prisma.backgroundJob.findMany({ where: { projectId: p.projectId, type: 'evolution_undo' } })
    expect(done.status).toBe('completed')
    expect(done.result).toMatchObject({ state: 'rolled_back' })
    expect((await stateOf(p.projectId, decisionId)).state).toBe('rolled_back')
    expect(await satellite()).toEqual([{ r: null }])
    // Nothing left to undo is said at once, and queues nothing.
    expect(await undoWhereTheTablesAre({ projectId: p.projectId, decisionId, userId: p.ownerId })).toMatchObject({ ok: false, status: 409 })
    expect(await prisma.backgroundJob.count({ where: { projectId: p.projectId, type: 'evolution_undo' } })).toBe(1)
  })

  it('looks for changes in the region when a person asks now', async () => {
    const r = await proposeWhereTheTablesAre(p.projectId)
    expect(r).toMatchObject({ requested: 0, assessed: 0 })
    expect(r.message).toMatch(/^It runs in .*us-east-1.*, where this project's tables are, starting within a minute\./)
    await proposeWhereTheTablesAre(p.projectId)
    expect(await prisma.backgroundJob.count({ where: { projectId: p.projectId, type: 'evolution_assess' } })).toBe(1)
    expect(await drainInRegion()).toBe(1)
    const [done] = await prisma.backgroundJob.findMany({ where: { projectId: p.projectId, type: 'evolution_assess' } })
    expect(done.status).toBe('completed')
    // The owner undid it, so nothing is asked again; what home keeps is counts.
    expect(done.result).toMatchObject({ requested: 0, skipped: expect.any(Number) })
  })

  it('runs nothing against the tables of a paused project, and says so', async () => {
    await prisma.project.update({ where: { id: p.projectId }, data: { pausedAt: new Date() } })
    try {
      expect((await proposeWhereTheTablesAre(p.projectId)).message).toMatch(/^This project is paused, so nothing runs against its tables until it is resumed\./)
      expect(await prisma.backgroundJob.count({ where: { projectId: p.projectId, type: { startsWith: 'evolution_' }, status: 'regional_pending' } })).toBe(0)
    } finally {
      await prisma.project.update({ where: { id: p.projectId }, data: { pausedAt: null } })
    }
  })

  it('left nothing at home that quotes a statement, a definition, or a row', async () => {
    const id = p.projectId
    const home = {
      findings: await prisma.healthFinding.findMany({ where: { projectId: id } }),
      memory: await prisma.auditLog.findMany({ where: { projectId: id } }),
      approvals: await prisma.maintenanceApproval.findMany({ where: { projectId: id } }),
      executions: await prisma.maintenanceExecution.findMany({ where: { projectId: id } }),
      steps: await prisma.maintenanceStepExecution.findMany({ where: { execution: { projectId: id } } }),
      jobs: await prisma.backgroundJob.findMany({ where: { projectId: id } }),
      changes: await prisma.backendChange.findMany({ where: { projectId: id } }),
      events: await prisma.backendChangeEvent.findMany({ where: { projectId: id } }),
    }
    // The whole life is there, by names and counts.
    expect(JSON.stringify(home)).toContain('order_refunds')
    const statement = /CREATE (TABLE|POLICY|TRIGGER|FUNCTION|INDEX)|INSERT INTO|ALTER TABLE|DROP (TABLE|TRIGGER|FUNCTION)/i
    const definition = /refund_amount >= 0|backenly_jwt_claim\(|SECURITY DEFINER|set_config/i
    const values = new Set(rowValues)
    const found = leaks(home, text =>
      statement.test(text) || definition.test(text) || /\bdamaged\b|SAVE10/.test(text) || [...values].some(v => text.includes(v)),
    )
    expect(found).toEqual([])
  })
})
