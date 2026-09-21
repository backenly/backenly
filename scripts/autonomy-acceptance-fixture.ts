/**
 * AUTONOMY ACCEPTANCE FIXTURE — one disposable project, fixed shapes, no input
 * ===========================================================================
 *
 * Qualifies the LIVE Authority Decision against a real database before a
 * release reaches production. It prepares one throwaway project, applies ONE
 * fixed fault at a time, lets the real scheduler act, and reads ground truth
 * back from the catalog and the audit ledger.
 *
 * ── Built so it cannot become an admin tool ─────────────────────────────────
 *
 * The sibling of `maintenance-acceptance-fixture.ts`, under the same rules:
 *
 *   - it touches exactly ONE project, found by the exact name below. It never
 *     accepts a project id or name for mutation, and refuses if the name is
 *     ambiguous;
 *   - there is no SQL input, no table input, no column input. Every statement
 *     and every schema/fault shape is fixed in this file, so "what could this
 *     possibly write" is answered by reading it rather than auditing a caller;
 *   - one fault at a time: every fault first restores the healthy baseline,
 *     then applies exactly one departure from it;
 *   - teardown is its own mode, needs a second confirmation naming the exact
 *     project id AND the environment, and re-checks the fixture identity;
 *   - before ANY write it proves where it is: the expected environment matches
 *     the container's own BACKENLY_ENV, the database host is the expected
 *     instance, and production additionally needs ALLOW_PRODUCTION_FIXTURE=yes.
 *
 * Runs inside the VPC as a one-shot task (see run-autonomy-acceptance-*.ts);
 * the launcher supplies only the mode and the confirmations, as environment.
 *
 * ── What it does NOT do ─────────────────────────────────────────────────────
 *
 * It repairs nothing itself. Every repair comes from the running scheduler in
 * the web task, which is the thing being qualified.
 *
 * `freeze-begin` / `freeze-end` bracket live scheduler ticks with the fixture
 * made unobservable. A blind probe emits no gap, so the scheduler does not
 * propose a repair to freeze — that is the Phase 2 finding, not a gap in this
 * test. What IS measurable live, and what matters, is the safety property:
 * across real ticks against a resource Backenly cannot see, nothing is mutated
 * and no registered metadata is deleted (the #83 invariant).
 *
 * Why not call runAutoFix directly: the auto-fix engine is compiled into the web
 * server bundle and exists as an importable module in no deployed image. The
 * runtime image carries only the data-plane bundle.
 */

import { randomUUID } from 'crypto'

import { prisma } from '@/lib/db/prisma'
import { P } from '@/lib/principal'
import { declareOwnershipIntent } from '@/lib/authority/ownership-intent'
import { grantAuthority, revokeAuthority, loadGrants } from '@/lib/authority/grants'
import { workspaceSchemaName } from '@/lib/security/workspace-schema'
import { generateUniqueSlug } from '@/lib/utils/slug'
import { createEmptyGraph } from '@/lib/orchestration/backend-state-graph'

/** The only project this file will ever touch. */
export const FIXTURE_NAME = '__backenly_autonomy_acceptance_v1__'
/** A dedicated, disposable owner. Never a real account. */
const FIXTURE_USER_EMAIL = 'autonomy-acceptance-v1@backenly.internal'

const ENVS = ['staging', 'production'] as const
type Env = (typeof ENVS)[number]
type Mode = 'prepare' | 'fault' | 'authority' | 'freeze-begin' | 'freeze-end' | 'observe' | 'teardown'
type Fault = 'healthy' | 'rls_disabled' | 'missing_index' | 'wide_open_policy'
type Action = 'declare_intent' | 'grant' | 'revoke'

const MODES: readonly Mode[] = ['prepare', 'fault', 'authority', 'freeze-begin', 'freeze-end', 'observe', 'teardown']
const FAULTS: readonly Fault[] = ['healthy', 'rls_disabled', 'missing_index', 'wide_open_policy']
const ACTIONS: readonly Action[] = ['declare_intent', 'grant', 'revoke']

