/**
 * ARCHITECTURE EVOLUTION ENGINE
 * ==============================
 * Tracks the backend's life stage and plans its path forward.
 *
 * Stages:
 *   MVP        — small, early: < 10 tables, < 1M rows, < 5 integrations
 *   Growth     — expanding: 10-50 tables, 1M-50M rows, multi-integration
 *   Scale      — under load: 50+ tables, 50M+ rows, realtime pressure, query latency
 *   Enterprise — compliance, multi-tenant, audit trail, SSO, SLAs
 *
 * For each stage the engine produces:
 *   - Stage classification with evidence
 *   - Readiness for next stage (what's missing)
 *   - Migration plan (concrete, prioritised steps)
 *   - Technical debt items (what to clean up now)
 *   - Service extraction candidates (what could become its own service)
 *
 * Never auto-applies destructive changes. Structural suggestions always
 * require user approval — only additive safe ops (indexes, RLS) run automatically.
 *
 * Called by:
 *   - instrumentation.ts cron every 6 hours (same slot as workspace observer)
 *   - post-build-orchestrator.ts when a significant build completes
 */

import { prisma } from '@/lib/db/prisma'
import { Pool } from 'pg'
import { countExposedResources } from '@/lib/api/exposed-resources'

// ── Public types ──────────────────────────────────────────────────────────────

export type ArchStage = 'mvp' | 'growth' | 'scale' | 'enterprise'

export interface StageEvidence {
  tableCount: number
  totalRows: number
  integrationCount: number
  apiCount: number
  hasRealtime: boolean
  hasAuditLog: boolean
  hasMultiTenant: boolean
  hasRls: boolean
}

export interface MigrationStep {
  priority: 'immediate' | 'soon' | 'when_ready'
  title: string
  description: string
  category: 'performance' | 'security' | 'reliability' | 'scalability' | 'architecture'
  effort: 'small' | 'medium' | 'large'
  requiresApproval: boolean
  sqlFix?: string
}

export interface ServiceCandidate {
  name: string
  tables: string[]
  reason: string
  extractionComplexity: 'low' | 'medium' | 'high'
}

export interface TechDebtItem {
  kind: 'missing_index' | 'inconsistent_naming' | 'orphaned_table' | 'no_rls' | 'missing_auth' | 'no_soft_delete'
  location: string
  impact: 'low' | 'medium' | 'high'
  fix: string
  autoFixable: boolean
  sqlFix?: string
}

export interface EvolutionReport {
  projectId: string
  scannedAt: string
  currentStage: ArchStage
  stageLabel: string
  evidence: StageEvidence
  nextStage: ArchStage | null
  nextStageRequirements: string[]
  migrationPlan: MigrationStep[]
  serviceExtractionCandidates: ServiceCandidate[]
  techDebt: TechDebtItem[]
  scalingRecommendations: string[]
}

// ── Stage classifier ──────────────────────────────────────────────────────────

function classifyStage(evidence: StageEvidence): ArchStage {
  // Stages describe the LIFE stage of a running backend, so every stage above
  // MVP requires real rows. Schema shape alone proves nothing: the AI builds
  // 10-15 tables (often including audit_logs) in one prompt, and classifying
  // that empty, pre-launch backend as "growth"/"enterprise" made this engine
  // propose scale work — composite indexes, partitioning, PII encryption — on
  // projects with zero rows and zero traffic. Structure is free; load is not.
  const { totalRows } = evidence

  // Enterprise signals only count once the backend carries serious data
  if ((evidence.hasMultiTenant || evidence.hasAuditLog) && totalRows > 1_000_000) {
    return 'enterprise'
  }

  // Scale signals
  if (
    totalRows > 50_000_000 ||
    (evidence.tableCount >= 50 && totalRows > 1_000_000) ||
    (evidence.hasRealtime && totalRows > 5_000_000)
  ) return 'scale'

  // Growth signals — a wide schema or many integrations still needs real usage
  if (
    totalRows > 1_000_000 ||
    (totalRows >= 10_000 && (evidence.tableCount >= 10 || evidence.integrationCount >= 5))
  ) return 'growth'

  return 'mvp'
}

