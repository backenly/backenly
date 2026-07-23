/**
 * BEHAVIORAL CHECK → FIX MAPPER
 * =============================
 *
 * Given a failed BehavioralCheck (from `lib/ai/behavioral-verifier.ts`), produce
 * an ordered list of FixCandidate objects that the agentic-fix-loop can apply
 * via the existing `executeAction` executor.
 *
 * The mapping is intentionally heuristic, not an LLM call: it inspects the
 * check id and the error message text to choose from the executor's curated
 * vocabulary (FIX_AUTH, FIX_API, FIX_TABLE, FIX_REALTIME, SET_PERMISSION, ...).
 *
 * Why curated and not freeform SQL: the platform never exposes raw SQL to
 * users. The agent must speak the same vocabulary the deterministic build
 * runtime uses, so every applied fix is governed, audited, and reversible.
 *
 * Each FixCandidate carries a `reason` that gets streamed to the UI so the
 * user can see why a specific fix was chosen.
 */

import type { BehavioralCheck } from './behavioral-verifier'
import type { AIAction } from './minimal-executor'

export interface FixCandidate {
  id: string
  /** The executor action to invoke. */
  action: AIAction['action']
  /** Action params — shape determined by the action. */
  params: Record<string, unknown>
  /** Short human-readable reason — surfaced to the UI. */
  reason: string
  /** The originating check id, e.g. 'auth_flow' / 'rls_isolation'. */
  sourceCheckId: string
  /** When true, this candidate requires user approval before applying. */
  requiresApproval?: boolean
}

const RLS_ERROR = /row[- ]level security|policy.*table|permission denied for table|42501/i
const FK_ERROR = /foreign key constraint|violates foreign key|fk_/i
const NO_USER_TABLE = /workspace users table does not exist|users table.*missing|users.*not found/i
const JWT_ERROR = /jwt|token|signature|expired token/i
const SIGNUP_500 = /signup returned http 5\d\d|signup.*internal_error|signup.*500/i

let _seq = 0
const nextId = () => `fix-${Date.now()}-${++_seq}`