/** One line, so the launcher can find it in the log stream. */
function emit(result: Record<string, unknown>): void {
  console.log('ACCEPTANCE-RESULT ' + JSON.stringify(result))
}

function refuse(msg: string): never {
  emit({ ok: false, refused: msg })
  process.exit(2)
}

const q = (sql: string) => prisma.$executeRawUnsafe(sql)
const rows = <T>(sql: string, ...p: unknown[]) => prisma.$queryRawUnsafe<T[]>(sql, ...p)

// ── Where am I? Proven before any write. ─────────────────────────────────────

async function assertIdentity(): Promise<Env> {
  const expect = (process.env.EXPECT_ENVIRONMENT ?? '') as Env
  if (!ENVS.includes(expect)) refuse(`EXPECT_ENVIRONMENT must be staging or production, got "${expect}"`)

  // The container's own environment, set by the task definition. A launcher
  // pointed at the wrong cluster would fail here, not after a write.
  const actual = process.env.BACKENLY_ENV ?? ''
  if (actual !== expect) refuse(`container BACKENLY_ENV is "${actual}", expected "${expect}"`)

  if (expect === 'production' && process.env.ALLOW_PRODUCTION_FIXTURE !== 'yes') {
    refuse('production needs ALLOW_PRODUCTION_FIXTURE=yes, supplied deliberately')
  }

  const host = (() => {
    try {
      return new URL(process.env.DATABASE_URL ?? '').hostname
    } catch {
      return ''
    }
  })()
  // Matched by environment marker rather than by instance name: this repository
  // is public, and a hostname here would be free reconnaissance. Both halves
  // are checked, so a host carrying neither marker refuses too.
  const other = expect === 'production' ? 'staging' : 'production'
  if (!host.includes(expect)) refuse(`database host "${host}" does not identify the ${expect} instance`)
  if (host.includes(other)) refuse(`database host "${host}" identifies ${other}, not ${expect}`)

  const db = await rows<{ d: string; u: string }>('select current_database() as d, current_user as u')
  if (db[0].d !== 'backenly') refuse(`connected to database "${db[0].d}", expected "backenly"`)
  return expect
}

/** The fixture project, found by exact name. Never by an id a caller supplied. */
async function fixtureProject(): Promise<{ id: string; userId: string } | null> {
  const found = await prisma.project.findMany({
    where: { name: FIXTURE_NAME },
    select: { id: true, userId: true, name: true },
  })
  if (found.length > 1) refuse(`${found.length} projects are named ${FIXTURE_NAME}; refusing to guess`)
  if (found.length === 0) return null
  if (found[0].name !== FIXTURE_NAME) refuse('fixture name mismatch')
  return { id: found[0].id, userId: found[0].userId as string }
}

const schemaOf = (projectId: string) => `workspace_${projectId}`

// ── The fixed shapes ─────────────────────────────────────────────────────────

/**
 * Restore the healthy baseline. Idempotent, and run before every fault, which
 * is what makes "one fault at a time" true rather than hoped.
 *
 *   posts     user-owned through user_id: RLS enabled + forced, an owner policy,
 *             an index on user_id
 *   comments  child of posts through post_id: RLS enabled + forced, a policy
 *             that follows the parent, an index on the foreign key
 */
