// lib/ai/frontend-coevolution.ts
/**
 * FRONTEND-RUNTIME COEVOLUTION
 * =============================
 * The backend evolves automatically when frontend usage patterns change.
 *
 * Core idea:
 *   The frontend SDK reports which API fields it accesses per request.
 *   When the backend notices patterns — missing fields, unused fields, frequent
 *   field-not-found responses — it proposes schema / API changes and, for purely
 *   additive (non-breaking) SQL, auto-applies them.
 *
 * Storage:
 *   Usage events are stored as a JSON array inside
 *   project.architecturalMemory["frontendTelemetry"]. Capped at 500 events
 *   (oldest rotated out). Same blob pattern used throughout project-memory.ts.
 *
 * Safety guardrails:
 *   - autoApprove ONLY for additive SQL (ADD COLUMN), never for drops/alters.
 *   - Auth/payment tables always require approval regardless of change type.
 *   - applyAutoApprovedProposals never throws — failures are logged only.
 */

import { loadProjectMemory, saveProjectMemory } from '@/lib/ai/project-memory'
import { getWorkspaceDatabaseNames } from '@/lib/services/databaseProvisioning'
import { prisma } from '@/lib/db/prisma'
import { Pool } from 'pg'

// ── Public types ─────────────────────────────────────────────────────────────

export interface ApiUsageEvent {
  endpoint: string
  method: string
  tableName: string
  fieldsRead: string[]
  fieldsMissed: string[]
  responseStatus: number
  timestamp: string
}

export interface CoevolutionGap {
  tableName: string
  gapType: 'missing_field' | 'unused_field' | 'type_mismatch' | 'missing_table' | 'missing_endpoint'
  fieldName?: string
  occurrences: number
  firstSeenAt: string
  lastSeenAt: string
  confidence: number
  proposal?: CoevolutionProposal
}

export interface CoevolutionProposal {
  title: string
  sql?: string
  action: string
  autoApprove: boolean
  rationale: string
}

export interface CoevolutionReport {
  projectId: string
  analyzedAt: string
  totalEvents: number
  gaps: CoevolutionGap[]
  autoApprovedCount: number
  pendingApprovalCount: number
  topMissingFields: Array<{ table: string; field: string; occurrences: number }>
}

// ── Sensitive tables that must never be auto-altered ─────────────────────────

const PROTECTED_TABLES = new Set([
  'users', 'user', 'accounts', 'account',
  'sessions', 'session', 'tokens', 'token',
  'payments', 'payment', 'orders', 'order',
  'invoices', 'invoice', 'subscriptions', 'subscription',
  'billing', 'charges', 'charge',
  'api_keys', 'api_key', 'secrets', 'secret',
  'audit_logs', 'audit_log',
])

function isProtectedTable(tableName: string): boolean {
  return PROTECTED_TABLES.has(tableName.toLowerCase())
}

// ── Memory accessors (frontendTelemetry sub-key) ──────────────────────────────

/** Maximum number of telemetry events to retain per project. */
const MAX_EVENTS = 500

async function loadTelemetry(projectId: string): Promise<ApiUsageEvent[]> {
  const memory = await loadProjectMemory(projectId)
  const raw = (memory as any).frontendTelemetry
  if (Array.isArray(raw)) return raw as ApiUsageEvent[]
  return []
}

async function saveTelemetry(projectId: string, events: ApiUsageEvent[]): Promise<void> {
  // We write directly into the architecturalMemory JSON blob so that the
  // existing ProjectMemory typed shape is not disturbed.
  const memory = await loadProjectMemory(projectId)
  ;(memory as any).frontendTelemetry = events
  await saveProjectMemory(projectId, memory)
}

// ── recordApiUsageEvent ───────────────────────────────────────────────────────

/**
 * Append one usage event to the project's telemetry store.
 * Fire-and-forget safe — never throws.
 */
