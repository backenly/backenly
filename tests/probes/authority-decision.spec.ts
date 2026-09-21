/**
 * THE AUTHORITY DECISION MUST REFUSE FOR THE RIGHT REASONS
 * =======================================================
 *
 * The Phase 2 comparison in `docs/autonomy-baseline-phase0.json` is the primary
 * evidence: it runs this layer beside the live loop on real PostgreSQL and
 * compares both against the declared oracle. This suite covers what that
 * comparison cannot isolate — each individual narrowing rule, and the guarantees
 * that must hold for every decision whatever the inputs.
 *
 * Every test here is written to be able to FAIL on the bug it names. A suite
 * that asserts the shape of a returned object would pass on a layer that always
 * said AUTO_EXECUTE.
 */

import { decideAuthority, type AuthorityInputs } from '@/lib/authority/decision'
import { ACTION_CLASSES, actionClass } from '@/lib/authority/action-classes'
import { P } from '@/lib/principal'
import type { OwnershipIntentRecord } from '@/lib/authority/ownership-intent'
import type { TierDelegation } from '@/lib/authority/delegation'
import { applyIntentToFixDetails } from '@/lib/authority/gate'
import { buildFixAction } from '@/lib/core/fix-actions'
import type { ProbeOutcome } from '@/lib/autonomy/sensor-health'

function probe(id: string, status: ProbeOutcome['status']): ProbeOutcome {
  return { id, title: id, status, findingCount: status === 'fired' ? 1 : 0 }
}

/** An ownership intent record, defaulting to one that DOES authorize. */
function intent(over: Partial<OwnershipIntentRecord> = {}): OwnershipIntentRecord {
  return {
    id: 'i1',
    projectId: 'p1',
    tableName: 'posts',
    ownerColumn: 'user_id',
    subject: 'authenticated_user',
    provenance: 'declared_by_user',
    version: 1,
    supersededById: null,
    supersededAt: null,
    revokedAt: null,
    declaredBy: null,
    ...over,
  }
}

/** The policy-rewrite action, on the table the intents above name. */
function policyInputs(over: Partial<AuthorityInputs> = {}): AuthorityInputs {
  return inputs({
    actionClassId: 'tighten_policy',
    resource: 'workspace_x.posts',
    probes: [probe('rls_policies_are_not_wide_open', 'clean')],
    ...over,
  })
}

/** Healthy baseline: everything permits action. Each test breaks ONE thing. */
function inputs(over: Partial<AuthorityInputs> = {}): AuthorityInputs {
  const cls = actionClass('create_index')!
  return {
    projectId: 'p1',
    actionClassId: 'create_index',
    resource: 'workspace_x.orders',
    environment: 'development',
    principals: {
      requestedBy: P.reconciler(),
      authorizedBy: P.user('owner-1'),
      executedBy: P.reconciler(),
      authorizationSource: 'project_autonomy_dial',
    },
    level: 'AGGRESSIVE',
    probes: cls.requiredSensors.map(s => probe(s.probeId, 'clean')),
    observation: {
      role: 'backenly_user',
      bypassesRls: false,
      observedAt: new Date().toISOString(),
      resourceObservable: true,
      reason: null,
    },
    ownershipIntents: [],
    ...over,
  }
}

beforeAll(() => {
  // The deployment must permit live execution, or every case below collapses to
  // PROPOSE_ONLY for the same uninteresting reason and none of the rules under
  // test would be exercised. FLAGS reads env on each access, so setting it here
  // is enough.
  process.env.ENABLE_AUTONOMY_RECONCILER = 'true'
  process.env.ENABLE_AUTONOMY_LIVE_EXECUTION = 'true'

  // The healthy baseline must actually permit action, or every test below would
  // pass for the wrong reason. This guard already earned its place: it caught
  // the missing flags rather than letting 23 tests pass vacuously.
  expect(decideAuthority(inputs()).decision).toBe('AUTO_EXECUTE')
})

