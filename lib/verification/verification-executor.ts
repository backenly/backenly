/**
 * VERIFICATION EXECUTOR — Phase 13
 * =================================
 * Executes verification scenarios in a controlled, structurally safe way.
 * Never mutates workspace data — all checks are read-only DB queries.
 *
 * Two entry points:
 *
 *   executeVerificationScenarios(scenarios, context)
 *     Runs planned scenarios from the behavior-runner (those with
 *     safeLiveEligible=true in safe_live mode). Used by the AI pipeline
 *     when consuming a BehaviorVerificationReport.
 *
 *   runBuiltInVerification(projectId)
 *     Runs a fixed set of structural checks that the workspace-observer
 *     calls after each fix cycle. Does not need a BehaviorVerificationReport.
 *
 * SAFE LIVE CONTRACT (must never be violated):
 *   • Only categories: auth, rls, state_machine, security
 *   • All DB operations are SELECT / information_schema reads
 *   • No INSERT, UPDATE, DELETE, TRUNCATE, DDL of any kind
 *   • No HTTP calls to external services
 *   • No side effects on workspace state
 *
 * Gated by FLAGS.ENABLE_VERIFICATION_EXECUTION + FLAGS.ENABLE_SAFE_VERIFICATION_MODE.
 */

import { queryWorkspaceSchema } from '../services/workspaceDatabase'
import { prisma } from '../db/prisma'
import { notReservedTableSql } from '../security/workspace-schema'
import type { ScenarioDryRunResult } from './behavior-runner'
import { SAFE_LIVE_CATEGORIES, BLOCKED_LIVE_CATEGORIES } from './behavior-runner'

// ─── Public types ─────────────────────────────────────────────────────────────

export type VerificationExecutionMode = 'dry_run' | 'safe_live'
export type ScenarioOutcome = 'passed' | 'failed' | 'skipped'

export interface CheckResult {
  stepId: string
  description: string
  passed: boolean
  message: string
}

export interface ScenarioResult {
  scenarioId: string
  name: string
  category: string
  severity: string
  outcome: ScenarioOutcome
  /** Human-readable explanation of the outcome */
  reason: string
  checks: CheckResult[]
  durationMs: number
  executedAt: string
}

export interface VerificationExecutionResult {
  passed: ScenarioResult[]
  failed: ScenarioResult[]
  skipped: ScenarioResult[]
  total: number
  durationMs: number
  executedAt: string
}

// ─── Scenario execution from behavior-runner output ──────────────────────────

/**
 * Execute planned scenarios from the behavior-runner.
 *
 * In dry_run mode every scenario is skipped (no DB reads occur).
 * In safe_live mode only safeLiveEligible=true scenarios run structural checks.
 */
export async function executeVerificationScenarios(
  scenarios: ScenarioDryRunResult[],
  context: { projectId: string; mode: VerificationExecutionMode },
): Promise<VerificationExecutionResult> {
  const overallStart = Date.now()
  const executedAt = new Date().toISOString()
  const passed: ScenarioResult[] = []
  const failed: ScenarioResult[] = []
  const skipped: ScenarioResult[] = []

  for (const scenario of scenarios) {
    // dry_run: skip everything, no live checks
    if (context.mode === 'dry_run') {
      skipped.push(makeSkippedFromRunner(scenario, 'dry_run mode — no live execution'))
      continue
    }

    // Runner already marked this as blocked or filtered
    if (scenario.status !== 'planned') {
      skipped.push(makeSkippedFromRunner(scenario, `runner status is "${scenario.status}"`))
      continue
    }

    // Safety gate: category must be in SAFE_LIVE_CATEGORIES
    if (BLOCKED_LIVE_CATEGORIES.has(scenario.category as any)) {
      skipped.push(makeSkippedFromRunner(scenario, `category "${scenario.category}" is blocked from safe_live execution`))
      continue
    }
    if (!SAFE_LIVE_CATEGORIES.has(scenario.category as any)) {
      skipped.push(makeSkippedFromRunner(scenario, `category "${scenario.category}" is not in safe_live allowlist`))
      continue
    }

    // Runner must have explicitly approved this scenario for live execution
    if (!scenario.safeLiveEligible) {
      skipped.push(makeSkippedFromRunner(scenario, 'not marked safeLiveEligible by behavior-runner'))
      continue
    }

    const result = await runStructuralChecksForScenario(scenario, context.projectId)
    if (result.outcome === 'passed') passed.push(result)
    else failed.push(result)
  }

  return {
    passed,
    failed,
    skipped,
    total: scenarios.length,
    durationMs: Date.now() - overallStart,
    executedAt,
  }
}