export function mapCheckToFixes(check: BehavioralCheck): FixCandidate[] {
  if (check.passed || check.skipped) return []

  const candidates: FixCandidate[] = []
  const err = (check.error ?? '').toString()
  const detailsBlob = (check.details ?? []).join('\n')
  const errLower = err.toLowerCase()
  const blob = `${err}\n${detailsBlob}`

  switch (check.id) {
    // ── Auth flow: signup → token → JWT verify → protected access ──────────
    case 'auth_flow': {
      if (RLS_ERROR.test(blob)) {
        candidates.push({
          id: nextId(),
          action: 'FIX_AUTH',
          params: { issue: 'auth_signup_blocked_by_rls', reason: 'Signup INSERT is blocked by an RLS policy on users.' },
          reason: 'Signup is blocked by an RLS policy on the users table.',
          sourceCheckId: check.id,
        })
        break
      }
      if (NO_USER_TABLE.test(blob)) {
        candidates.push({
          id: nextId(),
          action: 'FIX_AUTH',
          params: { issue: 'auth_users_table_missing' },
          reason: 'The workspace users table is missing — auth cannot function without it.',
          sourceCheckId: check.id,
        })
        break
      }
      if (JWT_ERROR.test(blob)) {
        candidates.push({
          id: nextId(),
          action: 'FIX_AUTH',
          params: { issue: 'auth_jwt_misconfigured' },
          reason: 'JWT signing or verification is misconfigured.',
          sourceCheckId: check.id,
        })
        break
      }
      // Fall-through: generic auth repair
      candidates.push({
        id: nextId(),
        action: 'FIX_AUTH',
        params: { issue: 'auth_flow_broken', detail: err.slice(0, 200) },
        reason: 'Auth flow failed verification — running generic auth repair.',
        sourceCheckId: check.id,
      })
      break
    }

    // ── RLS isolation: user A inserts row → user B sees nothing ─────────────
    case 'rls_isolation': {
      // FK error during the RLS check is almost always a verifier seeding
      // bug (the comment references a user that wasn't created first). We
      // flag it for approval rather than auto-applying a destructive fix.
      if (FK_ERROR.test(blob)) {
        candidates.push({
          id: nextId(),
          action: 'FIX_TABLE',
          params: { issue: 'fk_seed_mismatch', detail: err.slice(0, 200) },
          reason: 'A foreign-key constraint is rejecting verifier seed inserts — the FK insertion order in the verifier is wrong.',
          sourceCheckId: check.id,
          requiresApproval: true,
        })
        break
      }
      // Otherwise: missing or weak RLS — apply own-rows template
      candidates.push({
        id: nextId(),
        action: 'SET_PERMISSION',
        params: { template: 'own_rows', userIdColumn: 'user_id', scope: 'all_workspace_tables' },
        reason: 'RLS isolation failed — re-applying the own-rows policy template across workspace tables.',
        sourceCheckId: check.id,
      })
      break
    }

    // ── Trigger/function execution ─────────────────────────────────────────
    case 'trigger_execution': {
      if (FK_ERROR.test(blob)) {
        candidates.push({
          id: nextId(),
          action: 'FIX_TABLE',
          params: { issue: 'fk_seed_mismatch_in_trigger_check', detail: err.slice(0, 200) },
          reason: 'Trigger check failed due to a foreign-key seed mismatch.',
          sourceCheckId: check.id,
          requiresApproval: true,
        })
        break
      }
      candidates.push({
        id: nextId(),
        action: 'FIX_REALTIME',
        params: { issue: 'trigger_execution_broken', detail: err.slice(0, 200) },
        reason: 'AI function trigger did not fire — reinstalling NOTIFY triggers.',
        sourceCheckId: check.id,
      })
      break
    }

    // ── Webhook HMAC (often N/A and falsely failing) ───────────────────────
    case 'webhook_hmac': {
      // Common false positive: no webhook configured at all. The check
      // SHOULD have been skipped — surface it as informational, not a fix.
      candidates.push({
        id: nextId(),
        action: 'INFO',
        params: { message: 'No webhook AI functions or triggers configured — webhook HMAC check is not applicable.' },
        reason: 'No webhook is configured for this project — the check should be skipped, not failed.',
        sourceCheckId: check.id,
        requiresApproval: true,
      })
      break
    }

    // ── Live HTTP endpoints: signup → JWT → GET → POST via real HTTP ───────
    case 'live_api_endpoints': {
      if (SIGNUP_500.test(blob) && RLS_ERROR.test(blob)) {
        candidates.push({
          id: nextId(),
          action: 'FIX_AUTH',
          params: { issue: 'auth_signup_blocked_by_rls' },
          reason: 'Live signup returns 500 because RLS blocks the INSERT.',
          sourceCheckId: check.id,
        })
        break
      }
      if (errLower.includes('signup') && (errLower.includes('5') || errLower.includes('internal'))) {
        candidates.push({
          id: nextId(),
          action: 'FIX_AUTH',
          params: { issue: 'auth_signup_5xx', detail: err.slice(0, 200) },
          reason: 'Live signup endpoint is returning a 5xx error.',
          sourceCheckId: check.id,
        })
        break
      }
      candidates.push({
        id: nextId(),
        action: 'FIX_API',
        params: { issue: 'live_endpoint_broken', detail: err.slice(0, 200) },
        reason: 'A live HTTP endpoint failed the round-trip test.',
        sourceCheckId: check.id,
      })
      break
    }

    // ── CRUD lifecycle ─────────────────────────────────────────────────────
    case 'crud_lifecycle': {
      candidates.push({
        id: nextId(),
        action: 'FIX_API',
        params: { issue: 'crud_lifecycle_broken', detail: err.slice(0, 200) },
        reason: 'CRUD lifecycle failed — regenerating REST endpoints for the affected table.',
        sourceCheckId: check.id,
      })
      break
    }

    default:
      // Unknown check id — no curated mapping. Caller will surface it as a
      // notice rather than attempting a fix.
      break
  }

  return candidates
}
