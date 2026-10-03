/**
 * PHASE 6 RDS REHEARSAL — prove the mutation assumptions on the real engine
 * =========================================================================
 *
 * Phase 6b installs triggers, backfills live tables and reconciles the result.
 * Every one of those was designed against a local PostgreSQL, and the target is
 * RDS, where the differences that matter are not cosmetic:
 *
 *   • there is no true superuser. This codebase already has one feature that
 *     cannot work on RDS for exactly that reason (the PostgREST GUC registry),
 *     so "SECURITY DEFINER behaves the same" is an assumption, not a fact.
 *   • parameter groups set statement and idle timeouts the local box does not.
 *   • lock behaviour under a managed engine is worth measuring rather than
 *     assuming.
 *
 * This script proves or disproves those assumptions. It is the gate on starting
 * Phase 6b, and a FAIL here means the design changes rather than the gate moving.
 *
 * ── Safety ──────────────────────────────────────────────────────────────────
 *
 * Refuses to run unless the database it is pointed at is staging. Everything it
 * creates lives in one throwaway schema, and the rollback check proves that
 * schema's artifacts are gone rather than assuming DROP worked.
 *
 * Uses @prisma/client rather than `pg`: the runtime image ships the Prisma
 * client and bundles everything else, so `pg` is not resolvable inside it.
 *
 * ── Output ──────────────────────────────────────────────────────────────────
 *
 * One machine-readable JSON object between sentinels on stdout, and a non-zero
 * exit code if any mandatory check fails.
 *
 * ── WHAT THE FIRST REAL RUN CHANGED — Phase 6b invariants ───────────────────
 *
 * Two checks failed on the first run against RDS. Both were defects in this
 * script, and both exposed constraints the implementation must obey. They are
 * recorded here because the knowledge is worth more than the fix.
 *
 * 1. A BEFORE UPDATE trigger silently repaired the corruption the reconciliation
 *    check was trying to introduce. Any test that simulates divergence must
 *    remove the mirror first — otherwise it proves the trigger works while
 *    appearing to prove the detector does not.
 *
 * 2. **Prisma pools connections, so a session-scoped `SET` is not observable by
 *    a later query.** `SET lock_timeout` landed on one pooled connection and the
 *    verifying `SHOW` read another, which looked exactly like RDS forbidding it.
 *
 *    Phase 6b MUST therefore bound lock waits transaction-locally:
 *
 *        await prisma.$transaction(async tx => {
 *          await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '250ms'`)
 *          // the lock-sensitive batch, on THIS tx
 *        })
 *
 *    and must NOT be "simplified" to a bare `SET` followed by separate
 *    statements. Pooling makes that form a safety control that does nothing,
 *    while reading as though it does.
 */

import { PrismaClient } from '@prisma/client'

const RESULT_BEGIN = '---REHEARSAL-RESULT-BEGIN---'
const RESULT_END = '---REHEARSAL-RESULT-END---'

type Status = 'PASS' | 'FAIL' | 'SKIP'

interface Check {
  status: Status
  detail: string
  /** A failure here does not fail the rehearsal. */
  advisory?: boolean
}

const checks: Record<string, Check> = {}
const log = (m: string) => console.log(`[rehearsal] ${m}`)

function record(name: string, status: Status, detail: string, advisory = false): void {
  checks[name] = { status, detail, advisory }
  log(`${status.padEnd(4)} ${name} — ${detail}`)
}

const prisma = new PrismaClient()
const exec = (sql: string) => prisma.$executeRawUnsafe(sql)
const query = <T = any>(sql: string, ...p: unknown[]) =>
  prisma.$queryRawUnsafe<T[]>(sql, ...p)

/** Everything this rehearsal creates lives here and nowhere else. */
const SCHEMA = `_rehearsal_${Date.now()}`

/**
 * Structural identity of a schema.
 *
 * Used before and after to prove rollback removed EVERY artifact — not just the
 * column. A dual-write leaves a trigger AND a trigger function AND a column, and
 * checking only the obvious one is how leftovers accumulate.
 */