async function restoreHealthy(projectId: string): Promise<void> {
  const s = schemaOf(projectId)
  const claim = `current_setting('request.jwt.claim.sub', true)`

  await q(`ALTER TABLE "${s}"."posts" ENABLE ROW LEVEL SECURITY`)
  await q(`ALTER TABLE "${s}"."posts" FORCE ROW LEVEL SECURITY`)
  await q(`ALTER TABLE "${s}"."comments" ENABLE ROW LEVEL SECURITY`)
  await q(`ALTER TABLE "${s}"."comments" FORCE ROW LEVEL SECURITY`)

  await q(`DROP POLICY IF EXISTS "p_open" ON "${s}"."posts"`)
  await q(`DROP POLICY IF EXISTS "fixture_posts_owner" ON "${s}"."posts"`)
  await q(
    `CREATE POLICY "fixture_posts_owner" ON "${s}"."posts" ` +
      `USING (user_id::text = ${claim}) WITH CHECK (user_id::text = ${claim})`,
  )
  await q(`DROP POLICY IF EXISTS "fixture_comments_parent" ON "${s}"."comments"`)
  await q(
    `CREATE POLICY "fixture_comments_parent" ON "${s}"."comments" USING (EXISTS (` +
      `SELECT 1 FROM "${s}"."posts" p WHERE p.id = post_id AND p.user_id::text = ${claim}))`,
  )

  await q(`CREATE INDEX IF NOT EXISTS "fixture_posts_user_id_idx" ON "${s}"."posts" ("user_id")`)
  await q(`CREATE INDEX IF NOT EXISTS "fixture_comments_post_id_idx" ON "${s}"."comments" ("post_id")`)
}

async function applyFault(projectId: string, fault: Fault): Promise<void> {
  const s = schemaOf(projectId)
  await restoreHealthy(projectId)
  switch (fault) {
    case 'healthy':
      return
    case 'rls_disabled':
      await q(`ALTER TABLE "${s}"."posts" DISABLE ROW LEVEL SECURITY`)
      return
    case 'missing_index':
      await q(`DROP INDEX IF EXISTS "${s}"."fixture_comments_post_id_idx"`)
      return
    case 'wide_open_policy':
      await q(`DROP POLICY IF EXISTS "fixture_posts_owner" ON "${s}"."posts"`)
      await q(`CREATE POLICY "p_open" ON "${s}"."posts" USING (true)`)
      return
  }
}

// ── Modes ────────────────────────────────────────────────────────────────────