const STAGE_LABELS: Record<ArchStage, string> = {
  mvp:        'MVP — Early Stage',
  growth:     'Growth — Expanding',
  scale:      'Scale — Under Load',
  enterprise: 'Enterprise — Production-Grade',
}

const NEXT_STAGE: Record<ArchStage, ArchStage | null> = {
  mvp:        'growth',
  growth:     'scale',
  scale:      'enterprise',
  enterprise: null,
}

// ── Evidence collection ───────────────────────────────────────────────────────

async function collectEvidence(projectId: string): Promise<StageEvidence> {
  const schemaName = `workspace_${projectId}`

  const [tableCount, integrationCount, apiCount, rlsCount, auditTableExists] = await Promise.all([
    prisma.table.count({ where: { projectId } }).catch(() => 0),
    prisma.projectIntegrationKey.count({ where: { projectId } }).catch(() => 0),
    countExposedResources(projectId).catch(() => 0),
    prisma.permissionPolicy.count({ where: { projectId } }).catch(() => 0),
    prisma.table.findFirst({ where: { projectId, name: { in: ['audit_log', 'audit_logs', 'audit'] } } })
      .then(r => !!r).catch(() => false),
  ])

  // Row count and realtime detection from pg_stat
  let totalRows = 0
  let hasRealtime = false
  try {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 })
    try {
      const rows = await pool.query<{ tablename: string; n_live_tup: string }>(
        `SELECT tablename, n_live_tup::int
           FROM pg_stat_user_tables
          WHERE schemaname = $1`,
        [schemaName],
      )
      for (const r of rows.rows) {
        totalRows += Number(r.n_live_tup)
        if (r.tablename === '_backenly_presence') hasRealtime = true
      }
    } finally {
      await pool.end().catch(() => {})
    }
  } catch { /* non-fatal */ }

  return {
    tableCount,
    totalRows,
    integrationCount,
    apiCount,
    hasRealtime,
    hasAuditLog: auditTableExists,
    hasMultiTenant: false, // future: detect per-project user isolation pattern
    hasRls: rlsCount > 0,
  }
}

// ── Next-stage requirements ───────────────────────────────────────────────────

function computeNextStageRequirements(
  currentStage: ArchStage,
  evidence: StageEvidence,
): string[] {
  switch (currentStage) {
    case 'mvp':
      return [
        evidence.tableCount < 10   ? `Add ${10 - evidence.tableCount} more tables to model your core domain fully` : '',
        evidence.integrationCount < 5 ? 'Connect at least 5 integrations (auth, email, payments, analytics, storage)' : '',
        !evidence.hasRls             ? 'Enable row-level security (RLS) on user-owned tables' : '',
        evidence.apiCount < 5        ? 'Generate REST APIs for all core tables' : '',
      ].filter(Boolean) as string[]

    case 'growth':
      return [
        evidence.totalRows < 1_000_000 ? 'Grow to 1M+ rows with active usage' : '',
        !evidence.hasRls               ? 'Enable RLS on all user-facing tables before scaling user base' : '',
        !evidence.hasRealtime          ? 'Add realtime subscriptions for live-update features' : '',
        evidence.tableCount < 20       ? 'Build out the full domain model (20+ tables)' : '',
      ].filter(Boolean) as string[]

    case 'scale':
      return [
        !evidence.hasAuditLog   ? 'Add an audit log table for compliance tracking' : '',
        !evidence.hasRls        ? 'Enable RLS everywhere — mandatory at scale' : '',
        'Set up read replicas or connection pooling for query load distribution',
        'Add table partitioning for high-growth append-only tables (events, logs)',
      ].filter(Boolean) as string[]

    case 'enterprise':
      return [] // already at top

    default:
      return []
  }
}

// ── Migration plan ────────────────────────────────────────────────────────────

