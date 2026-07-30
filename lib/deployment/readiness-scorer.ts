/**
 * PRODUCTION READINESS SCORER
 * ============================
 * Evaluates a project's readiness before allowing a production deploy.
 *
 * Each check has a severity:
 *   blocking    — must be resolved before deploy proceeds
 *   warning     — should be resolved but will not block deploy
 *   auto-fixable — will be deterministically fixed before re-evaluation
 *
 * Usage:
 *   const report = await scoreReadiness(projectId)
 *   if (!report.ready) { ... show report.blockers ... }
 */

import { prisma } from '@/lib/db'
import { sanitizeDiagnostic } from '@/lib/errors/diagnostic-sanitize'

// ─── Types ────────────────────────────────────────────────────────────────────

export type CheckSeverity = 'blocking' | 'warning' | 'auto-fixable'
export type CheckStatus = 'pass' | 'fail' | 'skip'

export interface ReadinessCheck {
  id: string
  name: string
  description: string
  severity: CheckSeverity
  status: CheckStatus
  message: string
  details: string[]
  fixApplied: boolean
}

export interface ReadinessReport {
  projectId: string
  /** true only when no blocking checks remain after auto-fixes */
  ready: boolean
  /** 0–100. Deducted per failing check weighted by severity */
  score: number
  checks: ReadinessCheck[]
  blockers: ReadinessCheck[]
  warnings: ReadinessCheck[]
  autoFixed: ReadinessCheck[]
  evaluatedAt: string
}

export interface ReadinessOptions {
  /** When true, run safe deterministic fixes before evaluating blockers. Default: true */
  autoFix?: boolean
}

// ─── Weights ──────────────────────────────────────────────────────────────────

const SCORE_DEDUCTIONS: Record<CheckSeverity, number> = {
  blocking: 30,
  warning: 8,
  'auto-fixable': 5,
}

// ─── Public entry point ───────────────────────────────────────────────────────

export async function scoreReadiness(
  projectId: string,
  options: ReadinessOptions = {},
): Promise<ReadinessReport> {
  const { autoFix = true } = options

  // Load everything we need in one round-trip
  // `apiDefs` was destructured here and never referenced again in this file —
  // a query fetching rows nobody read, from a table nothing writes. Removed
  // 2026-07-30 rather than converted: there was no consumer to convert.
  const [project, triggers, policies] = await Promise.all([
    prisma.project.findUnique({
      where: { id: projectId },
      select: {
        id: true,
        jwtSecret: true,
        authManifest: true,
        activeGraphId: true,
        projectStatus: true,
        activeGraph: { select: { graphData: true } },
      },
    }),
    prisma.appTrigger.findMany({
      where: { projectId, actionType: 'webhook', enabled: true },
      select: {
        id: true,
        name: true,
        webhookUrl: true,
        webhookSecret: true,
      },
    }),
    prisma.permissionPolicy.findMany({
      where: { projectId },
      select: { tableName: true, policyName: true },
    }),
  ])

  if (!project) {
    return buildEmptyReport(projectId, 'Project not found')
  }

  const graphData = (project.activeGraph?.graphData as any) ?? {}
  const entities: Record<string, any> = graphData.entities ?? {}

  // Run all checks (some may trigger auto-fixes when autoFix=true)
  const checks = await Promise.all([
    checkEnvVars(),
    checkProjectJwt(project, autoFix, projectId),
    checkRouteProtection(projectId),
    checkRlsApplied(projectId, entities, policies, autoFix),
    checkWebhookSecurity(triggers),
    checkApiExposure(projectId),
    checkEndUserAuthTable(projectId, project),  // auth enabled → users table must exist
    checkMonitoringBasics(projectId),
    checkBehavioralVerification(projectId),
    checkSecurityAudit(projectId),          // #31/#7 security — blocks deploy on critical/high findings
    checkFunctionTriggers(projectId),        // signup functions must have auto-triggers; placeholders must be cleaned up
  ])

  return buildReport(projectId, checks)
}

// ─── Individual checks ────────────────────────────────────────────────────────

/**
 * CHECK 1 — env_vars (blocking)
 * Verifies the critical runtime variables are present.
 */
async function checkEnvVars(): Promise<ReadinessCheck> {
  const base: Omit<ReadinessCheck, 'status' | 'message' | 'details' | 'fixApplied'> = {
    id: 'env_vars',
    name: 'Required environment variables',
    description: 'DATABASE_URL and JWT_SECRET must be set for the backend to function',
    severity: 'blocking',
  }

  const missing: string[] = []

  if (!process.env.DATABASE_URL) missing.push('DATABASE_URL')
  if (!process.env.JWT_SECRET) missing.push('JWT_SECRET')

  const jwtSecret = process.env.JWT_SECRET ?? ''
  if (jwtSecret && jwtSecret.length < 32) missing.push('JWT_SECRET (too short — must be ≥ 32 characters)')

  const warnings: string[] = []
  if (process.env.NODE_ENV === 'production' && !process.env.NEXT_PUBLIC_APP_URL) {
    warnings.push('NEXT_PUBLIC_APP_URL is not set — public API URLs will fall back to localhost')
  }
  if (process.env.ENABLE_AI_FEATURES !== 'false' && !process.env.OPENAI_API_KEY) {
    warnings.push('OPENAI_API_KEY is not set — AI features will be unavailable')
  }

  if (missing.length > 0) {
    return {
      ...base,
      status: 'fail',
      message: `${missing.length} required variable${missing.length > 1 ? 's' : ''} missing`,
      details: [...missing.map(v => `✗ ${v}`), ...warnings.map(v => `⚠ ${v}`)],
      fixApplied: false,
    }
  }

  return {
    ...base,
    status: 'pass',
    message: 'All critical environment variables are set',
    details: warnings.map(v => `⚠ ${v}`),
    fixApplied: false,
  }
}

