/**
 * GET  /api/projects/:id/health          — current health summary (widget data)
 * GET  /api/projects/:id/health?history  — full fix audit log
 * GET  /api/projects/:id/health?digest   — "while you were away" digest
 * POST /api/projects/:id/health/dismiss  — dismiss a finding
 */

export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { withProjectValidation } from '@/lib/middleware/projectValidation'
import { prisma } from '@/lib/db/prisma'
import { sanitizeDiagnostic } from '@/lib/errors/diagnostic-sanitize'
import { resolvePendingActionMemory } from '@/lib/operational-memory/ledger'
import { summariseFinding } from '@/lib/core/finding-summaries'

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

// ─── GET ──────────────────────────────────────────────────────────────────────

export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
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
        }),
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
    const [findings, recentAutoFixes, lastScan, project] = await Promise.all([
      prisma.healthFinding.findMany({
        where: { projectId, status: { in: ['open', 'pending_approval'] } },
        orderBy: [{ severity: 'asc' }, { detectedAt: 'desc' }],
        select: {
          id: true,
          type: true,
          severity: true,
          details: true,
          status: true,
          detectedAt: true,
        },
      }),
      // Count auto-fixes in the last 7 days
      prisma.correctionEvent.count({
        where: {
          projectId,
          correctionType: 'AI_SELF_CORRECT',
          createdAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
        },
      }),
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
        lastCheckedAt: project?.lastObservedAt ?? lastScan?.detectedAt ?? null,
        autoFixedThisWeek: recentAutoFixes,
        needsAttention: needsAction.length,
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

export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  return withProjectValidation<any>(request, async (validated) => {
    const { projectId } = validated
    try {
      const { runObserverForProject } = await import('@/lib/services/workspace-observer')
      await runObserverForProject(projectId)
    } catch (err: any) {
      return NextResponse.json(
        { success: false, error: sanitizeDiagnostic(err) || 'Health scan failed' },
        { status: 500 },
      )
    }

    // Return a fresh health summary after the scan
    const [findings, recentAutoFixes, project] = await Promise.all([
      prisma.healthFinding.findMany({
        where: { projectId, status: { in: ['open', 'pending_approval'] } },
        orderBy: [{ severity: 'asc' }, { detectedAt: 'desc' }],
        select: { id: true, type: true, severity: true, details: true, status: true, detectedAt: true },
      }),
      prisma.correctionEvent.count({
        where: {
          projectId,
          correctionType: 'AI_SELF_CORRECT',
          createdAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
        },
      }),
      // The observer we just ran stamped this — read it back rather than approximating
      prisma.project.findUnique({
        where: { id: projectId },
        select: { lastObservedAt: true },
      }),
    ])

    return NextResponse.json({
      success: true,
      data: {
        scannedAt: new Date().toISOString(),
        lastCheckedAt: project?.lastObservedAt ?? new Date().toISOString(),
        autoFixedThisWeek: recentAutoFixes,
        criticalCount: findings.filter(f => f.severity === 'critical').length,
        warningCount: findings.filter(f => f.severity === 'warning').length,
        needsAttention: findings.filter(f => f.status === 'pending_approval').length,
        // Same contract as GET: count with this, render with the array.
        actionableTotal: findings.length,
        findings: findings.slice(0, FINDINGS_PREVIEW_LIMIT),
        summary: buildHealthSummary(findings),
      },
    })
  })
}

// ─── POST /dismiss | /approve ─────────────────────────────────────────────────
// Body: { findingId: string, action?: 'dismiss' | 'approve' }
// action='approve' marks the finding as auto_fixed and records a CorrectionEvent
// so the health widget and audit log stay consistent.

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  return withProjectValidation<any>(request, async (validated) => {
    const { projectId } = validated
    const body = await request.json().catch(() => ({}))
    const { findingId, action = 'dismiss' } = body

    if (!findingId) {
      return NextResponse.json({ error: 'findingId required' }, { status: 400 })
    }

    const finding = await prisma.healthFinding.findFirst({
      where: { id: findingId, projectId },
      select: { id: true, type: true, severity: true, details: true },
    })

    if (!finding) {
      return NextResponse.json({ error: 'Finding not found' }, { status: 404 })
    }

    if (action === 'approve') {
      // Human approved the suggested fix — mark as resolved and log it
      await prisma.$transaction([
        prisma.healthFinding.update({
          where: { id: findingId },
          data: { status: 'auto_fixed', autoFixed: true },
        }),
        prisma.correctionEvent.create({
          data: {
            projectId,
            correctionType: 'HUMAN_APPROVED',
            correctionDetail: {
              findingId,
              findingType: finding.type,
              approvedAt: new Date().toISOString(),
              details: finding.details,
            },
            originalActionType: finding.type,
            errorClassification: finding.severity,
          },
        }),
      ])
    } else {
      await prisma.healthFinding.update({
        where: { id: findingId },
        data: { status: 'dismissed' },
      })
    }

    // Keep the Memory timeline in step with the Review-Queue decision so a
    // change the user acted on never lingers as "proposed" in the ledger.
    await resolvePendingActionMemory({
      projectId,
      finding,
      decision: action === 'approve' ? 'approved' : 'dismissed',
    })

    // Tier-B diagnosis precision receipt: if this finding carried an autonomous
    // diagnosis (escalation-diagnosis.ts), record whether the human accepted the
    // recommended fix (approve) or rejected it (dismiss). This is the measurable
    // "is our 3am reasoning actually good?" signal — the number the funding pitch
    // needs, and it can only be captured at decision time. Fire-and-forget.
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
            outcome: action === 'approve' ? 'accepted' : 'rejected',
            confidence: diagnosis.confidence ?? null,
            model: diagnosis.model ?? null,
            at: new Date().toISOString(),
          }),
          timestamp: new Date(),
        },
      }).catch(() => {})
    }

    return NextResponse.json({ success: true })
  })
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