function buildMigrationPlan(
  stage: ArchStage,
  evidence: StageEvidence,
  tableNames: string[],
): MigrationStep[] {
  const steps: MigrationStep[] = []

  // Universal: missing RLS is always immediate for user-facing tables
  if (!evidence.hasRls && evidence.tableCount > 0) {
    steps.push({
      priority: stage === 'mvp' ? 'soon' : 'immediate',
      title: 'Enable row-level security on user-owned tables',
      description: 'Every table that stores per-user data should have RLS policies. Without them, any user can read all rows via the public API.',
      category: 'security',
      effort: 'small',
      requiresApproval: false,
      sqlFix: tableNames.slice(0, 3).map(t =>
        `ALTER TABLE "\${schemaName}"."${t}" ENABLE ROW LEVEL SECURITY;`
      ).join('\n'),
    })
  }

  // MVP → Growth: add indexes, auth
  if (stage === 'mvp') {
    if (!evidence.hasRls) {
      steps.push({
        priority: 'soon',
        title: 'Add authentication',
        description: 'Enable email/password and at least one OAuth provider so users can register and log in.',
        category: 'security',
        effort: 'small',
        requiresApproval: false,
      })
    }
    steps.push({
      priority: 'when_ready',
      title: 'Set up analytics integration',
      description: 'Connect PostHog or Plausible to understand which features users actually use before investing in performance.',
      category: 'architecture',
      effort: 'small',
      requiresApproval: false,
    })
  }

  // Growth → Scale: performance hardening
  if (stage === 'growth') {
    steps.push({
      priority: 'immediate',
      title: 'Add composite indexes on high-traffic query patterns',
      description: 'As row counts grow, queries without indexes will cause full table scans. Add (user_id, created_at DESC) on every user-owned table.',
      category: 'performance',
      effort: 'small',
      requiresApproval: false,
      sqlFix: tableNames.slice(0, 5).map(t =>
        `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_${t}_user_created ON "\${schemaName}"."${t}" (user_id, created_at DESC) WHERE user_id IS NOT NULL;`
      ).join('\n'),
    })
    steps.push({
      priority: 'soon',
      title: 'Add soft-delete pattern to core tables',
      description: 'Add a deleted_at column instead of hard-deleting rows. This prevents accidental data loss, enables undo, and avoids foreign key cascade issues.',
      category: 'reliability',
      effort: 'medium',
      requiresApproval: true,
    })
    if (evidence.hasRealtime) {
      steps.push({
        priority: 'soon',
        title: 'Throttle realtime subscriptions',
        description: 'High write volume on subscribed tables causes NOTIFY fan-out. Cap subscription frequency to 1-2s intervals.',
        category: 'scalability',
        effort: 'small',
        requiresApproval: false,
      })
    }
  }

  // Scale → Enterprise: compliance + reliability
  if (stage === 'scale') {
    if (!evidence.hasAuditLog) {
      steps.push({
        priority: 'immediate',
        title: 'Create audit log table',
        description: 'Enterprise buyers and compliance requirements (SOC 2, GDPR) require an immutable audit trail of who changed what and when.',
        category: 'security',
        effort: 'small',
        requiresApproval: false,
      })
    }
    steps.push({
      priority: 'immediate',
      title: 'Partition high-growth tables by time',
      description: 'Tables with >1M rows must be partitioned to keep per-partition scans fast. PostgreSQL declarative partitioning works well for time-series data.',
      category: 'scalability',
      effort: 'large',
      requiresApproval: true,
    })
    steps.push({
      priority: 'soon',
      title: 'Extract notification / event delivery into a queue',
      description: 'At scale, synchronous webhook delivery and email sends block request threads. Move to an async queue (pg_notify → worker or dedicated queue service).',
      category: 'architecture',
      effort: 'large',
      requiresApproval: true,
    })
  }

  // Enterprise: hardening
  if (stage === 'enterprise') {
    steps.push({
      priority: 'soon',
      title: 'Add column-level encryption for PII',
      description: 'GDPR Article 32 and SOC 2 CC6.1 require encryption of sensitive fields. Encrypt email, phone, and payment identifiers at rest.',
      category: 'security',
      effort: 'large',
      requiresApproval: true,
    })
    steps.push({
      priority: 'when_ready',
      title: 'Set up read replica routing',
      description: 'Route read-heavy endpoints to a replica to offload the primary and improve read latency under concurrency.',
      category: 'scalability',
      effort: 'medium',
      requiresApproval: true,
    })
  }

  return steps
}

// ── Service extraction candidates ────────────────────────────────────────────