// ─── Built-in structural verification (used by workspace-observer) ────────────

interface BuiltInScenario {
  id: string
  name: string
  category: string
  severity: string
  run: (projectId: string) => Promise<CheckResult[]>
}

const BUILT_IN_SCENARIOS: BuiltInScenario[] = [
  {
    id: 'builtin_auth_users_table',
    name: 'Auth: workspace users table exists',
    category: 'auth',
    severity: 'critical',
    run: (pid) => Promise.all([checkAuthUsersTable(pid)]),
  },
  {
    id: 'builtin_auth_jwt_config',
    name: 'Auth: project JWT secret configured',
    category: 'auth',
    severity: 'critical',
    run: (pid) => Promise.all([checkJwtConfig(pid)]),
  },
  {
    id: 'builtin_rls_user_tables',
    name: 'RLS: user-data tables are protected',
    category: 'rls',
    severity: 'warning',
    run: (pid) => Promise.all([checkRlsOnUserTables(pid)]),
  },
  {
    id: 'builtin_sm_status_constraints',
    name: 'State Machine: status columns have CHECK constraints',
    category: 'state_machine',
    severity: 'warning',
    run: (pid) => Promise.all([checkStatusColumnConstraints(pid)]),
  },
  {
    id: 'builtin_security_no_unprotected_data',
    name: 'Security: no unprotected user-data tables',
    category: 'security',
    severity: 'critical',
    run: (pid) => Promise.all([checkNoUnprotectedUserData(pid)]),
  },
]

/**
 * Run the built-in structural verification scenarios for a project.
 * Called by workspace-observer after the fix-plan cycle to confirm fixes held.
 */
export async function runBuiltInVerification(
  projectId: string,
): Promise<VerificationExecutionResult> {
  const overallStart = Date.now()
  const executedAt = new Date().toISOString()
  const passed: ScenarioResult[] = []
  const failed: ScenarioResult[] = []
  const skipped: ScenarioResult[] = []

  await Promise.allSettled(
    BUILT_IN_SCENARIOS.map(async (scenario) => {
      const start = Date.now()
      let checks: CheckResult[] = []
      let errorMsg: string | undefined

      try {
        checks = await scenario.run(projectId)
      } catch (err) {
        errorMsg = err instanceof Error ? err.message : String(err)
        checks = [{
          stepId: 'execution_error',
          description: 'Executor threw an unexpected error',
          passed: false,
          message: errorMsg,
        }]
      }

      const allPassed = checks.every(c => c.passed)
      const result: ScenarioResult = {
        scenarioId: scenario.id,
        name: scenario.name,
        category: scenario.category,
        severity: scenario.severity,
        outcome: allPassed ? 'passed' : 'failed',
        reason: allPassed
          ? 'All structural checks passed'
          : checks.find(c => !c.passed)?.message ?? 'One or more checks failed',
        checks,
        durationMs: Date.now() - start,
        executedAt: new Date().toISOString(),
      }

      if (allPassed) passed.push(result)
      else failed.push(result)
    }),
  )

  return {
    passed,
    failed,
    skipped,
    total: BUILT_IN_SCENARIOS.length,
    durationMs: Date.now() - overallStart,
    executedAt,
  }
}

// ─── Structural check dispatcher ─────────────────────────────────────────────

async function runStructuralChecksForScenario(
  scenario: ScenarioDryRunResult,
  projectId: string,
): Promise<ScenarioResult> {
  const start = Date.now()
  let checks: CheckResult[] = []

  try {
    switch (scenario.category) {
      case 'auth': {
        checks = await Promise.all([
          checkAuthUsersTable(projectId),
          checkJwtConfig(projectId),
        ])
        break
      }
      case 'rls': {
        checks = await Promise.all([checkRlsOnUserTables(projectId)])
        break
      }
      case 'state_machine': {
        checks = await Promise.all([checkStatusColumnConstraints(projectId)])
        break
      }
      case 'security': {
        checks = await Promise.all([checkNoUnprotectedUserData(projectId)])
        break
      }
      default: {
        checks = [{
          stepId: 'category_guard',
          description: 'Category safety check',
          passed: false,
          message: `Category "${scenario.category}" reached executor but is not in safe allowlist — this is a bug`,
        }]
      }
    }
  } catch (err) {
    checks = [{
      stepId: 'execution_error',
      description: 'Unexpected executor error',
      passed: false,
      message: err instanceof Error ? err.message : String(err),
    }]
  }

  const allPassed = checks.every(c => c.passed)
  return {
    scenarioId: scenario.scenarioId,
    name: scenario.name,
    category: scenario.category,
    severity: scenario.severity,
    outcome: allPassed ? 'passed' : 'failed',
    reason: allPassed
      ? 'All structural checks passed'
      : checks.find(c => !c.passed)?.message ?? 'One or more checks failed',
    checks,
    durationMs: Date.now() - start,
    executedAt: new Date().toISOString(),
  }
}

