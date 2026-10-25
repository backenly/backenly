/**
 * GET  /api/projects/:id/health          — current health summary (widget data)
 * GET  /api/projects/:id/health?history  — full fix audit log
 * GET  /api/projects/:id/health?digest   — "while you were away" digest
 * POST /api/projects/:id/health/dismiss  — dismiss a finding
 */

export const dynamic = 'force-dynamic'

import { EVOLUTION_FINDING_TYPE, isEvolutionApprovalFinding } from '@/lib/core/types'
import { NextRequest, NextResponse } from 'next/server'
import { withProjectValidation } from '@/lib/middleware/projectValidation'
import { redactSecretParams } from '@/lib/mcp/withhold-secrets'
import { withHeldActions } from '@/lib/operational-memory/held-action-targets'
import { prisma } from '@/lib/db/prisma'
import { sanitizeDiagnostic } from '@/lib/errors/diagnostic-sanitize'
import { resolvePendingActionMemory } from '@/lib/operational-memory/ledger'
import { summariseFinding } from '@/lib/core/finding-summaries'
import { getLastLoopTickAt } from '@/lib/autonomy/loop-tick'
import { countRepairs, recentlyResolved } from '@/lib/autonomy/resolution'
import { loadSensorState } from '@/lib/autonomy/sensor-state'
import { countPendingAgentApprovals } from '@/lib/mcp/pending-approvals'
import { countWaitingRequests } from '@/lib/evolution-engine/request'

/**
 * How many findings the summary payload carries. A preview, not the truth —
 * `actionableTotal` / `needsAttention` are always computed from the full set.
 *
 * Was 10, which the dashboard renders as root-cause GROUPS: one bad policy
 * across nine tables is one row, so ten findings could be a single row and the
 * cap made the grouping under-count what it folded. 50 keeps the payload
 * bounded while covering any project a human would still call "a few issues".
 */
const FINDINGS_PREVIEW_LIMIT = 50

/**
 * How far back `recentlyResolved` reaches. The dashboard animates a repair the
 * moment it sees one, and it polls every few seconds while anything is open, so
 * a short window is enough; it remembers what it already showed.
 */
const RESOLVED_WINDOW_MS = 10 * 60 * 1000

const WEEK_MS = 7 * 24 * 60 * 60 * 1000

/**
 * The findings the self-healing loop's readings count. An architecture change
 * Backenly prepared is an approval request, not a broken guarantee: it waits in
 * the Review Queue and is counted on its own (`architectureRequestsPending`).
 */
const LOOP_FINDING = { status: { in: ['open', 'pending_approval'] }, type: { not: EVOLUTION_FINDING_TYPE } }

// ─── GET ──────────────────────────────────────────────────────────────────────


/**
 * A finding as it may be SERVED. Pending-action findings carry the parked
 * call's executor params in `details`; the display copy is redacted at write
 * since the sealed-params split, and this covers the legacy rows that stored
 * them raw. The sealed copy is for the approval replay, not for clients.
 */
function withServableDetails<T extends { details: unknown }>(row: T): T {
  const det = row.details as Record<string, unknown> | null
  if (!det || typeof det !== 'object' || !('executorParams' in det)) return row
  return {
    ...row,
    details: { ...det, executorParams: redactSecretParams(det.executorParams), executorParamsSealed: undefined },
  }
}

/**
 * Findings as they may be served, with a regional project's held actions read
 * back from its region: their target and arguments are what the approver
 * decides on (lib/operational-memory/held-action-targets.ts).
 */
async function servable<T extends { id: string; details: unknown }>(projectId: string, rows: T[]): Promise<T[]> {
  return (await withHeldActions(projectId, rows)).map(withServableDetails)
}

