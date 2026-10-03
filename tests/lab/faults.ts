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

import { isClientReachable } from './postgrest'
import {
  observerRowCount,
  observerTableCount,
  privilegedRowCount,
  type LabObserver,
} from './observer-role'
import { hasForeignKey, indexesOn, policies, rlsState } from './oracles'

export interface FaultContext {
  prisma: PrismaClient
  projectId: string
  schema: string
  /** Raw DDL executor on the lab's own connection. */
  exec: (sql: string) => Promise<unknown>
  /**
   * A NOSUPERUSER NOBYPASSRLS non-owning reader, for faults that impair
   * OBSERVATION rather than the database. Null when the lab could not create
   * one, in which case blindness faults invalidate rather than pass.
   */
  observer: LabObserver | null
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
  /**
   * The action class the SHADOW Authority Decision is evaluated for.
   *
   * Observer and control faults propose no repair, so they have no action class
   * of their own. They still need one here, because the question being asked is
   * "what would the decision layer say if this action were proposed against
   * THIS backend" — and for a blind or healthy backend the answer must be
   * FREEZE or a refusal, not silence by absence.
   */
  shadowActionClass: string
  /** Should the database itself end up converged after a live run? */
  converges: boolean
  /** Why this is the right answer. Read by whoever disputes a baseline number. */
  rationale: string
}

export interface LabFault {
  id: string
  family: 'backend' | 'observer' | 'control'
  /**
   * True when this fault only blinds a reader WEAKER than the application
   * connection. If the deployment's own role bypasses RLS, the product never
   * experiences the blindness, so scoring its behaviour here would attribute a
   * failure it could not have had. The harness records such rows and excludes
   * them from scoring.
   */
  requiresProductionEquivalentAppRole?: boolean
  scenario: string
  description: string
  /** Establish the healthy state this fault departs from. Optional. */
  precondition?: (ctx: FaultContext) => Promise<void>
  /**
   * Break it. Returns an optional cleanup for faults that change schema or
   * role state the teardown could not otherwise reverse.
   */
  apply: (ctx: FaultContext) => Promise<(() => Promise<void>) | void>
  /**
   * Prove, from PostgreSQL, that the healthy state this fault departs from is
   * actually in place. Throwing invalidates the row instead of scoring it.
   *
   * This exists because `enable_rls` was scored as a product false negative on
   * the strength of a precondition nobody had checked: the table was never
   * client-reachable, so the detector's silence was correct and the lab was
   * wrong. An unasserted precondition is an assumption, and this baseline
   * exists to stop assumptions becoming numbers.
   */
  verifyHealthy?: (ctx: FaultContext) => Promise<void>
  /** Prove the fault actually produced the condition it claims to. */
  verifyBroken?: (ctx: FaultContext) => Promise<void>
  /**
   * Did the repair actually fix THIS fault, asked of the catalog?
   *
   * Falls back to whole-schema fingerprint equality when absent, which is too
   * strict once a tick also applies unrelated repairs: `unindexed-fk` recreated
   * its index correctly and still scored as not converged, because collateral
   * repairs had moved the fingerprint. Convergence is about the fault's own
   * target, so the faults that can state it precisely do.
   */
  verifyConverged?: (ctx: FaultContext) => Promise<boolean>
  expected: FaultExpectation
}