export async function recordApiUsageEvent(
  projectId: string,
  event: ApiUsageEvent,
): Promise<void> {
  try {
    const events = await loadTelemetry(projectId)
    events.push(event)

    // Rotate oldest if over cap
    const capped = events.length > MAX_EVENTS ? events.slice(events.length - MAX_EVENTS) : events

    await saveTelemetry(projectId, capped)
  } catch (err: any) {
    console.warn('[CoEvolution] recordApiUsageEvent failed (non-fatal):', err?.message)
  }
}

// ── analyzeCoevolutionGaps ────────────────────────────────────────────────────

/**
 * Analyse stored telemetry events and produce a CoevolutionReport.
 * Requires at least 5 events before producing gaps.
 */
export async function analyzeCoevolutionGaps(projectId: string): Promise<CoevolutionReport> {
  const analyzedAt = new Date().toISOString()
  const emptyReport: CoevolutionReport = {
    projectId,
    analyzedAt,
    totalEvents: 0,
    gaps: [],
    autoApprovedCount: 0,
    pendingApprovalCount: 0,
    topMissingFields: [],
  }

  try {
    const events = await loadTelemetry(projectId)

    if (events.length < 5) return emptyReport

    const totalEvents = events.length

    // ── Step 1: Aggregate miss counts per (table, field) ────────────────────

    interface FieldMiss {
      occurrences: number
      firstSeenAt: string
      lastSeenAt: string
    }

    // Key: `${tableName}::${fieldName}`
    const missCounts = new Map<string, FieldMiss>()
    // Track which tables have appeared at all in requests
    const knownTables = new Set<string>()

    for (const event of events) {
      if (event.tableName) knownTables.add(event.tableName)

      for (const field of event.fieldsMissed ?? []) {
        const key = `${event.tableName}::${field}`
        const existing = missCounts.get(key)
        if (existing) {
          existing.occurrences += 1
          if (event.timestamp < existing.firstSeenAt) existing.firstSeenAt = event.timestamp
          if (event.timestamp > existing.lastSeenAt) existing.lastSeenAt = event.timestamp
        } else {
          missCounts.set(key, {
            occurrences: 1,
            firstSeenAt: event.timestamp,
            lastSeenAt: event.timestamp,
          })
        }
      }
    }

    // ── Step 2: Fetch existing columns from information_schema ───────────────

    let knownColumns: Map<string, Set<string>> = new Map()
    try {
      const { postgresSchema } = getWorkspaceDatabaseNames(projectId)
      const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 })
      try {
        const result = await pool.query<{ table_name: string; column_name: string }>(
          `SELECT table_name, column_name
             FROM information_schema.columns
            WHERE table_schema = $1`,
          [postgresSchema],
        )
        for (const row of result.rows) {
          const tbl = row.table_name.toLowerCase()
          if (!knownColumns.has(tbl)) knownColumns.set(tbl, new Set())
          knownColumns.get(tbl)!.add(row.column_name.toLowerCase())
        }
      } finally {
        await pool.end()
      }
    } catch {
      // If column lookup fails, treat all as unknown — analysis continues with empty map
    }

    // ── Step 3: Build gaps ────────────────────────────────────────────────────

    const gaps: CoevolutionGap[] = []

    const totalRequests = totalEvents

    for (const [key, stats] of missCounts.entries()) {
      if (stats.occurrences < 3) continue

      const [tableName, fieldName] = key.split('::')
      const confidence = Math.min(stats.occurrences / totalRequests, 1)

      // Detect whether the whole table is unknown (missing_table) vs just the field
      const tableExists = knownColumns.has(tableName.toLowerCase())

      if (!tableExists) {
        // Whole table is missing
        const alreadyAdded = gaps.find(g => g.tableName === tableName && g.gapType === 'missing_table')
        if (!alreadyAdded) {
          gaps.push({
            tableName,
            gapType: 'missing_table',
            occurrences: stats.occurrences,
            firstSeenAt: stats.firstSeenAt,
            lastSeenAt: stats.lastSeenAt,
            confidence,
            proposal: buildProposal('missing_table', tableName, undefined),
          })
        }
        continue
      }

      // Field missing in existing table
      const fieldExists = knownColumns.get(tableName.toLowerCase())?.has(fieldName.toLowerCase()) ?? false
      if (!fieldExists) {
        gaps.push({
          tableName,
          gapType: 'missing_field',
          fieldName,
          occurrences: stats.occurrences,
          firstSeenAt: stats.firstSeenAt,
          lastSeenAt: stats.lastSeenAt,
          confidence,
          proposal: buildProposal('missing_field', tableName, fieldName),
        })
      }
    }

    // ── Step 4: Sort by occurrences desc ─────────────────────────────────────

    gaps.sort((a, b) => b.occurrences - a.occurrences)

    // ── Step 5: Compute report metadata ──────────────────────────────────────

    const autoApprovedCount = gaps.filter(g => g.proposal?.autoApprove).length
    const pendingApprovalCount = gaps.filter(g => g.proposal && !g.proposal.autoApprove).length

    const topMissingFields = gaps
      .filter(g => g.gapType === 'missing_field' && g.fieldName)
      .slice(0, 10)
      .map(g => ({ table: g.tableName, field: g.fieldName!, occurrences: g.occurrences }))

    return {
      projectId,
      analyzedAt,
      totalEvents,
      gaps,
      autoApprovedCount,
      pendingApprovalCount,
      topMissingFields,
    }
  } catch (err: any) {
    console.error('[CoEvolution] analyzeCoevolutionGaps error:', err?.message)
    return emptyReport
  }
}

