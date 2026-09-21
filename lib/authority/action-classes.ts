/**
 * WHAT AN ACTION DEPENDS ON, DECLARED WHERE THE ACTION IS DEFINED
 * ==============================================================
 *
 * `docs/intent-and-authority-rfc.md` §8. An action class states the sensors that
 * must support it, the verifier that can independently confirm it, the recovery
 * it needs, and how bad it is if it goes wrong. Without that declaration,
 * "degrade authority per dependency" (§7.1) is a matter of judgement at every
 * call site; with it, it is a lookup.
 *
 * ── Scope: the Phase 0 bank, and nothing else ───────────────────────────────
 *
 * Only the classes the lab already measures are declared here. Registering
 * every conceivable action would produce a table nobody has evidence for, and
 * the point of Phase 2 is to compare against the Phase 0 oracle on the rows that
 * oracle actually covers.
 *
 * ── Default-deny is structural ──────────────────────────────────────────────
 *
 * An action with no registered class is not "unconstrained", it is unsupported,
 * and `FREEZE` is the answer. That mirrors `ROLLBACK_CAPABILITY`, which is
 * default-deny for the same reason: an unknown capability that reads as
 * permitted is how a missing implementation becomes a production mutation.
 */

import type { RollbackStrategy } from '@/lib/autonomy/maintenance/rollback-capability'

/**
 * A sensor this action depends on, with the bounds that belong to THIS action.
 *
 * Freshness is per action and per sensor, never one global TTL (RFC §7.2): a
 * policy reading decays in minutes and an index reading does not, and a single
 * bound would have to be wrong for one of them.
 */
export interface SensorRequirement {
  probeId: string
  /** How old the probe's last successful run may be, in seconds. */
  livenessBound: number
  /** How old the observation it produced may be, in seconds. */
  evidenceBound: number
}

export interface ActionClass {
  id: string
  /** Reuses the maintenance tier scale. 0 is cheapest, 3 is never automatic. */
  tier: 0 | 1 | 2 | 3
  /** Probes that must support the claim. Empty is not allowed. */
  requiredSensors: SensorRequirement[]
  /**
   * The probe that independently confirms success.
   *
   * May not be the executor (RFC P11). Structurally separate so an executor can
   * never certify itself, which is what `#79` was.
   */
  verifier: SensorRequirement
  recovery: RollbackStrategy | 'none'
  blastRadius: 'single_object' | 'table' | 'schema'
  reversibility: 'reversible' | 'irreversible'
  /**
   * Does this action change who can READ data?
   *
   * Authorization-shaped actions need to know what the correct end state is,
   * and that is a property of the application rather than of the database.
   * Without declared ownership intent Backenly would be guessing a predicate,
   * so these can never be automatic on evidence alone. This is the flag that
   * makes `tighten_policy` PROPOSE_ONLY in Phase 2 and lets Phase 3 change that
   * answer by supplying the missing intent rather than by loosening a rule.
   */
  changesAuthorization: boolean
}

const MINUTE = 60
const HOUR = 60 * MINUTE

export const ACTION_CLASSES: Readonly<Record<string, ActionClass>> = {
  /**
   * Turn row-level security back on for a table that has a policy already.
   *
   * Additive, reversible, and verifiable from `pg_class`. It does not decide who
   * may read what — the policy already says that — so it restores an existing
   * authorization rather than inventing one.
   */
  enable_rls: {
    id: 'enable_rls',
    tier: 1,
    requiredSensors: [
      // Security-relevant and invalidated by any migration, so minutes.
      { probeId: 'user_data_is_rls_protected', livenessBound: 24 * HOUR, evidenceBound: 5 * MINUTE },
    ],
    verifier: { probeId: 'user_data_is_rls_protected', livenessBound: 24 * HOUR, evidenceBound: 5 * MINUTE },
    recovery: 'none',
    blastRadius: 'table',
    reversibility: 'reversible',
    changesAuthorization: false,
  },

  /** The canonical safe autonomous action: additive, slow-moving, cheap to check. */
  create_index: {
    id: 'create_index',
    tier: 0,
    requiredSensors: [
      { probeId: 'relationships_are_indexed', livenessBound: 24 * HOUR, evidenceBound: 6 * HOUR },
    ],
    verifier: { probeId: 'relationships_are_indexed', livenessBound: 24 * HOUR, evidenceBound: 6 * HOUR },
    recovery: 'drop_column',
    blastRadius: 'single_object',
    reversibility: 'reversible',
    changesAuthorization: false,
  },

  /**
   * Re-add a foreign key.
   *
   * Tier 2 because it can fail against existing violating rows, and proving the
   * data conforms first is a different and larger job than observing that the
   * constraint is absent.
   */
  add_foreign_key: {
    id: 'add_foreign_key',
    tier: 2,
    requiredSensors: [
      { probeId: 'relationships_have_fk_constraints', livenessBound: 24 * HOUR, evidenceBound: 1 * HOUR },
    ],
    verifier: { probeId: 'relationships_have_fk_constraints', livenessBound: 24 * HOUR, evidenceBound: 1 * HOUR },
    recovery: 'drop_constraint',
    blastRadius: 'table',
    reversibility: 'reversible',
    changesAuthorization: false,
  },

  /**
   * Replace a permissive policy with a narrower one.
   *
   * `changesAuthorization` is the whole story. Backenly can SEE that
   * `USING (true)` is wrong; it cannot know what predicate is right without the
   * application telling it who owns a row. The Phase 0 baseline measured this
   * being auto-applied anyway, which is the one unsafe mutation in the bank.
   */
  tighten_policy: {
    id: 'tighten_policy',
    tier: 2,
    requiredSensors: [
      { probeId: 'rls_policies_are_not_wide_open', livenessBound: 24 * HOUR, evidenceBound: 5 * MINUTE },
    ],
    verifier: { probeId: 'rls_policies_are_not_wide_open', livenessBound: 24 * HOUR, evidenceBound: 5 * MINUTE },
    recovery: 'restore_policies',
    blastRadius: 'table',
    reversibility: 'reversible',
    changesAuthorization: true,
  },
}

export function actionClass(id: string): ActionClass | null {
  return ACTION_CLASSES[id] ?? null
}

/**
 * Map a desired-state invariant to the action class that would repair it.
 *
 * Returns null when no registered class covers the invariant, which is a
 * `FREEZE` rather than a free pass: the loop may have a repair for it, but this
 * layer has no declared dependencies to check, so it cannot say the repair is
 * safe.
 */
export function actionClassForInvariant(invariantId: string): ActionClass | null {
  for (const cls of Object.values(ACTION_CLASSES)) {
    if (cls.requiredSensors.some(s => s.probeId === invariantId)) return cls
  }
  return null
}