async function prepare(env: Env): Promise<Record<string, unknown>> {
  let user = await prisma.user.findUnique({ where: { email: FIXTURE_USER_EMAIL } })
  if (!user) {
    user = await prisma.user.create({
      data: { email: FIXTURE_USER_EMAIL, name: 'autonomy acceptance fixture', password: 'not-a-login' },
    })
  }

  // ── An ordinary free-tier subscription ───────────────────────────────────
  //
  // Not decoration: with no subscription at all the plan ceiling cannot be
  // resolved, getProjectAutonomyLevel clamps to the safe fallback, and every
  // tier-1 repair would be refused for a reason that has nothing to do with the
  // Authority Decision. The fixture must be a project the loop treats normally.
  //
  // What `createFreeSubscription` writes, inlined rather than imported, because
  // importing lib/billing pulls its whole dependency graph into a payload that
  // travels in a 64 KB task definition. Kept identical to lib/billing/index.ts
  // — SANDBOX, falling back to the legacy FREE plan, status FREE — and it
  // refuses rather than inventing a plan if neither is seeded, because a
  // fixture quietly running at a different ceiling would report a wrong answer.
  const sub = await prisma.subscription.findFirst({
    where: { userId: user.id, status: { in: ['ACTIVE', 'FREE', 'GRACE'] } },
    include: { plan: { select: { name: true, autonomyMaxLevel: true } } },
  })
  let subscription = sub
  if (!subscription) {
    const plan =
      (await prisma.plan.findUnique({ where: { name: 'SANDBOX' } })) ??
      (await prisma.plan.findUnique({ where: { name: 'FREE' } }))
    if (!plan) refuse('no SANDBOX or FREE plan is seeded, so the fixture cannot be an ordinary free project')
    await prisma.subscription.create({ data: { userId: user.id, planId: plan.id, status: 'FREE' } })
    subscription = await prisma.subscription.findFirst({
      where: { userId: user.id },
      include: { plan: { select: { name: true, autonomyMaxLevel: true } } },
    })
  }

  // ── A real project, not a row and a schema ───────────────────────────────
  //
  // Every step `createProvisionedProject` performs, in its order, using the same
  // helpers: the project row and its BackendGraph in one transaction, then the
  // schema, the Workspace row, and the PostgREST registration that is the
  // difference between a served data plane and PGRST106 on every table.
  //
  // Why not call that function: importing it pulls ~1.7 MB into a payload that
  // travels in a task definition capped at 64 KB. The one step deliberately NOT
  // reproduced is the JWT signing secret, which the product itself treats as
  // non-fatal and provisions lazily on first end-user signup. Nothing the
  // autonomy loop reads depends on it, and the fixture has no end-users.
  let proj = await fixtureProject()
  let dataPlaneRegistered: boolean | null = null
  if (!proj) {
    const id = randomUUID()
    const slug = await generateUniqueSlug(FIXTURE_NAME, async candidate => {
      const taken = await prisma.project.findUnique({ where: { slug: candidate }, select: { id: true } })
      return !!taken
    })
    await prisma.$transaction(async tx => {
      await tx.project.create({ data: { id, name: FIXTURE_NAME, slug, userId: user!.id } })
      const graph = await tx.backendGraph.create({
        data: { projectId: id, graphData: createEmptyGraph(id) as any },
        select: { id: true },
      })
      await tx.project.update({ where: { id }, data: { activeGraphId: graph.id } })
    })

    const postgresSchema = workspaceSchemaName(id)
    await q(`CREATE SCHEMA IF NOT EXISTS "${postgresSchema}"`)
    await prisma.workspace.create({
      data: {
        name: `${FIXTURE_NAME} Workspace`,
        projectId: id,
        userId: user.id,
        postgresSchema,
        databaseProvisioned: true,
        databaseProvisionedAt: new Date(),
      },
    })
    // The same call lib/postgrest/registration.ts makes. It grants and registers
    // in one function, so the data plane is served rather than 403ing.
    dataPlaneRegistered = await q(`SELECT public.backenly_pgrst_register_schema('${postgresSchema}')`)
      .then(() => true)
      .catch(() => false)
    proj = { id, userId: user.id }
  }
  if (proj.userId !== user.id) refuse('fixture project is not owned by the fixture user')

  const s = schemaOf(proj.id)
  await q(`CREATE SCHEMA IF NOT EXISTS "${s}"`)
  await q(`CREATE TABLE IF NOT EXISTS "${s}"."posts" (id uuid PRIMARY KEY, user_id uuid, body text)`)
  await q(
    `CREATE TABLE IF NOT EXISTS "${s}"."comments" (id uuid PRIMARY KEY, ` +
      `post_id uuid REFERENCES "${s}"."posts"(id), body text)`,
  )
  await q(
    `INSERT INTO "${s}"."posts" (id, user_id, body) SELECT gen_random_uuid(), gen_random_uuid(), 'fixture' ` +
      `FROM generate_series(1, 5) WHERE NOT EXISTS (SELECT 1 FROM "${s}"."posts")`,
  )

  // Registered metadata. The scheduler's activity gate selects only projects
  // with tables on record; raw DDL alone would leave the fixture invisible.
  for (const name of ['posts', 'comments']) {
    const exists = await prisma.table.findFirst({ where: { projectId: proj.id, name } })
    if (!exists) {
      await prisma.table.create({
        data: { projectId: proj.id, name, schema: s, description: 'autonomy acceptance fixture' },
      })
    }
  }

  // Production-equivalent exposure, so reachability-gated probes can see it.
  // Re-run AFTER the tables exist: registration grants what was there when it
  // ran, and these two tables are created after it. Without this the data plane
  // serves the schema and has no privileges on its tables.
  const fn = await rows<{ n: number }>(
    `select count(*)::int as n from pg_proc where proname = 'backenly_pgrst_prepare_schema'`,
  )
  if (fn[0].n > 0) await q(`SELECT public.backenly_pgrst_prepare_schema('${s}')`)

  await restoreHealthy(proj.id)
  return {
    mode: 'prepare',
    env,
    projectId: proj.id,
    schema: s,
    postgrestPrepared: fn[0].n > 0,
    dataPlaneRegistered,
    plan: subscription?.plan?.name ?? null,
    planAutonomyCeiling: subscription?.plan?.autonomyMaxLevel ?? null,
    autonomyLevel: (await prisma.project.findUnique({ where: { id: proj.id }, select: { autonomyLevel: true } }))
      ?.autonomyLevel ?? null,
  }
}

