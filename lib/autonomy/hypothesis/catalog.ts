/**
 * PHASE 4 — what could be causing this, and what would tell them apart.
 *
 * Every symptom here has been produced by this system for real, and every
 * hypothesis under it is a cause that actually occurred or was one step away.
 * That grounding is the difference between diagnosis and a decision tree
 * someone imagined.
 *
 * The predictions matrix is the substance. Writing it forces the question a
 * rule-based fixer never has to answer: *if this explanation were true, what
 * would I see that I would NOT see otherwise?* A hypothesis that cannot answer
 * that is not a hypothesis, it is a guess with a name.
 *
 * Priors encode real base rates, not politeness. A stale schema cache is far
 * more common than a dropped table, and pretending otherwise wastes the first
 * test — which is usually the only one anybody waits for.
 */

import type { DiagnosticTest, Hypothesis } from './types'

export interface SymptomDefinition {
  id: string
  /** How a human would describe seeing this. */
  description: string
  hypotheses: Hypothesis[]
  tests: DiagnosticTest[]
}

// ── Symptom: a table returns 200 with an empty array ────────────────────────
// The most dangerous symptom in the system, because it is not an error. Every
// instrument reports health; only the customer notices, and they conclude their
// data was lost.
const EMPTY_READS: SymptomDefinition = {
  id: 'empty_reads',
  description: 'A table that should contain rows returns 200 with an empty array',
  tests: [
    {
      id: 'service_rows',
      description: 'Count rows with RLS bypassed — does the data physically exist?',
      cost: 'cheap',
    },
    {
      id: 'contract_match',
      description: 'Does the serving engine set the identity the RLS policies read?',
      cost: 'trivial',
    },
    {
      id: 'caller_identity',
      description: 'Did the request carry an end-user identity at all?',
      cost: 'trivial',
    },
    {
      id: 'soft_deleted',
      description: 'Are all rows soft-deleted?',
      cost: 'cheap',
    },
  ],
  hypotheses: [
    {
      id: 'engine_policy_mismatch',
      statement:
        'The serving engine sets an identity the RLS policies do not read, so every ' +
        'policy evaluates against NULL and matches nothing',
      // Highest prior during a migration window: it is the failure this
      // architecture newly makes possible, and it produces exactly this symptom.
      prior: 0.3,
      predicts: {
        service_rows: 'rows_exist',
        contract_match: 'mismatch',
      },
      remedy: {
        summary:
          'Align the engine and the policies — either complete the cutover or roll ' +
          'the policies back. Which one depends on what was intended.',
        // Both repairs are correct in isolation and opposite in effect, and
        // guessing wrong reproduces this exact symptom from the other side.
        autoApplicable: false,
      },
    },
    {
      id: 'no_caller_identity',
      statement:
        'The request carried no end-user identity, so own-rows policies correctly ' +
        'matched nothing',
      prior: 0.25,
      predicts: {
        service_rows: 'rows_exist',
        contract_match: 'match',
        caller_identity: 'absent',
      },
      remedy: {
        summary:
          'Not a fault. The caller must send a user token, or use a service-role key ' +
          'if this is a backend-to-backend call.',
        autoApplicable: false,
      },
    },
    {
      id: 'table_genuinely_empty',
      statement: 'The table contains no rows',
      prior: 0.25,
      predicts: {
        service_rows: 'no_rows',
      },
      remedy: {
        summary: 'Nothing to repair — the table is empty.',
        autoApplicable: false,
      },
    },
    {
      id: 'all_rows_soft_deleted',
      statement: 'Every row is soft-deleted, so the deleted_at filter hides all of them',
      prior: 0.1,
      predicts: {
        service_rows: 'rows_exist',
        contract_match: 'match',
        soft_deleted: 'all_deleted',
      },
      remedy: {
        summary:
          'Expected behaviour. Rows are recoverable with include_deleted=true if the ' +
          'deletion was not intended.',
        autoApplicable: false,
      },
    },
    {
      id: 'rls_predicate_too_strict',
      statement:
        'An RLS policy is narrower than intended and excludes rows the caller should see',
      prior: 0.1,
      predicts: {
        service_rows: 'rows_exist',
        contract_match: 'match',
        caller_identity: 'present',
        soft_deleted: 'some_live',
      },
      remedy: {
        summary:
          'Review the policy predicate against the caller identity — it is stricter ' +
          'than the ownership model implies.',
        // Widening a security predicate automatically is the one repair that
        // turns a visibility bug into a data breach. Never unattended.
        autoApplicable: false,
      },
    },
  ],
}