// ── applyAutoApprovedProposals ────────────────────────────────────────────────

/**
 * Execute all auto-approved SQL proposals against the workspace schema.
 * Records each applied fix as a HealthFinding with type 'coevolution_fix'.
 * Never throws.
 *
 * @returns Array of human-readable descriptions of applied fixes.
 */
export async function applyAutoApprovedProposals(
  projectId: string,
  report: CoevolutionReport,
): Promise<string[]> {
  const applied: string[] = []

  const { postgresSchema } = getWorkspaceDatabaseNames(projectId)

  for (const gap of report.gaps) {
    if (!gap.proposal?.autoApprove || !gap.proposal.sql) continue

    const sql = gap.proposal.sql.trim()
    if (!sql) continue

    // Extra safety: never auto-apply to protected tables
    if (isProtectedTable(gap.tableName)) continue

    const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 })
    try {
      // Scope the SQL to the correct schema by setting search_path for this connection
      await pool.query(`SET search_path TO "${postgresSchema}", public`)
      await pool.query(sql)

      const description = gap.proposal.title || `Added ${gap.fieldName ?? gap.gapType} to ${gap.tableName}`
      applied.push(description)

      // Record in HealthFinding
      try {
        await prisma.healthFinding.create({
          data: {
            projectId,
            type: 'coevolution_fix',
            severity: 'info',
            status: 'auto_fixed',
            autoFixed: true,
            fixAppliedAt: new Date(),
            details: {
              tableName: gap.tableName,
              fieldName: gap.fieldName ?? null,
              gapType: gap.gapType,
              sql,
              occurrences: gap.occurrences,
              confidence: gap.confidence,
              description,
            },
          },
        })
      } catch (hfErr: any) {
        console.warn('[CoEvolution] HealthFinding create failed (non-fatal):', hfErr?.message)
      }
    } catch (sqlErr: any) {
      console.warn(
        `[CoEvolution] Auto-apply failed for ${gap.tableName}.${gap.fieldName ?? gap.gapType}:`,
        sqlErr?.message,
      )
    } finally {
      await pool.end().catch(() => {})
    }
  }

  return applied
}

// ── Proposal builder ──────────────────────────────────────────────────────────