async function catalogFingerprint(schema: string): Promise<string> {
  const rows = await query<{ kind: string; name: string; extra: string }>(
    `SELECT 'column' AS kind, c.table_name || '.' || c.column_name AS name,
            c.data_type AS extra
       FROM information_schema.columns c WHERE c.table_schema = $1
     UNION ALL
     SELECT 'table', c.relname, c.relkind::text
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relkind IN ('r','p','v','m')
     UNION ALL
     SELECT 'trigger', t.tgname, c.relname
       FROM pg_trigger t
       JOIN pg_class c ON c.oid = t.tgrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND NOT t.tgisinternal
     UNION ALL
     SELECT 'function', p.proname, p.prosecdef::text
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = $1
     UNION ALL
     SELECT 'index', i.indexname, i.tablename
       FROM pg_indexes i WHERE i.schemaname = $1
      ORDER BY 1, 2, 3`,
    schema,
  )
  return rows.map(r => `${r.kind}:${r.name}:${r.extra}`).join('\n')
}

// ── 1. ADD COLUMN on a populated table ───────────────────────────────────────

async function checkAddColumnLock(): Promise<void> {
  const t0 = Date.now()
  await exec(`ALTER TABLE "${SCHEMA}".subjects ADD COLUMN status_v2 text`)
  const ms = Date.now() - t0

  // A nullable ADD COLUMN with no default must be metadata-only: no table
  // rewrite, no long ACCESS EXCLUSIVE hold. If RDS makes this expensive, the
  // expand step needs a different shape.
  const rows = await query<{ n: bigint }>(
    `SELECT count(*)::bigint AS n FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = 'subjects' AND column_name = 'status_v2'`,
    SCHEMA,
  )
  const present = Number(rows[0]?.n ?? 0) === 1
  record(
    'add_column_lock',
    present && ms < 5000 ? 'PASS' : 'FAIL',
    `added in ${ms}ms, present=${present}`,
  )
}

// ── 2. SECURITY DEFINER trigger ──────────────────────────────────────────────

async function checkSecurityDefinerTrigger(): Promise<void> {
  // The dual-write mechanism. SECURITY DEFINER is required because the role
  // writing the source row is generally NOT permitted to write the target under
  // RLS — the same reason derived-columns.ts uses it. RDS has no true
  // superuser, so this is the check most likely to fail.
  await exec(`
    CREATE OR REPLACE FUNCTION "${SCHEMA}".mirror_status() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
    BEGIN
      NEW.status_v2 := upper(NEW.status);
      RETURN NEW;
    END;
    $fn$`)
  await exec(`
    CREATE TRIGGER mirror_status_trg BEFORE INSERT OR UPDATE ON "${SCHEMA}".subjects
    FOR EACH ROW EXECUTE FUNCTION "${SCHEMA}".mirror_status()`)

  await exec(`INSERT INTO "${SCHEMA}".subjects (id, status) VALUES (9001, 'active')`)
  const rows = await query<{ status_v2: string; secdef: boolean }>(
    `SELECT s.status_v2, p.prosecdef AS secdef
       FROM "${SCHEMA}".subjects s,
            pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE s.id = 9001 AND n.nspname = $1 AND p.proname = 'mirror_status'`,
    SCHEMA,
  )
  const ok = rows[0]?.status_v2 === 'ACTIVE' && rows[0]?.secdef === true
  record(
    'security_definer_trigger',
    ok ? 'PASS' : 'FAIL',
    `fired=${rows[0]?.status_v2 ?? 'none'} secdef=${rows[0]?.secdef}`,
  )
}

// ── 3. Exception swallowing ──────────────────────────────────────────────────

async function checkExceptionSwallowing(): Promise<void> {
  // The property the whole dual-write design rests on: a trigger that fails
  // must NOT abort the customer's write. Without this, one bad mirror takes
  // down every INSERT on the table.
  await exec(`
    CREATE OR REPLACE FUNCTION "${SCHEMA}".mirror_status() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
    BEGIN
      BEGIN
        -- Deliberately fails. A real body would be a cast that can throw.
        NEW.status_v2 := (1 / 0)::text;
      EXCEPTION WHEN OTHERS THEN
        -- Swallowed, and RECORDED. Silence here is what turns a broken mirror
        -- into silent divergence, which is why Phase 6a exists.
        INSERT INTO "${SCHEMA}".mismatch_ledger (subject_id, reason)
        VALUES (NEW.id, SQLERRM);
        NEW.status_v2 := NULL;
      END;
      RETURN NEW;
    END;
    $fn$`)

  let callerAborted = false
  try {
    await exec(`INSERT INTO "${SCHEMA}".subjects (id, status) VALUES (9002, 'pending')`)
  } catch {
    callerAborted = true
  }

  const rows = await query<{ subjects: bigint; ledger: bigint }>(
    `SELECT (SELECT count(*) FROM "${SCHEMA}".subjects WHERE id = 9002)::bigint AS subjects,
            (SELECT count(*) FROM "${SCHEMA}".mismatch_ledger WHERE subject_id = 9002)::bigint AS ledger`,
  )
  const wrote = Number(rows[0]?.subjects ?? 0) === 1
  const logged = Number(rows[0]?.ledger ?? 0) === 1

  record(
    'exception_swallowing',
    !callerAborted && wrote && logged ? 'PASS' : 'FAIL',
    `callerAborted=${callerAborted} rowWritten=${wrote} ledgerRecorded=${logged}`,
  )

  // Restore the working mirror for the backfill checks.
  await exec(`
    CREATE OR REPLACE FUNCTION "${SCHEMA}".mirror_status() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
    BEGIN NEW.status_v2 := upper(NEW.status); RETURN NEW; END;
    $fn$`)
}

