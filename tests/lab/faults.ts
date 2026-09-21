/**
 * THE FAULT BANK — what goes wrong, and what should happen about it
 * =================================================================
 *
 * `scenarios.ts` describes healthy backends. This file breaks them, on purpose,
 * in the ways real backends break, so Phase 0 can measure what the CURRENT
 * autonomy system does about each one.
 *
 * ── Expectations are DECLARED, never derived ────────────────────────────────
 *
 * Each fault states what the system should conclude, written by a person, next
 * to the fault. It is never computed from what the system produced. This is the
 * same reasoning `scenarios.ts` gives for stating `expectedSkeletonComponents`
 * per scenario: a lab that accepts whatever the system returns is
 * indistinguishable from one that works, and it would ratify a regression as
 * confidently as a fix.
 *
 * When the baseline reports a mismatch, exactly one of two things is true: the
 * system is wrong, or this declared expectation is wrong. Both are worth
 * knowing and neither can hide.
 *
 * ── precondition, then apply ────────────────────────────────────────────────
 *
 * The scenario bank is shared with other suites and must not be edited to suit
 * this one. Where a scenario does not already hold the healthy state a fault
 * needs, the fault establishes it in `precondition` and breaks it in `apply`.
 *
 * That split is also what makes a fault provably non-vacuous: the harness
 * fingerprints the schema after `precondition` and again after `apply`, and a
 * fault whose two fingerprints match is a fault that did nothing. `unindexed-fk`
 * was exactly that in the first draft of this file — the bank creates no
 * secondary indexes, so "drop the index" dropped nothing and would have scored
 * the system against a fault that never happened.
 *
 * ── Three families, and the second is the point ─────────────────────────────
 *
 * `backend` faults break the database: RLS off, a foreign key dropped, an
 * unindexed relationship. Any advisor can be measured on these.
 *
 * `observer` faults break Backenly's ability to SEE, leaving the database
 * healthy: revoke catalog access, move the schema out from under the probes.
 * These are what the RFC exists for, no current test can express them, and the
 * correct behaviour for every one is refusal rather than repair. `#77` shipped
 * for months because nothing asked this question.
 *
 * `control` breaks nothing. Silence is a result, and a system that reports a
 * violation on a healthy backend is not cautious, it is wrong.
 */

import type { PrismaClient } from '@prisma/client'

export interface FaultContext {
  prisma: PrismaClient
  projectId: string
  schema: string
  /** Raw DDL executor on the lab's own connection. */
  exec: (sql: string) => Promise<unknown>
}

/** What the system is expected to do about a fault. */
export interface FaultExpectation {
  /** Should any finding be produced for this fault at all? */
  detected: boolean
  /**
   * The action class this maps to, for per-class reporting. `null` where no
   * action should be proposed.
   */
  actionClass: string | null
  /**
   * The RFC's four-valued outcome (§10.1), declared as the CORRECT answer.
   *
   * The current system has no Authority Decision, so Phase 0 cannot read this
   * out of it — the harness derives an equivalent from observed behaviour and
   * compares. That gap is itself a measurement: it says how often today's
   * system lands where a decision layer would have put it.
   */
  decision: 'AUTO_EXECUTE' | 'PROPOSE_ONLY' | 'FREEZE' | 'DENY'
  /**
   * The invariant id(s) whose firing COUNTS as detecting this fault.
   *
   * Without this, "detected" meant "the loop said something", and a lab-seeded
   * project always has unrelated advisory gaps to say something about — so the
   * RLS fault scored as a true positive while the RLS invariant stayed silent.
   * Empty means any finding counts, which is only right for controls.
   */
  detectorInvariants: string[]
  /** Should the database itself end up converged after a live run? */
  converges: boolean
  /** Why this is the right answer. Read by whoever disputes a baseline number. */
  rationale: string
}

export interface LabFault {
  id: string
  family: 'backend' | 'observer' | 'control'
  scenario: string
  description: string
  /** Establish the healthy state this fault departs from. Optional. */
  precondition?: (ctx: FaultContext) => Promise<void>
  /**
   * Break it. Returns an optional cleanup for faults that change schema or
   * role state the teardown could not otherwise reverse.
   */
  apply: (ctx: FaultContext) => Promise<(() => Promise<void>) | void>
  expected: FaultExpectation
}