export async function GET(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params
  return withProjectValidation<any>(request, async (validated) => {
    const { projectId } = validated
    const url = new URL(request.url)

    // ?history — full audit log of every auto-fix ever applied
    if (url.searchParams.has('history')) {
      const events = await prisma.correctionEvent.findMany({
        where: { projectId },
        orderBy: { createdAt: 'desc' },
        take: 100,
        select: {
          id: true,
          correctionType: true,
          correctionDetail: true,
          domain: true,
          createdAt: true,
          originalActionType: true,
        },
      })
      return NextResponse.json({ success: true, data: events })
    }

    // ?digest — activity since lastLogin (for "while you were away" banner)
    if (url.searchParams.has('digest')) {
      const since = url.searchParams.get('since')
        ? new Date(url.searchParams.get('since')!)
        : new Date(Date.now() - 12 * 60 * 60 * 1000)

      const [autoFixed, pendingApproval, notifications] = await Promise.all([
        prisma.correctionEvent.findMany({
          where: {
            projectId,
            createdAt: { gte: since },
            correctionType: 'AI_SELF_CORRECT',
          },
          orderBy: { createdAt: 'desc' },
          take: 20,
          select: {
            id: true,
            correctionDetail: true,
            createdAt: true,
          },
        }),
        prisma.healthFinding.findMany({
          where: {
            projectId,
            status: 'pending_approval',
            detectedAt: { gte: since },
          },
          select: {
            id: true,
            type: true,
            severity: true,
            details: true,
            detectedAt: true,
          },
        }).then(rows => servable(projectId, rows)),
        prisma.platformNotification.findMany({
          where: {
            metadata: { path: ['projectId'], equals: projectId },
            createdAt: { gte: since },
            readAt: null,
          },
          orderBy: { createdAt: 'desc' },
          take: 10,
          select: { id: true, title: true, body: true, createdAt: true, type: true },
        }),
      ])

      return NextResponse.json({
        success: true,
        data: { autoFixed, pendingApproval, notifications, since: since.toISOString() },
      })
    }

    // Default: health summary for the dashboard widget
    const [findings, repairs, resolved, sensors, lastScan, project, lastLoopTick, agentApprovals, architectureRequests] = await Promise.all([
      prisma.healthFinding.findMany({
        where: { projectId, ...LOOP_FINDING },
        orderBy: [{ severity: 'asc' }, { detectedAt: 'desc' }],
        select: {
          id: true,
          type: true,
          severity: true,
          details: true,
          status: true,
          detectedAt: true,
        },
      }).then(rows => servable(projectId, rows)),
      // Repairs in the last 7 days, split by whether a re-check confirmed them.
      // Only the confirmed ones may be called fixed.
      countRepairs(projectId, new Date(Date.now() - WEEK_MS)),
      // How each recently closed finding closed — the only basis a surface has
      // for saying something was fixed (lib/autonomy/resolution.ts).
      recentlyResolved(projectId, new Date(Date.now() - RESOLVED_WINDOW_MS)),
      // Which checks the loop's last pass could actually run.
      loadSensorState(projectId),
      // Fallback for projects whose last scan predates the lastObservedAt column
      prisma.healthFinding.findFirst({
        where: { projectId },
        orderBy: { detectedAt: 'desc' },
        select: { detectedAt: true },
      }),
      prisma.project.findUnique({
        where: { id: projectId },
        select: { lastObservedAt: true },
      }),
      // The per-minute loop's own clock. Deliberately NOT folded into
      // lastObservedAt below — see lib/autonomy/loop-tick.ts for why conflating
      // the daily observer with the per-minute reconciler is the bug this fixes.
      getLastLoopTickAt(projectId),
      // The other queue that waits on the owner: calls their coding agent
      // parked for approval. Not findings, so not in `findings` or
      // `needsAttention`, and counted where every surface can read it.
      countPendingAgentApprovals(projectId).catch(() => 0),
      // Architecture changes Backenly prepared, waiting in the same queue.
      countWaitingRequests(projectId).catch(() => 0),
    ])

    const critical = findings.filter(f => f.severity === 'critical')
    const warnings = findings.filter(f => f.severity === 'warning')
    const needsAction = findings.filter(f => f.status === 'pending_approval')

    // No completion stamp yet — either never scanned, or last scanned before the
    // lastObservedAt column existed. Kick a background scan: it stamps the project
    // (self-healing the missing timestamp) and the next page load shows real data
    // instead of "Last checked: Never" + fake green.
    if (project?.lastObservedAt == null) {
      Promise.resolve().then(async () => {
        try {
          const { runObserverForProject } = await import('@/lib/services/workspace-observer')
          await runObserverForProject(projectId)
        } catch { /* non-fatal — scan is best-effort */ }
      })
    }

    return NextResponse.json({
      success: true,
      data: {
        // Last DEEP observer sweep (daily). Not the self-healing cadence.
        lastCheckedAt: project?.lastObservedAt ?? lastScan?.detectedAt ?? null,
        // Last self-healing loop pass (per-minute on every plan). null means the
        // loop has not run for this project inside the lookback — surface that,
        // never substitute lastCheckedAt for it.
        lastReconciledAt: lastLoopTick ? lastLoopTick.toISOString() : null,
        // Repairs a re-check confirmed. Repairs that ran but could not be
        // confirmed are counted separately and must never be shown as fixes.
        autoFixedThisWeek: repairs.verified,
        unverifiedRepairsThisWeek: repairs.unverified,
        needsAttention: needsAction.length,
        // Agent requests parked for approval, waiting in the Review Queue on
        // the Autonomy page. Kept apart from needsAttention, which counts held
        // FINDINGS (actionableTotal - needsAttention is the open findings).
        // The Overview and the top bar read both; they read only the findings
        // before, so a parked deploy or drop was invisible there (OV-1, AUT-08).
        agentApprovalsPending: agentApprovals,
        // Architecture changes Backenly prepared, waiting for approval in the
        // same queue. Not broken guarantees, so in neither count above.
        architectureRequestsPending: architectureRequests,
        criticalCount: critical.length,
        warningCount: warnings.length,
        // Uncapped count of everything still needing attention. `findings` below
        // is a TRUNCATED preview, but every sibling count here is computed from
        // the full set — a caller that measured the array instead got a number
        // that silently stopped at the cap. The dashboard's Detect node did
        // exactly that: it read `findings.length` (max 10) while the Propose
        // node read the uncapped approval list, so a project with more than ten
        // open findings rendered "10 need attention · 14 of those held for you".
        // Callers must count with this field and render with the array.
        actionableTotal: findings.length,
        findings: findings.slice(0, FINDINGS_PREVIEW_LIMIT),
        // How findings that recently left the queue left it. A surface that
        // says "fixed" reads `closedBy` here; it never infers a fix from a
        // finding disappearing between two polls.
        recentlyResolved: resolved,
        // What the loop's last pass could check. A surface may say "no issues"
        // only for checks that ran; errored or disabled checks are blind.
        sensors,
        // Categorical summary for the dashboard widget rows
        summary: buildHealthSummary(findings),
      },
    })
  })
}