function detectServiceCandidates(tableNames: string[]): ServiceCandidate[] {
  const candidates: ServiceCandidate[] = []

  const DOMAIN_CLUSTERS: Array<{ name: string; patterns: string[]; reason: string; complexity: ServiceCandidate['extractionComplexity'] }> = [
    {
      name: 'Notification Service',
      patterns: ['notifications', 'emails', 'push_tokens', 'templates', 'message_logs'],
      reason: 'Notification delivery is I/O-bound and benefits from its own scaling envelope and retry queue.',
      complexity: 'medium',
    },
    {
      name: 'Billing Service',
      patterns: ['subscriptions', 'invoices', 'payments', 'charges', 'credits', 'plans'],
      reason: 'Billing logic is compliance-sensitive and changes independently of product features.',
      complexity: 'high',
    },
    {
      name: 'Analytics Service',
      patterns: ['events', 'analytics', 'metrics', 'sessions', 'page_views', 'click_events'],
      reason: 'Write-heavy analytics tables compete with OLTP reads. Separation prevents interference.',
      complexity: 'medium',
    },
    {
      name: 'File Storage Service',
      patterns: ['files', 'uploads', 'attachments', 'media', 'documents'],
      reason: 'File metadata and binary storage scale differently and benefit from CDN integration.',
      complexity: 'low',
    },
    {
      name: 'User Identity Service',
      patterns: ['users', 'sessions', 'tokens', 'api_keys', 'oauth_accounts'],
      reason: 'Auth is the highest-risk service and benefits from an isolated security boundary.',
      complexity: 'high',
    },
  ]

  for (const cluster of DOMAIN_CLUSTERS) {
    const matched = tableNames.filter(t =>
      cluster.patterns.some(p => t === p || t.startsWith(p.replace(/s$/, '') + '_') || t.endsWith('_' + p.replace(/s$/, '')))
    )
    if (matched.length >= 2) {
      candidates.push({
        name: cluster.name,
        tables: matched,
        reason: cluster.reason,
        extractionComplexity: cluster.complexity,
      })
    }
  }

  return candidates
}

// ── Tech debt detection ───────────────────────────────────────────────────────

async function detectTechDebt(
  projectId: string,
  tableNames: string[],
  evidence: StageEvidence,
): Promise<TechDebtItem[]> {
  const debt: TechDebtItem[] = []
  const schemaName = `workspace_${projectId}`

  // No RLS on any table
  if (!evidence.hasRls && tableNames.length > 0) {
    for (const t of tableNames.slice(0, 5)) {
      debt.push({
        kind: 'no_rls',
        location: t,
        impact: 'high',
        fix: `Enable RLS: ALTER TABLE "${schemaName}"."${t}" ENABLE ROW LEVEL SECURITY;`,
        autoFixable: false,
        sqlFix: `ALTER TABLE "${schemaName}"."${t}" ENABLE ROW LEVEL SECURITY;`,
      })
    }
  }

  // Missing soft-delete on core tables (no deleted_at column)
  try {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 })
    try {
      const cols = await pool.query<{ tablename: string; attname: string }>(
        `SELECT c.relname AS tablename, a.attname
           FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
           JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'deleted_at' AND a.attnum > 0
          WHERE n.nspname = $1 AND c.relkind = 'r'`,
        [schemaName],
      )
      const hasDeletedAt = new Set(cols.rows.map(r => r.tablename))
      const CORE_TABLE_PATTERNS = ['users', 'orders', 'products', 'posts', 'items', 'listings']
      for (const t of tableNames) {
        if (CORE_TABLE_PATTERNS.some(p => t === p || t.startsWith(p)) && !hasDeletedAt.has(t)) {
          debt.push({
            kind: 'no_soft_delete',
            location: t,
            impact: 'medium',
            fix: `Add soft-delete: ALTER TABLE "${schemaName}"."${t}" ADD COLUMN deleted_at TIMESTAMP;`,
            autoFixable: false,
            sqlFix: `ALTER TABLE "${schemaName}"."${t}" ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP WITH TIME ZONE;`,
          })
        }
      }
    } finally {
      await pool.end().catch(() => {})
    }
  } catch { /* non-fatal */ }

  return debt
}

// ── Main API ──────────────────────────────────────────────────────────────────

/**
 * Run a full architecture evolution analysis for a project.
 * Returns EvolutionReport — never throws.
 */