/**
 * CHECK 2 — project_jwt (auto-fixable)
 * Every project needs its own JWT secret to sign end-user tokens.
 * Auto-fix: generate and persist a cryptographically secure secret.
 */
async function checkProjectJwt(
  project: { id: string; jwtSecret: string | null },
  autoFix: boolean,
  projectId: string,
): Promise<ReadinessCheck> {
  const base: Omit<ReadinessCheck, 'status' | 'message' | 'details' | 'fixApplied'> = {
    id: 'project_jwt',
    name: 'Project JWT secret',
    description: 'Each project must have a unique JWT secret for signing end-user auth tokens',
    severity: 'auto-fixable',
  }

  if (project.jwtSecret && project.jwtSecret.length >= 32) {
    return {
      ...base,
      status: 'pass',
      message: 'Project JWT secret is configured',
      details: [],
      fixApplied: false,
    }
  }

  if (autoFix) {
    try {
      const { randomBytes } = await import('crypto')
      const secret = randomBytes(40).toString('hex')
      await prisma.project.update({
        where: { id: projectId },
        data: { jwtSecret: secret },
      })
      return {
        ...base,
        status: 'pass',
        message: 'Project JWT secret was auto-generated and saved',
        details: ['✓ Generated a 80-character hex secret'],
        fixApplied: true,
      }
    } catch (err: any) {
      return {
        ...base,
        severity: 'blocking',
        status: 'fail',
        message: 'Failed to auto-generate project JWT secret',
        details: [sanitizeDiagnostic(err)],
        fixApplied: false,
      }
    }
  }

  return {
    ...base,
    status: 'fail',
    message: 'Project JWT secret is not set',
    details: ['End-user authentication (sign-up / sign-in) will not work without this'],
    fixApplied: false,
  }
}

/**
 * CHECK 3 — route_protection (blocking)
 *
 * Can an UNAUTHENTICATED caller mutate a table?
 *
 * Under the PostgREST data plane that question is answered by two things in the
 * live catalog — the grants held by the `anon` role, and whether the table
 * enforces RLS — not by an `authRequired` flag on an ApiDefinition row. That
 * flag was the old Express runtime's gate; the data plane no longer reads it,
 * so a project could hold zero ApiDefinition rows, be fully exposed over
 * PostgREST, and have this check report "All mutating endpoints require
 * authentication" because it iterated an empty list.
 *
 * A vacuous pass on a blocking security gate is worse than no gate. This reads
 * what actually decides the answer.
 */
async function checkRouteProtection(projectId: string): Promise<ReadinessCheck> {
  const base: Omit<ReadinessCheck, 'status' | 'message' | 'details' | 'fixApplied'> = {
    id: 'route_protection',
    name: 'API route protection',
    description: 'Unauthenticated callers must not be able to insert, update or delete rows',
    severity: 'blocking',
  }

  const schema = `workspace_${projectId}`

  // `anon` is the role an unauthenticated request runs as. If it holds a write
  // privilege on a table that does not enforce RLS, that table is writable by
  // anyone holding the public key — no policy stands between them and the row.
  const rows = await prisma.$queryRawUnsafe<Array<{ table_name: string; privs: string; rls: boolean }>>(
    `SELECT c.relname AS table_name,
            string_agg(DISTINCT g.privilege_type, ', ' ORDER BY g.privilege_type) AS privs,
            c.relrowsecurity AS rls
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN information_schema.role_table_grants g
         ON g.table_schema = n.nspname AND g.table_name = c.relname
      WHERE n.nspname = $1
        AND c.relkind = 'r'
        AND g.grantee = 'anon'
        AND g.privilege_type IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
        AND NOT c.relrowsecurity
      GROUP BY c.relname, c.relrowsecurity
      ORDER BY c.relname`,
    schema,
  ).catch(() => [] as Array<{ table_name: string; privs: string; rls: boolean }>)

  // A dev/CI database may have no PostgREST roles at all. "The role does not
  // exist" is not "the check passed" — say which one it is.
  const rolesExist = await prisma.$queryRawUnsafe<Array<{ ok: boolean }>>(
    `SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') AS ok`,
  ).catch(() => [{ ok: false }])

  if (!rolesExist[0]?.ok) {
    return {
      ...base,
      status: 'skip',
      message: 'No `anon` role on this database — route exposure cannot be evaluated here',
      details: [],
      fixApplied: false,
    }
  }

  const unprotected = rows.filter((r) => isExposedTableName(r.table_name))

  if (unprotected.length > 0) {
    return {
      ...base,
      status: 'fail',
      message: `${unprotected.length} table${unprotected.length > 1 ? 's are' : ' is'} writable by unauthenticated callers`,
      details: unprotected.map(
        (r) => `✗ ${r.table_name}: anon holds ${r.privs} and RLS is not enabled — any caller can mutate it`,
      ),
      fixApplied: false,
    }
  }

  return {
    ...base,
    status: 'pass',
    message: 'No table accepts writes from an unauthenticated caller',
    details: [],
    fixApplied: false,
  }
}

