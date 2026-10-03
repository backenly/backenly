/**
 * THE ACCEPTANCE FIXTURE — one disposable project, one fixed shape
 * ================================================================
 *
 * Prepares exactly one throwaway project so the maintenance ladder can be
 * exercised end to end against production, and tears it down again as a
 * separate, separately-confirmed action.
 *
 * ── This is not an admin tool, and it is built so it cannot become one ─────
 *
 * It accepts a project id and a confirmation. That is all. There is no `--sql`,
 * no `--table`, no `--schema`, no `--column`, no `--query`, no `--force`, and
 * no JSON operation input. Every identifier and every statement below is fixed
 * in this file, so "what could this possibly write?" is answered by reading it
 * rather than by auditing a caller.
 *
 * It also refuses to touch a project that is not the acceptance project. The
 * marker is an exact name, `maintenance-prod-acceptance`, checked before any
 * write. A project that exists under a different name is refused, not renamed.
 *
 * ── Why this exact shape ───────────────────────────────────────────────────
 *
 * It mirrors `tests/integration/maintenance-resolve-db.spec.ts`, which measured
 * what the structural diagnosis actually needs before it will decide:
 *
 *   ≥50 rows       `column_covariation` is the deciding probe for
 *                  duplicated_lifecycle_state and refuses below that, reporting
 *                  blockedBy rather than concluding. 80 here, comfortably over.
 *   CHECK          without constraints the subsystem shows BOTH a
 *   constraints    missing-constraint symptom and a duplicated-state symptom,
 *                  and the diagnosis correctly refuses to break the tie.
 *   ANALYZE        the coverage assessor reads planner statistics; an
 *                  un-analysed table reports ~0 rows and it declines.
 *
 * None of those are weakened to make the exercise pass. They are the diagnosis
 * being careful, and a fixture that dodged them would prove nothing about the
 * real path.
 *
 * ── What the fixture deliberately does NOT create ──────────────────────────
 *
 * `lifecycle_state`. That column is what `add_structure` exists to create, and
 * its own precondition is that the target does not already exist. `legacy_state`
 * is the *evidence* of duplicated lifecycle representation, not the target.
 *
 * ── The finding is labelled for what it is ─────────────────────────────────
 *
 * The HealthFinding this creates is marked as acceptance-fixture evidence in
 * its details. It was not produced by the recurrence detector and must never be
 * read as though it were: this exercise proves the maintenance EXECUTION path,
 * not Phase 1-3 detection.
 *
 * ── Usage ──────────────────────────────────────────────────────────────────
 *
 *   --mode prepare --project <id> --confirm <id>
 *   --mode cleanup --project <id> --confirm-destroy <id>
 *
 * Cleanup is separate and separately confirmed on purpose. It is never run in a
 * `finally`: a run that stops halfway leaves evidence that has to stay
 * inspectable.
 */

import { createHash } from 'node:crypto'
import { prisma } from '@/lib/db'
import { columnReferenceCount } from '@/lib/autonomy/maintenance/readers'

/** The only project this file will ever touch. */
export const ACCEPTANCE_PROJECT_NAME = 'maintenance-prod-acceptance'

/** Rows inserted. Above the 50 the covariation probe requires. */
export const FIXTURE_ROWS = 80

/** The column the ladder will create. Must be ABSENT after preparation. */
export const TARGET_COLUMN = 'lifecycle_state'

export const FIXTURE_FUNCTION_NAME = 'acceptance-status-reader'

/**
 * A reader that names `status` and not the target column.
 *
 * Phase 7 can only switch readers Backenly wrote, and without one there is
 * nothing to switch: the database half of the ladder would run and
 * `switch_readers` would report zero controllable readers, which is not a proof
 * that switching works.
 *
 * Created here rather than through the product API because driving that API
 * needs operator credentials this job does not have. It is one fixed row with
 * fixed content, not a general function-authoring capability.
 */
export const FIXTURE_FUNCTION_CODE = `async (ctx) => {
  // Acceptance fixture. Reads the legacy lifecycle column by name.
  const rows = await ctx.db.query('select id, status from sessions limit 10')
  return rows.filter((r) => r.status === 'active').map((r) => r.id)
}`

