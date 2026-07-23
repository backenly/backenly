/**
 * AGENT DECISIONS — Audit Log
 * ============================
 * Append-only log of decisions made by the Phase Planner between build phases.
 *
 * Every entry is persisted on the BuildJob itself so:
 *   - The UI can render the agent's reasoning trail alongside build cards
 *   - Eval tooling can compare deterministic vs agentic runs on the same prompt
 *   - Post-mortems can replay "why did the agent insert that repair phase"
 *
 * This module owns *recording*. The planner owns *deciding*. The executor
 * owns *doing*. Each stays in its lane.
 */

import type { AgentDecision, AgentDecisionKind, BuildJob } from './types'

export interface RecordDecisionArgs {
  job: BuildJob
  afterPhase: number
  appliesTo: number | 'end'
  kind: AgentDecisionKind
  reasoning: string
  insertedNodeIds?: string[]
  removedNodeIds?: string[]
  requestedIntegrationIds?: string[]
  telemetry?: AgentDecision['telemetry']
  fallbackReason?: string
}

/**
 * Append a decision to BuildJob.agentDecisions. Mutates the job in place.
 * Returns the decision so callers can also emit it as an SSE event.
 */
export function recordAgentDecision(args: RecordDecisionArgs): AgentDecision {
  const decision: AgentDecision = {
    at: new Date().toISOString(),
    afterPhase: args.afterPhase,
    appliesTo: args.appliesTo,
    kind: args.kind,
    reasoning: args.reasoning,
    insertedNodeIds: args.insertedNodeIds,
    removedNodeIds: args.removedNodeIds,
    requestedIntegrationIds: args.requestedIntegrationIds,
    telemetry: args.telemetry,
    fallbackReason: args.fallbackReason,
  }

  if (!args.job.agentDecisions) args.job.agentDecisions = []
  args.job.agentDecisions.push(decision)
  return decision
}

/**
 * Returns how many replan-style decisions the agent has already made on this
 * build. Used by the planner to enforce the per-build replan cap.
 */
export function countReplans(job: BuildJob): number {
  if (!job.agentDecisions) return 0
  return job.agentDecisions.filter(d =>
    d.kind === 'replan_next_phase' || d.kind === 'insert_repair_phase',
  ).length
}