/** Mirrors lib/mcp/schema-introspection#isExposedTable without the import cycle. */
function isExposedTableName(name: string): boolean {
  return !!name && !name.startsWith('_') && !name.startsWith('pg_') && name !== 'spatial_ref_sys'
}

/**
 * CHECK 4 — rls_applied (auto-fixable)
 *
 * Reads the LIVE schema, not the BackendGraph entity list, and infers ownership
 * from foreign keys as well as column names — the same rules the autonomy loop
 * and CREATE_TABLE use (lib/services/rls-ownership.ts).
 *
 * The previous version had its own copy of the heuristic and passed a project
 * whose `order_items` was world-readable: no `user_id` column meant "no
 * ownership", which meant "not a candidate", which meant the check reported
 * PASS on an unprotected table. A readiness gate that can only see the tables
 * already easy to protect is not a gate.
 *
 * Tables where ownership is genuinely undecidable are reported as a fail a
 * human must resolve — never auto-"fixed", because enabling RLS with no
 * derivable policy makes the table read empty.
 */
async function checkRlsApplied(
  projectId: string,
  entities: Record<string, any>,
  policies: Array<{ tableName: string; policyName: string }>,
  autoFix: boolean,
): Promise<ReadinessCheck> {
  const base: Omit<ReadinessCheck, 'status' | 'message' | 'details' | 'fixApplied'> = {
    id: 'rls_applied',
    name: 'Row-level security (RLS)',
    description: 'Every client-reachable table should carry an RLS policy so users only see rows they own',
    severity: 'auto-fixable',
  }

  const { loadOwnershipCatalog, inferRlsPlanFromCatalog } = await import('@/lib/services/rls-ownership')
  const catalog = await loadOwnershipCatalog(projectId)

  const tablesWithPolicies = new Set(policies.map((p) => p.tableName.toLowerCase()))

  const needsRls: Array<{ tableName: string; plan: Awaited<ReturnType<typeof inferRlsPlanFromCatalog>> }> = []
  const undecidable: Array<{ tableName: string; reason: string }> = []

  for (const tableName of catalog.columns.keys()) {
    if (tableName.startsWith('_')) continue
    if (tablesWithPolicies.has(tableName.toLowerCase())) continue

    const plan = inferRlsPlanFromCatalog(catalog, tableName)
    if (plan.kind === 'undecidable') {
      undecidable.push({ tableName, reason: plan.reason })
      continue
    }
    needsRls.push({ tableName, plan })
  }

  if (needsRls.length === 0 && undecidable.length === 0) {
    return {
      ...base,
      status: 'pass',
      message: 'Every table carries an RLS policy',
      details: [],
      fixApplied: false,
    }
  }

  const undecidableDetails = undecidable.map((u) => `✗ ${u.tableName} — ${u.reason}`)

  if (!autoFix) {
    const total = needsRls.length + undecidable.length
    return {
      ...base,
      status: 'fail',
      message: `${total} table${total > 1 ? 's are' : ' is'} missing RLS`,
      details: [
        ...needsRls.map((t) => `✗ ${t.tableName} — will apply ${t.plan.template}: ${t.plan.reason}`),
        ...undecidableDetails,
      ],
      fixApplied: false,
    }
  }

  const { applyPermissionPolicy } = await import('@/lib/services/workspace-rls')
  const fixed: string[] = []
  const failed: string[] = []

  await Promise.all(
    needsRls.map(async ({ tableName, plan }) => {
      const result = await applyPermissionPolicy(projectId, { tableName, template: 'auto' })
      if (result.success) {
        fixed.push(`${tableName} (${plan.template})`)
      } else {
        failed.push(`${tableName}: ${result.message}`)
      }
    }),
  )

  if (failed.length > 0 || undecidable.length > 0) {
    return {
      ...base,
      status: 'fail',
      message:
        `Auto-fix applied to ${fixed.length} table${fixed.length !== 1 ? 's' : ''}` +
        (failed.length ? `, ${failed.length} failed` : '') +
        (undecidable.length ? `, ${undecidable.length} need${undecidable.length === 1 ? 's' : ''} your decision` : ''),
      details: [
        ...fixed.map((t) => `✓ RLS applied to "${t}"`),
        ...failed.map((f) => `✗ ${f}`),
        ...undecidableDetails,
      ],
      fixApplied: fixed.length > 0,
    }
  }

  return {
    ...base,
    status: 'pass',
    message: `Auto-applied RLS policies to ${fixed.length} table${fixed.length !== 1 ? 's' : ''}`,
    details: fixed.map((t) => `✓ "${t}" is now protected`),
    fixApplied: true,
  }
}

