'use client'

/**
 * Built-vs-Missing Card (Phase 0 trust hotfix)
 * --------------------------------------------
 * Pairs the resource counts already exposed by /api/projects/[id]/state with
 * the open HealthFinding records exposed by /api/projects/[id]/health, so the
 * dashboard stops showing only what was built and starts honestly showing
 * what still needs attention.
 *
 * Source of truth:
 *   • Built side    → /api/projects/[id]/state  (entities, apis, capabilities)
 *   • Missing side  → /api/projects/[id]/health (open + pending_approval findings)
 *
 * Phase 9 will replace this with the layered Workflow Readiness card. For now
 * this is intentionally a small, drop-in widget that uses only data the
 * platform already produces.
 */

import { useEffect, useState } from 'react'
import { CheckCircle2, AlertTriangle, AlertCircle } from 'lucide-react'

interface StateSnapshot {
  entities?: unknown[]
  apis?: unknown[]
  capabilities?: string[]
  hasContent?: boolean
}

interface HealthFindingRow {
  id: string
  type: string
  severity: 'critical' | 'warning' | 'info'
  details: Record<string, unknown>
  status: string
  detectedAt: string
}

interface HealthData {
  needsAttention?: number
  criticalCount?: number
  warningCount?: number
  findings?: HealthFindingRow[]
}

interface Props {
  projectId: string
}

const FINDING_LABELS: Record<string, (d: any) => string> = {
  missing_rls: (d) => `Add RLS to "${d.tableName ?? '?'}"`,
  missing_fk: (d) => `Add FK constraint on "${d.tableName ?? '?'}.${d.column ?? d.columnName ?? '?'}"`,
  missing_fk_index: (d) => `Add index on FK "${d.tableName ?? '?'}.${d.column ?? d.columnName ?? '?'}"`,
  api_drift: (d) => `Re-sync API for "${d.tableName ?? '?'}"`,
  missing_api_definition: (d) => `Generate API for "${d.tableName ?? '?'}"`,
  missing_api_crud: (d) => `Complete CRUD for "${d.tableName ?? '?'}"`,
  dead_api_endpoint: (d) => `Remove dead endpoint "${d.path ?? '?'}"`,
  broken_webhook: () => `Webhook delivery failing — needs your action`,
  broken_auth: () => `Auth flow broken — needs your action`,
  auth_spike: (d) => `Auth error spike (${d.errorCount ?? '?'} in ${d.windowMinutes ?? '?'}m)`,
  auth_jwt_missing: () => `JWT secret not configured`,
  auth_users_table_missing: () => `Auth users table not provisioned`,
  oauth_redirect_uri_missing: (d) => `OAuth redirect URI missing for "${d.provider ?? '?'}"`,
  oauth_config_invalid: (d) => `OAuth config invalid for "${d.provider ?? '?'}"`,
  rls_expression_invalid: (d) => `RLS expression invalid on "${d.tableName ?? '?'}"`,
  unprotected_user_data: (d) => `User data unprotected on "${d.tableName ?? '?'}"`,
  integration_key_invalid: (d) => `Integration key invalid: ${d.integrationId ?? d.integration ?? '?'}`,
  integration_webhook_failing: (d) => `Webhook failing: ${d.integrationId ?? '?'}`,
  integration_smtp_unreachable: () => `SMTP server unreachable`,
  workflow_broken: (d) => `Workflow "${d.workflow ?? '?'}" broken: ${d.reason ?? 'check trigger'}`,
  orphan_table: (d) => `Orphan table: "${d.tableName ?? '?'}"`,
  shadow_mutation: (d) => `Shadow mutation detected on "${d.tableName ?? '?'}"`,
  realtime_gap: (d) => `Realtime gap on "${d.tableName ?? '?'}"`,
  missing_rate_limit: (d) => `Add rate limit to "${d.path ?? '?'}"`,
  deploy_failure: () => `Deployment failed — check deploy logs`,
}

function describeFinding(f: HealthFindingRow): string {
  const fn = FINDING_LABELS[f.type]
  if (fn) return fn(f.details)
  return f.type.replace(/_/g, ' ')
}

