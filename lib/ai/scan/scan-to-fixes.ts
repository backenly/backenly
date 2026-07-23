/**
 * SCAN-TO-FIXES MAPPER
 * ====================
 *
 * Turns structured scan sources (production-intelligence, readiness-scorer,
 * build-ledger, integration-readiness, proof) into FixCandidate[] that the
 * existing agentic-fix-loop can apply through the AIAction executor.
 *
 * Why this exists:
 *   /scan and the behavioral-fix-loop historically spoke different vocabularies.
 *   `/scan` produced human-readable risk titles ("missing api definition —
 *   notifications", "missing rls users"), while the fix-loop only knew how to
 *   address BehavioralCheck results. The findings the user saw could not be
 *   addressed by the fixer, because they lived in two unconnected data models.
 *
 *   This module is the bridge: every auto-fixable scan finding becomes a
 *   typed FixCandidate keyed on an AIAction, then flows through the same
 *   executor + governance kernel as every other mutation.
 *
 * Scope:
 *   This mapper is heuristic, not LLM-driven. Each finding type has a curated
 *   target action. Findings without a safe deterministic mapping (n+1 queries,
 *   webhook replay risk, build failures with unknown context) are returned
 *   with requiresApproval=true and skipped by the fix-loop unless surfaced
 *   to the user. The agentic-fix-author (FLAGS.ENABLE_AGENTIC_FIX_AUTHOR)
 *   is the right path for those — kept as a Move 4/5 follow-up.
 */

import type { FixCandidate } from '../behavioral-check-to-fixes'
import { collectProof } from '../proof-system'
import { analyzeProductionReadiness } from '../production-intelligence'
import { scoreReadiness } from '@/lib/deployment/readiness-scorer'
import { loadBuildLedger } from '../build-ledger'
import { checkAllIntegrationReadiness } from '@/lib/integrations/readiness'

let _seq = 0
const nextId = () => `scanfix-${Date.now()}-${++_seq}`

export interface ScanFixHarvest {
  candidates: FixCandidate[]
  /** Findings the mapper saw but couldn't safely auto-fix — surfaced for transparency. */
  uncovered: Array<{ source: string; title: string; reason: string }>
}

/**
 * Harvest fix candidates from all scan sources.
 *
 * Read-only — pulls each source independently, falls back to an empty
 * result on any individual failure so a single broken source doesn't
 * silence the rest.
 */
