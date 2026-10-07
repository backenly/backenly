/**
 * REHEARSAL — run the ladder for real, on a copy, and throw the result away
 * =========================================================================
 *
 * Every other check in this engine reasons about SQL. This one runs it. The
 * generated CREATE TABLE, both sync triggers and the backfill template are
 * executed against a copy of real rows from the table they will later touch,
 * and then exercised the way the customer's application will exercise them:
 * a row carrying the concern is inserted, its values changed, cleared and set
 * again on a row that had none; the satellite is written directly, deleted
 * from and inserted into; the parent is deleted. After every exercise the two
 * representations are reconciled, and one disagreement fails the rehearsal.
 *
 * ── It is a transaction that is always rolled back ──────────────────────────
 *
 * The scratch schema, the copied rows, every trigger, policy, grant and write
 * exist only inside one transaction, which ends in ROLLBACK whatever happened.
 * Nothing is ever committed, so nothing is ever visible to another session,
 * and a crash mid-rehearsal leaves exactly what a clean finish does: nothing.
 * There is no cleanup step to forget.
 *
 * The live table is only READ: the sample is copied out of it, its policies
 * are read from the catalog, and a share lock is never taken on it. The one
 * thing the rehearsal touches outside its own schema is the sampled rows'
 * visibility, read as the platform.
 *
 * ── Access is rehearsed too, not only data ─────────────────────────────────
 *
 * Reconciliation proves the two representations hold the same values. It says
 * nothing about WHO can see or change them, and that is the half of the
 * promise a person cannot check by looking: "a row of the new table is
 * visible exactly when its parent is, and writable exactly when its parent
 * is". So the copy is given the live host's access, and the access rungs are
 * run on it exactly as they will run in production:
 *
 *   1. The scratch host gets the live host's row-level security (enabled and
 *      forced as there), every one of its policies, its table and column
 *      grants, and USAGE on the scratch schema for the same roles. Policy
 *      expressions are read from the catalog with the search path pinned to
 *      pg_catalog, so every name in them is printed schema-qualified; the one
 *      name redirected is the live host's own, to the copy. Everything else a
 *      policy calls — the workspace's claim reader, another table it looks up —
 *      stays pointed at the live object, which is read, never written.
 *   2. `exposeReadsSql` and `openWritesSql` run with the readers and writers
 *      the plan computes, so the policies and grants under test are the ones
 *      consent will bind to.
 *   3. Then, for every role that can read the host (PUBLIC excepted, and only
 *      roles the platform can actually SET ROLE to), and for a few claim
 *      contexts — anonymous, up to three signed-in subjects drawn from the
 *      sampled rows' values of the columns the host's policies read, and a
 *      caller presenting the service-role claim — a differential check runs
 *      inside a savepoint that is rolled back:
 *
 *        read           the host rows carrying the concern that this identity
 *                       sees are exactly the satellite rows it sees, with the
 *                       same values
 *        hidden parent  no satellite row whose parent is hidden from it is
 *                       visible to it
 *        writes         UPDATE, INSERT (on a visible parent without the
 *                       concern) and DELETE through the satellite are allowed
 *                       iff the same change made to the parent directly is
 *                       allowed — probed first, in its own rolled-back
 *                       savepoint; an allowed write must land in the host, and
 *                       a refused one must change nothing
 *
 * The service-role claim is not a privilege: any role that can run SQL can
 * set it. It is in the set because the satellite's own policies honour it, so
 * a host whose policies do not would otherwise hand that caller more through
 * the new table than through the old columns.
 *
 * When there is nothing to compare — no row-level security and no role other
 * than the owner holding a privilege — or no identity can be assumed (the
 * platform's database role is not allowed to SET ROLE to any reader), the
 * result says `unavailable` with the reason, and access stays listed under
 * `notRehearsed`. It is never reported as passed.
 *
 * ── What it cannot rehearse, said out loud ──────────────────────────────────
 *
 * Foreign keys to OTHER tables are not carried into the copy: they would reach
 * live tables from inside the rehearsal. Identities are sampled, not
 * enumerated: a policy keyed on a value no sampled row carries is exercised
 * only through the identities that were drawn. Both appear in `notRehearsed`
 * or in the authorization detail rather than being quietly skipped.
 */

import { createHash } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db'
import type { RlsIdentity } from '@/lib/services/rls-session'
import { granteesWith, type TableFacts } from './facts'
import { reconcileWith } from './reconcile'
import {
  backfillBatchSql,
  carriedObjects,
  createSatelliteSql,
  exposeReadsSql,
  forwardSyncSql,
  fq,
  ladderAccessSql,
  ladderNames,
  lit,
  openWritesSql,
  policiesWiderThanParent,
  qi,
  type ExtractionSpec,
  type RenderTarget,
} from './sql'
import { BACKFILL_BATCH_ROWS } from './plan'

/** Rows copied of each kind: carrying the concern, and not. */
export const REHEARSAL_ROWS_PER_KIND = 200

/** At most this many roles are rehearsed as; the rest are named as not rehearsed. */
export const REHEARSAL_MAX_ROLES = 4

/** Signed-in subjects drawn from the sampled rows. */
export const REHEARSAL_MAX_SUBJECTS = 3

/** Rows tried per write check while looking for one the parent allows and one it refuses. */
const WRITE_CANDIDATES = 6

export type ExerciseOutcome = 'passed' | 'failed' | 'not_exercised'

export interface RehearsalExercise {
  name: string
  outcome: ExerciseOutcome
  detail: string
}

export interface AuthorizationCheck {
  /** Role and claim context, e.g. `web_user as anonymous`. Never a raw claim value. */
  identity: string
  check: string
  outcome: ExerciseOutcome
  detail: string
}

export interface AuthorizationRehearsal {
  status: 'passed' | 'failed' | 'unavailable'
  detail: string
  /** Role × claim combinations actually exercised. */
  identities: number
  checks: AuthorizationCheck[]
}

export interface RehearsalReport {
  passed: boolean
  sampledRows: number
  presentRows: number
  exercises: RehearsalExercise[]
  /** Who may read and write the new table, compared with its parent identity by identity. */
  authorization: AuthorizationRehearsal
  notRehearsed: string[]
  /** Set when the rehearsal could not run at all, as opposed to failing an exercise. */
  error: string | null
  durationMs: number
}