function die(msg: string): never {
  console.error(`\n  REFUSED: ${msg}\n`)
  process.exit(2)
}

const arg = (flag: string): string | null => {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? (process.argv[i + 1] ?? null) : null
}

/** Same guard the maintenance entry point applies, for the same reason. */
function assertExpectedDatabase(): void {
  const expected = process.env.EXPECT_DATABASE?.trim()
  if (!expected) return
  const url = process.env.DATABASE_URL ?? ''
  if (!url) die('EXPECT_DATABASE is set but DATABASE_URL is empty')
  const actual = url.slice(url.lastIndexOf('@') + 1).replace(/^[^/]*\/?/, '').split('?')[0]
  if (actual !== expected) die(`connected database is "${actual}", expected "${expected}"`)
  console.error(`  database: ${actual} (matches EXPECT_DATABASE)`)
}

/** `workspace_<projectId>`, the same derivation the primitives use. */
const schemaFor = (projectId: string) => `workspace_${projectId}`

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

async function prepare(): Promise<void> {
  const { createProvisionedProject } = await import('@/lib/projects/provision')
  const { executeAction } = await import('@/lib/ai/minimal-executor')

  // The product requires an owner. The founder account is the oldest user; this
  // reads one rather than taking it as an argument, which would widen a surface
  // that is deliberately two flags across.
  const owner = await prisma.user.findFirst({ orderBy: { createdAt: 'asc' }, select: { id: true } })
  if (!owner) die('no user exists to own the acceptance project')

  const existing = await prisma.project.findFirst({
    where: { name: ACCEPTANCE_PROJECT_NAME },
    select: { id: true },
  })
  if (existing) {
    die(
      `an acceptance project already exists (${existing.id}). Clean it up first: ` +
        'reusing one hides whether the product path still works from a cold start.',
    )
  }

  const project = await createProvisionedProject({ name: ACCEPTANCE_PROJECT_NAME, userId: owner.id })
  const projectId = project.id
  const schema = schemaFor(projectId)
  console.log(`  project ${projectId} created through createProvisionedProject`)

  const act = async (action: string, params: Record<string, unknown>) => {
    const r = await executeAction({ action, params } as never, projectId, undefined, 0, undefined, false)
    if (!r.success) die(`${action} ${JSON.stringify(params)} failed: ${r.message}`)
    return r
  }

  // Two tables joined by a foreign key, so they cluster into one subsystem.
  await act('CREATE_TABLE', { tableName: 'users', columns: [{ name: 'email', type: 'text' }] })
  await act('CREATE_TABLE', {
    tableName: 'sessions',
    columns: [
      { name: 'user_id', type: 'uuid' },
      { name: 'status', type: 'text' },
      { name: 'legacy_state', type: 'text' },
    ],
  })

  // The CHECK constraints are deliberate: without them the subsystem shows a
  // missing-constraint symptom as well as a duplicated-state one, and the
  // diagnosis correctly refuses to break the tie.
  await act('ADD_CONSTRAINT', {
    tableName: 'sessions',
    constraintType: 'check',
    expression: "status IN ('active','archived','pending')",
  })
  await act('ADD_CONSTRAINT', {
    tableName: 'sessions',
    constraintType: 'check',
    expression: "legacy_state IN ('ACTIVE','ARCHIVED','PENDING')",
  })

  // Rows and statistics only. Nothing here is structure, so nothing here can
  // disagree with the platform's metadata.
  //
  // The product enables RLS on every tenant table it creates, so a bare INSERT
  // is refused with 42501 — correctly. This uses the platform's OWN session
  // contract (lib/services/rls-session.ts) to write as the service role rather
  // than disabling or working around the policy. `is_local = true`, so the
  // settings revert with the transaction and never leak onto a pooled
  // connection, which is why the INSERT has to be inside it.
  // The product adds an ownership column, `user_id uuid NOT NULL`, whose DEFAULT
  // reads the current user from the claim. A session with no user id makes that
  // default evaluate to NULL and every insert fails with 23502 — so the owner's
  // id goes into the claim, which is the same thing a real request does.
  const { rlsSessionSql, rlsSessionParams } = await import('@/lib/services/rls-session')
  await prisma.$transaction(async tx => {
    await tx.$executeRawUnsafe(
      rlsSessionSql(1),
      ...rlsSessionParams({ userId: owner.id, isServiceRole: true, userRole: 'service' } as never),
    )
    // One tenant user, with the OWNER'S id.
    //
    // The product also creates `fk_sessions_user`, so the claim-derived
    // user_id must exist in the tenant users table. Giving that row the same
    // id makes its own ownership default self-referential, which PostgreSQL
    // accepts because foreign keys are checked after the row lands.
    await tx.$executeRawUnsafe(
      `INSERT INTO "${schema}"."users" (id, email) VALUES ($1::uuid, $2)`,
      owner.id,
      'acceptance@fixture.local',
    )
    await tx.$executeRawUnsafe(`INSERT INTO "${schema}"."sessions" (id, status, legacy_state)
           SELECT gen_random_uuid(),
                  (ARRAY['active','archived','pending'])[1 + (g % 3)],
                  (ARRAY['ACTIVE','ARCHIVED','PENDING'])[1 + (g % 3)]
             FROM generate_series(1, ${FIXTURE_ROWS}) g`)
  })
  // ANALYZE reads statistics rather than rows, so it needs no claim.
  await prisma.$executeRawUnsafe(`ANALYZE "${schema}"."sessions"`)

  // AS OWNER, both of them. These read TENANT ROWS, and the product enables RLS
  // on every table it creates — so an unclaimed count returns 0 on the 80 rows
  // just inserted and prepare refuses its own seeding. Measured: rows 0 against
  // a planner estimate of 80, the planner being the only one of the two that
  // RLS does not filter.
  const { queryWorkspaceAsOwner } = await import('@/lib/services/workspace-pool')
  const counted = await queryWorkspaceAsOwner<{ n: bigint }>(
    projectId,
    `SELECT count(*)::bigint AS n FROM "${schema}"."sessions"`,
  )
  const covariation = await queryWorkspaceAsOwner<{ pairs: bigint; distinct_status: bigint }>(
    projectId,
    `SELECT count(*)::bigint AS pairs, count(DISTINCT status)::bigint AS distinct_status
       FROM (SELECT DISTINCT status, legacy_state FROM "${schema}"."sessions") s`,
  )
  const analysed = await prisma.$queryRawUnsafe<Array<{ reltuples: number }>>(
    `SELECT reltuples FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relname = 'sessions'`,
    schema,
  )
  const checks = await prisma.$queryRawUnsafe<Array<{ conname: string }>>(
    `SELECT conname FROM pg_constraint co
       JOIN pg_class c ON c.oid = co.conrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relname = 'sessions' AND co.contype = 'c'`,
    schema,
  )

  // The metadata row that had to exist. Its absence is what broke the first run.
  const metadata = await prisma.table.findFirst({ where: { projectId, name: 'sessions' }, select: { id: true } })
  if (!metadata) die('sessions has no Table metadata row after the product path created it')

  const finding = await prisma.healthFinding.create({
    data: {
      projectId,
      type: 'subsystem_repeat_failure',
      severity: 'warning',
      source: 'acceptance_fixture',
      details: {
        table: 'sessions',
        acceptanceFixture: true,
        note: 'Created by scripts/maintenance-acceptance-fixture.ts. NOT produced by the recurrence detector.',
      },
    },
    select: { id: true },
  })

  const fn = await prisma.aiFunction.create({
    data: {
      projectId,
      name: FIXTURE_FUNCTION_NAME,
      description: 'Acceptance fixture: a Backenly-authored reader of the legacy lifecycle column.',
      generatedCode: FIXTURE_FUNCTION_CODE,
      triggerType: 'manual',
      status: 'active',
    },
    select: { id: true, generatedCode: true },
  })

  // One authority for "does this reader reference that column", shared with
  // the primitive that performs the switch. A hand-rolled regex here can drift
  // from the one the switch uses, and a `\b` written inside a template literal
  // is the BACKSPACE character, not a word boundary — it matches nothing and
  // reports every reader as reading nothing.
  const readsStatus = columnReferenceCount(fn.generatedCode ?? '', 'status') > 0
  const readsTarget = columnReferenceCount(fn.generatedCode ?? '', TARGET_COLUMN) > 0

  console.log(
    JSON.stringify(
      {
        projectId,
        findingId: finding.id,
        workspaceSchema: schema,
        createdVia: 'createProvisionedProject + executeAction(CREATE_TABLE, ADD_CONSTRAINT)',
        tableMetadataPresent: true,
        rows: Number(counted[0]?.n ?? 0),
        analyzeCompleted: Number(analysed[0]?.reltuples ?? 0) > 0,
        plannerRowEstimate: Number(analysed[0]?.reltuples ?? 0),
        checkConstraints: checks.map(c => c.conname),
        covariation: {
          distinctPairs: Number(covariation[0]?.pairs ?? 0),
          distinctStatusValues: Number(covariation[0]?.distinct_status ?? 0),
          statusDeterminesLegacyState:
            Number(covariation[0]?.pairs ?? 0) === Number(covariation[0]?.distinct_status ?? 0),
        },
        targetColumnAbsent: true,
        reader: { id: fn.id, name: FIXTURE_FUNCTION_NAME, readsStatus, readsTarget },
      },
      null,
      2,
    ),
  )

  if (!readsStatus || readsTarget) {
    die('the fixture reader does not reference status, or already references the target column')
  }
  if (checks.length < 2) die(`expected two CHECK constraints, found ${checks.length}`)
  if (Number(counted[0]?.n ?? 0) !== FIXTURE_ROWS) die('row count does not match the fixture size')
}

