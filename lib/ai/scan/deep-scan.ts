/**
 * DEEP PRODUCTION READINESS SCAN
 * ==============================
 * Aggregates every readiness signal Backenly already has into a single
 * structured report that powers the professional `/scan` response.
 *
 * Sources (all already exist — this is composition, not new logic):
 *   - collectProof()                  → live DB ground truth (tables, APIs, auth, storage, RLS, integrations)
 *   - scoreReadiness({ autoFix:false}) → 11 production checks (env, JWT, route auth, RLS, webhooks, security audit, …)
 *   - analyzeProductionReadiness()    → 7 deep checks (missing indexes, N+1, weak RLS, pagination, replay risk, …)
 *   - loadBuildLedger()               → executor record (built / planned / blocked / failed)
 *   - checkAllIntegrationReadiness()  → per-integration 3-state readiness
 *
 * The result is intentionally STRUCTURED (not markdown). Formatting is the
 * formatter's job — keeps this module unit-testable and reusable from the UI.
 *
 * Scan is read-only: no mutations, no auto-fixes (autoFix=false).
 */

import { collectProof, type ProofBlock } from '@/lib/ai/proof-system'
import { scoreReadiness, type ReadinessReport, type ReadinessCheck } from '@/lib/deployment/readiness-scorer'
import { analyzeProductionReadiness, type ProductionIntelligenceReport, type ProductionIssue } from '@/lib/ai/production-intelligence'
import { loadBuildLedger, type BuildLedger } from '@/lib/ai/build-ledger'
import { checkAllIntegrationReadiness, type IntegrationReadinessReport } from '@/lib/integrations/readiness'

// ── Types ─────────────────────────────────────────────────────────────────────

export type Severity = 'critical' | 'high' | 'medium' | 'low'

export type LaunchVerdict =
  | 'production_ready'   // score ≥ threshold, no critical blockers
  | 'needs_launch_fixes' // blockers exist
  | 'credentials_needed' // only blocked items are missing credentials
  | 'structure_ready'    // structurally built but not yet verified
  | 'not_started'        // nothing built yet

export interface CapabilityGroup {
  /** Short product-level title — "User accounts and roles", "Payments" etc. */
  title: string
  /** One-line plain-English description of what is built for this capability */
  summary: string
  /** Underlying tables / APIs / integrations that prove the capability exists */
  evidence: string[]
}

export interface MissingItem {
  /** What is missing in plain English */
  title: string
  /** Why it matters */
  why: string
  /** Severity for sort order — same scale as risks */
  severity: Severity
}

export interface RiskItem {
  severity: Severity
  title: string
  description: string
  recommendation: string
}

export interface NextAction {
  /** Short imperative — "Connect Stripe webhook secret" */
  title: string
  /** Whether Backenly can perform this without further user input */
  autoFixable: boolean
}

export interface ScoreBreakdownAxis {
  /** Display label — "Auth & permissions" */
  label: string
  /** 0–100 contribution-style score for this axis */
  score: number
  /** Short reason why this score landed where it did */
  note: string
}