describe('observability is a precondition of evidence', () => {
  it('freezes when the resource cannot be observed', () => {
    const d = decideAuthority(inputs({ observation: { role: 'r', bypassesRls: false, observedAt: new Date().toISOString(), resourceObservable: false, reason: 'schema missing' } }))
    expect(d.decision).toBe('FREEZE')
    expect(d.narrowedBy).toContain('resource_unobservable')
  })

  it('treats unknown observability as unobservable, never as fine', () => {
    const d = decideAuthority(inputs({ observation: { role: 'r', bypassesRls: false, observedAt: new Date().toISOString(), resourceObservable: 'unknown', reason: 'lookup failed' } }))
    expect(d.decision).toBe('FREEZE')
  })

  it('checks observability BEFORE trusting a silent probe', () => {
    // The Phase 2 finding: a probe against a missing schema returns zero rows
    // and no error, so it looks `clean`. If observability were checked after
    // sensor health, that silence would read as evidence of health.
    const d = decideAuthority(inputs({ observation: { role: 'r', bypassesRls: false, observedAt: new Date().toISOString(), resourceObservable: false, reason: null }, probes: [probe('relationships_are_indexed', 'clean')] }))
    expect(d.decision).toBe('FREEZE')
    expect(d.narrowedBy).toContain('resource_unobservable')
  })
})

describe('sensor confidence constrains authority', () => {
  it('freezes when a required sensor errored', () => {
    const d = decideAuthority(inputs({ probes: [probe('relationships_are_indexed', 'errored')] }))
    expect(d.decision).toBe('FREEZE')
    expect(d.narrowedBy).toContain('required_sensor_unavailable')
  })

  it('freezes when a required sensor is disabled', () => {
    const d = decideAuthority(inputs({ probes: [probe('relationships_are_indexed', 'disabled')] }))
    expect(d.decision).toBe('FREEZE')
  })

  it('freezes when a required sensor is absent from the report', () => {
    const d = decideAuthority(inputs({ probes: [] }))
    expect(d.decision).toBe('FREEZE')
  })

  it('will not auto-execute on an unverified sensor, but does not freeze either', () => {
    // `unverified` means the probe ran quietly and has NEVER fired, so its
    // silence proves nothing. It can still observe, so the action is proposable.
    const d = decideAuthority(inputs({ probes: [probe('relationships_are_indexed', 'unverified')] }))
    expect(d.decision).toBe('PROPOSE_ONLY')
    expect(d.narrowedBy).toContain('sensor_unverified')
  })

  it('accepts a fired sensor as support', () => {
    const d = decideAuthority(inputs({ probes: [probe('relationships_are_indexed', 'fired')] }))
    expect(d.decision).toBe('AUTO_EXECUTE')
  })
})

describe('authorization changes need a MATCHING AUTHORITATIVE intent', () => {
  it('refuses to auto-apply a policy rewrite with no intent at all', () => {
    // The one unsafe mutation the Phase 0 baseline measured.
    const d = decideAuthority(policyInputs({ ownershipIntents: [] }))
    expect(d.decision).toBe('PROPOSE_ONLY')
    expect(d.narrowedBy).toContain('intent_no_intent_for_resource')
    expect(d.intent?.satisfied).toBe(false)
  })

  it('a declared, current intent for THIS table authorizes it', () => {
    const d = decideAuthority(policyInputs({ ownershipIntents: [intent()] }))
    expect(d.intent?.satisfied).toBe(true)
    expect(d.intent?.predicate).toContain('user_id')
    expect(d.narrowedBy.some(n => n.startsWith('intent_'))).toBe(false)
  })

  // ── The negative cases. "Some intent exists" must never be enough. ────────

  it('an intent for ANOTHER table cannot authorize', () => {
    const d = decideAuthority(
      policyInputs({ ownershipIntents: [intent({ tableName: 'comments' })] }),
    )
    expect(d.decision).toBe('PROPOSE_ONLY')
    expect(d.narrowedBy).toContain('intent_no_intent_for_resource')
  })

  it('an INFERRED intent cannot authorize', () => {
    const d = decideAuthority(
      policyInputs({ ownershipIntents: [intent({ provenance: 'inferred_by_backenly' })] }),
    )
    expect(d.decision).toBe('PROPOSE_ONLY')
    expect(d.narrowedBy).toContain('intent_intent_provenance_not_authoritative')
  })

  it('an OBSERVED ownership pattern cannot authorize', () => {
    const d = decideAuthority(
      policyInputs({ ownershipIntents: [intent({ provenance: 'observed_from_existing_state' })] }),
    )
    expect(d.decision).toBe('PROPOSE_ONLY')
    expect(d.narrowedBy).toContain('intent_intent_provenance_not_authoritative')
  })

  it('a SUPERSEDED intent cannot authorize', () => {
    const d = decideAuthority(
      policyInputs({
        ownershipIntents: [intent({ supersededById: 'i2', supersededAt: new Date() })],
      }),
    )
    expect(d.decision).toBe('PROPOSE_ONLY')
    expect(d.narrowedBy).toContain('intent_intent_superseded')
  })

  it('a REVOKED intent cannot authorize', () => {
    const d = decideAuthority(
      policyInputs({ ownershipIntents: [intent({ revokedAt: new Date() })] }),
    )
    expect(d.decision).toBe('PROPOSE_ONLY')
    expect(d.narrowedBy).toContain('intent_intent_revoked')
  })

  it('an intent that determines no predicate cannot authorize', () => {
    const d = decideAuthority(
      policyInputs({ ownershipIntents: [intent({ ownerColumn: '' })] }),
    )
    expect(d.decision).toBe('PROPOSE_ONLY')
    expect(d.narrowedBy).toContain('intent_intent_does_not_determine_predicate')
  })

  it('only the CURRENT version is consulted, and its state decides', () => {
    // v2 is revoked; v1 is a perfectly good declaration. The newest version is
    // what describes the table now, so the answer is refusal, not "find one
    // that works".
    const d = decideAuthority(
      policyInputs({
        ownershipIntents: [intent({ version: 2, revokedAt: new Date() }), intent({ version: 1 })],
      }),
    )
    expect(d.decision).toBe('PROPOSE_ONLY')
    expect(d.narrowedBy).toContain('intent_intent_revoked')
  })

  it('does not apply the intent rule to actions that do not change authorization', () => {
    expect(ACTION_CLASSES.create_index.changesAuthorization).toBe(false)
    const d = decideAuthority(inputs({ ownershipIntents: [] }))
    expect(d.narrowedBy.some(n => n.startsWith('intent_'))).toBe(false)
    expect(d.intent).toBeNull()
  })

  it('intent never rescues a FREEZE', () => {
    // Authority cannot substitute for evidence. A declared intent says what
    // SHOULD be true; it cannot establish what IS true.
    const d = decideAuthority(
      policyInputs({
        ownershipIntents: [intent()],
        probes: [probe('rls_policies_are_not_wide_open', 'errored')],
      }),
    )
    expect(d.decision).toBe('FREEZE')
  })
})