// ─── Individual structural checks ─────────────────────────────────────────────

/**
 * Verify the workspace has a `users` table (required for auth scenarios).
 * READ-ONLY: queries information_schema.tables.
 */
async function checkAuthUsersTable(projectId: string): Promise<CheckResult> {
  const schemaName = `workspace_${projectId}`
  try {
    const rows = await queryWorkspaceSchema(
      projectId,
      `SELECT COUNT(*) AS cnt
       FROM information_schema.tables
       WHERE table_schema = $1 AND table_name = 'users'`,
      schemaName,
    )
    const count = parseInt(String((rows?.rows ?? rows)?.[0]?.cnt ?? '0'), 10)
    if (count === 0) {
      // The users table is created lazily by the first signup. Missing is only
      // a failure when the developer configured auth surface that depends on it.
      const { getEndUserAuthUsage } = await import('@/lib/services/auth-status')
      const usage = await getEndUserAuthUsage(projectId)
      if (!usage.configuredEvidence) {
        return {
          stepId: 'auth_users_table',
          description: 'Workspace users table exists',
          passed: true,
          message: 'End-user auth not in use yet — the users table is provisioned automatically on first signup',
        }
      }
    }
    return {
      stepId: 'auth_users_table',
      description: 'Workspace users table exists',
      passed: count > 0,
      message: count > 0
        ? 'users table found in workspace schema'
        : `users table is missing from schema "${schemaName}" — auth cannot function`,
    }
  } catch (err) {
    return {
      stepId: 'auth_users_table',
      description: 'Workspace users table exists',
      passed: false,
      message: `Check failed: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

/**
 * Verify the project has a jwtSecret configured.
 * READ-ONLY: queries the platform Prisma DB (public schema).
 */
async function checkJwtConfig(projectId: string): Promise<CheckResult> {
  try {
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { jwtSecret: true },
    })
    const configured = typeof project?.jwtSecret === 'string' && project.jwtSecret.length > 0
    if (!configured) {
      // The jwtSecret is provisioned lazily (bootstrap seeds it; the first
      // signup creates it on demand). Missing is only a failure when end-user
      // auth is demonstrably in use.
      const { getEndUserAuthUsage } = await import('@/lib/services/auth-status')
      const usage = await getEndUserAuthUsage(projectId)
      if (!usage.inUse) {
        return {
          stepId: 'auth_jwt_config',
          description: 'Project JWT secret configured',
          passed: true,
          message: 'End-user auth not in use yet — the JWT secret is provisioned automatically on first signup',
        }
      }
    }
    return {
      stepId: 'auth_jwt_config',
      description: 'Project JWT secret configured',
      passed: configured,
      message: configured
        ? 'Project has a jwtSecret configured'
        : 'Project jwtSecret is missing — end-user auth tokens cannot be issued',
    }
  } catch (err) {
    return {
      stepId: 'auth_jwt_config',
      description: 'Project JWT secret configured',
      passed: false,
      message: `Check failed: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

/**
 * Verify that all workspace tables containing a user_id-style column have
 * row-level security enabled.
 * READ-ONLY: queries pg_tables + information_schema.columns + pg_class.
 */
async function checkRlsOnUserTables(projectId: string): Promise<CheckResult> {
  const schemaName = `workspace_${projectId}`
  try {
    const rows = await queryWorkspaceSchema(
      projectId,
      `SELECT t.tablename
       FROM pg_tables t
       JOIN information_schema.columns c
         ON c.table_schema = $1
        AND c.table_name = t.tablename
        AND c.column_name IN ('user_id', 'userId', 'owner_id')
       LEFT JOIN pg_class pc
         ON pc.relname = t.tablename
        AND pc.relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = $1)
       WHERE t.schemaname = $1
         AND NOT COALESCE(pc.relrowsecurity, false)
         AND ${notReservedTableSql('t.tablename')}
       GROUP BY t.tablename`,
      schemaName,
    )
    const unprotected: string[] = (rows?.rows ?? rows ?? []).map((r: any) => r.tablename)
    return {
      stepId: 'rls_user_tables',
      description: 'User-data tables have RLS enabled',
      passed: unprotected.length === 0,
      message: unprotected.length === 0
        ? 'All user-data tables have RLS enabled'
        : `${unprotected.length} table(s) missing RLS: ${unprotected.join(', ')}`,
    }
  } catch (err) {
    return {
      stepId: 'rls_user_tables',
      description: 'User-data tables have RLS enabled',
      passed: false,
      message: `Check failed: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

/**
 * Verify that status columns in the workspace have CHECK constraints
 * (minimal guard for state-machine integrity).
 * READ-ONLY: queries information_schema.check_constraints.
 */
async function checkStatusColumnConstraints(projectId: string): Promise<CheckResult> {
  const schemaName = `workspace_${projectId}`
  try {
    const tablesWithStatus = await queryWorkspaceSchema(
      projectId,
      `SELECT DISTINCT c.table_name
       FROM information_schema.columns c
       WHERE c.table_schema = $1
         AND c.column_name = 'status'
         AND ${notReservedTableSql('c.table_name')}`,
      schemaName,
    )
    const statusTables: string[] = (tablesWithStatus?.rows ?? tablesWithStatus ?? []).map((r: any) => r.table_name)

    if (statusTables.length === 0) {
      return {
        stepId: 'sm_status_constraints',
        description: 'Status columns have CHECK constraints',
        passed: true,
        message: 'No status columns found — state machine check is not applicable',
      }
    }

    const tablesWithConstraints = await queryWorkspaceSchema(
      projectId,
      `SELECT DISTINCT tc.table_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.check_constraints cc
         ON cc.constraint_name = tc.constraint_name
        AND cc.constraint_schema = tc.constraint_schema
       WHERE tc.constraint_type = 'CHECK'
         AND tc.table_schema = $1
         AND tc.table_name = ANY($2)`,
      schemaName,
      statusTables,
    )
    const constrainedTables = new Set<string>(
      (tablesWithConstraints?.rows ?? tablesWithConstraints ?? []).map((r: any) => r.table_name),
    )
    const unconstrained = statusTables.filter(t => !constrainedTables.has(t))

    return {
      stepId: 'sm_status_constraints',
      description: 'Status columns have CHECK constraints',
      passed: unconstrained.length === 0,
      message: unconstrained.length === 0
        ? `All ${statusTables.length} status column(s) have CHECK constraints`
        : `${unconstrained.length} table(s) with status column but no CHECK constraint: ${unconstrained.join(', ')}`,
    }
  } catch (err) {
    return {
      stepId: 'sm_status_constraints',
      description: 'Status columns have CHECK constraints',
      passed: false,
      message: `Check failed: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

/**
 * Verify there are no workspace tables with user-data columns that lack both
 * RLS and a user_id ownership column (fully unprotected data).
 * READ-ONLY: cross-join of pg_tables with information_schema.columns.
 */
async function checkNoUnprotectedUserData(projectId: string): Promise<CheckResult> {
  const schemaName = `workspace_${projectId}`
  try {
    const rows = await queryWorkspaceSchema(
      projectId,
      `SELECT t.tablename
       FROM pg_tables t
       LEFT JOIN information_schema.columns c
         ON c.table_schema = $1
        AND c.table_name = t.tablename
        AND c.column_name IN ('user_id', 'userId', 'owner_id', 'email')
       LEFT JOIN pg_class pc
         ON pc.relname = t.tablename
        AND pc.relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = $1)
       WHERE t.schemaname = $1
         AND c.column_name IS NOT NULL
         AND NOT COALESCE(pc.relrowsecurity, false)
         AND ${notReservedTableSql('t.tablename')}
       GROUP BY t.tablename`,
      schemaName,
    )
    const unprotected: string[] = (rows?.rows ?? rows ?? []).map((r: any) => r.tablename)
    return {
      stepId: 'security_no_unprotected_data',
      description: 'No unprotected user-data tables',
      passed: unprotected.length === 0,
      message: unprotected.length === 0
        ? 'No unprotected user-data tables found'
        : `${unprotected.length} table(s) hold user data without RLS: ${unprotected.join(', ')}`,
    }
  } catch (err) {
    return {
      stepId: 'security_no_unprotected_data',
      description: 'No unprotected user-data tables',
      passed: false,
      message: `Check failed: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeSkippedFromRunner(
  scenario: ScenarioDryRunResult,
  reason: string,
): ScenarioResult {
  return {
    scenarioId: scenario.scenarioId,
    name: scenario.name,
    category: scenario.category,
    severity: scenario.severity,
    outcome: 'skipped',
    reason,
    checks: [],
    durationMs: 0,
    executedAt: new Date().toISOString(),
  }
}