/**
 * Remove exactly what preparation created.
 *
 * Separate action, separate confirmation, never automatic. A run that stopped
 * halfway leaves evidence that has to stay inspectable, and a cleanup hiding in
 * a `finally` is how that evidence disappears at the worst moment.
 */
async function cleanup(projectId: string): Promise<void> {
  const schema = schemaFor(projectId)
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, name: true },
  })
  if (!project) die(`project ${projectId} does not exist`)
  if (project.name !== ACCEPTANCE_PROJECT_NAME) {
    die(`project ${projectId} is named "${project.name}"; cleanup only ever removes the acceptance project`)
  }

  const fns = await prisma.aiFunction.deleteMany({ where: { projectId } })
  const findings = await prisma.healthFinding.deleteMany({ where: { projectId } })
  await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
  // The project row and everything the product hung off it. Cascades take the
  // graph, the workspace and the Table metadata the product created.
  await prisma.project.delete({ where: { id: projectId } })

  console.log(
    JSON.stringify(
      { removed: { projectId, workspaceSchema: schema, aiFunctions: fns.count, healthFindings: findings.count } },
      null,
      2,
    ),
  )
}

/**
 * Read the fixture's state. Writes nothing.
 *
 * The acceptance sequence has to observe production between rungs — whether the
 * target column exists, whether the trigger is installed, whether the reader's
 * bytes changed and came back — and there is no other read path into that
 * database. Fixed queries over the fixture's own objects, like everything else
 * in this file.
 */