function buildProposal(
  gapType: CoevolutionGap['gapType'],
  tableName: string,
  fieldName: string | undefined,
): CoevolutionProposal {
  const safeToAutoApprove = !isProtectedTable(tableName)

  switch (gapType) {
    case 'missing_field': {
      const col = sanitizeIdentifier(fieldName ?? 'new_field')
      return {
        title: `Add column "${col}" to "${tableName}"`,
        action: 'ADD_COLUMN',
        sql: `ALTER TABLE "${tableName}" ADD COLUMN IF NOT EXISTS "${col}" TEXT;`,
        autoApprove: safeToAutoApprove,
        rationale: `Frontend requested the field "${col}" on "${tableName}" ${3}+ times but it is not in the current schema.`,
      }
    }

    case 'missing_table': {
      return {
        title: `Create table "${tableName}"`,
        action: 'ADD_TABLE',
        autoApprove: false, // Table creation always needs design review
        rationale: `Frontend accessed an endpoint for table "${tableName}" which does not exist yet. Manual schema design required.`,
      }
    }

    case 'missing_endpoint': {
      return {
        title: `Generate REST endpoint for "${tableName}"`,
        action: 'ADD_ENDPOINT',
        autoApprove: false,
        rationale: `Requests to "${tableName}" are returning 404 because no REST API is configured. Use the AI chat to generate one.`,
      }
    }

    default: {
      return {
        title: `Review usage pattern on "${tableName}"`,
        action: 'ADD_COLUMN',
        autoApprove: false,
        rationale: `Unusual field access pattern detected on "${tableName}". Manual review recommended.`,
      }
    }
  }
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function sanitizeIdentifier(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/^[^a-z_]/, '_$&')
    .slice(0, 63)
}

// ── AuditLog-based signal analysis (no SDK required) ─────────────────────────

/**
 * Analyse AuditLog entries to detect usage patterns without SDK instrumentation.
 * Looks at call frequency, failure rates, and large result sets.
 * Complements the SDK telemetry approach above.
 *
 * This path needs no frontend changes — it derives signals from what already exists.
 */
export async function analyzeAuditLogSignals(
  projectId: string,
  windowDays = 7,
): Promise<Array<{ type: string; tableName: string; evidence: string; sqlFix?: string; requiresApproval: boolean }>> {
  const findings: Array<{ type: string; tableName: string; evidence: string; sqlFix?: string; requiresApproval: boolean }> = []
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000)

  try {
    const logs = await prisma.auditLog.findMany({
      where: {
        projectId,
        timestamp: { gte: since },
        OR: [
          { action: { startsWith: 'API_CALL:' } },
          { action: { startsWith: 'v1:' } },
          { type: 'api_call' },
        ],
      },
      select: { action: true, details: true, timestamp: true },
      take: 5000,
    }).catch(() => [] as any[])

    if (logs.length < 10) return findings

    // Group by table
    const tableStats = new Map<string, { calls: number; failures: number; rowSums: number; rowCount: number; params: Map<string, number> }>()

    for (const log of logs) {
      let tableName = ''
      let failed = false
      let rows = 0
      let params: string[] = []
      try {
        const d = typeof log.details === 'string' ? JSON.parse(log.details) : (log.details ?? {})
        tableName = d.table ?? d.tableName ?? ''
        failed = (d.status ?? 200) >= 400 || d.error != null
        rows = Number(d.rowCount ?? d.rows ?? 0)
        params = Object.keys(d.queryParams ?? d.params ?? {})
      } catch { continue }

      if (!tableName || isProtectedTable(tableName)) continue

      if (!tableStats.has(tableName)) {
        tableStats.set(tableName, { calls: 0, failures: 0, rowSums: 0, rowCount: 0, params: new Map() })
      }
      const s = tableStats.get(tableName)!
      s.calls++
      if (failed) s.failures++
      if (rows > 0) { s.rowSums += rows; s.rowCount++ }
      for (const p of params) s.params.set(p, (s.params.get(p) ?? 0) + 1)
    }

    const { postgresSchema } = getWorkspaceDatabaseNames(projectId)

    for (const [tableName, stats] of tableStats) {
      if (stats.calls < 10) continue

      const avgRows = stats.rowCount > 0 ? stats.rowSums / stats.rowCount : 0
      const failRate = stats.failures / stats.calls

      // Missing index on frequently filtered param
      const topParam = [...stats.params.entries()].sort((a, b) => b[1] - a[1])[0]
      if (topParam && topParam[1] > stats.calls * 0.3 && /^[a-z][a-z0-9_]{1,62}$/.test(topParam[0])) {
        findings.push({
          type: 'missing_index',
          tableName,
          evidence: `Column "${topParam[0]}" is filtered in ${topParam[1]}/${stats.calls} calls on "${tableName}" — likely doing a seq scan`,
          sqlFix: `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_${tableName}_${topParam[0]} ON "${postgresSchema}"."${tableName}" (${topParam[0]});`,
          requiresApproval: false,
        })
      }

      // Pagination needed
      if (avgRows > 500 && stats.calls > 20) {
        findings.push({
          type: 'pagination_needed',
          tableName,
          evidence: `"${tableName}" returns avg ${Math.round(avgRows)} rows per call (${stats.calls} calls in ${windowDays}d) — add LIMIT/OFFSET`,
          requiresApproval: true,
        })
      }

      // Broken endpoint
      if (failRate > 0.2 && stats.calls > 20) {
        findings.push({
          type: 'endpoint_broken',
          tableName,
          evidence: `"${tableName}" endpoint fails ${Math.round(failRate * 100)}% of the time — schema drift or missing column`,
          requiresApproval: true,
        })
      }
    }
  } catch (err: any) {
    console.warn('[CoEvolution] AuditLog signal analysis failed:', err?.message)
  }

  return findings
}