async function authority(env: Env, action: Action): Promise<Record<string, unknown>> {
  const proj = await fixtureProject()
  if (!proj) refuse('no fixture project; run prepare first')

  if (action === 'declare_intent') {
    // Through the real writer, so provenance and versioning are the product's.
    const i = await declareOwnershipIntent(prisma, {
      projectId: proj.id,
      tableName: 'posts',
      ownerColumn: 'user_id',
      provenance: 'declared_by_user',
      declaredBy: P.user(proj.userId),
    })
    return { mode: 'authority', action, intentId: i.id, version: i.version }
  }
  if (action === 'grant') {
    // The real writer refuses any non-human principal; the fixture user is one.
    const g = await grantAuthority({
      projectId: proj.id,
      grantedBy: P.user(proj.userId),
      actionClassId: 'tighten_policy',
      environment: env,
    })
    return { mode: 'authority', action, grantId: g.id, environment: env }
  }
  // Revoked through the product's own writer, so the version bump the mutation
  // boundary revalidates against is the one the product writes.
  const live = await loadGrants(proj.id, 'tighten_policy')
  const open = live.filter(g => !g.revokedAt)
  for (const g of open) await revokeAuthority(g.id, proj.userId)
  return { mode: 'authority', action, revoked: open.length }
}

/** Catalog fingerprint of the fixture tables: the zero-mutation oracle. */
async function fingerprint(projectId: string): Promise<string> {
  const s = schemaOf(projectId)
  const r = await rows<{ sig: string }>(
    `select string_agg(x, '|' order by x) as sig from (
       select 'rls:'||c.relname||':'||c.relrowsecurity||':'||c.relforcerowsecurity as x
         from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname=$1 and c.relkind='r'
       union all select 'pol:'||tablename||':'||policyname||':'||coalesce(qual,'') from pg_policies where schemaname=$1
       union all select 'idx:'||indexname from pg_indexes where schemaname=$1) t`,
    s,
  )
  return r[0]?.sig ?? ''
}

async function freezeBegin(env: Env): Promise<Record<string, unknown>> {
  const proj = await fixtureProject()
  if (!proj) refuse('no fixture project; run prepare first')
  const s = schemaOf(proj.id)
  // A real departure the loop WOULD repair if it could see it, so silence during
  // the window is attributable to blindness rather than to nothing being wrong.
  await applyFault(proj.id, 'wide_open_policy')
  const before = await fingerprint(proj.id)
  const tables = await prisma.table.count({ where: { projectId: proj.id } })
  await q(`ALTER SCHEMA "${s}" RENAME TO "${s}_blind"`)
  return { mode: 'freeze-begin', env, fingerprintBefore: before, tablesBefore: tables, blindedAt: new Date() }
}