// ─── PATCH — trigger an immediate health scan ─────────────────────────────────
// Body: (empty) — runs the observer and returns a fresh health summary.
// Useful when: user just fixed an issue and wants to confirm it without waiting
// for the daily cron cycle.

export async function PATCH(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params
  return withProjectValidation<any>(request, async (validated) => {
    const { projectId } = validated
    let skipped: { reason: 'served-elsewhere' | 'unreachable'; region: string | null } | null = null
    try {
      const { runObserverForProject } = await import('@/lib/services/workspace-observer')
      const observed = await runObserverForProject(projectId)
      // A project another region serves is checked by that region's worker on
      // its schedule, and one this process cannot reach is not checked at all:
      // nothing was scanned now, and the answer says so instead of a scan time.
      if (observed.skipped) skipped = { reason: observed.skipped, region: observed.region ?? null }
    } catch (err: any) {
      return NextResponse.json(
        { success: false, error: sanitizeDiagnostic(err) || 'Health scan failed' },
        { status: 500 },
      )
    }

    // Return a fresh health summary after the scan
    const [findings, repairs, resolved, sensors, project, lastLoopTick] = await Promise.all([
      prisma.healthFinding.findMany({
        where: { projectId, ...LOOP_FINDING },
        orderBy: [{ severity: 'asc' }, { detectedAt: 'desc' }],
        select: { id: true, type: true, severity: true, details: true, status: true, detectedAt: true },
      }).then(rows => servable(projectId, rows)),
      countRepairs(projectId, new Date(Date.now() - WEEK_MS)),
      recentlyResolved(projectId, new Date(Date.now() - RESOLVED_WINDOW_MS)),
      loadSensorState(projectId),
      // The observer we just ran stamped this — read it back rather than approximating
      prisma.project.findUnique({
        where: { id: projectId },
        select: { lastObservedAt: true },
      }),
      // Unchanged by this scan: running the observer on demand does not tick the
      // reconciler. Same field as GET so the two responses share one contract.
      getLastLoopTickAt(projectId),
    ])

    return NextResponse.json({
      success: true,
      data: {
        scannedAt: skipped ? null : new Date().toISOString(),
        lastCheckedAt: project?.lastObservedAt ?? (skipped ? null : new Date().toISOString()),
        ...(skipped ? { notScanned: skipped } : {}),
        lastReconciledAt: lastLoopTick ? lastLoopTick.toISOString() : null,
        autoFixedThisWeek: repairs.verified,
        unverifiedRepairsThisWeek: repairs.unverified,
        criticalCount: findings.filter(f => f.severity === 'critical').length,
        warningCount: findings.filter(f => f.severity === 'warning').length,
        needsAttention: findings.filter(f => f.status === 'pending_approval').length,
        // Same contract as GET: count with this, render with the array.
        actionableTotal: findings.length,
        findings: findings.slice(0, FINDINGS_PREVIEW_LIMIT),
        recentlyResolved: resolved,
        sensors,
        summary: buildHealthSummary(findings),
      },
    })
  })
}

// ─── POST /dismiss ────────────────────────────────────────────────────────────
// Body: { findingId: string, action?: 'dismiss' }
//
// Approving a fix is POST /health/approve, which runs the repair and records it
// as fixed only when a re-check confirms it. This route used to accept
// action='approve' too and mark the finding fixed without running anything;
// that is refused now, so the only way a finding becomes "fixed" is through a
// repair that actually ran.

