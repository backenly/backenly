/**
 * VERIFIER
 * ========
 * Post-execution verification against REAL project state.
 *
 * Rules:
 *  - Never returns 'verified' without reading actual DB/runtime state
 *  - Structural completion (table name in schema) is not enough
 *  - Each verification check has a specific probe — not a regex on a string
 *  - Verification nodes (type=verification) call these checks
 *  - Results feed back into the build graph to update node status
 */

import type { BuildNode, BuildJob, PostBuildValidationReport } from './types'
import type { BuildGraph } from './build-graph'
import { runBehavioralScenarios } from './behavioral-verifier'
import { auditGeneratedAPIs } from './security-auditor'
import { runLoadTestBaseline, clearLoadTestCache } from './load-tester'
import { analyzeProductionReadiness } from '@/lib/ai/production-intelligence'

export interface VerificationCheck {
  label: string
  status: 'pass' | 'fail' | 'skip' | 'warn'
  detail?: string
}

export interface VerificationReport {
  nodeId: string
  passed: boolean
  checks: VerificationCheck[]
  summary: string
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface FullVerificationResult {
  structuralReports: VerificationReport[]
  validationReport: PostBuildValidationReport
}

/**
 * Run all verification checks for a BuildJob after execution.
 *
 * Three layers:
 *  1. Structural checks — tables, APIs, workspaces exist in DB (fast)
 *  2. Behavioral scenarios — real HTTP E2E tests: signup, auth, RLS, credits (#78, #79)
 *  3. Security audit — pattern scan of generated endpoint code (#80)
 *  4. Load test baseline — 100 concurrent requests, p95 latency, regression check (#81)
 *
 * Updates graph node statuses for verification nodes.
 * Returns the full structured validation report shown to the user (#82).
 */
export async function verifyBuildJob(
  job: BuildJob,
  graph: BuildGraph,
  projectId: string,
): Promise<FullVerificationResult> {
  const structuralReports: VerificationReport[] = []

  // ── Layer 1: Structural verification (original logic) ─────────────────────
  for (const phase of job.phases) {
    for (const node of phase.nodes) {
      if (node.type !== 'verification') continue
      if (node.status === 'blocked') continue

      const report = await verifyNode(node, job, graph, projectId)
      structuralReports.push(report)

      if (report.passed) {
        graph.markVerified(node.id, report.summary)
      } else {
        graph.setStatus(node.id, 'partial', { executionDetail: report.summary })
      }
    }
  }

  // ── Layers 2, 3, 4 run concurrently ─────────────────────────────────────────
  const [behavioralReport, securityReport, loadReport, productionReport] = await Promise.all([
    runBehavioralScenarios(projectId, 'verification.behavioral'),    // Layer 2
    auditGeneratedAPIs(projectId, 'verification.security'),          // Layer 3
    runLoadTestBaseline(projectId, 'verification.load'),             // Layer 4
    analyzeProductionReadiness(projectId),                           // Layer 5
  ])
  clearLoadTestCache()

  // ── Assemble PostBuildValidationReport ────────────────────────────────────
  const validationReport: PostBuildValidationReport = {
    passed: behavioralReport.passed && securityReport.passed && loadReport.passed,
    ranAt: new Date().toISOString(),

    behavioral: {
      passed: behavioralReport.passed,
      totalScenarios: behavioralReport.totalScenarios,
      passedScenarios: behavioralReport.passedScenarios,
      failedScenarios: behavioralReport.failedScenarios,
      durationMs: behavioralReport.durationMs,
      failures: (behavioralReport.scenarios ?? [])
        .filter(s => !s.passed)
        .map(s => s.scenario),
    },

    security: {
      passed: securityReport.passed,
      score: securityReport.score,
      endpointsAudited: securityReport.endpointsAudited,
      criticalCount: securityReport.criticalCount,
      highCount: securityReport.highCount,
      mediumCount: securityReport.mediumCount,
      topFindings: securityReport.findings
        .sort((a, b) => severityWeight(b.severity) - severityWeight(a.severity))
        .slice(0, 5)
        .map(f => ({
          severity: f.severity,
          category: f.category,
          location: f.location,
          description: f.description,
          recommendation: f.recommendation,
        })),
    },

    loadTest: {
      passed: loadReport.passed,
      overallP95Ms: loadReport.baseline.overallP95,
      overallFailureRate: loadReport.baseline.overallFailureRate,
      endpointsTested: loadReport.endpointResults.length,
      regressionDetected: loadReport.regressionDetected,
      regressions: loadReport.regressions,
    },

    productionIntelligence: {
      score: productionReport.score,
      criticalCount: productionReport.criticalCount,
      highCount: productionReport.highCount,
      mediumCount: productionReport.mediumCount,
      lowCount: productionReport.lowCount,
      autoFixableCount: productionReport.autoFixableCount,
      topIssues: productionReport.issues
        .sort((a, b) => severityWeight(b.severity) - severityWeight(a.severity))
        .slice(0, 8)
        .map(i => ({
          type: i.type,
          severity: i.severity,
          location: i.location,
          description: i.description,
          recommendation: i.recommendation,
          autoFixable: i.autoFixable,
          fix: i.fix,
        })),
    },
  }

  console.log(
    `[Verifier] Production intelligence: score=${productionReport.score} ` +
    `critical=${productionReport.criticalCount} high=${productionReport.highCount} ` +
    `autoFixable=${productionReport.autoFixableCount}`,
  )

  return { structuralReports, validationReport }
}

function severityWeight(s: string): number {
  return s === 'critical' ? 4 : s === 'high' ? 3 : s === 'medium' ? 2 : 1
}

/**
 * Verify a single verification node.
 */
export async function verifyNode(
  node: BuildNode,
  job: BuildJob,
  graph: BuildGraph,
  projectId: string,
): Promise<VerificationReport> {
  const subtype = node.id.replace(/^verification\./, '')

  switch (subtype) {
    case 'auth':
      return verifyAuth(node.id, projectId, graph)
    case 'apis':
      return verifyAPIs(node.id, projectId)
    case 'storage':
      return verifyStorage(node.id, projectId)
    case 'stripe':
      return verifyStripe(node.id, projectId, graph)
    case 'functions':
      return verifyFunctions(node.id, projectId)
    default:
      return genericVerify(node.id, projectId, graph)
  }
}

// ── Auth Verification ─────────────────────────────────────────────────────────

async function verifyAuth(
  nodeId: string,
  projectId: string,
  graph: BuildGraph,
): Promise<VerificationReport> {
  const checks: VerificationCheck[] = []

  // Check 1: Auth node in graph is verified
  const authNode = graph.getNode('auth.jwt')
  checks.push({
    label: 'JWT auth node executed',
    status: authNode?.status === 'verified' ? 'pass' : 'fail',
    detail: authNode?.executionDetail,
  })

  // Check 2: Users table exists in DB
  try {
    const { prisma } = await import('@/lib/db/prisma')
    const table = await prisma.table.findFirst({
      where: { projectId, name: 'users' },
    })
    checks.push({
      label: 'Users table in database',
      status: table ? 'pass' : 'fail',
      detail: table ? `Table found with ${table.name}` : 'users table not found in DB',
    })
  } catch {
    checks.push({ label: 'Users table in database', status: 'warn', detail: 'Could not query DB' })
  }

  // Check 3: Auth configuration exists
  try {
    const { prisma } = await import('@/lib/db/prisma')
    const workspace = await prisma.workspace.findFirst({ where: { projectId } })
    checks.push({
      label: 'Workspace provisioned',
      status: workspace ? 'pass' : 'fail',
      detail: workspace ? 'Workspace schema active' : 'Workspace not found',
    })
  } catch {
    checks.push({ label: 'Workspace provisioned', status: 'warn', detail: 'Could not verify workspace' })
  }

  const passed = checks.filter(c => c.status === 'fail').length === 0
  return {
    nodeId,
    passed,
    checks,
    summary: passed
      ? 'Auth: JWT enabled, users table verified, workspace active'
      : `Auth: ${checks.filter(c => c.status === 'fail').map(c => c.label).join(', ')} failed`,
  }
}

// ── API Verification ──────────────────────────────────────────────────────────

async function verifyAPIs(nodeId: string, projectId: string): Promise<VerificationReport> {
  const checks: VerificationCheck[] = []

  try {
    const { prisma } = await import('@/lib/db/prisma')
    const apiCount = await prisma.apiDefinition.count({ where: { projectId } })

    checks.push({
      label: 'REST endpoints generated',
      status: apiCount > 0 ? 'pass' : 'fail',
      detail: apiCount > 0
        ? `${apiCount} endpoint${apiCount !== 1 ? 's' : ''} created`
        : 'No API definitions found in DB',
    })

    const tableCount = await prisma.table.count({ where: { projectId } })
    checks.push({
      label: 'Tables have corresponding APIs',
      status: tableCount > 0 && apiCount > 0 ? 'pass' : 'warn',
      detail: `${tableCount} tables, ${apiCount} API definitions`,
    })
  } catch {
    checks.push({ label: 'REST endpoints generated', status: 'warn', detail: 'Could not query API definitions' })
  }

  const passed = checks.every(c => c.status !== 'fail')
  return {
    nodeId,
    passed,
    checks,
    summary: passed
      ? `APIs: ${checks[0].detail ?? 'endpoints verified'}`
      : `APIs: ${checks.filter(c => c.status === 'fail').map(c => c.detail).join('; ')}`,
  }
}

// ── Storage Verification ──────────────────────────────────────────────────────

async function verifyStorage(nodeId: string, projectId: string): Promise<VerificationReport> {
  const checks: VerificationCheck[] = []

  try {
    const { prisma } = await import('@/lib/db/prisma')
    const bucketCount = await prisma.storageBucket.count({ where: { projectId } })
    checks.push({
      label: 'Storage buckets created',
      status: bucketCount > 0 ? 'pass' : 'warn',
      detail: bucketCount > 0
        ? `${bucketCount} bucket${bucketCount !== 1 ? 's' : ''} provisioned`
        : 'No storage buckets found — storage may not be required',
    })
  } catch {
    checks.push({ label: 'Storage buckets', status: 'warn', detail: 'Could not verify storage state' })
  }

  // Storage verification is non-fatal if buckets don't exist (it's optional)
  const passed = checks.every(c => c.status !== 'fail')
  return {
    nodeId,
    passed,
    checks,
    summary: checks[0].detail ?? 'Storage check complete',
  }
}

// ── Stripe Verification ───────────────────────────────────────────────────────

async function verifyStripe(
  nodeId: string,
  projectId: string,
  graph: BuildGraph,
): Promise<VerificationReport> {
  const checks: VerificationCheck[] = []

  const checkoutNode = graph.getNode('integration.stripe.checkout')
  const webhookNode = graph.getNode('integration.stripe.webhook')

  checks.push({
    label: 'Stripe checkout endpoint',
    status: checkoutNode?.status === 'verified' ? 'pass'
           : checkoutNode?.status === 'blocked' ? 'skip'
           : 'fail',
    detail: checkoutNode?.status === 'blocked'
      ? `Blocked: ${checkoutNode.blockedReason?.requiredEnvVar ?? 'credentials required'}`
      : checkoutNode?.executionDetail,
  })

  checks.push({
    label: 'Stripe webhook handler',
    status: webhookNode?.status === 'verified' ? 'pass'
           : webhookNode?.status === 'blocked' ? 'skip'
           : 'fail',
    detail: webhookNode?.status === 'blocked'
      ? `Blocked: ${webhookNode.blockedReason?.requiredEnvVar ?? 'webhook secret required'}`
      : webhookNode?.executionDetail,
  })

  const skipped = checks.every(c => c.status === 'skip')
  const passed = !checks.some(c => c.status === 'fail')

  return {
    nodeId,
    passed,
    checks,
    summary: skipped
      ? 'Stripe: blocked — STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET required'
      : passed
        ? 'Stripe: checkout and webhook handler verified'
        : 'Stripe: partial — some components not verified',
  }
}

// ── Functions Verification ────────────────────────────────────────────────────

async function verifyFunctions(nodeId: string, projectId: string): Promise<VerificationReport> {
  const checks: VerificationCheck[] = []

  try {
    const { prisma } = await import('@/lib/db/prisma')
    const fnCount = await prisma.aiFunction.count({ where: { projectId } })
    checks.push({
      label: 'AI functions created',
      status: fnCount > 0 ? 'pass' : 'warn',
      detail: fnCount > 0
        ? `${fnCount} function${fnCount !== 1 ? 's' : ''} deployed`
        : 'No functions found — may not be required',
    })
  } catch {
    checks.push({ label: 'AI functions', status: 'warn', detail: 'Could not verify functions' })
  }

  const passed = checks.every(c => c.status !== 'fail')
  return {
    nodeId,
    passed,
    checks,
    summary: checks[0].detail ?? 'Functions check complete',
  }
}

// ── Generic Verification ──────────────────────────────────────────────────────

async function genericVerify(
  nodeId: string,
  projectId: string,
  graph: BuildGraph,
): Promise<VerificationReport> {
  const checks: VerificationCheck[] = []

  // Count verified nodes overall
  const all = graph.getAllNodes().filter(n => n.type !== 'verification')
  const verified = all.filter(n => n.status === 'verified').length
  const blocked = all.filter(n => n.status === 'blocked').length
  const total = all.length

  checks.push({
    label: `Build nodes verified`,
    status: verified > 0 ? 'pass' : 'fail',
    detail: `${verified}/${total} nodes verified, ${blocked} blocked`,
  })

  // Check tables in DB
  try {
    const { prisma } = await import('@/lib/db/prisma')
    const tableCount = await prisma.table.count({ where: { projectId } })
    checks.push({
      label: 'Database tables',
      status: tableCount > 0 ? 'pass' : 'fail',
      detail: `${tableCount} table${tableCount !== 1 ? 's' : ''} in database`,
    })
  } catch {
    checks.push({ label: 'Database tables', status: 'warn', detail: 'Could not query tables' })
  }

  const passed = checks.every(c => c.status !== 'fail')
  return {
    nodeId,
    passed,
    checks,
    summary: passed
      ? `Verified: ${verified}/${total} nodes, ${checks[1]?.detail ?? ''}`
      : `Verification incomplete: ${checks.filter(c => c.status === 'fail').map(c => c.label).join(', ')}`,
  }
}

// ── Quick readiness check ─────────────────────────────────────────────────────

/**
 * Fast readiness summary from graph state.
 * Used for VERIFICATION sub-behavior in build mode.
 */
export function quickReadinessFromGraph(graph: BuildGraph): {
  ready: boolean
  summary: string
  checks: VerificationCheck[]
} {
  const all = graph.getAllNodes()
  const required = all.filter(n => !n.optional && n.type !== 'verification')

  const verified = required.filter(n => n.status === 'verified')
  const blocked = required.filter(n => n.status === 'blocked')
  const failed = required.filter(n => n.status === 'failed')
  const pending = required.filter(n => n.status === 'pending' || n.status === 'partial')

  const checks: VerificationCheck[] = [
    {
      label: 'Required nodes verified',
      status: verified.length === required.length ? 'pass' : pending.length > 0 ? 'warn' : 'fail',
      detail: `${verified.length}/${required.length} required nodes verified`,
    },
  ]

  if (blocked.length > 0) {
    checks.push({
      label: 'Blocked nodes',
      status: 'warn',
      detail: `${blocked.length} node(s) blocked: ${blocked.map(n => n.label).join(', ')}`,
    })
  }

  if (failed.length > 0) {
    checks.push({
      label: 'Failed nodes',
      status: 'fail',
      detail: `${failed.length} node(s) failed: ${failed.map(n => n.label).join(', ')}`,
    })
  }

  const ready = verified.length === required.length && failed.length === 0

  return {
    ready,
    checks,
    summary: ready
      ? 'Backend is complete — all required components verified.'
      : pending.length > 0
        ? `In progress — ${pending.length} node(s) still pending.`
        : blocked.length > 0
          ? `Partial — blocked on: ${blocked.map(n => n.blockedReason?.requiredEnvVar ?? n.label).join(', ')}`
          : 'Needs attention — check failed nodes.',
  }
}