describe('the other inputs each narrow, and only narrow', () => {
  it('a tier above the dial ceiling proposes rather than acts', () => {
    const d = decideAuthority(
      inputs({
        actionClassId: 'add_foreign_key', // tier 2; ceiling is 1 even at AGGRESSIVE
        probes: [probe('relationships_have_fk_constraints', 'clean')],
      }),
    )
    expect(d.decision).toBe('PROPOSE_ONLY')
    // The key names WHY the ceiling was not lifted, not just that it applied:
    // a tier-2 action with no delegation and one whose delegation expired are
    // different situations and a reader should not have to guess which.
    expect(d.narrowedBy).toContain('tier_above_ceiling_no_delegation_for_action')
  })

  it('an unimplemented rollback strategy prevents unattended action', () => {
    // add_foreign_key declares `drop_constraint`, which the capability registry
    // records as not implemented.
    const d = decideAuthority(
      inputs({
        actionClassId: 'add_foreign_key',
        probes: [probe('relationships_have_fk_constraints', 'clean')],
      }),
    )
    expect(d.capability.recoveryStatus).toBe('not_implemented')
    expect(d.narrowedBy).toContain('recovery_not_implemented')
  })

  it('a recent conflicting change stops the loop fighting whoever made it', () => {
    const d = decideAuthority(
      inputs({
        recentChanges: [
          // external_ddl: the one source that is definitely not Backenly.
          { at: new Date().toISOString(), source: 'external_ddl', summary: 'ALTER TABLE', minutesBefore: 2 },
        ],
      }),
    )
    expect(d.decision).toBe('PROPOSE_ONLY')
    expect(d.narrowedBy).toContain('recent_conflicting_change')
  })

  it('an old change does not narrow anything', () => {
    const d = decideAuthority(
      inputs({
        recentChanges: [
          { at: new Date().toISOString(), source: 'external_ddl', summary: 'ALTER TABLE', minutesBefore: 300 },
        ],
      }),
    )
    expect(d.decision).toBe('AUTO_EXECUTE')
  })

  it('does not treat its own recent repairs as a conflict with itself', () => {
    // The loop blocked itself for ten minutes after doing anything, and a user
    // who had just created tables got no repairs at all.
    const d = decideAuthority(
      inputs({
        recentChanges: [
          { at: new Date().toISOString(), source: 'autonomy', summary: 'index created', minutesBefore: 1 },
          { at: new Date().toISOString(), source: 'schema', summary: 'schema v2', minutesBefore: 1 },
          { at: new Date().toISOString(), source: 'deploy', summary: 'deploy', minutesBefore: 1 },
        ],
      }),
    )
    expect(d.decision).toBe('AUTO_EXECUTE')
    expect(d.narrowedBy).not.toContain('recent_conflicting_change')
  })

  it('the project dial being off prevents action', () => {
    const d = decideAuthority(inputs({ level: 'OFF' }))
    expect(d.decision).toBe('PROPOSE_ONLY')
    expect(d.narrowedBy).toContain('deployment_project_dial_off')
  })

  it('the deployment flag being off prevents action', () => {
    const prev = process.env.ENABLE_AUTONOMY_LIVE_EXECUTION
    process.env.ENABLE_AUTONOMY_LIVE_EXECUTION = 'false'
    try {
      const d = decideAuthority(inputs())
      expect(d.decision).toBe('PROPOSE_ONLY')
      expect(d.narrowedBy).toContain('deployment_deployment_flag_off')
    } finally {
      process.env.ENABLE_AUTONOMY_LIVE_EXECUTION = prev
    }
  })
})