function must(ok: boolean, msg: string): void {
  if (!ok) throw new Error(msg)
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
  verifyHealthy: async ({ prisma, schema }) => {
    const st = await rlsState(prisma, schema, 'posts')
    must(st.exists, 'posts does not exist')
    must(st.enabled, 'RLS is not enabled before the fault, so nothing is being removed')
    must(
      await isClientReachable(prisma, schema, 'posts'),
      'posts is not reachable by anon/authenticated, so an exposure cannot exist ' +
        'and detectMissingRls is correct to stay silent',
    )
  },
  verifyBroken: async ({ prisma, schema }) => {
    const st = await rlsState(prisma, schema, 'posts')
    must(!st.enabled, 'RLS is still enabled after the fault')
    must(
      await isClientReachable(prisma, schema, 'posts'),
      'posts stopped being client-reachable, so the fault changed reachability ' +
        'rather than protection and is measuring the wrong thing',
    )
  },
  verifyConverged: async ({ prisma, schema }) =>
    (await rlsState(prisma, schema, 'posts')).enabled,
  expected: {
    detected: true,
    actionClass: 'enable_rls',
    shadowActionClass: 'enable_rls',
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
  verifyConverged: async ({ prisma, schema }) =>
    hasForeignKey(prisma, schema, 'orders', 'user_id'),
  expected: {
    detected: true,
    actionClass: 'add_foreign_key',
    shadowActionClass: 'add_foreign_key',
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
  verifyConverged: async ({ prisma, schema }) =>
    (await indexesOn(prisma, schema, 'orders', 'user_id')).length > 0,
  expected: {
    detected: true,
    actionClass: 'create_index',
    shadowActionClass: 'create_index',
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
  verifyConverged: async ({ prisma, schema }) => {
    // Converged means no wide-open policy remains, whatever the replacement is
    // called. Requiring the original policy NAME back would fail a correct
    // repair that generated its own.
    const names = await policies(prisma, schema, 'posts')
    return names.length > 0 && !names.includes('p_posts_open')
  },
  expected: {
    detected: true,
    actionClass: 'tighten_policy',
    shadowActionClass: 'tighten_policy',
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
 * Resolved in Phase 0B.
 *
 * `catalog-permission-revoked` was unimplementable while the lab had one role
 * that owned every schema: no REVOKE can blind an owner. It is now
 * `observer-blinded-by-catalog-revoke`, measured through a second
 * NOSUPERUSER NOBYPASSRLS non-owning reader.
 *
 * Kept as an empty list rather than deleted, because the next unreproducible
 * fault should be recorded here instead of quietly narrowing the bank.
 */
export const UNIMPLEMENTED_FAULTS: Array<{ id: string; family: string; blockedBy: string }> = []

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
  verifyBroken: async ({ prisma, schema }) => {
    // This one blinds the OWNER too, so it is the only observer fault whose
    // blindness the product itself experiences regardless of role privileges.
    const rows = await prisma.$queryRawUnsafe<Array<{ n: number }>>(
      `SELECT count(*)::int AS n FROM pg_namespace WHERE nspname = $1`,
      schema,
    )
    must(rows[0].n === 0, 'the schema is still present, so nothing was blinded')
    const moved = await prisma.$queryRawUnsafe<Array<{ n: number }>>(
      `SELECT count(*)::int AS n FROM pg_namespace WHERE nspname = $1`,
      `${schema}_moved`,
    )
    must(moved[0].n === 1, 'the schema was destroyed rather than moved; data is gone')
  },
  expected: {
    detected: false,
    actionClass: null,
    detectorInvariants: [],
    // Ask what the decision layer would say about enabling RLS on this backend.
    // On a blind one the honest answer is FREEZE; on a healthy one it is a
    // refusal for lack of a violation, never an automatic mutation.
    shadowActionClass: 'enable_rls',
    decision: 'FREEZE',
    converges: false,
    rationale:
      'An unreadable schema and an empty one produce identical zero counts. ' +
      'Treating this as "the tables are gone" is what deleted metadata in #83, ' +
      'so the only safe answer is to establish observability and refuse.',
  },
}



/**
 * The same fault as `policy-wide-open`, with the missing half supplied.
 *
 * This is the Phase 3 comparison. Identical database, identical probe, identical
 * violation — the only difference is that the application has DECLARED who owns
 * a row. If the decision changes, it changes because Backenly was told what
 * correct looks like, not because a rule was relaxed.
 */
const wideOpenPolicyWithIntent: LabFault = {
  id: 'policy-wide-open-with-ownership-intent',
  family: 'backend',
  scenario: 'content-community',
  description: 'A wide-open policy on a table whose ownership the owner has declared',
  precondition: async ctx => {
    await grantOwnerPolicies(ctx, ['posts'])
    const { declareOwnershipIntent } = await import('@/lib/authority/ownership-intent')
    const { P } = await import('@/lib/principal')
    const proj = await ctx.prisma.project.findUnique({
      where: { id: ctx.projectId },
      select: { userId: true },
    })
    await declareOwnershipIntent(ctx.prisma, {
      projectId: ctx.projectId,
      tableName: 'posts',
      ownerColumn: 'user_id',
      provenance: 'declared_by_user',
      declaredBy: P.user(proj!.userId!),
    })
  },
  apply: async ({ exec, schema }) => {
    await exec(`DROP POLICY "p_posts_owner" ON "${schema}"."posts"`)
    await exec(`CREATE POLICY "p_posts_open" ON "${schema}"."posts" USING (true)`)
  },
  verifyConverged: async ({ prisma, schema }) => {
    const names = await policies(prisma, schema, 'posts')
    return names.length > 0 && !names.includes('p_posts_open')
  },
  expected: {
    detected: true,
    actionClass: 'tighten_policy',
    shadowActionClass: 'tighten_policy',
    detectorInvariants: ['rls_policies_are_not_wide_open'],
    // PROPOSE_ONLY, and the reason matters more than the value.
    //
    // The intent gate IS satisfied here: the decision carries no `intent_*`
    // narrowing, which is the whole Phase 3 claim. What still blocks it is
    // unrelated to intent and entirely legitimate:
    //
    //   tier_above_dial_ceiling   tighten_policy is tier 2, and the dial's
    //                             ceiling is 1 even at AGGRESSIVE
    //   recovery_not_implemented  restore_policies is honestly unimplemented
    //                             (#80), so this cannot be undone
    //
    // Expecting AUTO_EXECUTE would have required weakening the tier ceiling or
    // pretending a rollback exists, to make a target table green. Declaring
    // ownership intent removes the reason Backenly was GUESSING; it does not
    // and should not remove the requirement to be able to undo an authorization
    // change. `intentSatisfied` in the baseline artifact is what proves the
    // Phase 3 result.
    decision: 'PROPOSE_ONLY',
    converges: false,
    rationale:
      'A declared, current, authoritative ownership intent determines the ' +
      'predicate, so Backenly is no longer guessing and the intent gate lifts. ' +
      'It still may not act unattended, because restore_policies is not ' +
      'implemented and the action is above the dial tier ceiling. Authority ' +
      'requires being able to undo an authorization change, not just knowing ' +
      'what it should be.',
  },
}

/**
 * Ownership Backenly INFERRED rather than being told.
 *
 * The negative case that matters most, because it is the one a future
 * implementation would be tempted to accept. An inferred assertion may explain
 * and recommend; it may never authorise a mutation, or this architecture
 * recreates the failure the whole audit removed.
 */
const wideOpenPolicyInferredIntent: LabFault = {
  id: 'policy-wide-open-with-inferred-intent',
  family: 'backend',
  scenario: 'content-community',
  description: 'A wide-open policy where ownership was only inferred, never declared',
  precondition: async ctx => {
    await grantOwnerPolicies(ctx, ['posts'])
    const { declareOwnershipIntent } = await import('@/lib/authority/ownership-intent')
    const { P } = await import('@/lib/principal')
    await declareOwnershipIntent(ctx.prisma, {
      projectId: ctx.projectId,
      tableName: 'posts',
      ownerColumn: 'user_id',
      provenance: 'inferred_by_backenly',
      declaredBy: P.reconciler(),
    })
  },
  apply: async ({ exec, schema }) => {
    await exec(`DROP POLICY "p_posts_owner" ON "${schema}"."posts"`)
    await exec(`CREATE POLICY "p_posts_open" ON "${schema}"."posts" USING (true)`)
  },
  expected: {
    detected: true,
    actionClass: 'tighten_policy',
    shadowActionClass: 'tighten_policy',
    detectorInvariants: ['rls_policies_are_not_wide_open'],
    decision: 'PROPOSE_ONLY',
    converges: false,
    rationale:
      'An inferred ownership pattern is a hypothesis about what the application ' +
      'wants. Acting on it would be Backenly guessing and then treating the ' +
      'guess as authority, which is exactly the class of defect this ' +
      'architecture exists to prevent.',
  },
}

// ── Observation blindness, measured through a production-equivalent reader ───
//
// These are the faults Phase 0 could not express. The database stays healthy and
// the OBSERVER is impaired, which is the shape of #77 and #83 and the reason the
// RFC introduces FREEZE. The correct answer to both is refusal.

const rlsRowBlindness: LabFault = {
  id: 'observer-blinded-by-force-rls',
  requiresProductionEquivalentAppRole: true,
  family: 'observer',
  scenario: 'content-community',
  description:
    'Rows physically exist, but FORCE RLS hides every one of them from a ' +
    'non-superuser reader with no claim set',
  apply: async ctx => {
    // Production's own sequence: ENABLE, then FORCE, then own-rows policies.
    // FORCE is the part that matters — without it the table OWNER bypasses
    // every policy, and a pooled connection is most likely running as the owner
    // (lib/postgrest/rls-translation.ts).
    //
    // This is the `apply` step rather than a precondition because the harness
    // proves a fault is non-vacuous by diffing the schema before and after it.
    // A standing condition established in `precondition` leaves both sides
    // identical and the row is correctly rejected as measuring nothing.
    await ctx.exec(`ALTER TABLE "${ctx.schema}"."posts" ENABLE ROW LEVEL SECURITY`)
    await ctx.exec(`ALTER TABLE "${ctx.schema}"."posts" FORCE ROW LEVEL SECURITY`)
    await grantOwnerPolicies(ctx, ['posts'])
  },
  verifyHealthy: async ({ prisma, schema, observer }) => {
    must(observer !== null, 'no production-equivalent observer; blindness is unmeasurable')
    must(
      (await privilegedRowCount(prisma, schema, 'posts')) > 0,
      'posts holds no rows, so hidden rows and absent rows cannot be told apart',
    )
  },
  verifyBroken: async ({ prisma, schema, observer }) => {
    // The contrast IS the fault: rows exist, and a production-equivalent reader
    // cannot see one of them. Asserting both halves is what makes this
    // non-vacuous — either alone would be satisfied by an empty table.
    // Exact COUNT(*) on both sides. The contrast is the finding, and an
    // estimate on either side would weaken it to "roughly some rows".
    const privileged = await privilegedRowCount(prisma, schema, 'posts')
    const seen = await observerRowCount(observer!, schema, 'posts')
    const forced = await rlsState(prisma, schema, 'posts')
    must(forced.forced, 'FORCE RLS is not set, so the table owner still bypasses every policy')
    must(privileged > 0, `privileged COUNT(*) is ${privileged}; hidden and absent are the same`)
    must(
      seen.visible === 0,
      `observer sees ${seen.visible} rows but should see 0 under FORCE RLS with no claim`,
    )
  },
  expected: {
    detected: false,
    actionClass: null,
    detectorInvariants: [],
    // Ask what the decision layer would say about enabling RLS on this backend.
    // On a blind one the honest answer is FREEZE; on a healthy one it is a
    // refusal for lack of a violation, never an automatic mutation.
    shadowActionClass: 'enable_rls',
    decision: 'FREEZE',
    converges: false,
    rationale:
      'The table is full and protected. A reader that cannot see its rows has ' +
      'established nothing, and "no rows visible" must never become "the table ' +
      'is empty" — the confident wrong answer #77 shipped for months.',
  },
}

const catalogBlindness: LabFault = {
  id: 'observer-blinded-by-catalog-revoke',
  requiresProductionEquivalentAppRole: true,
  family: 'observer',
  scenario: 'auth-heavy',
  description:
    'The schema is healthy, but the observer loses USAGE and can no longer ' +
    'read its catalog',
  apply: async ({ exec, schema }) => {
    // USAGE alone is not enough: information_schema.tables lists any table the
    // caller holds a privilege on, so a surviving SELECT grant kept the
    // observer sighted and the first run reported "still sees 6 tables".
    await exec(`REVOKE SELECT ON ALL TABLES IN SCHEMA "${schema}" FROM "bkn_lab_observer"`)
    await exec(`REVOKE USAGE ON SCHEMA "${schema}" FROM "bkn_lab_observer"`)
    return async () => {
      await exec(`GRANT USAGE ON SCHEMA "${schema}" TO "bkn_lab_observer"`)
      await exec(`GRANT SELECT ON ALL TABLES IN SCHEMA "${schema}" TO "bkn_lab_observer"`)
    }
  },
  verifyHealthy: async ({ schema, observer }) => {
    must(observer !== null, 'no production-equivalent observer; blindness is unmeasurable')
    const seen = await observerTableCount(observer!, schema)
    must(seen.visible > 0, `observer cannot already be blind (saw ${seen.visible} tables)`)
  },
  verifyBroken: async ({ prisma, schema, observer }) => {
    const seen = await observerTableCount(observer!, schema)
    must(
      seen.visible === 0 || seen.error !== null,
      `observer still sees ${seen.visible} tables, so USAGE was not effectively revoked`,
    )
    // And the tables are still really there, asked of the owner.
    const owner = await prisma.$queryRawUnsafe<Array<{ n: number }>>(
      `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = $1`,
      schema,
    )
    must(owner[0].n > 0, 'the tables actually disappeared; this is not a blindness fault')
  },
  expected: {
    detected: false,
    actionClass: null,
    detectorInvariants: [],
    // Ask what the decision layer would say about enabling RLS on this backend.
    // On a blind one the honest answer is FREEZE; on a healthy one it is a
    // refusal for lack of a violation, never an automatic mutation.
    shadowActionClass: 'enable_rls',
    decision: 'FREEZE',
    converges: false,
    rationale:
      'Zero tables from an unreadable catalog and zero tables from an empty ' +
      'schema are the same value. Acting on the first is what deleted metadata ' +
      'in #83, so observability must be established before anything is pruned.',
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
    // Ask what the decision layer would say about enabling RLS on this backend.
    // On a blind one the honest answer is FREEZE; on a healthy one it is a
    // refusal for lack of a violation, never an automatic mutation.
    shadowActionClass: 'enable_rls',
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
  wideOpenPolicyWithIntent,
  wideOpenPolicyInferredIntent,
  schemaMoved,
  rlsRowBlindness,
  catalogBlindness,
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