/**
 * TEST SEAM. Never passed by production code.
 *
 * `extraSatelliteSqlForTest` runs extra statements against the scratch schema
 * right after the access rungs and before the authorization checks, so a test
 * can plant a flaw (a permissive policy, a dropped trigger) and prove the
 * rehearsal catches it. The statements run inside the same transaction that is
 * always rolled back.
 */
export interface RehearsalOptions {
  extraSatelliteSqlForTest?: (scratch: RenderTarget) => string[]
}

class RolledBack extends Error {
  constructor() {
    super('bkn_rehearsal_rollback')
  }
}

type Tx = Prisma.TransactionClient

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

/** The database's own words from a driver error, on one line. */
const brief = (err: string) => {
  const m = /Message: `(?:ERROR: )?([^`]*)`/.exec(err)
  return (m ? m[1] : err).replace(/\s+/g, ' ').trim().slice(0, 200)
}

const SERVICE: RlsIdentity = { userId: '', isServiceRole: true, userRole: 'service' }

export async function rehearseExtraction(
  facts: TableFacts,
  spec: ExtractionSpec,
  planId: string,
  options: RehearsalOptions = {},
): Promise<RehearsalReport> {
  const started = Date.now()
  const names = ladderNames(spec)
  const live = facts.schema
  // Named for the project's schema too: the same table pair in two projects,
  // or two passes over one, must not wait on each other's uncommitted schema.
  const scratch: RenderTarget = {
    schema: `bkn_rehearsal_${createHash('sha256').update(`${live}|${names.hash}`).digest('hex').slice(0, 16)}`,
  }
  const pk = qi(facts.primaryKey[0])
  const m = spec.members.map(qi)
  const anySet = `(${m.map(c => `${c} IS NOT NULL`).join(' OR ')})`
  const insertable = facts.columns.filter(c => !c.generated).map(c => qi(c.name)).join(', ')
  const overriding = facts.columns.some(c => c.identity) ? ' OVERRIDING SYSTEM VALUE' : ''
  const host = fq(scratch.schema, spec.host)
  const sat = fq(scratch.schema, spec.satellite)
  const fk = qi(names.fkColumn)
  const carried = carriedObjects(facts, spec, names, scratch, { includeForeignKeys: false })
  // Exactly as plan.ts computes them, so the rungs rehearsed are the rungs approved.
  const readers = granteesWith(facts, 'SELECT')
  const writers = granteesWith(facts, 'UPDATE').filter(r => readers.includes(r))

  const report: RehearsalReport = {
    passed: false,
    sampledRows: 0,
    presentRows: 0,
    exercises: [],
    authorization: { status: 'unavailable', detail: 'not reached', identities: 0, checks: [] },
    notRehearsed: [],
    error: null,
    durationMs: 0,
  }
  const accessNotes: string[] = []

  const { rlsSessionSql, rlsSessionParams } = await import('@/lib/services/rls-session')

  try {
    await prisma.$transaction(
      async tx => {
        const exec = (sql: string, ...p: unknown[]) => tx.$executeRawUnsafe(sql, ...p)
        const rows = <T = Record<string, unknown>>(sql: string, ...p: unknown[]) => tx.$queryRawUnsafe<T[]>(sql, ...p)

        await exec(`SET LOCAL statement_timeout = '20s'`)
        await exec(`SET LOCAL lock_timeout = '2s'`)
        await exec(rlsSessionSql(1), ...rlsSessionParams(SERVICE))
        // The platform's own exercises run in the ladder's context, as
        // production's backfill and reconciliation do; every identity below
        // runs outside it, as a client would.
        await exec(ladderAccessSql(spec))
        const platformRole = (await rows<{ u: string }>(`SELECT current_user::text AS u`))[0].u

        // ── The copy ────────────────────────────────────────────────────────
        await exec(`CREATE SCHEMA ${qi(scratch.schema)}`)
        await exec(
          `CREATE TABLE ${host} (LIKE ${fq(live, spec.host)} INCLUDING DEFAULTS INCLUDING CONSTRAINTS ` +
            `INCLUDING INDEXES INCLUDING GENERATED INCLUDING IDENTITY)`,
        )
        const copied = await exec(
          `INSERT INTO ${host} (${insertable})${overriding}
           (SELECT ${insertable} FROM ${fq(live, spec.host)} WHERE ${anySet} ORDER BY ${pk} LIMIT ${REHEARSAL_ROWS_PER_KIND})
           UNION ALL
           (SELECT ${insertable} FROM ${fq(live, spec.host)} WHERE NOT ${anySet} ORDER BY ${pk} LIMIT ${REHEARSAL_ROWS_PER_KIND})`,
        )
        report.sampledRows = Number(copied)
        const present = await rows<{ n: bigint }>(`SELECT count(*)::bigint AS n FROM ${host} WHERE ${anySet}`)
        report.presentRows = Number(present[0]?.n ?? 0)

        // ── The live host's access, given to the copy ───────────────────────
        // After the rows are in, so the copy itself is not filtered twice.
        const access = await reproduceHostAccess(tx, facts, spec, scratch)

        // ── The ladder, exactly as rendered for production ──────────────────
        for (const s of createSatelliteSql(facts, spec, scratch, carried, planId)) await exec(s)
        for (const s of forwardSyncSql(facts, spec, scratch)) await exec(s)

        let failed = false
        const check = async (name: string, detail: string) => {
          const r = await reconcileWith(tx, facts, spec, scratch)
          report.exercises.push({ name, outcome: r.consistent ? 'passed' : 'failed', detail: r.consistent ? detail : r.summary })
          if (!r.consistent) failed = true
        }
        // After a failure the reason a later exercise did not run is the
        // failure, not whatever precondition it would otherwise have named.
        const skip = (name: string, why: string) =>
          report.exercises.push({ name, outcome: 'not_exercised', detail: failed ? 'not run: an earlier exercise failed' : why })
        const keys = async (where: string, limit: number) =>
          (await rows<{ k: string }>(`SELECT ${pk}::text AS k FROM ${host} WHERE ${where} ORDER BY ${pk} LIMIT ${limit}`)).map(r => r.k)

        // Backfill with the production template, batch by batch.
        let cursor: string | null = null
        let batches = 0
        for (;;) {
          const out: Array<{ scanned: bigint; next_cursor: string | null }> = await rows(
            backfillBatchSql(facts, spec, scratch, BACKFILL_BATCH_ROWS),
            cursor,
          )
          batches++
          cursor = out[0]?.next_cursor ?? cursor
          if (Number(out[0]?.scanned ?? 0) < BACKFILL_BATCH_ROWS || batches > 50) break
        }
        await check('backfill', `${report.presentRows} row(s) carrying the concern copied in ${batches} batch(es)`)

        const presentKeys = await keys(anySet, 2)
        const absentKeys = await keys(`NOT ${anySet}`, 1)
        const [p1, p2] = presentKeys
        const a1 = absentKeys[0]
        const copyFrom = (target: string, source: string) =>
          exec(
            `UPDATE ${host} SET (${m.join(', ')}) = (SELECT ${m.join(', ')} FROM ${host} WHERE ${pk}::text = $2) WHERE ${pk}::text = $1`,
            target,
            source,
          )

        // ── Writes to the host, as every existing client makes them ─────────
        if (!failed && p1) {
          await exec(`DELETE FROM ${host} WHERE ${pk}::text = $1`, p1)
          await exec(
            `INSERT INTO ${host} (${insertable})${overriding} SELECT ${insertable} FROM ${fq(live, spec.host)} WHERE ${pk}::text = $1`,
            p1,
          )
          await check('insert_with_concern', 'a row inserted with the concern set got its satellite row')
        } else skip('insert_with_concern', 'no sampled row carries the concern')

        if (!failed && p1 && p2) {
          await copyFrom(p1, p2)
          await check('update_concern', 'changing the concern on the host changed the satellite row')
        } else skip('update_concern', 'needs two sampled rows carrying the concern')

        if (!failed && p1) {
          await exec(`UPDATE ${host} SET ${m.map(c => `${c} = NULL`).join(', ')} WHERE ${pk}::text = $1`, p1)
          await check('clear_concern', 'clearing every column removed the satellite row')
        } else skip('clear_concern', 'no sampled row carries the concern')

        if (!failed && a1 && p2) {
          await copyFrom(a1, p2)
          await check('set_concern_on_bare_row', 'setting the concern on a row without one created its satellite row')
        } else skip('set_concern_on_bare_row', 'needs a row without the concern and one with it')

        // ── Access opened, as the expose_reads and open_writes rungs open it ─
        if (!failed) {
          for (const s of exposeReadsSql(facts, spec, scratch, readers)) await exec(s)
          for (const s of openWritesSql(facts, spec, scratch, writers)) await exec(s)
          for (const s of options.extraSatelliteSqlForTest?.(scratch) ?? []) await exec(s)

          report.authorization =
            access.problem === null
              ? await rehearseAccess({
                  tx,
                  facts,
                  spec,
                  scratch,
                  platformRole,
                  readers,
                  writers,
                  policyText: access.policyText,
                  session: { sql: rlsSessionSql, params: rlsSessionParams },
                  notes: accessNotes,
                })
              : {
                  status: 'unavailable',
                  detail: `the live access of ${spec.host} could not be reproduced on the copy: ${access.problem}`,
                  identities: 0,
                  checks: [],
                }
        } else {
          report.authorization = {
            status: 'unavailable',
            detail: 'not rehearsed: a data exercise failed before access was opened',
            identities: 0,
            checks: [],
          }
        }

        // ── Writes through the satellite, as new clients will make them ─────
        if (!failed) {
          const satKeys = (await rows<{ k: string }>(`SELECT ${fk}::text AS k FROM ${sat} ORDER BY ${fk} LIMIT 2`)).map(r => r.k)
          const [s1, s2] = satKeys

          if (s1 && s2) {
            await exec(
              `UPDATE ${sat} SET (${m.join(', ')}) = (SELECT ${m.join(', ')} FROM ${sat} WHERE ${fk}::text = $2) WHERE ${fk}::text = $1`,
              s1,
              s2,
            )
            await check('update_through_satellite', 'a write to the satellite reached the host')
          } else skip('update_through_satellite', 'needs two satellite rows')

          if (!failed && s1) {
            await exec(`DELETE FROM ${sat} WHERE ${fk}::text = $1`, s1)
            await check('delete_through_satellite', 'deleting the satellite row cleared the host columns')
            if (!failed && s2) {
              await exec(
                `INSERT INTO ${sat} (${fk}, ${m.join(', ')}) SELECT h.${pk}, ${m.map(c => `src.${c}`).join(', ')}
                   FROM ${host} h, ${sat} src WHERE h.${pk}::text = $1 AND src.${fk}::text = $2`,
                s1,
                s2,
              )
              await check('insert_through_satellite', 'inserting a satellite row set the host columns')
            }
          } else skip('delete_through_satellite', 'no satellite row to delete')

          const bare = await keys(`NOT ${anySet}`, 1)
          const target = (await rows<{ k: string }>(`SELECT ${fk}::text AS k FROM ${sat} ORDER BY ${fk} LIMIT 1`))[0]?.k
          if (!failed && bare[0] && target) {
            await exec('SAVEPOINT bkn_rehearse_fk')
            let refused = false
            let why = ''
            try {
              await exec(`UPDATE ${sat} SET ${fk} = h.${pk} FROM ${host} h WHERE h.${pk}::text = $1 AND ${sat}.${fk}::text = $2`, bare[0], target)
            } catch (err) {
              refused = true
              why = message(err)
            }
            await exec('ROLLBACK TO SAVEPOINT bkn_rehearse_fk')
            report.exercises.push({
              name: 'parent_key_is_immutable',
              outcome: refused && /cannot change/.test(why) ? 'passed' : 'failed',
              detail: refused ? 'moving a satellite row to another parent was refused' : 'moving a satellite row to another parent was ALLOWED',
            })
            if (!(refused && /cannot change/.test(why))) failed = true
          } else skip('parent_key_is_immutable', 'needs a satellite row and a bare parent')

          const victim = (await keys(anySet, 1))[0]
          if (!failed && victim) {
            await exec(`DELETE FROM ${host} WHERE ${pk}::text = $1`, victim)
            await check('delete_parent', 'deleting the parent removed its satellite row with both syncs live')
          } else skip('delete_parent', 'no row carries the concern any more')
        }

        report.passed =
          !failed &&
          report.exercises.some(e => e.outcome === 'passed') &&
          report.exercises.every(e => e.outcome !== 'failed') &&
          report.authorization.status !== 'failed'
        throw new RolledBack()
      },
      { timeout: 60_000, maxWait: 10_000 },
    )
  } catch (err) {
    if (!(err instanceof RolledBack) && message(err) !== 'bkn_rehearsal_rollback') {
      report.passed = false
      report.error = message(err)
      if (report.authorization.detail === 'not reached') {
        report.authorization.detail = `not rehearsed: the rehearsal could not run (${brief(report.error)})`
      }
    }
  }

  report.notRehearsed = [
    ...(report.authorization.status === 'unavailable'
      ? [
          `who may read and write ${spec.satellite}, compared with ${spec.host} role by role — ${report.authorization.detail}; ` +
            'the access rungs are checked against the live catalog after they run',
        ]
      : []),
    ...accessNotes,
    ...carried.notCarried,
  ]
  report.durationMs = Date.now() - started
  return report
}

// ── The live host's access, reproduced on the copy ───────────────────────────

const COMMAND: Record<string, string> = { r: 'SELECT', a: 'INSERT', w: 'UPDATE', d: 'DELETE', '*': 'ALL' }

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Point every mention of `from` (a qualified name as `quote_ident` prints it)
 * at `to`. Only whole names: `ws.orders` is not part of `ws.orders_archive`.
 * A string literal that happens to spell the name is rewritten too; policies
 * do not compare against their own table's name, so that is accepted.
 */
function redirect(expr: string, from: string, to: string): string {
  return expr.replace(new RegExp(`(?<![A-Za-z0-9_$."])${escapeRe(from)}(?![A-Za-z0-9_$"])`, 'g'), () => to)
}

async function reproduceHostAccess(
  tx: Tx,
  facts: TableFacts,
  spec: ExtractionSpec,
  scratch: RenderTarget,
): Promise<{ problem: string | null; policyText: string }> {
  const exec = (sql: string, ...p: unknown[]) => tx.$executeRawUnsafe(sql, ...p)
  const rows = <T>(sql: string, ...p: unknown[]) => tx.$queryRawUnsafe<T[]>(sql, ...p)
  const host = fq(scratch.schema, spec.host)
  const grantee = (g: string) => (g === 'PUBLIC' ? 'PUBLIC' : qi(g))
  let policyText = ''

  await exec('SAVEPOINT bkn_rehearse_access')
  try {
    if (facts.rowSecurity) await exec(`ALTER TABLE ${host} ENABLE ROW LEVEL SECURITY`)
    if (facts.forceRowSecurity) await exec(`ALTER TABLE ${host} FORCE ROW LEVEL SECURITY`)

    // Read with the search path pinned so pg_get_expr qualifies every name
    // outside pg_catalog — the facts were rendered under the connection's own
    // search path, where the live schema may print unqualified and could not
    // be told apart from the copy. Created under the same pin, so each name
    // resolves to exactly what was printed.
    const prevPath = (await rows<{ p: string }>(`SELECT current_setting('search_path') AS p`))[0].p
    await exec(`SELECT set_config('search_path', 'pg_catalog, pg_temp', true)`)
    const policies = await rows<{
      name: string; cmd: string; permissive: boolean; roles: string[]; qual: string | null; chk: string | null
    }>(
      `SELECT p.polname::text AS name, p.polcmd::text AS cmd, p.polpermissive AS permissive,
              ARRAY(SELECT CASE WHEN r = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(r)::text) END
                      FROM unnest(p.polroles) r) AS roles,
              pg_get_expr(p.polqual, p.polrelid) AS qual,
              pg_get_expr(p.polwithcheck, p.polrelid) AS chk
         FROM pg_policy p
        WHERE p.polrelid = to_regclass(format('%I.%I', $1::text, $2::text))
        ORDER BY p.polname`,
      facts.schema,
      spec.host,
    )
    const liveName = (await rows<{ q: string }>(`SELECT quote_ident($1::text) || '.' || quote_ident($2::text) AS q`, facts.schema, spec.host))[0].q
    for (const p of policies) {
      const qual = p.qual === null ? null : redirect(p.qual, liveName, host)
      const chk = p.chk === null ? null : redirect(p.chk, liveName, host)
      await exec(
        `CREATE POLICY ${qi(p.name)} ON ${host} AS ${p.permissive ? 'PERMISSIVE' : 'RESTRICTIVE'} ` +
          `FOR ${COMMAND[p.cmd] ?? 'ALL'} TO ${p.roles.length > 0 ? p.roles.join(', ') : 'PUBLIC'}` +
          (qual === null ? '' : ` USING (${qual})`) +
          (chk === null ? '' : ` WITH CHECK (${chk})`),
      )
      policyText += ` ${p.qual ?? ''} ${p.chk ?? ''}`
    }
    await exec(`SELECT set_config('search_path', $1, true)`, prevPath)

    // Table grants, as the plan read them; column grants, which a table grant
    // does not describe, from the catalog.
    const byGrantee = new Map<string, Set<string>>()
    for (const g of facts.grants) {
      if (g.grantee === facts.owner) continue
      byGrantee.set(g.grantee, (byGrantee.get(g.grantee) ?? new Set<string>()).add(g.privilege))
    }
    for (const [who, privileges] of byGrantee) await exec(`GRANT ${[...privileges].join(', ')} ON ${host} TO ${grantee(who)}`)
    const everyone = new Set(byGrantee.keys())
    if (facts.columns.some(c => c.hasColumnAcl)) {
      const columnGrants = await rows<{ col: string; who: string; privilege: string }>(
        `SELECT a.attname::text AS col,
                CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee)::text END AS who,
                x.privilege_type::text AS privilege
           FROM pg_attribute a, aclexplode(a.attacl) x
          WHERE a.attrelid = to_regclass(format('%I.%I', $1::text, $2::text))
            AND a.attnum > 0 AND NOT a.attisdropped AND a.attacl IS NOT NULL`,
        facts.schema,
        spec.host,
      )
      for (const g of columnGrants) {
        if (g.who === facts.owner) continue
        await exec(`GRANT ${g.privilege} (${qi(g.col)}) ON ${host} TO ${grantee(g.who)}`)
        everyone.add(g.who)
      }
    }
    if (everyone.size > 0) {
      await exec(`GRANT USAGE ON SCHEMA ${qi(scratch.schema)} TO ${[...everyone].map(grantee).join(', ')}`)
    }
    await exec('RELEASE SAVEPOINT bkn_rehearse_access')
    return { problem: null, policyText }
  } catch (err) {
    // Rolling back to the savepoint also restores the search path.
    await exec('ROLLBACK TO SAVEPOINT bkn_rehearse_access')
    await exec('RELEASE SAVEPOINT bkn_rehearse_access')
    return { problem: brief(message(err)), policyText: '' }
  }
}

// ── Access, compared identity by identity ────────────────────────────────────

interface AccessScope {
  tx: Tx
  facts: TableFacts
  spec: ExtractionSpec
  scratch: RenderTarget
  /** The role the rehearsal runs as, to return to for inspection. */
  platformRole: string
  readers: string[]
  writers: string[]
  /** The reproduced policies' expressions, for drawing subjects. */
  policyText: string
  session: { sql: (from?: number) => string; params: (identity: RlsIdentity) => unknown[] }
  /** Lines for `notRehearsed` about identities that were not exercised. */
  notes: string[]
}

interface ClaimContext {
  label: string
  identity: RlsIdentity
}

interface Read<T> {
  rows: T[] | null
  error: string | null
}

interface Attempt {
  allowed: boolean
  /** Why it was refused: the database's error, or that no row was changed. */
  refusal: string
  /** True when refused by raising an error, so the statement was undone whole. */
  raised: boolean
  /** What inspection found wrong afterwards, or null. */
  problem: string | null
}

type WriteKind = 'update' | 'insert' | 'delete'

const TEXTUAL = new Set(['text', 'varchar', 'bpchar', 'citext', 'name'])
const INTEGRAL = new Set(['int2', 'int4', 'int8'])

async function rehearseAccess(scope: AccessScope): Promise<AuthorizationRehearsal> {
  const { tx, facts, spec, scratch, session } = scope
  const exec = (sql: string, ...p: unknown[]) => tx.$executeRawUnsafe(sql, ...p)
  const rows = <T>(sql: string, ...p: unknown[]) => tx.$queryRawUnsafe<T[]>(sql, ...p)
  const names = ladderNames(spec)
  const host = fq(scratch.schema, spec.host)
  const sat = fq(scratch.schema, spec.satellite)
  const pkName = facts.primaryKey[0]
  const pk = qi(pkName)
  const pkType = facts.columns.find(c => c.name === pkName)!.type
  const fk = qi(names.fkColumn)
  const m = spec.members.map(qi)
  const types = spec.members.map(n => facts.columns.find(c => c.name === n)!.type)
  const anySet = `(${m.map(c => `${c} IS NOT NULL`).join(' OR ')})`
  const key = (i: number) => `($${i}::text)::${pkType}`
  const value = (i: number) => `($${i}::text)::${types[i - 2]}`
  const unavailable = (detail: string): AuthorizationRehearsal => ({ status: 'unavailable', detail, identities: 0, checks: [] })

  const nonOwner = facts.grants.filter(g => g.grantee !== facts.owner)
  if (!facts.rowSecurity && nonOwner.length === 0) {
    return unavailable(`${spec.host} has no row-level security and no role other than its owner holds a privilege on it; there is no access to compare`)
  }
  // The runtime serves end users as the platform role itself, claims set. When
  // the host's row-level security binds its owner and the platform is that
  // owner, the platform is one of the identities that must get from the new
  // table exactly what it gets from the host, and it is rehearsed first.
  const servesAsOwner = facts.forceRowSecurity && facts.owner === scope.platformRole
  const allRoles = [...new Set([...(servesAsOwner ? [scope.platformRole] : []), ...scope.readers, ...scope.writers])].filter(
    r => r !== 'PUBLIC',
  )
  if (allRoles.length === 0) {
    return unavailable(
      scope.readers.includes('PUBLIC')
        ? `only PUBLIC may read ${spec.host}; there is no named role to rehearse as`
        : `no role other than its owner may read ${spec.host}; there is nobody to rehearse as`,
    )
  }

  // Who can actually be assumed. SET ROLE needs membership; a platform that
  // lacks it cannot rehearse as that role, and says so.
  const assumable: string[] = []
  const refusedRoles: string[] = []
  for (const role of allRoles) {
    if (assumable.length >= REHEARSAL_MAX_ROLES) break
    await exec('SAVEPOINT bkn_auth_role')
    try {
      await exec(`SET LOCAL ROLE ${qi(role)}`)
      assumable.push(role)
    } catch (err) {
      refusedRoles.push(`${role} (${brief(message(err))})`)
    }
    await exec('ROLLBACK TO SAVEPOINT bkn_auth_role')
    await exec('RELEASE SAVEPOINT bkn_auth_role')
  }
  const untried = allRoles.filter(r => !assumable.includes(r) && !refusedRoles.some(x => x.startsWith(`${r} (`)))
  if (refusedRoles.length > 0) {
    scope.notes.push(`access as ${refusedRoles.join(', ')} — the platform's database role cannot SET ROLE to it`)
  }
  if (untried.length > 0) {
    scope.notes.push(`access as ${untried.join(', ')} — only the first ${REHEARSAL_MAX_ROLES} roles are rehearsed as`)
  }
  if (assumable.length === 0) {
    return unavailable(`the platform's database role could not act as any role that reads ${spec.host}: ${refusedRoles.join('; ')}`)
  }

  // ── The platform's view, read once. Every probe below is rolled back, so
  // it is the view every identity starts from.
  const satAll = await rows<{ k: string; v: string; vals: Array<string | null> }>(
    `SELECT ${fk}::text AS k, ROW(${m.join(', ')})::text AS v, ARRAY[${m.map(c => `${c}::text`).join(', ')}]::text[] AS vals
       FROM ${sat} ORDER BY ${fk}`,
  )
  const satBefore = new Map(satAll.map(r => [r.k, r.v]))
  const hostBefore = new Map(
    (await rows<{ k: string; v: string }>(`SELECT ${pk}::text AS k, ROW(${m.join(', ')})::text AS v FROM ${host}`)).map(r => [r.k, r.v]),
  )
  const nullRow = (await rows<{ v: string }>(`SELECT ROW(${types.map(t => `NULL::${t}`).join(', ')})::text AS v`))[0].v

  // ── Claim contexts ───────────────────────────────────────────────────────
  const subjects = await drawSubjects(tx, facts, spec, host, scope.policyText)
  const contexts: ClaimContext[] = [
    { label: 'as anonymous', identity: {} },
    ...subjects.map((s, i) => ({ label: `as subject ${i + 1} (a ${s.column} value)`, identity: { userId: s.value } })),
    { label: 'claiming the service role', identity: SERVICE },
  ]

  // ── Probes ───────────────────────────────────────────────────────────────
  const read = async <T>(sql: string, ...p: unknown[]): Promise<Read<T>> => {
    await exec('SAVEPOINT bkn_auth_probe')
    try {
      const r = await rows<T>(sql, ...p)
      await exec('RELEASE SAVEPOINT bkn_auth_probe')
      return { rows: r, error: null }
    } catch (err) {
      await exec('ROLLBACK TO SAVEPOINT bkn_auth_probe')
      await exec('RELEASE SAVEPOINT bkn_auth_probe')
      return { rows: null, error: brief(message(err)) }
    }
  }

  /**
   * One write as the current identity, in a savepoint that is always rolled
   * back. When it did not raise, `inspect` runs before the rollback, as the
   * platform, to see what it actually did.
   */
  const attempt = async (
    sql: string,
    params: unknown[],
    inspect?: (allowed: boolean) => Promise<string | null>,
  ): Promise<Attempt> => {
    await exec('SAVEPOINT bkn_auth_probe')
    let count = 0
    let error: string | null = null
    let problem: string | null = null
    try {
      count = Number(await exec(sql, ...params))
    } catch (err) {
      error = brief(message(err))
    }
    if (error === null && inspect) {
      try {
        await exec(`SET LOCAL ROLE ${qi(scope.platformRole)}`)
        await exec(session.sql(1), ...session.params(SERVICE))
        await exec(ladderAccessSql(spec))
        problem = await inspect(count > 0)
      } catch (err) {
        problem = `could not be inspected: ${brief(message(err))}`
      }
    }
    // Also returns to the identity's role and claims.
    await exec('ROLLBACK TO SAVEPOINT bkn_auth_probe')
    await exec('RELEASE SAVEPOINT bkn_auth_probe')
    return {
      allowed: error === null && count > 0,
      refusal: error ?? 'no row was changed: the row rules filtered it out',
      raised: error !== null,
      problem,
    }
  }

  const stateOf = async (k: string) =>
    (
      await rows<{ h: string | null; s: string | null }>(
        `SELECT (SELECT ROW(${m.join(', ')})::text FROM ${host} WHERE ${pk} = ${key(1)}) AS h,
                (SELECT ROW(${m.join(', ')})::text FROM ${sat} WHERE ${fk} = ${key(1)}) AS s`,
        k,
      )
    )[0]

  /** Compare the platform's view of one key with what should be there. */
  const expect = async (k: string, want: { h: string | null; s: string | null }, what: string): Promise<string | null> => {
    const now = await stateOf(k)
    const wrong = [
      ...(now.h !== want.h ? [`${spec.host} row ${k} does not hold ${what}`] : []),
      ...(now.s !== want.s ? [`${spec.satellite} does not hold ${what} for ${k}`] : []),
    ]
    return wrong.length > 0 ? wrong.join('; ') : null
  }

  const writeSql: Record<WriteKind, string> = {
    update: `UPDATE ${sat} SET ${m.map((c, i) => `${c} = ${value(i + 2)}`).join(', ')} WHERE ${fk} = ${key(1)}`,
    insert: `INSERT INTO ${sat} (${fk}, ${m.join(', ')}) VALUES (${key(1)}, ${m.map((_, i) => value(i + 2)).join(', ')})`,
    delete: `DELETE FROM ${sat} WHERE ${fk} = ${key(1)}`,
  }
  // The same change made to the parent directly, as an old client makes it.
  const hostSql = `UPDATE ${host} SET ${m.map((c, i) => `${c} = ${value(i + 2)}`).join(', ')} WHERE ${pk} = ${key(1)}`

  /** Values a write to `k` sets: another row's, so it is a real change where one exists. */
  const donorFor = (kind: WriteKind, k: string): { vals: Array<string | null>; v: string } | null => {
    if (kind === 'delete') return { vals: spec.members.map(() => null), v: nullRow }
    const current = satBefore.get(k)
    const donor = satAll.find(r => r.k !== k && r.v !== current) ?? satAll.find(r => r.k === k) ?? satAll[0]
    return donor ? { vals: donor.vals, v: donor.v } : null
  }

  const verbs: Record<WriteKind, string> = { update: 'an UPDATE', insert: 'an INSERT', delete: 'a DELETE' }

  /**
   * One write check: find a candidate whose parent this identity may change
   * and one whose parent it may not, then make the same change through the
   * satellite and require the same answer.
   */
  const writeCheck = async (kind: WriteKind, candidates: string[], none: string): Promise<{ outcome: AuthorizationCheck['outcome']; detail: string }> => {
    if (candidates.length === 0) return { outcome: 'not_exercised', detail: none }
    let mayKey: string | null = null
    let mayNotKey: string | null = null
    let parentRefusal = ''
    for (const k of candidates.slice(0, WRITE_CANDIDATES)) {
      if (mayKey !== null && mayNotKey !== null) break
      const d = donorFor(kind, k)
      if (!d) continue
      const probe = await attempt(hostSql, [k, ...d.vals])
      if (probe.allowed) mayKey = mayKey ?? k
      else if (mayNotKey === null) {
        mayNotKey = k
        parentRefusal = probe.refusal
      }
    }
    if (mayKey === null && mayNotKey === null) return { outcome: 'not_exercised', detail: `no ${spec.label} values to write` }

    const verb = verbs[kind]
    const lines: string[] = []
    let ok = true
    for (const [k, parentMay] of [[mayKey, true], [mayNotKey, false]] as Array<[string | null, boolean]>) {
      if (k === null) continue
      const d = donorFor(kind, k)!
      const landed = { h: d.v, s: kind === 'delete' ? null : d.v }
      const unchanged = { h: hostBefore.get(k) ?? null, s: satBefore.get(k) ?? null }
      const r = await attempt(writeSql[kind], kind === 'delete' ? [k] : [k, ...d.vals], allowed =>
        allowed ? expect(k, landed, 'what was written') : expect(k, unchanged, 'what it held before'),
      )
      if (parentMay && r.allowed && r.problem === null) {
        lines.push(`may change ${spec.host} row ${k}: ${verb} through ${spec.satellite} was allowed, and the write reached ${spec.host}`)
      } else if (parentMay && r.allowed) {
        ok = false
        lines.push(`${verb} through ${spec.satellite} was allowed, but ${r.problem}`)
      } else if (parentMay) {
        ok = false
        lines.push(`may change ${spec.host} row ${k}, but ${verb} through ${spec.satellite} was REFUSED (narrower than the parent): ${r.refusal}`)
      } else if (r.allowed) {
        ok = false
        lines.push(
          `may NOT change ${spec.host} row ${k} (${parentRefusal}), but ${verb} through ${spec.satellite} was ALLOWED (wider than the parent)`,
        )
      } else if (r.problem !== null) {
        ok = false
        lines.push(`${verb} through ${spec.satellite} was refused, but it still changed something: ${r.problem}`)
      } else {
        lines.push(
          `may not change ${spec.host} row ${k}: ${verb} through ${spec.satellite} was refused too ` +
            `(${r.raised ? `${r.refusal}; undone whole` : r.refusal})`,
        )
      }
    }
    if (mayKey === null) lines.push(`none of the ${Math.min(candidates.length, WRITE_CANDIDATES)} row(s) tried could be changed through ${spec.host}`)
    if (mayNotKey === null) lines.push(`every row tried could be changed through ${spec.host}`)
    return { outcome: ok ? 'passed' : 'failed', detail: lines.join('; ') }
  }

  /** Every check for the identity currently in effect. */
  const checkIdentity = async (): Promise<Array<Omit<AuthorizationCheck, 'identity'>>> => {
    const out: Array<Omit<AuthorizationCheck, 'identity'>> = []
    const hostSeen = await read<{ k: string; v: string }>(
      `SELECT ${pk}::text AS k, ROW(${m.join(', ')})::text AS v FROM ${host} WHERE ${anySet}`,
    )
    const satSeen = await read<{ k: string; v: string }>(`SELECT ${fk}::text AS k, ROW(${m.join(', ')})::text AS v FROM ${sat}`)

    // Read: the same rows, the same values.
    if (hostSeen.rows === null && satSeen.rows === null) {
      out.push({ check: 'read', outcome: 'passed', detail: `can read neither ${spec.host} (${hostSeen.error}) nor ${spec.satellite}` })
    } else if (hostSeen.rows === null) {
      out.push({
        check: 'read',
        outcome: 'failed',
        detail: `cannot read ${spec.host} (${hostSeen.error}) but CAN read ${satSeen.rows!.length} row(s) of ${spec.satellite}`,
      })
    } else if (satSeen.rows === null) {
      out.push({
        check: 'read',
        outcome: 'failed',
        detail: `reads ${hostSeen.rows.length} ${spec.host} row(s) carrying ${spec.label} data but cannot read ${spec.satellite}: ${satSeen.error}`,
      })
    } else {
      const h = new Map(hostSeen.rows.map(r => [r.k, r.v]))
      const s = new Map(satSeen.rows.map(r => [r.k, r.v]))
      const extra = [...s.keys()].filter(k => !h.has(k))
      const missing = [...h.keys()].filter(k => !s.has(k))
      const differ = [...h.keys()].filter(k => s.has(k) && s.get(k) !== h.get(k))
      const sample = (ks: string[]) => ks.slice(0, 3).join(', ')
      out.push(
        extra.length + missing.length + differ.length === 0
          ? {
              check: 'read',
              outcome: 'passed',
              detail:
                `sees ${h.size} of the ${satAll.length} row(s) carrying ${spec.label} data, ` +
                `the same rows with the same values through ${spec.host} and through ${spec.satellite}`,
            }
          : {
              check: 'read',
              outcome: 'failed',
              detail: [
                ...(extra.length > 0 ? [`${spec.satellite} shows ${extra.length} row(s) this identity cannot see in ${spec.host} (${sample(extra)})`] : []),
                ...(missing.length > 0 ? [`${spec.satellite} hides ${missing.length} row(s) it can see in ${spec.host} (${sample(missing)})`] : []),
                ...(differ.length > 0 ? [`${differ.length} row(s) read differently through the two tables (${sample(differ)})`] : []),
              ].join('; '),
            },
      )
    }

    // Hidden parent: rows whose parent this identity cannot see stay hidden.
    const visibleParents = new Set((hostSeen.rows ?? []).map(r => r.k))
    const hidden = satAll.map(r => r.k).filter(k => !visibleParents.has(k))
    if (hidden.length === 0) {
      out.push({
        check: 'hidden_parent',
        outcome: 'not_exercised',
        detail: `every row of ${spec.satellite} belongs to a ${spec.host} row this identity can see`,
      })
    } else {
      const visible = new Set((satSeen.rows ?? []).map(r => r.k))
      const leaked = hidden.filter(k => visible.has(k))
      out.push(
        leaked.length === 0
          ? {
              check: 'hidden_parent',
              outcome: 'passed',
              detail: `${hidden.length} row(s) of ${spec.satellite} belong to ${spec.host} rows this identity cannot see, and none of them is visible to it`,
            }
          : {
              check: 'hidden_parent',
              outcome: 'failed',
              detail:
                `${leaked.length} of the ${hidden.length} row(s) of ${spec.satellite} whose ${spec.host} row is hidden from this identity ` +
                `ARE visible to it (${leaked.slice(0, 3).join(', ')})`,
            },
      )
    }

    // Writes through the satellite, against the same change to the parent.
    const visibleSat = (satSeen.rows ?? []).map(r => r.k).sort()
    const bare =
      (await read<{ k: string }>(`SELECT ${pk}::text AS k FROM ${host} WHERE NOT ${anySet} ORDER BY ${pk} LIMIT ${WRITE_CANDIDATES}`)).rows?.map(
        r => r.k,
      ) ?? []
    const noRow = `no row of ${spec.satellite} is visible to this identity`
    out.push({ check: 'update_through_satellite', ...(await writeCheck('update', visibleSat, noRow)) })
    out.push({
      check: 'insert_through_satellite',
      ...(await writeCheck('insert', bare, `no ${spec.host} row without ${spec.label} data is visible to this identity`)),
    })
    out.push({ check: 'delete_through_satellite', ...(await writeCheck('delete', visibleSat, noRow)) })
    return out
  }

  async function policiesFollowParent(): Promise<AuthorizationCheck> {
    const identity = 'every role'
    const check = 'policies_follow_parent'
    const policies = await rows<{ name: string; permissive: boolean; roles: string[]; using: string | null; withCheck: string | null }>(
      `SELECT p.polname::text AS name, p.polpermissive AS permissive,
              ARRAY(SELECT CASE WHEN r = 0 THEN 'public' ELSE pg_get_userbyid(r)::text END FROM unnest(p.polroles) r) AS roles,
              pg_get_expr(p.polqual, p.polrelid) AS using, pg_get_expr(p.polwithcheck, p.polrelid) AS "withCheck"
         FROM pg_policy p WHERE p.polrelid = $1::regclass ORDER BY p.polname`,
      sat,
    )
    const { reference, wider } = policiesWiderThanParent(policies, names)
    if (reference === null) {
      return { identity, check, outcome: 'failed', detail: `${spec.satellite} has no read policy that follows ${spec.host}` }
    }
    return wider.length === 0
      ? { identity, check, outcome: 'passed', detail: `every policy on ${spec.satellite} admits a row only while its ${spec.host} row is visible` }
      : {
          identity,
          check,
          outcome: 'failed',
          detail: `${wider.join(', ')} admit${wider.length === 1 ? 's' : ''} rows of ${spec.satellite} by another test than whether their ${spec.host} row is visible`,
        }
  }

  // ── Every identity, each in a savepoint that is rolled back ─────────────
  const result: AuthorizationRehearsal = { status: 'unavailable', detail: '', identities: 0, checks: [] }
  for (const role of assumable) {
    for (const ctx of contexts) {
      const identity = `${role} ${ctx.label}`
      result.identities++
      await exec('SAVEPOINT bkn_auth_identity')
      try {
        await exec(`SET LOCAL ROLE ${qi(role)}`)
        await exec(session.sql(1), ...session.params(ctx.identity))
        // A client, not the ladder: whatever the platform's own work set.
        await exec(`SELECT set_config(${lit(names.access)}, '', true)`)
        for (const c of await checkIdentity()) result.checks.push({ identity, ...c })
      } catch (err) {
        // Fail closed: a check that could not finish proves nothing.
        result.checks.push({ identity, check: 'identity', outcome: 'failed', detail: `the checks could not complete: ${brief(message(err))}` })
      } finally {
        await exec('ROLLBACK TO SAVEPOINT bkn_auth_identity')
        await exec('RELEASE SAVEPOINT bkn_auth_identity')
      }
    }
  }

  // ── The catalog, for what no probe can see ───────────────────────────────
  // A write probe names its row, and naming a column makes PostgreSQL apply
  // the SELECT policies to an UPDATE or DELETE as well. So a write policy that
  // is wider only on rows the caller cannot see never shows in a probe, yet an
  // unqualified `DELETE FROM <satellite>` reads no column and would use it.
  // The catalog shows it: every permissive policy on the satellite, but the
  // owner's own, must admit a row by exactly the test its read policy uses,
  // so no role can write a row it could not read.
  const catalog = await policiesFollowParent()
  result.checks.push(catalog)

  const failedChecks = result.checks.filter(c => c.outcome === 'failed')
  // The catalog check can fail a rehearsal, never pass one on its own: a pass
  // needs an identity that was actually exercised.
  const exercised = result.checks.filter(c => c !== catalog)
  const passedChecks = exercised.filter(c => c.outcome === 'passed')
  const skipped = refusedRoles.length + untried.length > 0 ? ` Not rehearsed as: ${[...refusedRoles, ...untried].join(', ')}.` : ''
  const who =
    `${result.identities} identit${result.identities === 1 ? 'y' : 'ies'} (${assumable.join(', ')}; anonymous, ` +
    `${subjects.length} signed-in subject(s)${subjects.length > 0 ? ` drawn from ${[...new Set(subjects.map(s => s.column))].join(', ')}` : ''}` +
    ', and the service-role claim)'
  if (failedChecks.length > 0) {
    const first = failedChecks[0]
    result.status = 'failed'
    result.detail =
      `${failedChecks.length} of ${result.checks.length} access check(s) disagree between ${spec.host} and ${spec.satellite} ` +
      `across ${who}. First: ${first.identity}, ${first.check}: ${first.detail}.${skipped}`
  } else if (passedChecks.length > 0) {
    result.status = 'passed'
    result.detail =
      `${spec.satellite} gave the same answer as ${spec.host} in all ${passedChecks.length} check(s) across ${who}; ` +
      `${exercised.length - passedChecks.length} not applicable; and every policy on it follows ${spec.host}.${skipped}`
  } else {
    result.detail = `no access check could be exercised across ${who}.${skipped}`
  }
  return result
}