describe('guarantees that hold for every decision', () => {
  it('an unregistered action class freezes rather than passing unconstrained', () => {
    const d = decideAuthority(inputs({ actionClassId: 'drop_everything' }))
    expect(d.decision).toBe('FREEZE')
    expect(d.narrowedBy).toContain('action_class_unregistered')
  })

  it('every FREEZE names a blocker to restore', () => {
    // RFC P15: a refusal that says nothing is indistinguishable from health.
    const frozen = [
      decideAuthority(inputs({ observation: { role: 'r', bypassesRls: false, observedAt: new Date().toISOString(), resourceObservable: false, reason: 'schema missing' } })),
      decideAuthority(inputs({ probes: [probe('relationships_are_indexed', 'errored')] })),
      decideAuthority(inputs({ actionClassId: 'nope' })),
    ]
    for (const d of frozen) {
      expect(d.decision).toBe('FREEZE')
      expect(d.blocker).toBeTruthy()
      expect(d.reasons.length).toBeGreaterThan(0)
    }
  })

  it('no input ever widens the decision', () => {
    // Narrowing-only is what makes the intersection an intersection. If any
    // input could widen, ordering would change the answer.
    const base = decideAuthority(inputs())
    expect(base.decision).toBe('AUTO_EXECUTE')
    const narrowed = decideAuthority(
      inputs({
        level: 'OFF',
        probes: [probe('relationships_are_indexed', 'unverified')],
        recentChanges: [
          { at: new Date().toISOString(), source: 'deploy', summary: 'deploy', minutesBefore: 1 },
        ],
      }),
    )
    expect(narrowed.decision).not.toBe('AUTO_EXECUTE')
    expect(narrowed.narrowedBy.length).toBeGreaterThan(1)
  })

  it('is deterministic over its inputs', () => {
    const a = decideAuthority(inputs())
    const b = decideAuthority(inputs())
    expect(a.decision).toBe(b.decision)
    expect(a.narrowedBy).toEqual(b.narrowedBy)
  })

  it('carries the principals and the authorization source into the receipt', () => {
    const d = decideAuthority(inputs())
    expect(d.principals.executedBy).toEqual({ kind: 'backenly', loop: 'reconciler' })
    // Transitive authority through the dial, never "the owner approved this".
    expect(d.principals.authorizationSource).toBe('project_autonomy_dial')
  })
})

describe('the action class registry is well formed', () => {
  it('every class declares at least one required sensor and a verifier', () => {
    for (const cls of Object.values(ACTION_CLASSES)) {
      expect(cls.requiredSensors.length).toBeGreaterThan(0)
      expect(cls.verifier.probeId).toBeTruthy()
      for (const s of cls.requiredSensors) {
        expect(s.livenessBound).toBeGreaterThan(0)
        expect(s.evidenceBound).toBeGreaterThan(0)
      }
    }
  })

  it('covers exactly the classes the Phase 0 bank measures', () => {
    expect(Object.keys(ACTION_CLASSES).sort()).toEqual(
      ['add_foreign_key', 'create_index', 'enable_rls', 'tighten_policy'].sort(),
    )
  })
})