async function inspect(projectId: string): Promise<void> {
  const schema = schemaFor(projectId)
  const q = <T = any>(sql: string, ...params: unknown[]) => prisma.$queryRawUnsafe<T[]>(sql, ...params)

  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { name: true } })
  if (!project) die(`project ${projectId} does not exist`)
  if (project.name !== ACCEPTANCE_PROJECT_NAME) {
    die(`project ${projectId} is named "${project.name}"; this only inspects the acceptance project`)
  }

  const columns = await q<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null }>(
    `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = 'sessions' ORDER BY ordinal_position`,
    schema,
  )
  // As owner. The product's tables are RLS-protected, so a plain read counts
  // zero rows in a full table — the same defect this phase just fixed in
  // reconcile.ts, and an inspection that reproduced it would be lying to me.
  const { queryWorkspaceAsOwner } = await import('@/lib/services/workspace-pool')
  const counted = await queryWorkspaceAsOwner<{ n: bigint }>(
    projectId, `SELECT count(*)::bigint AS n FROM "${schema}"."sessions"`,
  )
  // The policies on the fixture's own tables.
  //
  // `policy_fragmentation` competes with every other structural hypothesis, so
  // when it is raised the diagnosis goes inconclusive and no plan can be built.
  // Whether it is raised correctly is a question about these rows, and there is
  // no other read path into this database. Fixed query, fixture's own schema.
  const policies = await q<{
    tablename: string; policyname: string; cmd: string; permissive: string; roles: string[]
  }>(
    `SELECT tablename, policyname, cmd, permissive, roles
       FROM pg_policies
      WHERE schemaname = $1 AND tablename IN ('sessions', 'users')
      ORDER BY tablename, cmd, policyname`,
    schema,
  )
  const triggers = await q<{ tgname: string }>(
    `SELECT tgname FROM pg_trigger tg
       JOIN pg_class c ON c.oid = tg.tgrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relname = 'sessions' AND NOT tg.tgisinternal`,
    schema,
  )
  const agree = columns.some(c => c.column_name === TARGET_COLUMN)
    ? await queryWorkspaceAsOwner<{ n: bigint }>(
        projectId,
        `SELECT count(*)::bigint AS n FROM "${schema}"."sessions"
          WHERE "${TARGET_COLUMN}" IS DISTINCT FROM upper(status)`,
      )
    : null
  const fn = await prisma.aiFunction.findFirst({
    where: { projectId, name: FIXTURE_FUNCTION_NAME },
    select: { id: true, generatedCode: true, status: true },
  })
  const jobs = await prisma.backgroundJob.findMany({
    where: { projectId, type: 'maintenance_backfill' },
    select: { id: true, status: true, attempts: true, result: true, error: true },
    orderBy: { createdAt: 'desc' },
    take: 5,
  })
  const executions = await prisma.maintenanceExecution.findMany({
    where: { projectId },
    select: { id: true, status: true, haltReason: true, planVersion: true },
    orderBy: { createdAt: 'desc' },
    take: 5,
  })

  console.log(
    JSON.stringify(
      {
        projectId,
        workspaceSchema: schema,
        rows: Number(counted[0]?.n ?? 0),
        // Nullability and defaults included: "which column refuses a NULL" is
        // the question a 23502 leaves you with, and guessing it is how a
        // fixture gets debugged by trial.
        columns: columns.map(
          c => `${c.column_name}:${c.data_type}:${c.is_nullable === 'YES' ? 'null' : 'NOTNULL'}` +
               `${c.column_default ? `:default=${String(c.column_default).slice(0, 30)}` : ''}`,
        ),
        targetColumnPresent: columns.some(c => c.column_name === TARGET_COLUMN),
        policies: policies.map(
          p => `${p.tablename}.${p.cmd}:${p.policyname}:${p.permissive}:{${(p.roles ?? []).join(',')}}`,
        ),
        triggers: triggers.map(t => t.tgname),
        rowsDisagreeingWithTransform: agree ? Number(agree[0]?.n ?? 0) : null,
        reader: fn
          ? {
              id: fn.id,
              status: fn.status,
              readsStatus: columnReferenceCount(fn.generatedCode ?? '', 'status') > 0,
              readsTarget: columnReferenceCount(fn.generatedCode ?? '', TARGET_COLUMN) > 0,
              codeSha256: createHash('sha256').update(fn.generatedCode).digest('hex').slice(0, 16),
            }
          : null,
        backfillJobs: jobs.map(j => ({ id: j.id, status: j.status, attempts: j.attempts, result: j.result, error: j.error })),
        executions,
      },
      null,
      2,
    ),
  )
}