export async function runArchitectureEvolution(projectId: string): Promise<EvolutionReport> {
  const scannedAt = new Date().toISOString()

  try {
    const evidence = await collectEvidence(projectId)
    const currentStage = classifyStage(evidence)
    const nextStage = NEXT_STAGE[currentStage]

    const tableRows = await prisma.table.findMany({
      where: { projectId },
      select: { name: true },
    }).catch(() => [] as Array<{ name: string }>)
    const tableNames = tableRows.map(t => t.name)

    const [migrationPlan, techDebt] = await Promise.all([
      Promise.resolve(buildMigrationPlan(currentStage, evidence, tableNames)),
      detectTechDebt(projectId, tableNames, evidence),
    ])

    const serviceExtractionCandidates = detectServiceCandidates(tableNames)

    const scalingRecommendations: string[] = []
    if (evidence.totalRows > 10_000_000) {
      scalingRecommendations.push('Consider read replicas — primary is handling significant read + write load')
    }
    if (evidence.totalRows > 50_000_000) {
      scalingRecommendations.push('Evaluate PgBouncer for connection multiplexing')
    }
    if (evidence.hasRealtime && evidence.totalRows > 1_000_000) {
      scalingRecommendations.push('Use LISTEN/NOTIFY with connection-level filtering — do not broadcast to all subscribers')
    }

    return {
      projectId,
      scannedAt,
      currentStage,
      stageLabel: STAGE_LABELS[currentStage],
      evidence,
      nextStage,
      nextStageRequirements: computeNextStageRequirements(currentStage, evidence),
      migrationPlan,
      serviceExtractionCandidates,
      techDebt,
      scalingRecommendations,
    }
  } catch (err: any) {
    console.warn(`[ArchEvolution] Failed for ${projectId}:`, err?.message)
    return {
      projectId,
      scannedAt,
      currentStage: 'mvp',
      stageLabel: STAGE_LABELS.mvp,
      evidence: { tableCount: 0, totalRows: 0, integrationCount: 0, apiCount: 0, hasRealtime: false, hasAuditLog: false, hasMultiTenant: false, hasRls: false },
      nextStage: 'growth',
      nextStageRequirements: [],
      migrationPlan: [],
      serviceExtractionCandidates: [],
      techDebt: [],
      scalingRecommendations: [],
    }
  }
}

// ── Arch finding types + reap (shared with lib/core/finding-reaper) ───────────

export function archMigrationType(title: string): string {
  return `arch_migration_${title.toLowerCase().replace(/\W+/g, '_').slice(0, 40)}`
}

export function archDebtType(kind: string, location: string): string {
  return `arch_debt_${kind}_${location}`
}

/**
 * The arch finding types the CURRENT evidence supports — a deterministic
 * re-run of the evolution engine's evidence pass (cheap SQL, no LLM).
 */
export async function computeValidArchTypes(projectId: string): Promise<Set<string>> {
  const report = await runArchitectureEvolution(projectId)
  return new Set<string>([
    ...report.migrationPlan
      .filter(s => s.priority === 'immediate')
      .map(s => archMigrationType(s.title)),
    ...report.techDebt
      .filter(d => d.impact === 'high')
      .map(d => archDebtType(d.kind, d.location)),
  ])
}

/**
 * Withdraw open/pending arch_* proposals not in `validTypes` (the project
 * regressed a stage, the debt was cleared, or an earlier traffic-blind scan
 * over-proposed). Marked withdrawnBy so dedup can tell a withdrawal apart
 * from a user dismissal: withdrawn types MAY come back when evidence later
 * supports them; user-dismissed types never re-nag.
 */
export async function withdrawUnsupportedArchFindings(
  projectId: string,
  validTypes: Set<string>,
): Promise<number> {
  const stale = await prisma.healthFinding.findMany({
    where: {
      projectId,
      type: { startsWith: 'arch_' },
      status: { in: ['open', 'pending_approval'] },
    },
    select: { id: true, type: true, details: true },
  }).catch(() => [] as Array<{ id: string; type: string; details: unknown }>)

  let withdrawn = 0
  for (const e of stale) {
    if (validTypes.has(e.type)) continue
    await prisma.healthFinding.update({
      where: { id: e.id },
      data: {
        status: 'dismissed',
        details: {
          ...((e.details as Record<string, unknown> | null) ?? {}),
          withdrawnBy: 'evolution_reaper',
          withdrawnAt: new Date().toISOString(),
        } as any,
      },
    }).then(() => { withdrawn++ }).catch(() => {})
  }
  return withdrawn
}