/**
 * CHECK 5 — webhook_security (blocking for payment providers, warning otherwise)
 * Webhook triggers without a signing secret allow any caller to forge events.
 */
async function checkWebhookSecurity(
  triggers: Array<{ id: string; name: string; webhookUrl: string | null; webhookSecret: string | null }>,
): Promise<ReadinessCheck> {
  const base: Omit<ReadinessCheck, 'status' | 'message' | 'details' | 'fixApplied' | 'severity'> = {
    id: 'webhook_security',
    name: 'Webhook signing secrets',
    description: 'Webhook triggers should have HMAC signing secrets to verify caller identity',
  }

  if (triggers.length === 0) {
    return {
      ...base,
      severity: 'warning',
      status: 'pass',
      message: 'No outbound webhook triggers configured',
      details: [],
      fixApplied: false,
    }
  }

  const PAYMENT_KEYWORDS = ['stripe', 'paddle', 'paypal', 'braintree', 'square', 'mollie', 'razorpay']

  const unsecured: string[] = []
  let hasPaymentProvider = false

  for (const trigger of triggers) {
    if (!trigger.webhookSecret || trigger.webhookSecret.trim() === '') {
      const url = (trigger.webhookUrl ?? '').toLowerCase()
      const isPayment = PAYMENT_KEYWORDS.some((kw) => url.includes(kw))
      if (isPayment) hasPaymentProvider = true
      unsecured.push(
        isPayment
          ? `✗ ${trigger.name} — PAYMENT webhook missing secret (critical)`
          : `⚠ ${trigger.name} — webhook missing secret`,
      )
    }
  }

  if (unsecured.length === 0) {
    return {
      ...base,
      severity: 'warning',
      status: 'pass',
      message: `All ${triggers.length} webhook trigger${triggers.length > 1 ? 's are' : ' is'} secured with signing secrets`,
      details: [],
      fixApplied: false,
    }
  }

  return {
    ...base,
    severity: hasPaymentProvider ? 'blocking' : 'warning',
    status: 'fail',
    message: `${unsecured.length} webhook trigger${unsecured.length > 1 ? 's are' : ' is'} missing signing secrets`,
    details: unsecured,
    fixApplied: false,
  }
}

/**
 * CHECK 6 — api_exposure (warning)
 *
 * Reads the LIVE catalog, the same projection `list_apis` returns.
 *
 * This check used to count `prisma.apiDefinition` rows. That model stopped
 * being the source of truth when the API surface became a projection of the
 * schema — every exposed table HAS full CRUD the instant it exists, with no
 * separate record to generate. The row count stayed at zero, so the gate that
 * guards production told users "3 tables exist but no API endpoints have been
 * generated" about a backend whose endpoints were live and serving. A readiness
 * gate reporting fiction is worse than one that is absent: it sends people to
 * fix something that is not broken and teaches them to ignore the panel.
 */
async function checkApiExposure(projectId: string): Promise<ReadinessCheck> {
  const base: Omit<ReadinessCheck, 'status' | 'message' | 'details' | 'fixApplied'> = {
    id: 'verification',
    name: 'API endpoint generation',
    description: 'Every data table should be reachable over the REST API',
    severity: 'warning',
  }

  const { listExposedTables, isAuthManagedTable } = await import('@/lib/mcp/schema-introspection')
  const tables = (await listExposedTables(projectId)).filter((t) => !isAuthManagedTable(t.name))

  if (tables.length === 0) {
    return {
      ...base,
      status: 'skip',
      message: 'No data tables yet — the built-in auth API needs no generation',
      details: [],
      fixApplied: false,
    }
  }

  return {
    ...base,
    status: 'pass',
    message: `${tables.length} table${tables.length > 1 ? 's are' : ' is'} exposed over REST with full CRUD`,
    details: tables.map((t) => `✓ /db/${t.name} — list, get, create, update, delete`),
    fixApplied: false,
  }
}

/**
 * CHECK 7 — monitoring_basics (warning)
 * Basic observability should be enabled before going live.
 * Checks: metrics enabled, no active incidents, at least one alert rule configured.
 */