// ── 4. Resumable backfill, interrupted at the JOB boundary ───────────────────

async function checkResumableBackfill(): Promise<void> {
  const BATCH = 100

  /** One batch, driven entirely by the persisted cursor. No in-memory state. */
  async function runBatch(): Promise<number> {
    const cur = await query<{ cursor_id: number }>(
      `SELECT cursor_id FROM "${SCHEMA}".backfill_checkpoint WHERE job = 'status_v2'`,
    )
    const from = Number(cur[0]?.cursor_id ?? 0)

    const rows = await query<{ id: number }>(
      `WITH batch AS (
         SELECT id FROM "${SCHEMA}".subjects
          WHERE id > ${from} AND status_v2 IS NULL
          ORDER BY id LIMIT ${BATCH}
       )
       UPDATE "${SCHEMA}".subjects s
          SET status_v2 = upper(s.status)
         FROM batch b WHERE s.id = b.id
       RETURNING s.id`,
    )
    if (rows.length === 0) return 0

    const maxId = Math.max(...rows.map(r => Number(r.id)))
    await exec(
      `UPDATE "${SCHEMA}".backfill_checkpoint SET cursor_id = ${maxId} WHERE job = 'status_v2'`,
    )
    return rows.length
  }

  const b1 = await runBatch()
  const b2 = await runBatch()

  // Simulated task death: every in-memory variable is discarded and the next
  // batch is driven purely from the checkpoint row. This is the real failure
  // boundary — a Fargate task disappearing mid-backfill — rather than an
  // exception inside one transaction, which proves something different.
  const checkpointAfterDeath = await query<{ cursor_id: number }>(
    `SELECT cursor_id FROM "${SCHEMA}".backfill_checkpoint WHERE job = 'status_v2'`,
  )
  const resumedFrom = Number(checkpointAfterDeath[0]?.cursor_id ?? -1)

  // Re-run a COMPLETED batch by rewinding the cursor. An idempotent backfill
  // rewrites the same values; a non-idempotent one corrupts or double-counts.
  await exec(`UPDATE "${SCHEMA}".backfill_checkpoint SET cursor_id = 0 WHERE job = 'status_v2'`)
  const replay = await runBatch()
  await exec(
    `UPDATE "${SCHEMA}".backfill_checkpoint SET cursor_id = ${resumedFrom} WHERE job = 'status_v2'`,
  )

  let more = 0
  let guard = 0
  while (guard++ < 200) {
    const n = await runBatch()
    if (n === 0) break
    more += n
  }

  const left = await query<{ n: bigint }>(
    `SELECT count(*)::bigint AS n FROM "${SCHEMA}".subjects WHERE status_v2 IS NULL`,
  )
  const remaining = Number(left[0]?.n ?? -1)

  record(
    'resumable_backfill',
    b1 === BATCH && b2 === BATCH && resumedFrom > 0 && remaining === 0 ? 'PASS' : 'FAIL',
    `batches=${b1}/${b2} resumedFrom=${resumedFrom} replayRewrote=${replay} ` +
      `tail=${more} remainingNull=${remaining}`,
  )
}

// ── 5. Reconciliation ────────────────────────────────────────────────────────

