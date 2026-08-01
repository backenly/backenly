/**
 * A PROBE THAT COULD NOT RUN MUST NOT REPORT "NOTHING FOUND"
 * =========================================================
 *
 * This codebase has shipped the same outage three times, and it is worth being
 * precise about the shape because it is not a SQL bug — it is an observability
 * bug wearing a SQL bug's clothes:
 *
 *   1. a query's parameter count disagrees with the arguments passed
 *   2. Postgres rejects the bind, correctly and immediately
 *   3. the caller is a PROBE, and probes wrap queries in a fail-soft catch
 *   4. the rejection becomes `[]`
 *   5. `[]` means "I looked and found nothing", which is indistinguishable
 *      from "I could not look"
 *   6. the detector reports healthy, forever, without ever having run
 *
 * Confirmed instances:
 *
 *   detectMissingRls      — `schemaName` passed twice to a one-placeholder
 *                           query. The flagship security probe was dead in every
 *                           environment for months, dashboard green throughout.
 *   getEndUserAuthUsage   — a parameter passed to a statement with none, so
 *                           `hasIdentities` was false on every project that has
 *                           ever existed and the auth evidence gate ran on half
 *                           its evidence.
 *   detectApiCoverageGaps — a different mechanism (a retired detector returning
 *                           `[]` by design) but the same end state: an invariant
 *                           reporting satisfied because nothing was asking.
 *
 * Step 1 is the only link that can be broken cheaply and completely, so that is
 * where the guard goes — `assertParamArity` in lib/services/workspace-pool.ts,
 * on the single chokepoint every workspace query passes through. These tests pin
 * the counting rule itself, which is the part that has to be right for the guard
 * to mean anything.
 *
 * Deliberately database-free so it runs in the `typecheck + unit tests` job on
 * every push, not only in the Postgres-backed one.
 */

import { describe, it, expect } from '@jest/globals'
import { requiredParamCount } from '@/lib/services/workspace-pool'

describe('requiredParamCount — how many parameters will Postgres demand', () => {
  it('counts none for a statement with no placeholders', () => {
    // The getEndUserAuthUsage case: schema interpolated into the identifier
    // (Postgres does not accept a placeholder for a table name), so the
    // statement takes nothing. It was passed one argument anyway.
    expect(requiredParamCount(`SELECT 1 FROM "workspace_abc"."users" LIMIT 1`)).toBe(0)
  })

  it('counts the highest placeholder, not the number of occurrences', () => {
    // The detectMissingRls case in reverse: `$1` used twice is still ONE
    // parameter. Counting occurrences would demand two and reject a correct call.
    expect(
      requiredParamCount(`SELECT * FROM t WHERE schemaname = $1 AND tablename <> $1`),
    ).toBe(1)
    expect(requiredParamCount(`SELECT $1, $2, $3`)).toBe(3)
  })

  it('ignores placeholders inside string literals', () => {
    // A probe searching for the literal text '$1' takes no parameter, and
    // Postgres agrees. Miscounting here would reject a working query — the
    // failure mode that gets a guard deleted.
    expect(requiredParamCount(`SELECT * FROM t WHERE body = '$1'`)).toBe(0)
    expect(requiredParamCount(`SELECT * FROM t WHERE body = '$1' AND id = $1`)).toBe(1)
  })

  it('ignores placeholders inside comments', () => {
    expect(requiredParamCount(`SELECT 1 -- was $1 before the rewrite`)).toBe(0)
    expect(requiredParamCount(`SELECT 1 /* $1 $2 */ FROM t`)).toBe(0)
    expect(requiredParamCount(`SELECT * FROM t WHERE a = $1 -- and not $9`)).toBe(1)
  })

  it('ignores dollar-quoted function bodies', () => {
    // Registration and policy SQL is full of $fn$ ... $fn$ blocks. Reading the
    // tag as a placeholder would make every one of them un-runnable.
    expect(
      requiredParamCount(`CREATE FUNCTION f() RETURNS text AS $fn$ SELECT 'x' $fn$ LANGUAGE sql`),
    ).toBe(0)
    expect(
      requiredParamCount(`DO $$ BEGIN PERFORM 1; END $$; SELECT * FROM t WHERE a = $1`),
    ).toBe(1)
  })

  it('handles the real detectMissingRls statement shape', () => {
    // Abridged from lib/services/workspace-observer.ts. One placeholder, used
    // in several clauses — exactly the statement that was passed two arguments.
    const sql = `
      SELECT t.tablename
      FROM pg_tables t
      JOIN pg_class pc ON pc.relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = $1)
      WHERE t.schemaname = $1
        AND NOT pc.relrowsecurity
        AND t.tablename <> 'users'
    `
    expect(requiredParamCount(sql)).toBe(1)
  })

  it('does not miscount an escaped quote inside a literal', () => {
    // '' is an escaped single quote in SQL, not the end of the string. Getting
    // this wrong would resume placeholder counting mid-literal.
    expect(requiredParamCount(`SELECT * FROM t WHERE a = 'it''s $1' AND b = $1`)).toBe(1)
  })
})

describe('the two historical outages, as arity arithmetic', () => {
  // Both reduce to one subtraction. Neither was caught for months, because the
  // only signal either produced was a detector saying nothing.

  it('detectMissingRls — one placeholder, two arguments supplied', () => {
    const sql = `SELECT t.tablename FROM pg_tables t WHERE t.schemaname = $1`
    const suppliedArgs = ['workspace_abc', 'workspace_abc'] // schemaName passed twice
    expect(requiredParamCount(sql)).toBe(1)
    expect(suppliedArgs.length).not.toBe(requiredParamCount(sql))
  })

  it('getEndUserAuthUsage — no placeholders, one argument supplied', () => {
    // The schema cannot be a placeholder (Postgres takes no parameter for an
    // identifier), so it is interpolated — and the parameter was passed anyway.
    const sql = `SELECT 1 FROM "workspace_abc"."users" LIMIT 1`
    const suppliedArgs = ['workspace_abc']
    expect(requiredParamCount(sql)).toBe(0)
    expect(suppliedArgs.length).not.toBe(requiredParamCount(sql))
  })

  it('the corrected forms both balance', () => {
    expect(requiredParamCount(`SELECT t.tablename FROM pg_tables t WHERE t.schemaname = $1`)).toBe(
      ['workspace_abc'].length,
    )
    expect(requiredParamCount(`SELECT 1 FROM "workspace_abc"."users" LIMIT 1`)).toBe(
      ([] as unknown[]).length,
    )
  })
})