// ── Symptom: an endpoint 404s that should exist ─────────────────────────────
// This is the symptom the founder originally reported as "not even a single api
// generated", and it has four distinct causes that look identical from outside.
const ENDPOINT_404: SymptomDefinition = {
  id: 'endpoint_404',
  description: 'A REST endpoint returns 404 for a table the user believes exists',
  tests: [
    {
      id: 'table_exists',
      description: 'Does the table exist in the live PostgreSQL catalog?',
      cost: 'trivial',
    },
    {
      id: 'api_definition',
      description: 'Is there an enabled ApiDefinition for this resource?',
      cost: 'trivial',
    },
    {
      id: 'postgrest_visibility',
      description: 'Can the PostgREST schema cache see the table?',
      cost: 'cheap',
    },
  ],
  hypotheses: [
    {
      id: 'stale_schema_cache',
      statement:
        'The table exists and is exposed, but PostgREST cached the schema before it ' +
        'was created and has not reloaded',
      // Highest prior on this platform specifically: tables are created at
      // runtime by an agent, so the cache is stale far more often than a table
      // is genuinely missing.
      prior: 0.35,
      predicts: {
        table_exists: 'exists',
        api_definition: 'present_enabled',
        postgrest_visibility: 'not_in_cache',
      },
      remedy: {
        summary: 'Reload the PostgREST schema cache.',
        // Purely additive, instantly reversible, and affects no data. One of
        // the few repairs safe to perform unattended.
        autoApplicable: true,
        action: 'POSTGREST_RELOAD_SCHEMA',
      },
    },
    {
      id: 'missing_api_definition',
      statement: 'The table exists but no API was ever generated for it',
      prior: 0.3,
      predicts: {
        table_exists: 'exists',
        api_definition: 'absent',
      },
      remedy: {
        summary: 'Generate the REST API for this table.',
        autoApplicable: true,
        action: 'GENERATE_API',
      },
    },
    {
      id: 'api_definition_disabled',
      statement: 'An API exists for this table but is disabled',
      prior: 0.2,
      predicts: {
        table_exists: 'exists',
        api_definition: 'present_disabled',
      },
      remedy: {
        summary:
          'The resource was disabled deliberately. Re-enabling it is a policy ' +
          'decision, not a repair.',
        autoApplicable: false,
      },
    },
    {
      id: 'table_does_not_exist',
      statement: 'The table does not exist — it was dropped, renamed, or never created',
      prior: 0.15,
      predicts: {
        table_exists: 'missing',
      },
      remedy: {
        summary:
          'The table is gone. Recreating it from the intended schema is a change to ' +
          'production data structure and needs review.',
        autoApplicable: false,
      },
    },
  ],
}

// ── Symptom: an endpoint 403s ───────────────────────────────────────────────
const ENDPOINT_403: SymptomDefinition = {
  id: 'endpoint_403',
  description: 'A REST endpoint returns 403 for a caller that should be allowed',
  tests: [
    {
      id: 'is_internal_table',
      description: 'Is this a credential or platform-internal table?',
      cost: 'trivial',
    },
    {
      id: 'role_grants',
      description: 'Do the data-plane roles hold table privileges?',
      cost: 'cheap',
    },
    {
      id: 'key_scope',
      description: 'Does the caller\'s API key carry the required scope?',
      cost: 'trivial',
    },
  ],
  hypotheses: [
    {
      id: 'internal_table_denied',
      statement:
        'The table is platform-internal (users or an underscore-prefixed table) and ' +
        'is denied by design',
      prior: 0.3,
      predicts: {
        is_internal_table: 'internal',
      },
      remedy: {
        summary:
          'Working as intended. These tables hold credentials and are deliberately ' +
          'unreachable from the public data plane.',
        // The single most dangerous auto-fix imaginable here: "repairing" this
        // means granting public read on password hashes.
        autoApplicable: false,
      },
    },
    {
      id: 'missing_role_grants',
      statement:
        'The table was created after provisioning and the data-plane roles were never ' +
        'granted access to it',
      prior: 0.4,
      predicts: {
        is_internal_table: 'not_internal',
        role_grants: 'absent',
      },
      remedy: {
        summary: 'Grant the data-plane roles access to the table.',
        // Restores the documented default rather than widening it, and the
        // internal-table exclusion is re-asserted immediately afterwards.
        autoApplicable: true,
        action: 'POSTGREST_PREPARE_SCHEMA',
      },
    },
    {
      id: 'insufficient_key_scope',
      statement: 'The caller\'s API key does not carry the scope this operation requires',
      prior: 0.3,
      predicts: {
        is_internal_table: 'not_internal',
        role_grants: 'present',
        key_scope: 'insufficient',
      },
      remedy: {
        summary:
          'Issue a key with the required scope. Widening an existing key\'s ' +
          'permissions is an authorization decision.',
        autoApplicable: false,
      },
    },
  ],
}