async function checkReconciliation(): Promise<void> {
  const agree = await query<{ compared: bigint; mismatched: bigint }>(
    `SELECT count(*)::bigint AS compared,
            count(*) FILTER (WHERE status_v2 IS DISTINCT FROM upper(status))::bigint AS mismatched
       FROM "${SCHEMA}".subjects`,
  )
  const cleanCompared = Number(agree[0]?.compared ?? 0)
  const cleanMismatch = Number(agree[0]?.mismatched ?? -1)

  // The case Phase 6a exists for: corrupt one target row WITHOUT touching the
  // ledger, exactly as a trigger that succeeded with a wrong value would.
  //
  // The mirror trigger has to come off first. It is BEFORE UPDATE, so it
  // recomputed status_v2 from status and silently undid the corruption — the
  // first run of this rehearsal reported silentDivergenceCaught=false for
  // exactly that reason, which is a defect in the test rather than in the
  // check. Dropping it is also the honest simulation: the divergence being
  // modelled is a trigger that wrote a WRONG value, not one that is working.
  await exec(`DROP TRIGGER IF EXISTS mirror_status_trg ON "${SCHEMA}".subjects`)
  await exec(`UPDATE "${SCHEMA}".subjects SET status_v2 = 'WRONG' WHERE id = 1`)
  const dirty = await query<{ mismatched: bigint }>(
    `SELECT count(*) FILTER (WHERE status_v2 IS DISTINCT FROM upper(status))::bigint AS mismatched
       FROM "${SCHEMA}".subjects`,
  )
  const ledger = await query<{ n: bigint }>(
    `SELECT count(*)::bigint AS n FROM "${SCHEMA}".mismatch_ledger WHERE subject_id = 1`,
  )
  const caught = Number(dirty[0]?.mismatched ?? 0) > 0
  const ledgerSilent = Number(ledger[0]?.n ?? 0) === 0

  await exec(`UPDATE "${SCHEMA}".subjects SET status_v2 = upper(status) WHERE id = 1`)
  await exec(`
    CREATE TRIGGER mirror_status_trg BEFORE INSERT OR UPDATE ON "${SCHEMA}".subjects
    FOR EACH ROW EXECUTE FUNCTION "${SCHEMA}".mirror_status()`)

  record(
    'reconciliation',
    cleanCompared > 0 && cleanMismatch === 0 && caught && ledgerSilent ? 'PASS' : 'FAIL',
    `clean=${cleanCompared}/${cleanMismatch} silentDivergenceCaught=${caught} ` +
      `ledgerStayedSilent=${ledgerSilent}`,
  )
}

// ── 6. Rollback removes EVERY artifact ───────────────────────────────────────

async function checkRollbackCleanup(baseline: string, baselineRows: string): Promise<void> {
  await exec(`DROP TRIGGER IF EXISTS mirror_status_trg ON "${SCHEMA}".subjects`)
  await exec(`DROP FUNCTION IF EXISTS "${SCHEMA}".mirror_status()`)
  await exec(`ALTER TABLE "${SCHEMA}".subjects DROP COLUMN IF EXISTS status_v2`)
  await exec(`DROP TABLE IF EXISTS "${SCHEMA}".mismatch_ledger`)
  await exec(`DROP TABLE IF EXISTS "${SCHEMA}".backfill_checkpoint`)

  const after = await catalogFingerprint(SCHEMA)
  const rowsAfter = await sourceRowDigest()

  const structureRestored = after === baseline
  const dataUnchanged = rowsAfter === baselineRows

  record(
    'rollback_cleanup',
    structureRestored && dataUnchanged ? 'PASS' : 'FAIL',
    structureRestored
      ? `catalog matches baseline, source rows ${dataUnchanged ? 'unchanged' : 'CHANGED'}`
      : `leftover artifacts: ${diffLines(baseline, after).join(', ') || '(ordering only)'}`,
  )
}

function diffLines(a: string, b: string): string[] {
  const left = new Set(a.split('\n'))
  return b.split('\n').filter(l => l && !left.has(l))
}

/** Logical digest of the source data, to prove the rehearsal did not alter it. */
async function sourceRowDigest(): Promise<string> {
  const rows = await query<{ d: string }>(
    `SELECT md5(string_agg(id || ':' || status, ',' ORDER BY id)) AS d
       FROM "${SCHEMA}".subjects WHERE id <= 1000`,
  )
  return rows[0]?.d ?? ''
}

// ── 7. Timeout behaviour ─────────────────────────────────────────────────────