async function checkMonitoringBasics(projectId: string): Promise<ReadinessCheck> {
  const base: Omit<ReadinessCheck, 'status' | 'message' | 'details' | 'fixApplied'> = {
    id: 'monitoring_basics',
    name: 'Monitoring configuration',
    description: 'Metrics collection, alert rules, and incident tracking help detect issues in production',
    severity: 'warning',
  }

  const issues: string[] = []
  const passing: string[] = []

  const metricsEnabled = process.env.ENABLE_METRICS
  if (metricsEnabled === 'false' || metricsEnabled === '0') {
    issues.push('⚠ ENABLE_METRICS is disabled — no request metrics will be collected')
  } else {
    passing.push('✓ Metrics collection enabled')
  }

  // Check for unresolved incidents that might signal instability
  try {
    const activeIncidents = await prisma.incident.count({
      where: { projectId, status: 'active' },
    })
    if (activeIncidents > 0) {
      issues.push(
        `⚠ ${activeIncidents} active incident${activeIncidents > 1 ? 's' : ''} — resolve before deploying to production`,
      )
    } else {
      passing.push('✓ No active incidents')
    }
  } catch {
    // Incident model may not exist in all environments — skip
  }

  // Alert rule coverage:
  //   Every Backenly project is watched by the autonomy runtime out of the box
  //   (error-rate, p95 latency, anomaly detection, incident freeze). User-defined
  //   alert rules are an *additive* upgrade, not a requirement — and treating
  //   "no custom rules" as a warning was deducting from every freshly-built
  //   project regardless of state. See feedback_issues_only_dashboard_autonomy:
  //   monitoring stays neutral; gaps surface on the dashboard, not as red dots.
  try {
    const monitoringAlertModel = (prisma as any).monitoringAlert
    if (monitoringAlertModel) {
      const alertRuleCount = await monitoringAlertModel.count({
        where: { projectId, enabled: true },
      })
      if (alertRuleCount > 0) {
        passing.push(`✓ ${alertRuleCount} custom alert rule${alertRuleCount !== 1 ? 's' : ''} configured`)
      } else {
        passing.push('✓ Autonomy default coverage active (error-rate, p95 latency, anomaly detection)')
      }
    } else {
      passing.push('✓ Autonomy default coverage active (error-rate, p95 latency, anomaly detection)')
    }
  } catch {
    // Counting failed — autonomy still runs; surface as informational, not a deduction.
    passing.push('✓ Autonomy default coverage active')
  }

  if (issues.length > 0) {
    return {
      ...base,
      status: 'fail',
      message: `Monitoring has ${issues.length} configuration gap${issues.length !== 1 ? 's' : ''}`,
      details: [...issues, ...passing],
      fixApplied: false,
    }
  }

  return {
    ...base,
    status: 'pass',
    message: 'Monitoring is configured',
    details: passing,
    fixApplied: false,
  }
}

/**
 * CHECK 8 — behavioral_verification (blocking)
 * Runs the Phase 3 behavioral verification engine against the project's live
 * workspace.  A project whose tables, auth, RLS, triggers, and webhooks do not
 * actually behave correctly must not be allowed to go to production.
 *
 * Skipped checks (not applicable to this project) never count as failures.
 * Only checks that ran and failed will block the deploy.
 */
async function checkBehavioralVerification(projectId: string): Promise<ReadinessCheck> {
  const base: Omit<ReadinessCheck, 'status' | 'message' | 'details' | 'fixApplied'> = {
    id: 'behavioral_verification',
    name: 'Behavioral verification',
    description:
      'CRUD, auth, RLS isolation, trigger execution, and webhook HMAC must all pass live end-to-end checks',
    severity: 'blocking',
  }

  try {
    const { runBehavioralVerification } = await import('@/lib/ai/behavioral-verifier')
    const result = await runBehavioralVerification(projectId)

    const ran     = result.checks.filter(c => !c.skipped)
    const failed  = ran.filter(c => !c.passed)
    const skipped = result.checks.filter(c => c.skipped)

    // All checks were skipped (no tables/auth/etc. yet) → not a blocking failure
    if (ran.length === 0) {
      return {
        ...base,
        severity: 'warning',
        status: 'skip',
        message: 'No behavioral checks applicable yet — deploy pending first content',
        details: skipped.map(c => `⏭ ${c.name}: ${c.skipReason}`),
        fixApplied: false,
      }
    }

    if (failed.length === 0) {
      return {
        ...base,
        status: 'pass',
        message: `All ${ran.length} behavioral check${ran.length !== 1 ? 's' : ''} passed${skipped.length > 0 ? ` (${skipped.length} skipped — not applicable)` : ''}`,
        details: [
          ...ran.map(c => `✓ ${c.name}`),
          ...skipped.map(c => `⏭ ${c.name}: ${c.skipReason}`),
        ],
        fixApplied: false,
      }
    }

    // One or more checks failed — block the deploy
    const details: string[] = []
    for (const c of failed) {
      details.push(`✗ ${c.name}: ${c.error ?? 'assertion failed'}`)
      for (const d of c.details.filter(l => l.startsWith('✗'))) {
        details.push(`    ${d}`)
      }
    }
    for (const c of ran.filter(c => c.passed)) {
      details.push(`✓ ${c.name}`)
    }
    for (const c of skipped) {
      details.push(`⏭ ${c.name}: ${c.skipReason}`)
    }

    return {
      ...base,
      status: 'fail',
      message: `${failed.length} of ${ran.length} behavioral check${failed.length !== 1 ? 's' : ''} failed — backend does not behave correctly`,
      details,
      fixApplied: false,
    }
  } catch (err: any) {
    // If the behavioral verifier itself errors (e.g. DB unreachable), treat as warning
    // so a transient infra issue does not permanently block deploys.
    return {
      ...base,
      severity: 'warning',
      status: 'fail',
      message: 'Behavioral verification could not run — verify your database connection',
      details: [`⚠ ${sanitizeDiagnostic(err) || 'Unknown error running behavioral verifier'}`],
      fixApplied: false,
    }
  }
}