// ── Symptom: every project is failing at once ───────────────────────────────
// Observed for real: one unrelated project's schema was dropped while still
// registered, and PostgREST returned 503 to every tenant. No rule connects
// "project A was deleted" to "project B is down".
const ALL_TENANTS_FAILING: SymptomDefinition = {
  id: 'all_tenants_failing',
  description: 'Every project\'s data plane is failing simultaneously',
  tests: [
    {
      id: 'postgrest_reachable',
      description: 'Does the PostgREST process answer at all?',
      cost: 'trivial',
    },
    {
      id: 'schema_cache_state',
      description: 'Is PostgREST reporting a failed schema cache (PGRST002)?',
      cost: 'trivial',
    },
    {
      id: 'dangling_registrations',
      description: 'Are any registered schemas missing from the database?',
      cost: 'cheap',
    },
    {
      id: 'database_reachable',
      description: 'Is PostgreSQL itself reachable?',
      cost: 'trivial',
    },
  ],
  hypotheses: [
    {
      id: 'dangling_schema_registration',
      statement:
        'A registered schema no longer exists, so the shared schema cache cannot ' +
        'build and every tenant is refused',
      prior: 0.45,
      predicts: {
        postgrest_reachable: 'reachable',
        schema_cache_state: 'failed',
        dangling_registrations: 'present',
        database_reachable: 'reachable',
      },
      remedy: {
        summary:
          'Prune the dangling registration, then restart PostgREST — a failed schema ' +
          'cache does not clear on a config reload.',
        autoApplicable: true,
        action: 'POSTGREST_PRUNE_AND_RESTART',
      },
    },
    {
      id: 'schema_cache_failed_other_cause',
      statement:
        'The schema cache is failing for a reason other than a dangling registration',
      prior: 0.15,
      predicts: {
        postgrest_reachable: 'reachable',
        schema_cache_state: 'failed',
        dangling_registrations: 'absent',
        database_reachable: 'reachable',
      },
      remedy: {
        summary:
          'Read the PostgREST log for the underlying cause. Restarting without ' +
          'knowing it risks a restart loop.',
        autoApplicable: false,
      },
    },
    {
      id: 'postgrest_process_down',
      statement: 'The PostgREST process is not running or not listening',
      prior: 0.2,
      predicts: {
        postgrest_reachable: 'unreachable',
        database_reachable: 'reachable',
      },
      remedy: {
        summary: 'Restart the PostgREST process.',
        autoApplicable: true,
        action: 'POSTGREST_RESTART',
      },
    },
    {
      id: 'database_down',
      statement: 'PostgreSQL is unreachable, so every engine fails regardless of PostgREST',
      prior: 0.2,
      predicts: {
        database_reachable: 'unreachable',
      },
      remedy: {
        summary:
          'The database is the fault. Restarting the data plane would change nothing ' +
          'and would obscure the real cause.',
        autoApplicable: false,
      },
    },
  ],
}

export const SYMPTOM_CATALOG: readonly SymptomDefinition[] = [
  EMPTY_READS,
  ENDPOINT_404,
  ENDPOINT_403,
  ALL_TENANTS_FAILING,
] as const

export function findSymptom(id: string): SymptomDefinition | undefined {
  return SYMPTOM_CATALOG.find(s => s.id === id)
}