/**
 * THE FINAL PROOF
 * ===============
 *
 * The seven cases that decide whether unattended autonomous repair of a
 * security property is actually reachable, or whether the architecture only
 * ever produces better refusals.
 *
 * Each row differs from the one above it by exactly ONE thing, so the answer
 * can be attributed. A suite that jumped straight from "nothing" to "everything
 * permits it" would prove only that some combination works.
 */
describe('unattended ownership repair: the seven cases', () => {
  const delegation = (over: Partial<TierDelegation> = {}): TierDelegation => ({
    id: 'd1',
    projectId: 'p1',
    actionClassId: 'tighten_policy',
    environment: 'development',
    grantedBy: P.user('owner-1'),
    expiresAt: null,
    revokedAt: null,
    ...over,
  })

  it('1. no ownership intent -> PROPOSE_ONLY', () => {
    const d = decideAuthority(policyInputs({ ownershipIntents: [], delegations: [delegation()] }))
    expect(d.decision).toBe('PROPOSE_ONLY')
    expect(d.intent?.satisfied).toBe(false)
  })

  it('2. inferred ownership -> PROPOSE_ONLY', () => {
    const d = decideAuthority(
      policyInputs({
        ownershipIntents: [intent({ provenance: 'inferred_by_backenly' })],
        delegations: [delegation()],
      }),
    )
    expect(d.decision).toBe('PROPOSE_ONLY')
    expect(d.narrowedBy).toContain('intent_intent_provenance_not_authoritative')
  })

  it('3. declared ownership, NO tier-2 delegation -> PROPOSE_ONLY', () => {
    // Intent is satisfied and the action is still refused. This is the case
    // that proves intent is not authority.
    const d = decideAuthority(policyInputs({ ownershipIntents: [intent()], delegations: [] }))
    expect(d.decision).toBe('PROPOSE_ONLY')
    expect(d.intent?.satisfied).toBe(true)
    expect(d.narrowedBy).toContain('tier_above_ceiling_no_delegation_for_action')
  })

  it('4. declared ownership + delegation, NO recovery -> PROPOSE_ONLY', () => {
    // Simulated by asking for an action class whose rollback is unimplemented,
    // with everything else in place. Knowing what correct looks like and being
    // permitted to act does not remove the need to be able to undo it.
    const d = decideAuthority(
      inputs({
        actionClassId: 'add_foreign_key',
        resource: 'workspace_x.posts',
        probes: [probe('relationships_have_fk_constraints', 'clean')],
        ownershipIntents: [intent()],
        delegations: [delegation({ actionClassId: 'add_foreign_key' })],
      }),
    )
    expect(d.capability.recoveryStatus).toBe('not_implemented')
    expect(d.decision).toBe('PROPOSE_ONLY')
    expect(d.narrowedBy).toContain('recovery_not_implemented')
  })

  it('5. declared ownership + delegation + recovery + healthy evidence -> AUTO_EXECUTE', () => {
    // Every contract satisfied, each established separately.
    const d = decideAuthority(
      policyInputs({ ownershipIntents: [intent()], delegations: [delegation()] }),
    )
    expect(d.capability.recoveryStatus).toBe('implemented')
    expect(d.intent?.satisfied).toBe(true)
    expect(d.delegation?.satisfied).toBe(true)
    expect(d.decision).toBe('AUTO_EXECUTE')
  })

  it('6. resource unobservable -> FREEZE', () => {
    const d = decideAuthority(
      policyInputs({
        ownershipIntents: [intent()],
        delegations: [delegation()],
        observation: {
          role: 'app',
          bypassesRls: false,
          observedAt: new Date().toISOString(),
          resourceObservable: false,
          reason: 'schema is not readable',
        },
      }),
    )
    expect(d.decision).toBe('FREEZE')
    expect(d.blocker).toBeTruthy()
  })

  it('7. conflicting recent change -> refuses and does not act', () => {
    const d = decideAuthority(
      policyInputs({
        ownershipIntents: [intent()],
        delegations: [delegation()],
        recentChanges: [
          { at: new Date().toISOString(), source: 'external_ddl', summary: 'ALTER TABLE', minutesBefore: 1 },
        ],
      }),
    )
    expect(d.decision).toBe('PROPOSE_ONLY')
    expect(d.narrowedBy).toContain('recent_conflicting_change')
  })

  // ── The properties that keep case 5 from being a loophole ────────────────

  it('a delegation in another environment does not carry', () => {
    const d = decideAuthority(
      policyInputs({
        ownershipIntents: [intent()],
        delegations: [delegation({ environment: 'staging' })],
      }),
    )
    expect(d.decision).toBe('PROPOSE_ONLY')
    expect(d.narrowedBy).toContain('tier_above_ceiling_delegation_wrong_environment')
  })

  it('an expired or revoked delegation permits nothing', () => {
    const expired = decideAuthority(
      policyInputs({
        ownershipIntents: [intent()],
        delegations: [delegation({ expiresAt: new Date(Date.now() - 1000) })],
      }),
    )
    expect(expired.narrowedBy).toContain('tier_above_ceiling_delegation_expired')

    const revoked = decideAuthority(
      policyInputs({
        ownershipIntents: [intent()],
        delegations: [delegation({ revokedAt: new Date() })],
      }),
    )
    expect(revoked.narrowedBy).toContain('tier_above_ceiling_delegation_revoked')
  })

  it('an agent cannot delegate authority to itself', () => {
    // The self-authorization rule. An agent requesting an action and an agent
    // authorizing it are the same principal, which is the thing the
    // requested/authorized distinction exists to prevent.
    const d = decideAuthority(
      policyInputs({
        ownershipIntents: [intent()],
        delegations: [delegation({ grantedBy: P.agent('key_1') })],
      }),
    )
    expect(d.decision).toBe('PROPOSE_ONLY')
    expect(d.narrowedBy).toContain('tier_above_ceiling_delegation_not_granted_by_human')
  })

  it('delegation never rescues a broken sensor', () => {
    // Authority is not evidence. Being permitted to act says nothing about
    // whether the state can be established.
    const d = decideAuthority(
      policyInputs({
        ownershipIntents: [intent()],
        delegations: [delegation()],
        probes: [probe('rls_policies_are_not_wide_open', 'errored')],
      }),
    )
    expect(d.decision).toBe('FREEZE')
  })
})