async function freezeEnd(env: Env): Promise<Record<string, unknown>> {
  const proj = await fixtureProject()
  if (!proj) refuse('no fixture project; run prepare first')
  const s = schemaOf(proj.id)
  const blind = await rows<{ n: number }>(`select count(*)::int as n from pg_namespace where nspname=$1`, `${s}_blind`)
  if (blind[0].n > 0) await q(`ALTER SCHEMA "${s}_blind" RENAME TO "${s}"`)
  const since = new Date(process.env.OBSERVE_SINCE ?? Date.now() - 15 * 60 * 1000)
  const autoExecuted = await prisma.auditLog.count({
    where: { projectId: proj.id, timestamp: { gte: since }, action: 'AUTHORITY_AUTO_EXECUTE' },
  })
  const frozen = await prisma.auditLog.count({
    where: { projectId: proj.id, timestamp: { gte: since }, action: 'AUTHORITY_FREEZE' },
  })
  return {
    mode: 'freeze-end',
    env,
    restored: blind[0].n > 0,
    fingerprintAfter: await fingerprint(proj.id),
    tablesAfter: await prisma.table.count({ where: { projectId: proj.id } }),
    autoExecutedDuringBlind: autoExecuted,
    freezeReceiptsDuringBlind: frozen,
  }
}

async function observe(env: Env): Promise<Record<string, unknown>> {
  const proj = await fixtureProject()
  if (!proj) refuse('no fixture project; run prepare first')
  const s = schemaOf(proj.id)
  const since = new Date(process.env.OBSERVE_SINCE ?? Date.now() - 15 * 60 * 1000)

  const rls = await rows<{ t: string; en: boolean; fo: boolean }>(
    `select c.relname as t, c.relrowsecurity as en, c.relforcerowsecurity as fo
       from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname=$1 and c.relkind='r' order by 1`,
    s,
  )
  const policies = await rows<{ t: string; p: string; qual: string | null }>(
    `select tablename as t, policyname as p, qual from pg_policies where schemaname=$1 order by 1,2`,
    s,
  )
  const indexes = await rows<{ i: string }>(`select indexname as i from pg_indexes where schemaname=$1 order by 1`, s)

  const receipts = await prisma.auditLog.findMany({
    where: { projectId: proj.id, timestamp: { gte: since }, action: { startsWith: 'AUTHORITY_' } },
    orderBy: { timestamp: 'asc' },
    select: { action: true, timestamp: true, details: true, metadata: true },
  })
  // Every action the loop writes for a tick (lib/autonomy/loop-tick.ts), not
  // just the live one: counting only AUTONOMY_LIVE_RUN would report "the loop
  // never looked" for a deployment running in shadow, which is a different
  // fact and would send the reader hunting the wrong problem.
  const ticks = await prisma.auditLog.groupBy({
    by: ['action'],
    where: {
      projectId: proj.id,
      timestamp: { gte: since },
      action: { in: ['AUTONOMY_TICK', 'AUTONOMY_LIVE_RUN', 'AUTONOMY_SHADOW_DECISION', 'AUTONOMY_CHANGE_FREEZE'] },
    },
    _count: { action: true },
  })

  // Compatibility debt, measured rather than manufactured: every project.
  const compat = await prisma.auditLog.findMany({
    where: { action: 'AUTHORITY_LEGACY_COMPATIBILITY', timestamp: { gte: since } },
    select: { details: true, projectId: true },
  })
  const compatByType: Record<string, number> = {}
  for (const c of compat) {
    const t = JSON.parse(c.details ?? '{}').findingType ?? 'unknown'
    compatByType[t] = (compatByType[t] ?? 0) + 1
  }

  // Any autonomous mutation on a project that is NOT the fixture.
  const crossProject = await prisma.auditLog.count({
    where: {
      projectId: { not: proj.id },
      timestamp: { gte: since },
      type: 'autonomy',
      action: { in: ['AGENT_AUTO_FIXED', 'AUTONOMY_FIX_APPLIED', 'HEALTH_AUTO_FIXED', 'AUTHORITY_AUTO_EXECUTE'] },
    },
  })

  const findings = await prisma.healthFinding.findMany({
    where: { projectId: proj.id },
    select: { type: true, status: true },
    orderBy: { detectedAt: 'desc' },
    take: 12,
  })

  return {
    mode: 'observe',
    env,
    projectId: proj.id,
    loopTicksOnFixture: Object.fromEntries(ticks.map(t => [t.action, t._count.action])),
    rls,
    policies,
    indexes: indexes.map(i => i.i),
    fingerprint: await fingerprint(proj.id),
    receipts: receipts.map(r => {
      const d = JSON.parse(r.details ?? '{}')
      return {
        at: r.timestamp,
        action: r.action,
        actionClass: d.actionClass ?? null,
        findingType: d.findingType ?? null,
        authorityPath: d.authorityPath ?? null,
        narrowedBy: d.narrowedBy ?? null,
        intentSatisfied: d.intent?.satisfied ?? null,
        delegationSatisfied: d.delegation?.satisfied ?? null,
        principals: (r.metadata as any)?.principals ?? null,
      }
    }),
    compatByType,
    crossProjectAutonomousMutations: crossProject,
    findings,
  }
}