/** Give every RLS-enabled table a sane per-owner policy. */
async function grantOwnerPolicies(
  { exec, schema }: FaultContext,
  tables: string[],
  column = 'user_id',
): Promise<void> {
  for (const t of tables) {
    await exec(
      `CREATE POLICY "p_${t}_owner" ON "${schema}"."${t}" ` +
        `USING ("${column}"::text = current_setting('request.jwt.claim.sub', true))`,
    )
  }
}

// ── Backend faults ───────────────────────────────────────────────────────────

const rlsDisabled: LabFault = {
  id: 'rls-disabled-on-user-table',
  family: 'backend',
  scenario: 'content-community',
  description: 'Row-level security switched off on a table holding per-user rows',
  precondition: async ctx => {
    // The bank enables RLS but declares no policies, which is deny-all rather
    // than healthy. Give `posts` a real ownership policy so the fault is
    // "protection removed" and not "protection was never configured".
    await grantOwnerPolicies(ctx, ['posts'])
  },
  apply: async ({ exec, schema }) => {
    await exec(`ALTER TABLE "${schema}"."posts" DISABLE ROW LEVEL SECURITY`)
  },
  expected: {
    detected: true,
    actionClass: 'enable_rls',
    detectorInvariants: ['user_data_is_rls_protected', 'rls_is_not_deny_all', 'live_schema_matches_intent'],
    decision: 'AUTO_EXECUTE',
    converges: true,
    rationale:
      'A user table readable across accounts is the highest-severity gap the ' +
      'product claims to close. Re-enabling RLS is additive and reversible, the ' +
      'policy still exists, and the result is verifiable from pg_class.',
  },
}

const fkDropped: LabFault = {
  id: 'fk-dropped',
  family: 'backend',
  scenario: 'ecommerce',
  description: 'A foreign key constraint dropped, leaving an implicit relationship',
  apply: async ({ exec, schema }) => {
    await exec(`ALTER TABLE "${schema}"."orders" DROP CONSTRAINT "fk_orders_user_id"`)
  },
  expected: {
    detected: true,
    actionClass: 'add_foreign_key',
    detectorInvariants: ['relationships_have_fk_constraints'],
    decision: 'PROPOSE_ONLY',
    converges: false,
    rationale:
      'Re-adding a constraint can fail against existing violating rows, so it ' +
      'is not safely automatic without first proving the data conforms. The ' +
      'bank seeds FK columns NULL, so it would succeed here and still should ' +
      'not be automatic in general.',
  },
}

const unindexedRelationship: LabFault = {
  id: 'unindexed-fk',
  family: 'backend',
  scenario: 'ecommerce',
  description: 'A foreign key column whose supporting index has been dropped',
  precondition: async ({ exec, schema }) => {
    // The bank creates no secondary indexes, so the healthy state must be
    // created before it can be broken. Without this the fault is a no-op.
    await exec(`CREATE INDEX "idx_orders_user_id" ON "${schema}"."orders" ("user_id")`)
  },
  apply: async ({ exec, schema }) => {
    await exec(`DROP INDEX "${schema}"."idx_orders_user_id"`)
  },
  expected: {
    detected: true,
    actionClass: 'create_index',
    detectorInvariants: ['relationships_are_indexed', 'hot_path_columns_are_indexed'],
    decision: 'AUTO_EXECUTE',
    converges: true,
    rationale:
      'Additive, reversible, low blast radius, and verifiable from pg_index. ' +
      'This is the canonical safe autonomous action and the one #79 proved ' +
      'against ground truth.',
  },
}

const wideOpenPolicy: LabFault = {
  id: 'policy-wide-open',
  family: 'backend',
  scenario: 'content-community',
  description: 'An RLS policy that permits every row to every caller',
  precondition: async ctx => {
    await grantOwnerPolicies(ctx, ['posts'])
  },
  apply: async ({ exec, schema }) => {
    await exec(`DROP POLICY "p_posts_owner" ON "${schema}"."posts"`)
    await exec(`CREATE POLICY "p_posts_open" ON "${schema}"."posts" USING (true)`)
  },
  expected: {
    detected: true,
    actionClass: 'tighten_policy',
    detectorInvariants: ['rls_policies_are_not_wide_open'],
    decision: 'PROPOSE_ONLY',
    converges: false,
    rationale:
      'RLS is enabled and a policy exists, so nothing structural is missing. ' +
      'Backenly cannot infer the correct ownership predicate without declared ' +
      'intent, and guessing would either break the application or leave it ' +
      'open. This fault is the argument for the ownership-intent slice (§19).',
  },
}

