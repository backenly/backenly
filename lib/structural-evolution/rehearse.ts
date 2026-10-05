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
 * The scratch schema, the copied rows, every trigger and every write exist only
 * inside one transaction, which ends in ROLLBACK whatever happened. Nothing is
 * ever committed, so nothing is ever visible to another session, and a crash
 * mid-rehearsal leaves exactly what a clean finish does: nothing. There is no
 * cleanup step to forget.
 *
 * The live table is only READ: the sample is copied out of it, and a share lock
 * is never taken on it. The one thing the rehearsal touches outside its own
 * schema is the sampled rows' visibility, read as the platform.
 *
 * ── What it cannot rehearse, said out loud ──────────────────────────────────
 *
 * Access. Policies and grants name roles and claims that a scratch schema
 * cannot reproduce faithfully, so the rungs that open access are validated
 * against the live catalog when they run, by their own postconditions. Foreign
 * keys to OTHER tables are not carried into the copy either: they would reach
 * live tables from inside the rehearsal. Both appear in `notRehearsed` rather
 * than being quietly skipped.
 */

import { prisma } from '@/lib/db'
import type { TableFacts } from './facts'
import { reconcileWith } from './reconcile'
import {
  backfillBatchSql,
  carriedObjects,
  createSatelliteSql,
  forwardSyncSql,
  fq,
  ladderNames,
  openWritesSql,
  qi,
  type ExtractionSpec,
  type RenderTarget,
} from './sql'
import { BACKFILL_BATCH_ROWS } from './plan'

/** Rows copied of each kind: carrying the concern, and not. */
export const REHEARSAL_ROWS_PER_KIND = 200

export type ExerciseOutcome = 'passed' | 'failed' | 'not_exercised'

export interface RehearsalExercise {
  name: string
  outcome: ExerciseOutcome
  detail: string
}

export interface RehearsalReport {
  passed: boolean
  sampledRows: number
  presentRows: number
  exercises: RehearsalExercise[]
  notRehearsed: string[]
  /** Set when the rehearsal could not run at all, as opposed to failing an exercise. */
  error: string | null
  durationMs: number
}

class RolledBack extends Error {
  constructor() {
    super('bkn_rehearsal_rollback')
  }
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

export async function rehearseExtraction(facts: TableFacts, spec: ExtractionSpec, planId: string): Promise<RehearsalReport> {
  const started = Date.now()
  const names = ladderNames(spec)
  const scratch: RenderTarget = { schema: `bkn_rehearsal_${names.hash}` }
  const live = facts.schema
  const pk = qi(facts.primaryKey[0])
  const m = spec.members.map(qi)
  const anySet = `(${m.map(c => `${c} IS NOT NULL`).join(' OR ')})`
  const insertable = facts.columns.filter(c => !c.generated).map(c => qi(c.name)).join(', ')
  const overriding = facts.columns.some(c => c.identity) ? ' OVERRIDING SYSTEM VALUE' : ''
  const host = fq(scratch.schema, spec.host)
  const sat = fq(scratch.schema, spec.satellite)
  const fk = qi(names.fkColumn)
  const carried = carriedObjects(facts, spec, names, scratch, { includeForeignKeys: false })

  const report: RehearsalReport = {
    passed: false,
    sampledRows: 0,
    presentRows: 0,
    exercises: [],
    notRehearsed: [
      'row-level policies and grants on the new table — checked against the live catalog after each rung runs',
      ...carried.notCarried,
    ],
    error: null,
    durationMs: 0,
  }

  const { rlsSessionSql, rlsSessionParams } = await import('@/lib/services/rls-session')

  try {
    await prisma.$transaction(
      async tx => {
        const exec = (sql: string, ...p: unknown[]) => tx.$executeRawUnsafe(sql, ...p)
        const rows = <T = Record<string, unknown>>(sql: string, ...p: unknown[]) => tx.$queryRawUnsafe<T[]>(sql, ...p)

        await exec(`SET LOCAL statement_timeout = '20s'`)
        await exec(`SET LOCAL lock_timeout = '2s'`)
        await exec(rlsSessionSql(1), ...rlsSessionParams({ userId: '', isServiceRole: true, userRole: 'service' }))

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

        // ── Writes through the satellite, as new clients will make them ─────
        if (!failed) {
          for (const s of openWritesSql(facts, spec, scratch, [])) await exec(s)
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
          !failed && report.exercises.some(e => e.outcome === 'passed') && report.exercises.every(e => e.outcome !== 'failed')
        throw new RolledBack()
      },
      { timeout: 60_000, maxWait: 10_000 },
    )
  } catch (err) {
    if (!(err instanceof RolledBack) && message(err) !== 'bkn_rehearsal_rollback') {
      report.passed = false
      report.error = message(err)
    }
  }

  report.durationMs = Date.now() - started
  return report
}