async function teardown(env: Env): Promise<Record<string, unknown>> {
  const proj = await fixtureProject()
  if (!proj) return { mode: 'teardown', env, removed: false, reason: 'no fixture project' }

  // Second confirmation, naming BOTH the exact id and the environment.
  if (process.env.CONFIRM_DESTROY !== proj.id) refuse('CONFIRM_DESTROY must name the fixture project id exactly')
  if (process.env.CONFIRM_ENV !== env) refuse('CONFIRM_ENV must name the environment exactly')

  const again = await prisma.project.findUnique({ where: { id: proj.id }, select: { name: true } })
  if (again?.name !== FIXTURE_NAME) refuse('project identity changed between lookup and teardown')

  const s = schemaOf(proj.id)
  await q(`DROP SCHEMA IF EXISTS "${s}" CASCADE`)
  await q(`DROP SCHEMA IF EXISTS "${s}_blind" CASCADE`)
  await prisma.project.delete({ where: { id: proj.id } })
  await prisma.subscription.deleteMany({ where: { userId: proj.userId } })
  await prisma.user.deleteMany({ where: { email: FIXTURE_USER_EMAIL } })
  return { mode: 'teardown', env, removed: true, projectId: proj.id }
}

async function main(): Promise<void> {
  const mode = (process.env.ACCEPTANCE_MODE ?? '') as Mode
  if (!MODES.includes(mode)) refuse(`ACCEPTANCE_MODE must be one of ${MODES.join('|')}`)

  const env = await assertIdentity()

  let result: Record<string, unknown>
  if (mode === 'prepare') result = await prepare(env)
  else if (mode === 'fault') {
    const fault = (process.env.ACCEPTANCE_FAULT ?? '') as Fault
    if (!FAULTS.includes(fault)) refuse(`ACCEPTANCE_FAULT must be one of ${FAULTS.join('|')}`)
    const proj = await fixtureProject()
    if (!proj) refuse('no fixture project; run prepare first')
    await applyFault(proj.id, fault)
    result = { mode, env, fault, fingerprint: await fingerprint(proj.id) }
  } else if (mode === 'authority') {
    const action = (process.env.ACCEPTANCE_ACTION ?? '') as Action
    if (!ACTIONS.includes(action)) refuse(`ACCEPTANCE_ACTION must be one of ${ACTIONS.join('|')}`)
    result = await authority(env, action)
  } else if (mode === 'freeze-begin') result = await freezeBegin(env)
  else if (mode === 'freeze-end') result = await freezeEnd(env)
  else if (mode === 'observe') result = await observe(env)
  else result = await teardown(env)

  emit({ ok: true, ...result })
  await prisma.$disconnect()
}

main().catch(err => {
  emit({ ok: false, error: String(err?.message ?? err) })
  process.exit(1)
})