export async function POST(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params
  return withProjectValidation<any>(request, async (validated) => {
    const { projectId } = validated
    const body = await request.json().catch(() => ({}))
    const { findingId, action = 'dismiss' } = body

    if (!findingId) {
      return NextResponse.json({ error: 'findingId required' }, { status: 400 })
    }

    if (action !== 'dismiss') {
      return NextResponse.json(
        {
          error:
            'This route only dismisses findings. To apply a fix, use POST /health/approve, ' +
            'which runs the repair and records it as fixed only when a re-check confirms it.',
        },
        { status: 400 },
      )
    }

    const finding = await prisma.healthFinding.findFirst({
      where: { id: findingId, projectId },
      select: { id: true, type: true, severity: true, details: true },
    })

    if (!finding) {
      return NextResponse.json({ error: 'Finding not found' }, { status: 404 })
    }

    // Declining an architecture change is a decision Backenly remembers, and
    // it is made where approving it is: POST /architecture { action: 'dismiss' },
    // at the same role floor. This route's floor is lower.
    if (isEvolutionApprovalFinding(finding.type)) {
      return NextResponse.json(
        { error: 'Architecture changes are decided on the Autonomy page, by an organization admin.' },
        { status: 409 },
      )
    }

    const details = (finding.details ?? {}) as Record<string, unknown>
    // The time is recorded so the closure can be told apart from a repair
    // (lib/autonomy/resolution.ts) and placed on a timeline.
    const dismissed = { status: 'dismissed', details: { ...details, dismissedAt: new Date().toISOString() } as any }
    await prisma.healthFinding.update({ where: { id: findingId }, data: dismissed })

    // Keep the Memory timeline in step with the Review-Queue decision so a
    // change the user acted on never lingers as "proposed" in the ledger.
    await resolvePendingActionMemory({
      projectId,
      finding,
      decision: 'dismissed',
    })

    // Tier-B diagnosis precision receipt: if this finding carried an autonomous
    // diagnosis (escalation-diagnosis.ts), record that the human dismissed it.
    // The accepted side is recorded where a fix is actually approved
    // (/health/approve). Fire-and-forget.
    const diagnosis = ((finding.details ?? {}) as Record<string, unknown>).diagnosis as
      | { confidence?: string; model?: string }
      | undefined
    if (diagnosis) {
      prisma.auditLog.create({
        data: {
          projectId,
          action: 'AUTONOMY_DIAGNOSIS_OUTCOME',
          type: 'autonomy',
          details: JSON.stringify({
            findingId,
            findingType: finding.type,
            outcome: 'rejected',
            confidence: diagnosis.confidence ?? null,
            model: diagnosis.model ?? null,
            at: new Date().toISOString(),
          }),
          timestamp: new Date(),
        },
      }).catch(() => {})
    }

    return NextResponse.json({ success: true })
  }, { floor: 'write' })
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

type FindingRow = { type: string; severity: string; status: string; details: any }

function buildHealthSummary(findings: FindingRow[]) {
  const byType = new Map<string, FindingRow[]>()
  for (const f of findings) {
    const arr = byType.get(f.type) ?? []
    arr.push(f)
    byType.set(f.type, arr)
  }

  const categories = [
    {
      key: 'schema',
      label: 'Schema integrity',
      types: ['missing_fk', 'missing_fk_index', 'shadow_mutation', 'orphan_table'],
    },
    {
      key: 'auth',
      label: 'Auth integrity',
      types: ['auth_spike', 'auth_jwt_missing', 'auth_users_table_missing', 'oauth_redirect_uri_missing', 'rls_expression_invalid'],
    },
    {
      key: 'integrations',
      label: 'Integrations',
      types: ['broken_webhook'],
    },
    {
      key: 'api',
      label: 'API coverage',
      types: ['api_drift', 'missing_api_definition', 'missing_api_crud', 'dead_api_endpoint'],
    },
    {
      key: 'rls',
      label: 'RLS policies',
      types: ['missing_rls', 'unprotected_user_data'],
    },
  ]

  return categories.map(cat => {
    const catFindings = cat.types.flatMap(t => byType.get(t) ?? [])
    const critical = catFindings.some(f => f.severity === 'critical')
    const warning = catFindings.length > 0

    let status: 'ok' | 'warning' | 'critical' = 'ok'
    // Phase 0 trust hotfix: "Clean" overclaimed — until Phase 7 verification runs,
    // we only know there are no open findings, not that the category is verified.
    let message = 'No issues detected'

    if (critical) {
      status = 'critical'
      const f = catFindings.find(f => f.severity === 'critical')!
      message = summariseFinding(f.type, f.details)
    } else if (warning) {
      status = 'warning'
      message = catFindings.length === 1
        ? summariseFinding(catFindings[0].type, catFindings[0].details)
        : `${catFindings.length} issues`
    }

    return { key: cat.key, label: cat.label, status, message, count: catFindings.length }
  })
}