export async function harvestScanFixes(projectId: string): Promise<ScanFixHarvest> {
  const candidates: FixCandidate[] = []
  const uncovered: ScanFixHarvest['uncovered'] = []

  const [proof, prodIntel, readiness, ledger, integrations] = await Promise.all([
    collectProof(projectId).catch(() => null),
    analyzeProductionReadiness(projectId).catch(() => null),
    scoreReadiness(projectId, { autoFix: false }).catch(() => null),
    loadBuildLedger(projectId).catch(() => null),
    checkAllIntegrationReadiness(projectId).catch(() => [] as Awaited<ReturnType<typeof checkAllIntegrationReadiness>>),
  ])

  // ── 1. Production-intelligence issues ──────────────────────────────────────
  // These carry the most structured metadata — table, location, autoFixable.
  if (prodIntel?.issues) {
    for (const issue of prodIntel.issues) {
      switch (issue.type) {
        case 'missing_index': {
          // location is "table.column" — pull the column out for the action.
          const column = issue.location.split('.').slice(1).join('.') || ''
          if (issue.table && column) {
            candidates.push({
              id: nextId(),
              action: 'CREATE_INDEX',
              params: { tableName: issue.table, columnName: column },
              reason: `Missing index on ${issue.location} — queries will scale poorly without it.`,
              sourceCheckId: `scan:missing_index:${issue.location}`,
            })
          }
          break
        }
        case 'weak_rls': {
          if (issue.table) {
            candidates.push({
              id: nextId(),
              action: 'SET_PERMISSION',
              params: { template: 'own_rows', userIdColumn: 'user_id', table: issue.table },
              reason: `Row-level security is disabled on "${issue.table}" — any authenticated user can read every row.`,
              sourceCheckId: `scan:weak_rls:${issue.table}`,
            })
          }
          break
        }
        case 'n_plus_one_risk':
        case 'unbounded_pagination':
        case 'webhook_replay_risk':
        case 'storage_abuse_risk':
        case 'missing_retry_queue':
          uncovered.push({
            source: 'production-intelligence',
            title: issue.location,
            reason: `${issue.type} requires a code-level change the curated action vocabulary does not cover yet.`,
          })
          break
      }
    }
  }

  // ── 2. Readiness scorer blockers ───────────────────────────────────────────
  if (readiness?.blockers) {
    for (const blocker of readiness.blockers) {
      switch (blocker.id) {
        case 'project_jwt':
          candidates.push({
            id: nextId(),
            action: 'FIX_AUTH',
            params: { issue: 'auth_jwt_misconfigured' },
            reason: 'Project JWT secret is missing or invalid — sign-in cannot issue tokens.',
            sourceCheckId: `scan:readiness:${blocker.id}`,
          })
          break
        case 'end_user_auth_table':
          candidates.push({
            id: nextId(),
            action: 'FIX_AUTH',
            params: { issue: 'auth_users_table_missing' },
            reason: 'End-user auth table is missing — sign-up will fail at the first INSERT.',
            sourceCheckId: `scan:readiness:${blocker.id}`,
          })
          break
        case 'rls_applied': {
          // No specific table — apply the own-rows template across all
          // workspace tables (same path the behavioral RLS check uses).
          candidates.push({
            id: nextId(),
            action: 'SET_PERMISSION',
            params: { template: 'own_rows', userIdColumn: 'user_id', scope: 'all_workspace_tables' },
            reason: 'No row-level security policies are active — applying the own-rows template across workspace tables.',
            sourceCheckId: `scan:readiness:${blocker.id}`,
          })
          break
        }
        case 'route_protection':
          // Auth middleware coverage — covered by FIX_AUTH's middleware repair path.
          candidates.push({
            id: nextId(),
            action: 'FIX_AUTH',
            params: { issue: 'route_protection_missing' },
            reason: 'One or more protected routes have no auth middleware — running the auth-middleware repair.',
            sourceCheckId: `scan:readiness:${blocker.id}`,
          })
          break
        case 'env_vars':
        case 'webhook_security':
        case 'monitoring_basics':
        case 'security_audit':
          // These need user input (env vars, secrets) or out-of-band actions.
          uncovered.push({
            source: 'readiness',
            title: blocker.name,
            reason: blocker.message || 'Requires user input — paste the missing credential or value in chat.',
          })
          break
        default:
          uncovered.push({
            source: 'readiness',
            title: blocker.name,
            reason: blocker.message || 'No curated mapping yet.',
          })
      }
    }
  }

  // ── 3. Build-ledger failures and blocks ────────────────────────────────────
  if (ledger) {
    for (const f of ledger.failed ?? []) {
      const type = String((f as any).type ?? '').toLowerCase()
      const name = (f as any).name ?? (f as any).id ?? 'component'
      // Map ledger node type → FIX_* action. Conservative: only map types
      // with a clear single-action repair.
      if (type.includes('auth')) {
        candidates.push({
          id: nextId(),
          action: 'FIX_AUTH',
          params: { issue: 'auth_flow_broken', detail: (f as any).error?.slice?.(0, 200) },
          reason: `Auth build step "${name}" failed — re-running auth repair.`,
          sourceCheckId: `scan:ledger_failed:${name}`,
        })
      } else if (type.includes('api')) {
        candidates.push({
          id: nextId(),
          action: 'FIX_API',
          params: { tableName: name },
          reason: `API build step "${name}" failed — re-generating the endpoint.`,
          sourceCheckId: `scan:ledger_failed:${name}`,
        })
      } else if (type.includes('storage')) {
        candidates.push({
          id: nextId(),
          action: 'FIX_STORAGE',
          params: { issue: 'bucket_misconfigured', detail: name },
          reason: `Storage build step "${name}" failed — re-running storage repair.`,
          sourceCheckId: `scan:ledger_failed:${name}`,
        })
      } else if (type.includes('realtime')) {
        candidates.push({
          id: nextId(),
          action: 'FIX_REALTIME',
          params: { issue: 'realtime_misconfigured' },
          reason: `Realtime build step "${name}" failed — re-running realtime repair.`,
          sourceCheckId: `scan:ledger_failed:${name}`,
        })
      } else {
        uncovered.push({
          source: 'ledger',
          title: `Failed: ${name}`,
          reason: (f as any).error ?? 'Build step failed with no recoverable type — manual retry needed.',
        })
      }
    }
    // Blocked items always need user input (credentials)
    for (const b of ledger.blocked ?? []) {
      uncovered.push({
        source: 'ledger',
        title: `${(b as any).name ?? 'component'} blocked`,
        reason: `Waiting on ${(b as any).blockedBy ?? 'a credential'} — paste the key in chat to resume.`,
      })
    }
  }

  // ── 4. Integration partial-configuration ───────────────────────────────────
  for (const integ of integrations) {
    if (integ.status === 'partially_configured' && integ.blocking.length > 0) {
      candidates.push({
        id: nextId(),
        action: 'FIX_INTEGRATION',
        params: { integrationId: integ.integrationId, blocking: integ.blocking },
        reason: `${integ.label} is only partially wired — running the integration repair to close the workflow.`,
        sourceCheckId: `scan:integration:${integ.integrationId}`,
      })
    }
  }

  // ── 5. Proof-level structural gaps ─────────────────────────────────────────
  if (proof && !proof.nothingBuilt) {
    // 5a. Tables exist but no APIs → generate APIs for every table.
    if (proof.tables.length > 0 && proof.apis.length === 0) {
      for (const tableName of proof.tables) {
        candidates.push({
          id: nextId(),
          action: 'GENERATE_API',
          params: { tableName },
          reason: `No REST endpoint exists for "${tableName}" — generating CRUD API.`,
          sourceCheckId: `scan:missing_api:${tableName}`,
        })
      }
    }
    // 5b. Users table exists but auth disabled → enable auth.
    if (proof.tables.includes('users') && !proof.authEnabled) {
      candidates.push({
        id: nextId(),
        action: 'ENABLE_AUTH',
        params: { provider: 'email' },
        reason: 'A users table exists but authentication is not enabled — enabling JWT email/password auth.',
        sourceCheckId: 'scan:users_without_auth',
      })
    }
  }

  // ── De-dupe by (action, sourceCheckId) ────────────────────────────────────
  const seen = new Set<string>()
  const deduped = candidates.filter(c => {
    const k = `${c.action}::${c.sourceCheckId}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })

  return { candidates: deduped, uncovered }
}