/**
 * Up to three values to sign in as, from the sampled rows' values of the host
 * columns its policies read — the columns a policy compares a claim against.
 * Identifier-like columns first. The values never leave this function except
 * as claims; the report names only the column.
 */
async function drawSubjects(
  tx: Tx,
  facts: TableFacts,
  spec: ExtractionSpec,
  host: string,
  policyText: string,
): Promise<Array<{ column: string; value: string }>> {
  const referenced = new Set(facts.policies.flatMap(p => p.references))
  for (const c of facts.columns) {
    if (new RegExp(`(?<![A-Za-z0-9_$])"?${escapeRe(c.name)}"?(?![A-Za-z0-9_$])`).test(policyText)) referenced.add(c.name)
  }
  const rank = (udt: string) => (udt === 'uuid' ? 0 : TEXTUAL.has(udt) ? 1 : INTEGRAL.has(udt) ? 2 : -1)
  const columns = facts.columns
    .filter(c => referenced.has(c.name) && !spec.members.includes(c.name) && rank(c.udt) >= 0)
    .sort((a, b) => rank(a.udt) - rank(b.udt) || a.attnum - b.attnum)
  const out: Array<{ column: string; value: string }> = []
  for (const c of columns) {
    if (out.length >= REHEARSAL_MAX_SUBJECTS) break
    const values = await tx.$queryRawUnsafe<Array<{ v: string }>>(
      `SELECT ${qi(c.name)}::text AS v FROM ${host} WHERE ${qi(c.name)} IS NOT NULL
        GROUP BY 1 ORDER BY count(*) DESC, 1 LIMIT ${REHEARSAL_MAX_SUBJECTS}`,
    )
    for (const { v } of values) {
      if (out.length < REHEARSAL_MAX_SUBJECTS && !out.some(o => o.value === v)) out.push({ column: c.name, value: v })
    }
  }
  return out
}