/**
 * Run evolution analysis and persist significant findings as HealthFindings + notifications.
 * Fire-and-forget — never throws.
 */
export async function runAndStoreArchitectureEvolution(
  projectId: string,
  userId: string,
): Promise<void> {
  try {
    const report = await runArchitectureEvolution(projectId)

    const immediateSteps = report.migrationPlan.filter(s => s.priority === 'immediate')
    const highDebt = report.techDebt.filter(d => d.impact === 'high')

    const validTypes = new Set<string>([
      ...immediateSteps.map(s => archMigrationType(s.title)),
      ...highDebt.map(d => archDebtType(d.kind, d.location)),
    ])

    // Withdraw stale proposals before the "nothing new" return so they clear
    // even when this scan produces none.
    await withdrawUnsupportedArchFindings(projectId, validTypes)

    if (immediateSteps.length === 0 && highDebt.length === 0) return

    // Dedup is one-shot per type across EVERY status — dedup against 'open'
    // alone duplicated any proposal that had moved to pending_approval, and
    // re-created proposals the user had already dismissed or applied.
    // Reaper-withdrawn rows are the exception (see withdrawUnsupportedArchFindings).
    const existing = await prisma.healthFinding.findMany({
      where: { projectId, type: { startsWith: 'arch_' } },
      select: { type: true, status: true, details: true },
    }).catch(() => [])
    const existingTypes = new Set(
      existing
        .filter(e => !(
          e.status === 'dismissed' &&
          (e.details as { withdrawnBy?: unknown } | null)?.withdrawnBy === 'evolution_reaper'
        ))
        .map(e => e.type),
    )

    const toCreate: any[] = []

    for (const step of immediateSteps) {
      const type = archMigrationType(step.title)
      if (!existingTypes.has(type)) {
        toCreate.push({
          projectId,
          type,
          severity: 'warning',
          details: {
            title: step.title,
            description: step.description,
            source: 'architecture_evolution',
            stage: report.currentStage,
            category: step.category,
            effort: step.effort,
            requiresApproval: step.requiresApproval,
            sqlFix: step.sqlFix ?? null,
            detectedAt: report.scannedAt,
          },
          status: 'open',
          autoFixed: false,
        })
      }
    }

    for (const debt of highDebt) {
      const type = archDebtType(debt.kind, debt.location)
      if (!existingTypes.has(type)) {
        toCreate.push({
          projectId,
          type,
          severity: 'warning',
          details: {
            title: `Tech debt: ${debt.kind} on ${debt.location}`,
            description: debt.fix,
            source: 'architecture_evolution',
            kind: debt.kind,
            location: debt.location,
            autoFixable: debt.autoFixable,
            sqlFix: debt.sqlFix ?? null,
            detectedAt: report.scannedAt,
          },
          status: 'open',
          autoFixed: false,
        })
      }
    }

    if (toCreate.length > 0) {
      await prisma.healthFinding.createMany({ data: toCreate, skipDuplicates: true }).catch(() => {})

      await prisma.platformNotification.create({
        data: {
          userId,
          projectId,
          type: 'architecture_evolution',
          title: `Architecture evolution: ${report.stageLabel}`,
          body: immediateSteps[0]?.title ?? `Your backend is at ${report.stageLabel} stage`,
          metadata: {
            currentStage: report.currentStage,
            nextStage: report.nextStage,
            immediateActions: immediateSteps.length,
            techDebtItems: highDebt.length,
            source: 'architecture_evolution',
          },
          read: false,
        } as any,
      }).catch(() => {})
    }

    console.log(`[ArchEvolution] project=${projectId} stage=${report.currentStage} immediate=${immediateSteps.length} debt=${highDebt.length}`)
  } catch (err: any) {
    console.warn(`[ArchEvolution] Store failed for ${projectId}:`, err?.message)
  }
}