async function checkTimeoutBehavior(): Promise<void> {
  const settings = await query<{ name: string; setting: string }>(
    `SELECT name, setting FROM pg_settings
      WHERE name IN ('statement_timeout','idle_in_transaction_session_timeout','lock_timeout')`,
  )
  const s = Object.fromEntries(settings.map(r => [r.name, r.setting]))

  // A backfill must be able to bound its own lock wait rather than inheriting
  // an unbounded one. Proving lock_timeout is settable per-session is what
  // makes "abort on lock wait" implementable.
  // SET LOCAL inside one transaction, not a bare SET.
  //
  // The first run reported lock_timeout_settable=false, which looked like an
  // RDS restriction and was not: Prisma pools connections, so the bare `SET`
  // landed on one connection and the `SHOW` read a different one. That is a
  // real constraint for Phase 6b rather than a quirk of this script — a pooled
  // client cannot rely on session GUCs — so the rehearsal now proves the
  // approach the backfill will actually have to use.
  let settable = false
  try {
    const back = await prisma.$transaction(async tx => {
      await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '250ms'`)
      return tx.$queryRawUnsafe<Array<{ lock_timeout: string }>>(`SHOW lock_timeout`)
    })
    settable = String(back[0]?.lock_timeout ?? '').startsWith('250')
  } catch (err) {
    log(`lock_timeout probe failed: ${err instanceof Error ? err.message : String(err)}`)
    settable = false
  }

  record(
    'timeout_behavior',
    settable ? 'PASS' : 'FAIL',
    `statement_timeout=${s.statement_timeout ?? '?'} ` +
      `idle_in_txn=${s.idle_in_transaction_session_timeout ?? '?'} ` +
      `lock_timeout_settable=${settable}`,
  )
}

// ── Orchestration ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL ?? ''

  // Structural refusal. A typo in a launcher argument must not be capable of
  // pointing a schema-mutating rehearsal at production.
  if (!/staging/i.test(url)) {
    console.error(
      '[rehearsal] REFUSING: DATABASE_URL does not identify a staging database. ' +
      'This script mutates schema and will not run anywhere else.',
    )
    process.exit(2)
  }
  if (/production|prod-/i.test(url)) {
    console.error('[rehearsal] REFUSING: DATABASE_URL looks like production.')
    process.exit(2)
  }

  log(`schema ${SCHEMA}`)
  let exitCode = 0

  try {
    await exec(`CREATE SCHEMA "${SCHEMA}"`)
    await exec(`CREATE TABLE "${SCHEMA}".subjects (id bigint PRIMARY KEY, status text NOT NULL)`)
    await exec(
      `INSERT INTO "${SCHEMA}".subjects (id, status)
       SELECT i, (ARRAY['active','pending','closed'])[1 + (i % 3)]
         FROM generate_series(1, 1000) AS i`,
    )
    await exec(`ANALYZE "${SCHEMA}".subjects`)

    const baseline = await catalogFingerprint(SCHEMA)
    const baselineRows = await sourceRowDigest()

    await exec(`CREATE TABLE "${SCHEMA}".mismatch_ledger (
      id bigserial PRIMARY KEY, subject_id bigint, reason text, at timestamptz DEFAULT now())`)
    await exec(`CREATE TABLE "${SCHEMA}".backfill_checkpoint (
      job text PRIMARY KEY, cursor_id bigint NOT NULL DEFAULT 0)`)
    await exec(`INSERT INTO "${SCHEMA}".backfill_checkpoint (job, cursor_id) VALUES ('status_v2', 0)`)

    await checkAddColumnLock()
    await checkSecurityDefinerTrigger()
    await checkExceptionSwallowing()
    await checkResumableBackfill()
    await checkReconciliation()
    await checkRollbackCleanup(baseline, baselineRows)
    await checkTimeoutBehavior()
  } catch (err) {
    record('fatal', 'FAIL', err instanceof Error ? err.message : String(err))
  } finally {
    await exec(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`).catch(() => {})
  }

  const mandatoryFailed = Object.entries(checks).filter(
    ([, c]) => c.status === 'FAIL' && !c.advisory,
  )
  if (mandatoryFailed.length > 0) exitCode = 1

  const result = {
    result: exitCode === 0 ? 'PASS' : 'FAIL',
    schema: SCHEMA,
    at: new Date().toISOString(),
    tests: Object.fromEntries(Object.entries(checks).map(([k, v]) => [k, v.status])),
    detail: Object.fromEntries(Object.entries(checks).map(([k, v]) => [k, v.detail])),
  }

  console.log(RESULT_BEGIN)
  console.log(JSON.stringify(result, null, 2))
  console.log(RESULT_END)

  await prisma.$disconnect().catch(() => {})
  process.exit(exitCode)
}

main().catch(err => {
  console.error('[rehearsal] unhandled:', err)
  process.exit(1)
})