// ── Observer faults: the database is healthy, the instrument is not ──────────

/**
 * NOT IMPLEMENTED, AND DELIBERATELY NOT FAKED
 * ===========================================
 *
 * `catalog-permission-revoked` was written as `REVOKE USAGE ON SCHEMA … FROM
 * PUBLIC`, and the first baseline run scored it "FAULT DID NOTHING". The reason
 * is structural, not a typo: the lab connects as the role that CREATED the
 * schema, and an owner keeps its privileges no matter what is revoked from
 * PUBLIC. The observer was never blinded, so the row measured nothing.
 *
 * The honest options were to delete the fault, or to keep it and let it look
 * like a passing observer test. Both are worse than saying what is true: **the
 * lab cannot currently express catalog-permission blindness**, because it has
 * exactly one database role and that role owns everything.
 *
 * Fixing it needs a second, non-owning role for the observer to read through —
 * which is also what would let the lab reproduce `#77` properly, since that bug
 * needed a `NOSUPERUSER NOBYPASSRLS` reader that RLS could actually hide rows
 * from. That is a Phase 0 follow-up, tracked here rather than in a comment
 * nobody reads.
 *
 * Until then `schema-absent` is the only working observer fault, and the
 * observer family is measured on one scenario rather than two. The baseline
 * report should be read with that in mind.
 */
export const UNIMPLEMENTED_FAULTS = [
  {
    id: 'catalog-permission-revoked',
    family: 'observer' as const,
    blockedBy:
      'The lab has one database role and it owns the schema, so no REVOKE can ' +
      'blind it. Needs a separate non-owning reader role.',
  },
]

const schemaMoved: LabFault = {
  id: 'schema-absent',
  family: 'observer',
  scenario: 'view-heavy',
  description: 'The workspace schema is gone, so every catalog probe reads nothing',
  apply: async ({ exec, schema }) => {
    await exec(`ALTER SCHEMA "${schema}" RENAME TO "${schema}_moved"`)
    return async () => {
      await exec(`ALTER SCHEMA "${schema}_moved" RENAME TO "${schema}"`)
    }
  },
  expected: {
    detected: false,
    actionClass: null,
    detectorInvariants: [],
    decision: 'FREEZE',
    converges: false,
    rationale:
      'An unreadable schema and an empty one produce identical zero counts. ' +
      'Treating this as "the tables are gone" is what deleted metadata in #83, ' +
      'so the only safe answer is to establish observability and refuse.',
  },
}

// ── Control: nothing is wrong ───────────────────────────────────────────────

const healthy: LabFault = {
  id: 'control-healthy',
  family: 'control',
  scenario: 'content-community',
  description: 'A well-formed backend with RLS enabled and real ownership policies',
  precondition: async ctx => {
    // Every RLS table gets a policy. RLS enabled with NO policy is deny-all,
    // which is a genuine defect the loop may legitimately report — so leaving
    // the bank's default here would measure the control as a false positive
    // when the detector was right.
    await grantOwnerPolicies(ctx, ['posts'])
    await grantOwnerPolicies(ctx, ['comments', 'post_tags'], 'post_id')
    await grantOwnerPolicies(ctx, ['users'], 'id')
    await grantOwnerPolicies(ctx, ['tags'], 'id')
  },
  apply: async () => {
    /* deliberately nothing */
  },
  expected: {
    detected: false,
    actionClass: null,
    detectorInvariants: [],
    decision: 'FREEZE',
    converges: false,
    rationale:
      'Silence is the correct output and must be measured. A detector that ' +
      'fires here is producing findings from noise, and its silence elsewhere ' +
      'would then carry no information.',
  },
}

export const FAULTS: readonly LabFault[] = [
  rlsDisabled,
  fkDropped,
  unindexedRelationship,
  wideOpenPolicy,
  schemaMoved,
  healthy,
]

export function fault(id: string): LabFault {
  const f = FAULTS.find(x => x.id === id)
  if (!f) throw new Error(`No such fault: ${id}`)
  return f
}

/**
 * A control has no proposed action, so the four-valued vocabulary has no member
 * that fits; `FREEZE` is recorded only to keep the type total. The harness
 * scores controls on SILENCE and ignores their declared `decision`. Written
 * down so the value is never mistaken for a claim that healthy backends freeze.
 */
export const CONTROL_SCORES_ON_SILENCE = true