/**
 * CHECK 7b — end_user_auth_table (blocking)
 * If the project has auth enabled (jwtSecret set + authManifest.enabled), the
 * workspace must contain a `users` table. Without it, end-user sign-up/sign-in
 * will fail with a SQL error at runtime.
 */
async function checkEndUserAuthTable(
  projectId: string,
  project: { jwtSecret: string | null; authManifest: any },
): Promise<ReadinessCheck> {
  const base: Omit<ReadinessCheck, 'status' | 'message' | 'details' | 'fixApplied'> = {
    id: 'end_user_auth_table',
    name: 'End-user auth table',
    description: 'Projects with auth enabled need a workspace `users` table for sign-up/sign-in',
    severity: 'blocking',
  }

  const jwtReady = !!project.jwtSecret && project.jwtSecret.length >= 32
  const manifestEnabled = (project.authManifest as any)?.enabled === true
  const authEnabled = jwtReady && manifestEnabled

  const schemaName = `workspace_${projectId}`

  try {
    const rows = await prisma.$queryRawUnsafe<{ count: string }[]>(
      `SELECT COUNT(*)::text AS count
         FROM information_schema.tables
        WHERE table_schema = $1
          AND table_name = 'users'`,
      schemaName,
    )
    const usersTableExists = parseInt(rows[0]?.count ?? '0', 10) > 0

    // Auth manifest flag not set but users table + jwtSecret already exist → auto-correct the flag.
    // This happens when Google OAuth is connected but the AI build flow skipped the manifest write.
    if (!authEnabled && jwtReady && usersTableExists) {
      try {
        const existing = (typeof project.authManifest === 'object' && project.authManifest !== null)
          ? (project.authManifest as Record<string, unknown>)
          : {}
        await prisma.project.update({
          where: { id: projectId },
          data: { authManifest: { ...existing, enabled: true } },
        })
      } catch { /* non-fatal — check still passes below */ }

      return {
        ...base,
        status: 'pass',
        message: `workspace_${projectId}.users table exists — authManifest.enabled auto-corrected`,
        details: ['✓ Auth manifest was missing enabled:true — auto-set because users table and jwtSecret exist'],
        fixApplied: true,
      }
    }

    // Auth is intentionally not enabled and no users table → skip (not a problem)
    if (!authEnabled) {
      return {
        ...base,
        severity: 'warning',
        status: 'skip',
        message: 'Auth is not enabled — skipping end-user users table check',
        details: [],
        fixApplied: false,
      }
    }

    // Auth is enabled — users table must exist
    if (usersTableExists) {
      return {
        ...base,
        status: 'pass',
        message: `workspace_${projectId}.users table exists — end-user auth is ready`,
        details: [],
        fixApplied: false,
      }
    }

    return {
      ...base,
      status: 'fail',
      message: 'Auth is enabled but the workspace `users` table does not exist',
      details: [
        '✗ Sign-up and sign-in routes will fail with a table-not-found error',
        '→ Ask the AI to "set up user authentication" or re-run the build to create the users table',
      ],
      fixApplied: false,
    }
  } catch (err: any) {
    return {
      ...base,
      severity: 'warning',
      status: 'fail',
      message: 'Could not verify end-user users table — check DB connectivity',
      details: [`⚠ ${sanitizeDiagnostic(err) || 'Unknown error'}`],
      fixApplied: false,
    }
  }
}

/**
 * CHECK 9 — security_audit (blocking on critical/high findings)
 * Runs the automated security scanner against all generated API definitions
 * and AI functions. Critical findings (SQL injection, path traversal, exposed
 * admin endpoints) and high findings (mass assignment, missing auth) block the
 * deploy. Medium/low findings are surfaced as warnings only.
 *
 * Skipped when the project has no API definitions yet (nothing to audit).
 */