/**
 * THE REPAIR MUST APPLY WHAT THE INTENT SAYS
 * ==========================================
 *
 * Authorizing a policy rewrite because an intent names the owner column, and
 * then letting the executor infer a DIFFERENT column, would make authorization
 * intent-aware and execution not. These pin that the column reaching the
 * executor is the intent's, and that nothing else is disturbed.
 */
describe('the repair follows the declared intent', () => {
  // The divergence case: a heuristic preferring `user_id` would scope rows on
  // the wrong column here. The intent names `owner_id`.
  const authorised = () =>
    decideAuthority(
      policyInputs({
        ownershipIntents: [intent({ ownerColumn: 'owner_id' })],
        delegations: [
          {
            id: 'd1',
            projectId: 'p1',
            actionClassId: 'tighten_policy',
            environment: 'development',
            grantedBy: P.user('owner-1'),
            expiresAt: null,
            revokedAt: null,
          },
        ],
      }),
    )

  it('passes the intent column to the executor, not a guessed one', () => {
    const d = authorised()
    expect(d.decision).toBe('AUTO_EXECUTE')
    expect(d.intent?.ownerColumn).toBe('owner_id')

    const out = applyIntentToFixDetails(d, { tableName: 'posts', rlsTemplate: 'auto' })
    expect(out.userIdColumn).toBe('owner_id')
    expect(out.rlsTemplate).toBe('own_rows')
    expect(out.tableName).toBe('posts')
  })

  it('reaches buildFixAction as the column the executor will apply', () => {
    // The end of the chain: buildFixAction already honours userIdColumn, so
    // this is the value SET_PERMISSION actually receives.
    const out = applyIntentToFixDetails(authorised(), { tableName: 'posts' })
    const action = buildFixAction('rls_expression_invalid', out)
    expect(action?.action).toBe('SET_PERMISSION')
    expect((action?.params as any).userIdColumn).toBe('owner_id')
    expect((action?.params as any).template).toBe('own_rows')
  })

  it('does not touch a decision that is not AUTO_EXECUTE', () => {
    const d = decideAuthority(policyInputs({ ownershipIntents: [intent()], delegations: [] }))
    expect(d.decision).not.toBe('AUTO_EXECUTE')
    const before = { tableName: 'posts', rlsTemplate: 'auto' }
    expect(applyIntentToFixDetails(d, before)).toBe(before)
  })

  it('does not touch any other action class', () => {
    const d = decideAuthority(inputs())
    expect(d.actionClassId).toBe('create_index')
    const before = { tableName: 'orders' }
    expect(applyIntentToFixDetails(d, before)).toBe(before)
  })
})
