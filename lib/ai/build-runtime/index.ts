/**
 * BUILD RUNTIME — Public API
 * ==========================
 * Single import point for the new build runtime.
 *
 * The build runtime replaces the AI orchestration brain for serious build requests.
 * It keeps all execution primitives (executeAction, real-executor, etc.) untouched.
 */

// ── Types ─────────────────────────────────────────────────────────────────────
export type {
  BuildJob,
  BuildNode,
  BuildPhase,
  BuildResponse,
  PlanResponse,
  BuildJobStatus,
  NodeStatus,
  NodeType,
  BlockedReason,
  BuildContext,
  Domain,
} from './types'

// ── Build Graph ───────────────────────────────────────────────────────────────
export { BuildGraph, graphFromJob, summarizeGraph } from './build-graph'

// ── Domain ────────────────────────────────────────────────────────────────────
export {
  detectDomain,
  phasesForDomain,
  ecommercePhases,
  saasPhases,
  marketplacePhases,
  genericPhases,
} from './domain-phases'

// ── Domain Compiler ───────────────────────────────────────────────────────────
export {
  compileBuildJob,
  compilePlanJob,
  isSeriousBuildRequest,
} from './domain-compiler'

// ── Persistence ───────────────────────────────────────────────────────────────
export {
  loadActiveBuildJob,
  saveBuildJob,
  clearBuildJob,
  hasActiveBuildJob,
  findResumePoint,
} from './continuation-store'

// ── Execution ─────────────────────────────────────────────────────────────────
export { executeNode } from './node-executor'
export type { NodeExecutionResult } from './node-executor'

// ── Verification ──────────────────────────────────────────────────────────────
export { verifyBuildJob, verifyNode, quickReadinessFromGraph } from './verifier'
export type { VerificationReport, VerificationCheck } from './verifier'

// ── Rendering ─────────────────────────────────────────────────────────────────
export {
  renderBuildResponse,
  renderPlanResponse,
  renderBlockedResponse,
  containsForbiddenProse,
  FORBIDDEN_BUILD_PROSE_PATTERNS,
} from './build-renderer'

// ── Block + Resume ────────────────────────────────────────────────────────────
export {
  resumeAfterCredential,
  tryResumeBuildJob,
  getBlockedStateSummary,
  integrationIdFromDetected,
} from './block-resume'
export type { ResumeResult } from './block-resume'

// ── Main Orchestrator ─────────────────────────────────────────────────────────
export {
  runBuild,
  detectBuildMode,
} from './run-build'
export type { RunBuildOptions, RunBuildResult } from './run-build'