// ── Cron entry point ──────────────────────────────────────────────────────────

/**
 * Run full coevolution analysis (SDK telemetry + AuditLog signals) and persist findings.
 * Fire-and-forget — never throws.
 */
export async function runAndStoreFrontendCoevolution(
  projectId: string,
  userId: string,
): Promise<void> {
  try {
    // Layer 1: SDK telemetry analysis (field-level gaps)
    const [sdkReport, auditSignals] = await Promise.allSettled([
      analyzeCoevolutionGaps(projectId),
      analyzeAuditLogSignals(projectId),
    ])

    const sdkGaps = sdkReport.status === 'fulfilled' ? sdkReport.value : null
    const signals = auditSignals.status === 'fulfilled' ? auditSignals.value : []

    // Withdraw coevo_* findings this run's fresh analysis no longer supports —
    // before the early return below, so a run that finds NOTHING (every prior
    // gap closed) still clears them instead of skipping straight past. Uses
    // the exact same still-pending subset (proposal not auto-approved / signal
    // still requires approval) the persistence block below would write from.
    try {
      const { reapCoevolutionFindings } = await import('@/lib/core/finding-reaper')
      const detected = new Set<string>([
        ...(sdkGaps?.gaps ?? [])
          .filter((g) => g.proposal && !g.proposal.autoApprove)
          .map((g) => `coevo_${g.gapType}_${g.tableName}_${g.fieldName ?? ''}`),
        ...signals
          .filter((s) => s.requiresApproval)
          .map((s) => `coevo_${s.type}_${s.tableName}`),
      ])
      const cleanScan =
        sdkReport.status === 'fulfilled' &&
        auditSignals.status === 'fulfilled' &&
        (sdkGaps?.totalEvents ?? 0) >= 5
      await reapCoevolutionFindings(projectId, detected, cleanScan)
    } catch { /* best-effort — a failed reap must never fail the scan */ }

    const hasWork = (sdkGaps && sdkGaps.gaps.length > 0) || signals.length > 0
    if (!hasWork) return

    // Layer 2: Auto-apply SDK proposals (additive column adds)
    let appliedDescriptions: string[] = []
    if (sdkGaps && sdkGaps.autoApprovedCount > 0) {
      appliedDescriptions = await applyAutoApprovedProposals(projectId, sdkGaps)
    }

    // Layer 3: Auto-apply safe AuditLog signals (index additions)
    const { postgresSchema } = getWorkspaceDatabaseNames(projectId)
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 })
    try {
      for (const sig of signals.filter(s => !s.requiresApproval && s.sqlFix)) {
        try {
          await pool.query(sig.sqlFix!)
          appliedDescriptions.push(`Index added: ${sig.tableName} (${sig.type})`)
        } catch { /* index may already exist */ }
      }
    } finally {
      await pool.end().catch(() => {})
    }

    // Store approval-required signals as HealthFindings
    const existing = await prisma.healthFinding.findMany({
      where: { projectId, status: 'open', type: { startsWith: 'coevo_' } },
      select: { type: true },
    }).catch(() => [] as Array<{ type: string }>)
    const existingTypes = new Set(existing.map(e => e.type))

    const toCreate: any[] = []

    // SDK pending proposals
    if (sdkGaps) {
      for (const gap of sdkGaps.gaps.filter(g => g.proposal && !g.proposal.autoApprove)) {
        const type = `coevo_${gap.gapType}_${gap.tableName}_${gap.fieldName ?? ''}`
        if (!existingTypes.has(type)) {
          toCreate.push({
            projectId, type,
            severity: gap.confidence > 0.5 ? 'warning' : 'info',
            details: {
              title: gap.proposal!.title,
              description: gap.proposal!.rationale,
              source: 'frontend_coevolution_sdk',
              tableName: gap.tableName,
              fieldName: gap.fieldName ?? null,
              occurrences: gap.occurrences,
              requiresApproval: true,
              detectedAt: sdkGaps.analyzedAt,
            },
            status: 'open', autoFixed: false,
          })
        }
      }
    }

    // AuditLog signals requiring approval
    for (const sig of signals.filter(s => s.requiresApproval)) {
      const type = `coevo_${sig.type}_${sig.tableName}`
      if (!existingTypes.has(type)) {
        toCreate.push({
          projectId, type,
          severity: 'info',
          details: {
            title: `Frontend signal: ${sig.type.replace(/_/g, ' ')} on ${sig.tableName}`,
            description: sig.evidence,
            source: 'frontend_coevolution_audit',
            tableName: sig.tableName,
            requiresApproval: true,
            detectedAt: new Date().toISOString(),
          },
          status: 'open', autoFixed: false,
        })
      }
    }

    if (toCreate.length > 0) {
      await prisma.healthFinding.createMany({ data: toCreate, skipDuplicates: true }).catch(() => {})
    }

    if (appliedDescriptions.length > 0 || toCreate.length > 0) {
      await prisma.platformNotification.create({
        data: {
          userId, projectId,
          type: 'frontend_coevolution',
          title: appliedDescriptions.length > 0
            ? `Auto-optimised ${appliedDescriptions.length} pattern${appliedDescriptions.length > 1 ? 's' : ''} from frontend usage`
            : `${toCreate.length} frontend-backend alignment suggestion${toCreate.length > 1 ? 's' : ''} ready`,
          body: sdkGaps?.topMissingFields[0]
            ? `Frontend requests field "${sdkGaps.topMissingFields[0].field}" on "${sdkGaps.topMissingFields[0].table}" ${sdkGaps.topMissingFields[0].occurrences}× but it doesn't exist`
            : signals[0]?.evidence ?? 'Review coevolution hints in your dashboard.',
          metadata: {
            autoApplied: appliedDescriptions.length,
            pendingReview: toCreate.length,
            source: 'frontend_coevolution',
          },
          read: false,
        } as any,
      }).catch(() => {})
    }

    console.log(`[Coevolution] project=${projectId} auto=${appliedDescriptions.length} pending=${toCreate.length}`)
  } catch (err: any) {
    console.warn(`[Coevolution] runAndStore failed for ${projectId}:`, err?.message)
  }
}