async function checkSecurityAudit(projectId: string): Promise<ReadinessCheck> {
  const base: Omit<ReadinessCheck, 'status' | 'message' | 'details' | 'fixApplied'> = {
    id: 'security_audit',
    name: 'Security audit',
    description: 'Generated endpoints must have no SQL injection, path traversal, mass assignment, or exposed admin routes',
    severity: 'blocking',
  }

  try {
    // Skip only when there is genuinely nothing exposed.
    //
    // This counted ApiDefinition rows, which have had no create path since the
    // PostgREST cutover. So on every project built after it the count was 0 and
    // this returned `skip` — "Generate APIs first to enable security scanning" —
    // meaning the security scan has not run on any modern project, and said so
    // in words that read like ordinary setup advice rather than a gap.
    //
    // Reachability is the catalog's answer, so ask it.
    const { listExposedTables } = await import('@/lib/mcp/schema-introspection')
    const exposedCount = (await listExposedTables(projectId).catch(() => [])).length
    if (exposedCount === 0) {
      return {
        ...base,
        severity: 'warning',
        status: 'skip',
        message: 'No tables are exposed over REST yet — security scan skipped',
        details: ['⏭ Create a table to enable security scanning'],
        fixApplied: false,
      }
    }

    const { auditGeneratedAPIs } = await import('@/lib/ai/build-runtime/security-auditor')
    // Use a synthetic nodeId — the auditor only uses it for report correlation
    const report = await auditGeneratedAPIs(projectId, 'readiness-check')

    // Critical + high findings block the deploy
    const blockingCount = report.criticalCount + report.highCount
    const details: string[] = []

    if (report.criticalCount > 0) {
      details.push(`✗ ${report.criticalCount} CRITICAL finding${report.criticalCount !== 1 ? 's' : ''} — must fix before deploying`)
      report.findings
        .filter(f => f.severity === 'critical')
        .forEach(f => details.push(`    ✗ ${f.category} at ${f.location}: ${f.description.slice(0, 100)}`))
    }

    if (report.highCount > 0) {
      details.push(`✗ ${report.highCount} HIGH finding${report.highCount !== 1 ? 's' : ''} — must fix before deploying`)
      report.findings
        .filter(f => f.severity === 'high')
        .forEach(f => details.push(`    ✗ ${f.category} at ${f.location}: ${f.description.slice(0, 100)}`))
    }

    if (report.mediumCount > 0) {
      details.push(`⚠ ${report.mediumCount} MEDIUM finding${report.mediumCount !== 1 ? 's' : ''} (advisory)`)
    }
    if (report.lowCount > 0) {
      details.push(`⚠ ${report.lowCount} LOW finding${report.lowCount !== 1 ? 's' : ''} (advisory)`)
    }

    details.push(`Security score: ${report.score}/100 (${report.endpointsAudited} endpoint${report.endpointsAudited !== 1 ? 's' : ''} audited)`)

    if (blockingCount > 0) {
      return {
        ...base,
        status: 'fail',
        message: `Security audit failed — ${blockingCount} blocking finding${blockingCount !== 1 ? 's' : ''} (score: ${report.score}/100)`,
        details,
        fixApplied: false,
      }
    }

    return {
      ...base,
      status: 'pass',
      message: `Security audit passed — score ${report.score}/100, ${report.endpointsAudited} endpoint${report.endpointsAudited !== 1 ? 's' : ''} audited`,
      details,
      fixApplied: false,
    }
  } catch (err: any) {
    // Treat auditor errors as a warning, not a hard block — infra issues shouldn't
    // permanently prevent deploys, but the team should know the audit couldn't run.
    return {
      ...base,
      severity: 'warning',
      status: 'fail',
      message: 'Security audit could not run — check build runtime configuration',
      details: [`⚠ ${sanitizeDiagnostic(err) || 'Unknown error running security auditor'}`],
      fixApplied: false,
    }
  }
}

/**
 * CHECK 11 — function_triggers (warning)
 * Detects two mis-configuration patterns that commonly break production:
 *   a) Placeholder functions (template description never filled in) that somehow
 *      acquired a live DB trigger — these will error on every insert/update.
 *   b) Functions whose name implies an on-signup side-effect (welcome email, etc.)
 *      but whose triggerType is still 'manual' — they will never run automatically.
 *
 * Placeholder functions with active triggers are auto-deactivated.
 */