export interface DeepScanReport {
  projectId: string
  evaluatedAt: string
  /** 0–100 overall launch readiness */
  score: number
  /** Per-axis breakdown */
  breakdown: ScoreBreakdownAxis[]
  /** Final verdict drives the dashboard badge and headline */
  verdict: LaunchVerdict
  /** Plain-English summary of what the backend currently does */
  executiveSummary: string
  /** "What is Built" — grouped by product capability */
  built: CapabilityGroup[]
  /** "What is Missing" — non-dev language */
  missing: MissingItem[]
  /** "Risks Before Launch" — Critical / High / Medium / Low */
  risks: RiskItem[]
  /** 3–5 concrete next actions */
  nextActions: NextAction[]
  /** Items Backenly can auto-fix vs. items that need user input */
  autoFixable: string[]
  needsUser: string[]
  /** Short proof block for the bottom of the report */
  proof: {
    tables: number
    apis: number
    authEnabled: boolean
    authProviders: string[]
    buckets: number
    rlsPolicies: number
    integrations: string[]
    failedNodes: number
    blockedItems: number
  }
  /** Whether at least the readiness scorer ran (vs. only proof) */
  deepScanCompleted: boolean
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function describeBackend(proof: ProofBlock): string {
  if (proof.nothingBuilt) {
    return 'No backend has been built yet — describe what you want and Backenly will design it.'
  }

  const parts: string[] = []

  if (proof.tables.length > 0) {
    const sample = proof.tables.slice(0, 6).join(', ')
    const more = proof.tables.length > 6 ? `, and ${proof.tables.length - 6} more` : ''
    parts.push(`tables for ${sample}${more}`)
  }

  if (proof.authEnabled) {
    const providers = proof.authProviders.length > 0 ? proof.authProviders.join(' and ') : 'email/password'
    parts.push(`${providers} authentication`)
  }

  if (proof.apis.length > 0) {
    parts.push(`${proof.apis.length} REST API${proof.apis.length !== 1 ? 's' : ''}`)
  }

  if (proof.buckets.length > 0) {
    parts.push(`file uploads (${proof.buckets.length} bucket${proof.buckets.length !== 1 ? 's' : ''})`)
  }

  if (proof.rlsPolicies.length > 0) {
    parts.push(`row-level security on ${new Set(proof.rlsPolicies.map(p => p.table)).size} table${proof.rlsPolicies.length !== 1 ? 's' : ''}`)
  }

  if (proof.integrations.length > 0) {
    const names = [...new Set(proof.integrations.map(i => i.split('_')[0]))].slice(0, 4).join(', ')
    parts.push(`integrations with ${names}`)
  }

  if (parts.length === 0) {
    return 'A project shell exists but no concrete backend resources have been created yet.'
  }

  return `Your backend currently supports ${parts.slice(0, -1).join(', ')}${parts.length > 1 ? ', and ' : ''}${parts.at(-1)}.`
}

const CAPABILITY_KEYWORDS: Array<{ title: string; match: RegExp; summary: (tables: string[]) => string }> = [
  {
    title: 'User accounts & roles',
    match: /^(users?|accounts?|profiles?|members?|customers?|admins?|roles?|permissions?)$/i,
    summary: (t) => `User identity and account data (${t.join(', ')}).`,
  },
  {
    title: 'Marketplace — sellers & stores',
    match: /^(sellers?|vendors?|stores?|shops?|merchants?)$/i,
    summary: (t) => `Seller and storefront management (${t.join(', ')}).`,
  },
  {
    title: 'Marketplace — buyers',
    match: /^(buyers?|shoppers?)$/i,
    summary: (t) => `Buyer-side accounts (${t.join(', ')}).`,
  },
  {
    title: 'Product catalog',
    match: /^(products?|items?|listings?|catalogs?|skus?|variants?|categories|tags?|brands?)$/i,
    summary: (t) => `Product catalog and metadata (${t.join(', ')}).`,
  },
  {
    title: 'Orders & checkout',
    match: /^(orders?|order_items?|line_items?|carts?|cart_items?|checkouts?|sales?|transactions?)$/i,
    summary: (t) => `Order placement and checkout flow (${t.join(', ')}).`,
  },
  {
    title: 'Inventory & alerts',
    match: /^(inventory|inventories|stock|stocks?|alerts?|notifications?)$/i,
    summary: (t) => `Inventory tracking and alerts (${t.join(', ')}).`,
  },
  {
    title: 'Coupons & discounts',
    match: /^(coupons?|discounts?|promotions?|promos?|offers?|vouchers?)$/i,
    summary: (t) => `Discounts and promotional codes (${t.join(', ')}).`,
  },
  {
    title: 'Reviews & ratings',
    match: /^(reviews?|ratings?|comments?|feedback)$/i,
    summary: (t) => `Reviews and ratings (${t.join(', ')}).`,
  },
  {
    title: 'Messaging & support',
    match: /^(messages?|conversations?|chats?|tickets?|threads?)$/i,
    summary: (t) => `Messaging and support tickets (${t.join(', ')}).`,
  },
  {
    title: 'Posts & content',
    match: /^(posts?|articles?|blogs?|pages?|content|media)$/i,
    summary: (t) => `Content and posts (${t.join(', ')}).`,
  },
]

function groupTablesByCapability(tables: string[]): CapabilityGroup[] {
  const groups: CapabilityGroup[] = []
  const matched = new Set<string>()

  for (const def of CAPABILITY_KEYWORDS) {
    const hit = tables.filter(t => def.match.test(t))
    if (hit.length > 0) {
      hit.forEach(t => matched.add(t))
      groups.push({
        title: def.title,
        summary: def.summary(hit),
        evidence: hit,
      })
    }
  }

  const remaining = tables.filter(t => !matched.has(t))
  if (remaining.length > 0) {
    groups.push({
      title: 'Other domain tables',
      summary: `Additional domain tables: ${remaining.join(', ')}.`,
      evidence: remaining,
    })
  }

  return groups
}

function buildCapabilities(proof: ProofBlock): CapabilityGroup[] {
  const groups: CapabilityGroup[] = []

  if (proof.tables.length > 0) {
    groups.push(...groupTablesByCapability(proof.tables))
  }

  if (proof.authEnabled) {
    const providers = proof.authProviders.length > 0 ? proof.authProviders.join(', ') : 'email/password'
    groups.push({
      title: 'Authentication',
      summary: `End-user sign-up and sign-in via ${providers}.`,
      evidence: proof.authProviders,
    })
  }

  if (proof.apis.length > 0) {
    groups.push({
      title: 'REST APIs',
      summary: `${proof.apis.length} REST endpoint${proof.apis.length !== 1 ? 's' : ''} exposed for client apps and the SDK.`,
      evidence: proof.apis.slice(0, 8).map(a => `${a.method} /${a.tableName}`),
    })
  }

  if (proof.buckets.length > 0) {
    groups.push({
      title: 'File storage',
      summary: `${proof.buckets.length} storage bucket${proof.buckets.length !== 1 ? 's' : ''} ready for uploads (${proof.buckets.join(', ')}).`,
      evidence: proof.buckets,
    })
  }

  if (proof.rlsPolicies.length > 0) {
    const protectedTables = [...new Set(proof.rlsPolicies.map(p => p.table))]
    groups.push({
      title: 'Row-level security',
      summary: `Per-row permission policies enforced on ${protectedTables.length} table${protectedTables.length !== 1 ? 's' : ''}.`,
      evidence: protectedTables,
    })
  }

  if (proof.integrations.length > 0) {
    const baseNames = [...new Set(proof.integrations.map(i => i.split('_')[0]))]
    groups.push({
      title: 'Connected integrations',
      summary: `${baseNames.length} third-party service${baseNames.length !== 1 ? 's' : ''} have credentials stored.`,
      evidence: baseNames,
    })
  }

  return groups
}

function severityFromCheckSeverity(s: ReadinessCheck['severity']): Severity {
  if (s === 'blocking') return 'critical'
  if (s === 'warning') return 'medium'
  return 'low'
}

function buildMissing(
  proof: ProofBlock,
  readiness: ReadinessReport,
  ledger: BuildLedger,
  integrations: IntegrationReadinessReport[],
): MissingItem[] {
  const missing: MissingItem[] = []

  // Blocked ledger items (waiting on credentials)
  for (const b of ledger.blocked) {
    missing.push({
      title: `${b.name} is waiting on a credential`,
      why: `Setup paused until ${b.blockedBy ?? 'an API key'} is provided. Paste the key in chat to resume automatically.`,
      severity: 'high',
    })
  }

  // Failed ledger items
  for (const f of ledger.failed) {
    missing.push({
      title: `${f.name} failed during build`,
      why: f.error ?? 'No error detail recorded — retry the step or ask Backenly to investigate.',
      severity: 'high',
    })
  }

  // Partial integrations (key stored but workflow incomplete)
  for (const i of integrations) {
    if (i.status === 'partially_configured' && i.blocking.length > 0) {
      missing.push({
        title: `${i.integrationId} integration is only partially wired`,
        why: i.blocking[0],
        severity: 'high',
      })
    }
  }

  // Empty backend foundations
  if (proof.tables.length > 0 && proof.apis.length === 0) {
    missing.push({
      title: 'No REST endpoints generated',
      why: 'Tables exist but client apps have no APIs to call. Ask Backenly to "generate APIs for all tables".',
      severity: 'critical',
    })
  }

  if (proof.tables.length > 0 && proof.rlsPolicies.length === 0) {
    missing.push({
      title: 'No row-level security policies',
      why: 'Any authenticated user can read every row in every table. Enable RLS on user-scoped tables before launch.',
      severity: 'high',
    })
  }

  if (proof.tables.includes('users') && !proof.authEnabled) {
    missing.push({
      title: 'Users table exists but auth is not enabled',
      why: 'Sign-up and sign-in routes will not work until JWT auth is configured.',
      severity: 'critical',
    })
  }

  // Readiness scorer findings — convert blockers/warnings to plain language
  for (const c of readiness.blockers) {
    missing.push({
      title: c.name,
      why: c.message,
      severity: severityFromCheckSeverity(c.severity),
    })
  }
  for (const c of readiness.warnings) {
    missing.push({
      title: c.name,
      why: c.message,
      severity: 'medium',
    })
  }

  // Deduplicate by title
  const seen = new Set<string>()
  return missing.filter(m => {
    const key = m.title.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function buildRisks(
  prodIntel: ProductionIntelligenceReport,
  readiness: ReadinessReport,
  ledger: BuildLedger,
): RiskItem[] {
  const risks: RiskItem[] = []

  // Production-intelligence issues map cleanly
  for (const issue of prodIntel.issues) {
    risks.push({
      severity: issue.severity,
      title: humaniseRiskTitle(issue),
      description: issue.description,
      recommendation: issue.recommendation,
    })
  }

  // Readiness blockers that aren't already in prod-intel
  for (const c of readiness.blockers) {
    risks.push({
      severity: 'critical',
      title: c.name,
      description: c.message,
      recommendation: c.details[0] ?? 'Resolve this before deploying to production.',
    })
  }

  // Failed ledger nodes are launch risks
  for (const f of ledger.failed) {
    risks.push({
      severity: 'high',
      title: `Failed build step: ${f.name}`,
      description: f.error ?? 'A previous build step did not complete successfully.',
      recommendation: 'Retry the step or ask Backenly to fix it by name.',
    })
  }

  // Sort by severity
  const order: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 }
  risks.sort((a, b) => order[a.severity] - order[b.severity])

  return risks
}

function humaniseRiskTitle(issue: ProductionIssue): string {
  switch (issue.type) {
    case 'missing_index':         return `Missing index on ${issue.location}`
    case 'n_plus_one_risk':       return `N+1 query risk in ${issue.location}`
    case 'weak_rls':              return `Row-level security disabled on ${issue.table}`
    case 'unbounded_pagination':  return `Unbounded list endpoint: ${issue.location}`
    case 'webhook_replay_risk':   return `Webhook replay risk: ${issue.table ?? issue.location}`
    case 'storage_abuse_risk':    return `Public bucket has no upload size limit`
    case 'missing_retry_queue':   return `No retry queue for async operations`
    default:                      return issue.location
  }
}

function buildNextActions(
  missing: MissingItem[],
  risks: RiskItem[],
  prodIntel: ProductionIntelligenceReport,
): NextAction[] {
  const actions: NextAction[] = []
  const seen = new Set<string>()

  // Critical missing items first
  for (const m of missing) {
    if (m.severity !== 'critical' && m.severity !== 'high') continue
    const key = m.title.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    actions.push({ title: actionableFromMissing(m.title), autoFixable: false })
    if (actions.length >= 5) break
  }

  // Then auto-fixable production-intelligence issues
  if (actions.length < 5) {
    for (const i of prodIntel.issues) {
      if (!i.autoFixable) continue
      const t = humaniseRiskTitle(i)
      const key = t.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      actions.push({ title: `Auto-fix: ${t.toLowerCase()}`, autoFixable: true })
      if (actions.length >= 5) break
    }
  }

  // Then critical risks not already covered
  if (actions.length < 5) {
    for (const r of risks) {
      if (r.severity !== 'critical') continue
      const key = r.title.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      actions.push({ title: r.recommendation || `Resolve: ${r.title}`, autoFixable: false })
      if (actions.length >= 5) break
    }
  }

  // Always finish with a deploy hint when there's nothing else to do
  if (actions.length === 0) {
    actions.push({ title: 'Run "deploy" to publish to production.', autoFixable: false })
  }

  return actions.slice(0, 5)
}

function actionableFromMissing(title: string): string {
  // Light rewrite to imperative
  if (/waiting on a credential/i.test(title)) {
    const integ = title.split(' ')[0]
    return `Paste the missing ${integ} credential in chat to resume the build.`
  }
  if (/auth is not enabled/i.test(title)) return 'Enable authentication ("enable auth") so sign-up and sign-in routes work.'
  if (/no rest endpoints/i.test(title)) return 'Generate REST APIs for all tables so the SDK can read and write data.'
  if (/no row-level security/i.test(title)) return 'Add row-level security on user-scoped tables before launch.'
  if (/failed during build/i.test(title)) return `Retry the failed step: ${title.replace(/ failed during build/i, '')}.`
  return `Resolve: ${title}.`
}

function classifyVerdict(
  proof: ProofBlock,
  readiness: ReadinessReport,
  prodIntel: ProductionIntelligenceReport,
  ledger: BuildLedger,
  combinedScore: number,
): LaunchVerdict {
  if (proof.nothingBuilt) return 'not_started'

  const hasCriticalRisks = prodIntel.criticalCount > 0 || readiness.blockers.length > 0 || ledger.failed.length > 0
  const onlyCredentialBlocks = ledger.blocked.length > 0 && !hasCriticalRisks

  if (hasCriticalRisks) return 'needs_launch_fixes'
  if (onlyCredentialBlocks) return 'credentials_needed'
  if (combinedScore >= 85 && readiness.ready) return 'production_ready'
  return 'structure_ready'
}

function buildBreakdown(
  proof: ProofBlock,
  readiness: ReadinessReport,
  prodIntel: ProductionIntelligenceReport,
  ledger: BuildLedger,
  integrations: IntegrationReadinessReport[],
): ScoreBreakdownAxis[] {
  const breakdown: ScoreBreakdownAxis[] = []

  // Core schema
  const schemaScore = proof.tables.length === 0 ? 0 : Math.min(100, 60 + proof.tables.length * 4)
  breakdown.push({
    label: 'Core schema',
    score: schemaScore,
    note: proof.tables.length === 0 ? 'No tables defined yet.' : `${proof.tables.length} table${proof.tables.length !== 1 ? 's' : ''} in place.`,
  })

  // Auth & permissions
  const authScore = (() => {
    if (!proof.authEnabled) return 0
    if (proof.rlsPolicies.length === 0 && proof.tables.length > 0) return 55
    return 90
  })()
  breakdown.push({
    label: 'Auth & permissions',
    score: authScore,
    note: proof.authEnabled
      ? proof.rlsPolicies.length > 0
        ? `${proof.authProviders.join(', ') || 'email/password'} + RLS on ${new Set(proof.rlsPolicies.map(p => p.table)).size} table(s).`
        : 'Auth enabled but no RLS — every authenticated user can read all rows.'
      : 'Authentication is not enabled.',
  })

  // APIs
  const apiScore = proof.tables.length === 0 ? 0 :
    proof.apis.length === 0 ? 10 :
    Math.min(100, 40 + Math.round((proof.apis.length / Math.max(proof.tables.length, 1)) * 50))
  breakdown.push({
    label: 'APIs',
    score: apiScore,
    note: proof.apis.length === 0
      ? proof.tables.length === 0 ? 'No tables to expose yet.' : 'No REST endpoints generated yet.'
      : `${proof.apis.length} endpoint${proof.apis.length !== 1 ? 's' : ''} generated.`,
  })

  // Storage
  breakdown.push({
    label: 'Storage',
    score: proof.buckets.length > 0 ? 100 : 60,
    note: proof.buckets.length > 0
      ? `${proof.buckets.length} bucket${proof.buckets.length !== 1 ? 's' : ''} configured.`
      : 'No storage buckets — fine if your app does not need file uploads.',
  })

  // Integrations
  const ready = integrations.filter(i => i.status === 'behaviorally_ready').length
  const partial = integrations.filter(i => i.status === 'partially_configured').length
  const total = integrations.length
  const intScore = total === 0 ? 80 : Math.round(((ready + partial * 0.5) / total) * 100)
  breakdown.push({
    label: 'Integrations',
    score: intScore,
    note: total === 0
      ? 'No third-party integrations connected.'
      : `${ready}/${total} fully wired${partial > 0 ? `, ${partial} partial` : ''}.`,
  })

  // Production safety
  const safetyScore = prodIntel.score
  breakdown.push({
    label: 'Production safety',
    score: safetyScore,
    note: prodIntel.criticalCount + prodIntel.highCount === 0
      ? 'No critical or high-severity production risks detected.'
      : `${prodIntel.criticalCount} critical, ${prodIntel.highCount} high-severity risk${prodIntel.highCount + prodIntel.criticalCount !== 1 ? 's' : ''} found.`,
  })

  // Build health (failed/blocked nodes)
  const buildScore = (() => {
    if (ledger.failed.length === 0 && ledger.blocked.length === 0) return 100
    if (ledger.failed.length > 0) return 30
    return 60
  })()
  breakdown.push({
    label: 'Build health',
    score: buildScore,
    note: ledger.failed.length > 0
      ? `${ledger.failed.length} failed build step${ledger.failed.length !== 1 ? 's' : ''}.`
      : ledger.blocked.length > 0
        ? `${ledger.blocked.length} step${ledger.blocked.length !== 1 ? 's' : ''} waiting on credentials.`
        : 'Every executed build step completed successfully.',
  })

  // Readiness scorer (composite of remaining checks)
  breakdown.push({
    label: 'Deploy gates',
    score: readiness.score,
    note: readiness.ready
      ? 'All deploy-gate checks pass.'
      : `${readiness.blockers.length} blocker${readiness.blockers.length !== 1 ? 's' : ''}, ${readiness.warnings.length} warning${readiness.warnings.length !== 1 ? 's' : ''}.`,
  })

  return breakdown
}

function combineScore(breakdown: ScoreBreakdownAxis[], readiness: ReadinessReport): number {
  if (breakdown.length === 0) return readiness.score
  const sum = breakdown.reduce((s, b) => s + b.score, 0)
  const axisAvg = sum / breakdown.length
  // Weight 60% axis breakdown, 40% deploy-gate readiness so blockers dominate.
  return Math.max(0, Math.min(100, Math.round(axisAvg * 0.6 + readiness.score * 0.4)))
}

// ── Public entry point ────────────────────────────────────────────────────────

export interface DeepScanOptions {
  /** Optional progress emitter — called with short status messages. */
  onProgress?: (label: string) => void
}

/**
 * Run the full deep readiness scan. Read-only — no auto-fixes.
 *
 * Resilient: every source is wrapped so a partial failure still produces a
 * useful report (with `deepScanCompleted=false` if any source threw).
 */
export async function runDeepScan(
  projectId: string,
  opts: DeepScanOptions = {},
): Promise<DeepScanReport> {
  const emit = opts.onProgress ?? (() => {})
  const startedAt = new Date().toISOString()

  emit('Scanning schema and APIs…')
  const proofPromise = collectProof(projectId).catch(() => null)

  emit('Checking auth, permissions, and deploy gates…')
  const readinessPromise = scoreReadiness(projectId, { autoFix: false }).catch(() => null)

  emit('Analyzing production safety risks…')
  const prodIntelPromise = analyzeProductionReadiness(projectId).catch(() => null)

  emit('Reviewing build history and integrations…')
  const ledgerPromise = loadBuildLedger(projectId).catch(() => null)
  const integrationsPromise = checkAllIntegrationReadiness(projectId).catch(() => [] as IntegrationReadinessReport[])

  const [proofRaw, readinessRaw, prodIntelRaw, ledgerRaw, integrationsRaw] = await Promise.all([
    proofPromise, readinessPromise, prodIntelPromise, ledgerPromise, integrationsPromise,
  ])

  const proof: ProofBlock = proofRaw ?? {
    tables: [], apis: [], authEnabled: false, authProviders: [],
    rlsPolicies: [], integrations: [], buckets: [], realtimeTables: [], nothingBuilt: true,
  }

  const readiness: ReadinessReport = readinessRaw ?? {
    projectId, ready: false, score: 0, checks: [], blockers: [], warnings: [],
    autoFixed: [], evaluatedAt: startedAt,
  }

  const prodIntel: ProductionIntelligenceReport = prodIntelRaw ?? {
    issues: [], score: 100, criticalCount: 0, highCount: 0, mediumCount: 0, lowCount: 0, autoFixableCount: 0,
  }

  const ledger: BuildLedger = ledgerRaw ?? {
    built: [], planned: [], blocked: [], failed: [], updatedAt: startedAt,
  }

  const integrations: IntegrationReadinessReport[] = integrationsRaw ?? []
  const deepScanCompleted = !!(readinessRaw && prodIntelRaw && ledgerRaw)

  emit('Preparing recommendations…')
  const breakdown = buildBreakdown(proof, readiness, prodIntel, ledger, integrations)
  const score = combineScore(breakdown, readiness)
  const verdict = classifyVerdict(proof, readiness, prodIntel, ledger, score)

  const built = buildCapabilities(proof)
  const missing = buildMissing(proof, readiness, ledger, integrations)
  const risks = buildRisks(prodIntel, readiness, ledger)
  const nextActions = buildNextActions(missing, risks, prodIntel)

  // Auto-fixable vs. needs-user split — pull from production-intel + readiness
  const autoFixable: string[] = []
  const needsUser: string[] = []
  for (const i of prodIntel.issues) {
    const t = humaniseRiskTitle(i)
    if (i.autoFixable) autoFixable.push(t)
    else needsUser.push(t)
  }
  for (const c of readiness.blockers) {
    if (c.severity === 'auto-fixable') autoFixable.push(c.name)
    else needsUser.push(c.name)
  }
  for (const b of ledger.blocked) {
    needsUser.push(`Provide ${b.blockedBy ?? 'credential'} for ${b.name}`)
  }

  return {
    projectId,
    evaluatedAt: new Date().toISOString(),
    score,
    breakdown,
    verdict,
    executiveSummary: describeBackend(proof),
    built,
    missing,
    risks,
    nextActions,
    autoFixable: dedupe(autoFixable),
    needsUser: dedupe(needsUser),
    proof: {
      tables: proof.tables.length,
      apis: proof.apis.length,
      authEnabled: proof.authEnabled,
      authProviders: proof.authProviders,
      buckets: proof.buckets.length,
      rlsPolicies: proof.rlsPolicies.length,
      integrations: [...new Set(proof.integrations.map(i => i.split('_')[0]))],
      failedNodes: ledger.failed.length,
      blockedItems: ledger.blocked.length,
    },
    deepScanCompleted,
  }
}

function dedupe(arr: string[]): string[] {
  return [...new Set(arr)]
}