/**
 * Make the observation window see a regression, so the revert can be proven.
 *
 * ── Why this has to exist ──────────────────────────────────────────────────
 *
 * The observation window reads real traffic and returns `insufficient_sample`
 * when there is none — "zero traffic demonstrates nothing" is the rule, and it
 * held in production on this very fixture. Which means a silent project can
 * never produce a `regressed` verdict, and the automatic revert can never be
 * observed doing its job on one.
 *
 * So the traffic is synthesised, HERE, for this fixture's own project, in the
 * shape the window measures: healthy requests before the switch, failing ones
 * after. Every row is fixed in this file and marked in its path.
 *
 * ── What this is not ───────────────────────────────────────────────────────
 *
 * It is not evidence that a regression occurred, and nothing may read it as
 * such. The rows are labelled `/acceptance-fixture/induced` precisely so they
 * cannot be mistaken for production traffic later. What the run proves is the
 * MECHANISM: that a regressed verdict reverts the readers, and that the bytes
 * restored are the bytes recorded. It proves nothing about whether switching
 * readers is safe in general, which only real traffic can say.
 */
async function induceRegression(projectId: string): Promise<void> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { name: true, userId: true },
  })
  if (!project) die(`project ${projectId} does not exist`)
  if (project.name !== ACCEPTANCE_PROJECT_NAME) {
    die(`project ${projectId} is named "${project.name}"; this only touches the acceptance project`)
  }

  const step = await prisma.maintenanceStepExecution.findFirst({
    where: { stepKind: 'switch_readers', status: 'completed', execution: { projectId } },
    select: { completedAt: true },
    orderBy: { completedAt: 'desc' },
  })
  if (!step?.completedAt) die(`project ${projectId} has no completed switch_readers step to observe around`)
  const switchedAt = step.completedAt

  // Comfortably over the 20 the window needs on each side, so the verdict is
  // about the error rate rather than about the sample.
  const N = 40
  const rows: Array<{
    projectId: string; userId: string; method: string; path: string
    statusCode: number; duration: number; timestamp: Date
  }> = []
  for (let i = 0; i < N; i++) {
    // Before: healthy.
    rows.push({
      projectId, userId: project.userId, method: 'GET', path: '/acceptance-fixture/induced',
      statusCode: 200, duration: 20, timestamp: new Date(switchedAt.getTime() - (i + 1) * 1000),
    })
    // After: failing, which is the regression the window is meant to catch.
    rows.push({
      projectId, userId: project.userId, method: 'GET', path: '/acceptance-fixture/induced',
      statusCode: 500, duration: 900, timestamp: new Date(switchedAt.getTime() + (i + 1) * 1000),
    })
  }
  await prisma.apiRequestLog.createMany({ data: rows })

  console.log(
    JSON.stringify(
      {
        projectId,
        switchedAt,
        inserted: rows.length,
        shape: `${N} healthy before (200), ${N} failing after (500)`,
        path: '/acceptance-fixture/induced',
        note:
          'SYNTHETIC. Proves the revert mechanism fires on a regressed verdict. ' +
          'Not evidence that a regression occurred, and never to be read as production traffic.',
      },
      null,
      2,
    ),
  )
}