async function checkFunctionTriggers(projectId: string): Promise<ReadinessCheck> {
  const base: Omit<ReadinessCheck, 'status' | 'message' | 'details' | 'fixApplied'> = {
    id: 'function_triggers',
    name: 'AI function trigger configuration',
    description: 'Placeholder functions must not have live triggers; signup functions must have on-signup triggers',
    severity: 'warning',
  }

  try {
    const fns = await prisma.aiFunction.findMany({
      where: { projectId },
      select: { id: true, name: true, description: true, triggerType: true, status: true },
    })

    if (fns.length === 0) {
      return { ...base, status: 'skip', message: 'No AI functions defined', details: [], fixApplied: false }
    }

    const { isPlaceholderDescription, PLACEHOLDER_NAME_RE } = await import('@/lib/ai/function-validation')

    const issues: string[] = []
    const toDeactivate: string[] = []

    for (const fn of fns) {
      const isPlaceholder =
        isPlaceholderDescription(fn.description) ||
        PLACEHOLDER_NAME_RE.test(fn.name)

      if (isPlaceholder && fn.status === 'active' && fn.triggerType !== 'manual') {
        issues.push(`✗ Placeholder function "${fn.name}" has an active ${fn.triggerType} trigger — will error on every event`)
        toDeactivate.push(fn.id)
        continue
      }
      if (isPlaceholder) {
        issues.push(`⚠ Placeholder function "${fn.name}" exists — fill in its description or delete it`)
        continue
      }

      // Detect signup-implied functions left on manual
      const impliesSignup = /signup|sign_up|on_signup|welcome.*user|user.*welcome|new.*user.*email/i.test(fn.name)
      if (impliesSignup && fn.triggerType === 'manual') {
        issues.push(`⚠ Function "${fn.name}" appears to be a signup hook but triggerType is "manual" — it will never auto-run on user signup`)
      }
    }

    // Auto-deactivate placeholder functions that have live triggers
    let fixApplied = false
    if (toDeactivate.length > 0) {
      try {
        await prisma.aiFunction.updateMany({
          where: { id: { in: toDeactivate } },
          data: { status: 'inactive' },
        })
        fixApplied = true
        issues.push(`✓ Auto-deactivated ${toDeactivate.length} placeholder function${toDeactivate.length !== 1 ? 's' : ''} that had live triggers`)
      } catch { /* non-fatal */ }
    }

    if (issues.length === 0) {
      return {
        ...base,
        status: 'pass',
        message: `All ${fns.length} AI function${fns.length !== 1 ? 's' : ''} have correct trigger configuration`,
        details: [],
        fixApplied: false,
      }
    }

    const hasBlocking = issues.some(i => i.startsWith('✗'))
    return {
      ...base,
      status: 'fail',
      message: `${issues.filter(i => i.startsWith('✗') || i.startsWith('⚠')).length} function trigger issue${issues.length !== 1 ? 's' : ''} detected`,
      details: issues,
      fixApplied,
    }
  } catch (err: any) {
    return {
      ...base,
      status: 'fail',
      message: 'Could not check function trigger configuration',
      details: [`⚠ ${sanitizeDiagnostic(err) || 'Unknown error'}`],
      fixApplied: false,
    }
  }
}

// ─── Report builder ───────────────────────────────────────────────────────────

function buildReport(projectId: string, checks: ReadinessCheck[]): ReadinessReport {
  const blockers = checks.filter(
    (c) =>
      (c.severity === 'blocking' || (c.severity === 'auto-fixable' && !c.fixApplied)) &&
      c.status === 'fail',
  )
  const warnings = checks.filter((c) => c.severity === 'warning' && c.status === 'fail')
  const autoFixed = checks.filter((c) => c.fixApplied)

  let score = 100
  for (const check of checks) {
    if (check.status === 'fail' && !check.fixApplied) {
      score -= SCORE_DEDUCTIONS[check.severity]
    }
  }
  score = Math.max(0, score)

  return {
    projectId,
    ready: blockers.length === 0,
    score,
    checks,
    blockers,
    warnings,
    autoFixed,
    evaluatedAt: new Date().toISOString(),
  }
}

function buildEmptyReport(projectId: string, reason: string): ReadinessReport {
  const check: ReadinessCheck = {
    id: 'project_exists',
    name: 'Project exists',
    description: 'The project must exist to evaluate readiness',
    severity: 'blocking',
    status: 'fail',
    message: reason,
    details: [],
    fixApplied: false,
  }
  return {
    projectId,
    ready: false,
    score: 0,
    checks: [check],
    blockers: [check],
    warnings: [],
    autoFixed: [],
    evaluatedAt: new Date().toISOString(),
  }
}

// ─── Formatting helpers (used by AI executor and API) ─────────────────────────

/**
 * Produce a concise human-readable summary of a failed readiness report.
 * Suitable for returning as an AI chat message.
 */
export function formatReadinessReport(report: ReadinessReport): string {
  const lines: string[] = []

  lines.push(`**Readiness Score: ${report.score}/100**`)
  lines.push('')

  if (report.autoFixed.length > 0) {
    lines.push(`✅ **Auto-fixed ${report.autoFixed.length} issue${report.autoFixed.length > 1 ? 's' : ''}:**`)
    for (const fix of report.autoFixed) {
      lines.push(`  • ${fix.name}: ${fix.message}`)
    }
    lines.push('')
  }

  if (report.blockers.length > 0) {
    lines.push(`🚫 **${report.blockers.length} blocking issue${report.blockers.length > 1 ? 's' : ''} must be resolved:**`)
    for (const blocker of report.blockers) {
      lines.push(`  • **${blocker.name}**: ${blocker.message}`)
      for (const detail of blocker.details) {
        lines.push(`    ${detail}`)
      }
    }
    lines.push('')
  }

  if (report.warnings.length > 0) {
    lines.push(`⚠️ **${report.warnings.length} warning${report.warnings.length > 1 ? 's' : ''} (deploy allowed but recommended to fix):**`)
    for (const warn of report.warnings) {
      lines.push(`  • **${warn.name}**: ${warn.message}`)
      for (const detail of warn.details) {
        lines.push(`    ${detail}`)
      }
    }
    lines.push('')
  }

  if (report.ready) {
    lines.push('✅ **Project passed all readiness checks and is cleared for deployment.**')
  } else {
    lines.push('**Fix the blocking issues above, then deploy again.**')
  }

  return lines.join('\n')
}