export function BuiltVsMissingCard({ projectId }: Props) {
  const [state, setState] = useState<StateSnapshot | null>(null)
  const [health, setHealth] = useState<HealthData | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      try {
        const [stateRes, healthRes] = await Promise.all([
          fetch(`/api/projects/${projectId}/state`, { credentials: 'include' }),
          fetch(`/api/projects/${projectId}/health`, { credentials: 'include' }),
        ])
        if (cancelled) return
        if (stateRes.ok) {
          const json = await stateRes.json()
          setState(json)
        }
        if (healthRes.ok) {
          const json = await healthRes.json()
          setHealth(json.data)
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [projectId])

  if (loading) {
    return (
      <div className="rounded-xl border border-white/[0.06] bg-[#0c0c0e] p-4 animate-pulse">
        <div className="h-3 w-32 bg-white/[0.04] rounded mb-3" />
        <div className="h-2 w-full bg-white/[0.03] rounded mb-2" />
        <div className="h-2 w-2/3 bg-white/[0.03] rounded" />
      </div>
    )
  }

  // Hide the card when the project has no content yet — avoid rendering an
  // empty "Built" column and an empty "Needs Attention" column on day zero.
  const hasAnyState = (state?.entities?.length ?? 0) > 0 || (state?.apis?.length ?? 0) > 0
  const hasAnyFindings = (health?.findings?.length ?? 0) > 0
  if (!hasAnyState && !hasAnyFindings) return null

  const tableCount = state?.entities?.length ?? 0
  const apiCount = state?.apis?.length ?? 0
  const capabilities = state?.capabilities ?? []
  const findings = (health?.findings ?? []).slice(0, 6)
  const overflow = (health?.findings?.length ?? 0) - findings.length

  return (
    <div className="rounded-xl border border-white/[0.06] bg-[#0c0c0e] overflow-hidden">
      <div className="px-4 py-3 border-b border-white/[0.06]">
        <span className="text-sm font-semibold text-white">Built vs Needs Attention</span>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 divide-y md:divide-y-0 md:divide-x divide-white/[0.04]">
        {/* Built side */}
        <div className="p-4 space-y-2.5">
          <div className="text-[10px] font-semibold text-emerald-400/80 uppercase tracking-wider mb-1">Built</div>
          <BuiltRow label="Tables" count={tableCount} />
          <BuiltRow label="API resources" count={apiCount} />
          {capabilities.includes('auth') && (
            <div className="flex items-center gap-2 text-[12px] text-zinc-300">
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500/80" />
              JWT auth enabled
            </div>
          )}
          {capabilities.includes('storage') && (
            <div className="flex items-center gap-2 text-[12px] text-zinc-300">
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500/80" />
              Storage configured
            </div>
          )}
          {capabilities.includes('realtime') && (
            <div className="flex items-center gap-2 text-[12px] text-zinc-300">
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500/80" />
              Realtime enabled
            </div>
          )}
          {!hasAnyState && (
            <div className="text-[12px] text-zinc-500 italic">Nothing built yet — describe your backend to your connected coding agent.</div>
          )}
        </div>

        {/* Needs Attention side */}
        <div className="p-4 space-y-2">
          <div className="text-[10px] font-semibold text-amber-500/80 uppercase tracking-wider mb-1">Needs Attention</div>
          {!hasAnyFindings && (
            <div className="text-[12px] text-zinc-500 italic">No open findings detected.</div>
          )}
          {findings.map(f => (
            <div key={f.id} className="flex items-start gap-2 text-[12px]">
              {f.severity === 'critical' ? (
                <AlertCircle className="w-3.5 h-3.5 text-red-400 flex-shrink-0 mt-0.5" />
              ) : (
                <AlertTriangle className="w-3.5 h-3.5 text-amber-500 flex-shrink-0 mt-0.5" />
              )}
              <span className="text-zinc-300 leading-snug">{describeFinding(f)}</span>
            </div>
          ))}
          {overflow > 0 && (
            <div className="text-[11px] text-zinc-500 pl-5">+{overflow} more — see Monitoring</div>
          )}
        </div>
      </div>
    </div>
  )
}

function BuiltRow({ label, count }: { label: string; count: number }) {
  if (count <= 0) return null
  return (
    <div className="flex items-center gap-2 text-[12px] text-zinc-300">
      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500/80" />
      <span>{count} {label}</span>
    </div>
  )
}