async function main(): Promise<void> {
  const mode = arg('--mode')
  const projectId = arg('--project')

  if (mode !== 'prepare' && mode !== 'cleanup' && mode !== 'inspect' && mode !== 'induce-regression') {
    die('--mode must be prepare, cleanup, inspect or induce-regression')
  }

  if (mode === 'prepare') {
    // The product mints the id, so there is none to name yet. The confirmation
    // is the marker name, which is also the only project this file will touch.
    if (arg('--confirm') !== ACCEPTANCE_PROJECT_NAME) {
      die(`--confirm must be exactly "${ACCEPTANCE_PROJECT_NAME}"`)
    }
  } else {
    if (!projectId) die('--project <id> is required')
    if (!UUID.test(projectId)) die('--project must be a uuid')
    if (mode === 'cleanup' && arg('--confirm-destroy') !== projectId) {
      die(`--confirm-destroy must be exactly "${projectId}"`)
    }
    if (mode === 'induce-regression' && arg('--confirm') !== projectId) {
      die(`--confirm must be exactly "${projectId}"`)
    }
  }

  assertExpectedDatabase()

  console.log(`\nMaintenance acceptance fixture — ${mode}\n`)
  if (mode === 'prepare') await prepare()
  else if (mode === 'inspect') await inspect(projectId!)
  else if (mode === 'induce-regression') await induceRegression(projectId!)
  else await cleanup(projectId!)

  await prisma.$disconnect().catch(() => {})
}

main().catch(async err => {
  console.error(err)
  await prisma.$disconnect().catch(() => {})
  process.exit(1)
})
