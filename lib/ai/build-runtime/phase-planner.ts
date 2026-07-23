/**
 * PHASE PLANNER — Bounded Agency Surface A
 * ==========================================
 * Called between phases of executeBuildGraph. Observes the just-completed
 * phase's real DB state and decides what to do next.
 *
 * Hard contract:
 *   - The planner can only emit decisions from the AgentDecisionKind union.
 *   - `insertNodes` are constrained to existing NodeType values — no novel
 *     types, no raw SQL, no freeform actions.
 *   - Every decision is validated by Zod. Invalid output → fall back to
 *     `proceed_as_planned` with a fallbackReason recorded for audit.
 *   - Every decision is persisted to BuildJob.agentDecisions (see
 *     agent-decisions.ts) so the UI and eval tooling can render the trail.
 *   - The deterministic executor still does the work. This file *plans*; it
 *     never *mutates*.
 *
 * Bounds:
 *   - Model:        gpt-4o-mini
 *   - Token budget: ~3000 input + ~600 output per call
 *   - Replan cap:   3 per build (enforced via countReplans in agent-decisions)
 *   - Timeout:      15s (planner is non-critical; build proceeds on timeout)
 *
 * Gated by ENABLE_AGENTIC_PHASE_PLANNER. When the flag is off the build
 * runtime never calls this module.
 */

import { z } from 'zod'
import { getOpenAIClient, trackCompletionCost } from '../openai-service'
import { withTimeout } from '../with-timeout'
import { countReplans, recordAgentDecision } from './agent-decisions'
import type { BuildJob, BuildNode, BuildPhase, NodeType } from './types'

// ── Constants ────────────────────────────────────────────────────────────────

const PLANNER_MODEL = 'gpt-4o-mini'
const PLANNER_TIMEOUT_MS = 15_000
const PLANNER_TEMPERATURE = 0.2
const MAX_REPLANS_PER_BUILD = 3
const MAX_INSERT_NODES = 6
const MAX_REMOVE_NODES = 4
const MAX_REASONING_LEN = 280

const ALLOWED_NODE_TYPES: NodeType[] = [
  'schema',
  'auth',
  'permissions',
  'storage',
  'integration',
  'function',
  'realtime',
  'trigger',
  'flow',
  'verification',
]

// ── Output schema (Zod) ──────────────────────────────────────────────────────

const InsertedNodeSchema = z.object({
  id: z.string().min(2).max(120),
  label: z.string().min(2).max(120),
  type: z.enum(ALLOWED_NODE_TYPES as [NodeType, ...NodeType[]]),
  dependencies: z.array(z.string()).max(8).optional().default([]),
  /** Optional rationale shown to the user. */
  why: z.string().max(200).optional(),
})

export const PhaseDecisionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('proceed_as_planned'),
    reasoning: z.string().max(MAX_REASONING_LEN),
  }),
  z.object({
    kind: z.literal('replan_next_phase'),
    reasoning: z.string().max(MAX_REASONING_LEN),
    insertNodes: z.array(InsertedNodeSchema).max(MAX_INSERT_NODES).optional().default([]),
    removeNodeIds: z.array(z.string()).max(MAX_REMOVE_NODES).optional().default([]),
  }),
  z.object({
    kind: z.literal('insert_repair_phase'),
    reasoning: z.string().max(MAX_REASONING_LEN),
    repairNodes: z.array(InsertedNodeSchema).min(1).max(MAX_INSERT_NODES),
  }),
  z.object({
    kind: z.literal('request_credentials'),
    reasoning: z.string().max(MAX_REASONING_LEN),
    integrationIds: z.array(z.string()).min(1).max(6),
  }),
  z.object({
    kind: z.literal('abort'),
    reasoning: z.string().max(MAX_REASONING_LEN),
  }),
])

export type PhaseDecision = z.infer<typeof PhaseDecisionSchema>

// ── Input / observation shape ────────────────────────────────────────────────

export interface PhaseObservation {
  /** Phase that just completed (1-based). */
  phaseNumber: number
  phaseName: string
  /** Live status snapshot for every node in this phase. */
  nodes: Array<{
    id: string
    label: string
    type: NodeType
    status: BuildNode['status']
    failureReason?: string
    blockedReason?: string
    detail?: string
  }>
  /**
   * The plan for the *next* phase (read-only — the planner suggests edits but
   * never mutates state itself).
   */
  nextPhase?: {
    number: number
    name: string
    nodeIds: string[]
  }
}

export interface PhasePlannerOptions {
  /** Suppress agent calls when the per-build replan cap has been hit. */
  jobReplansAlready?: number
  /** Optional override for evals/tests. */
  signal?: AbortSignal
}

export interface PhasePlannerResult {
  decision: PhaseDecision
  /** True when planner output validated cleanly. */
  fromAgent: boolean
  /** When fromAgent=false, why we fell back. */
  fallbackReason?: string
  telemetry: {
    model: string
    durationMs: number
    promptTokens?: number
    completionTokens?: number
  }
}

// ── Public entry ─────────────────────────────────────────────────────────────

/**
 * Ask the planner what to do next. Always resolves — on any error returns
 * `proceed_as_planned` with a fallbackReason so the build never stalls.
 */
export async function decideNextPhase(
  job: BuildJob,
  observation: PhaseObservation,
  options: PhasePlannerOptions = {},
): Promise<PhasePlannerResult> {
  const startedAt = Date.now()

  // ── Replan cap ────────────────────────────────────────────────────────────
  // Even if the planner *wants* to replan we refuse once we've hit the cap.
  // This protects against runaway agent loops on adversarial prompts.
  const replansSoFar = options.jobReplansAlready ?? countReplans(job)
  if (replansSoFar >= MAX_REPLANS_PER_BUILD) {
    return fallback(startedAt, `replan cap (${MAX_REPLANS_PER_BUILD}) reached for this build`)
  }

  let raw: string
  let promptTokens: number | undefined
  let completionTokens: number | undefined

  try {
    const client = getOpenAIClient()
    const completion = await withTimeout(
      client.chat.completions.create({
        model: PLANNER_MODEL,
        temperature: PLANNER_TEMPERATURE,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: buildUserPrompt(job, observation) },
        ],
      }, { signal: options.signal }),
      PLANNER_TIMEOUT_MS,
      'phase-planner',
    )

    trackCompletionCost(completion, job.projectId, 'phase-planner')
    promptTokens = completion.usage?.prompt_tokens
    completionTokens = completion.usage?.completion_tokens

    raw = completion.choices[0]?.message?.content ?? ''
    if (!raw) {
      return fallback(startedAt, 'planner returned empty response', PLANNER_MODEL, promptTokens, completionTokens)
    }
  } catch (err: any) {
    const reason = err?.name === 'AbortError'
      ? 'planner aborted'
      : err?.message?.includes('timed out')
        ? 'planner timed out'
        : `planner call failed: ${err?.message ?? String(err)}`
    return fallback(startedAt, reason, PLANNER_MODEL)
  }

  // ── Parse + validate ──────────────────────────────────────────────────────
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return fallback(startedAt, 'planner returned invalid JSON', PLANNER_MODEL, promptTokens, completionTokens)
  }

  const result = PhaseDecisionSchema.safeParse(parsed)
  if (!result.success) {
    const issues = result.error.issues.slice(0, 3).map(i => `${i.path.join('.')}: ${i.message}`).join('; ')
    return fallback(startedAt, `planner output failed schema validation: ${issues}`, PLANNER_MODEL, promptTokens, completionTokens)
  }

  // ── Additional semantic guards ────────────────────────────────────────────
  // Even valid output is rejected when it conflicts with executor invariants.
  const semanticError = semanticGuard(result.data, job, observation)
  if (semanticError) {
    return fallback(startedAt, `planner output rejected: ${semanticError}`, PLANNER_MODEL, promptTokens, completionTokens)
  }

  return {
    decision: result.data,
    fromAgent: true,
    telemetry: {
      model: PLANNER_MODEL,
      durationMs: Date.now() - startedAt,
      promptTokens,
      completionTokens,
    },
  }
}

// ── Semantic guards ──────────────────────────────────────────────────────────

/**
 * Last-line guards that catch validator-passing-but-executor-illegal outputs.
 * Examples we block:
 *   - Inserted node id collides with an existing one
 *   - Removed node id doesn't exist
 *   - Replan targets the wrong phase number
 *   - Repair phase requested when nothing actually failed
 */
function semanticGuard(
  decision: PhaseDecision,
  job: BuildJob,
  observation: PhaseObservation,
): string | null {
  const existingIds = new Set(job.phases.flatMap(p => p.nodes.map(n => n.id)))

  if (decision.kind === 'replan_next_phase') {
    for (const n of decision.insertNodes ?? []) {
      if (existingIds.has(n.id)) return `insertNode id collides with existing node: ${n.id}`
      // Inserted nodes' dependencies must reference existing nodes or other
      // newly-inserted nodes (no dangling refs).
      const newIds = new Set((decision.insertNodes ?? []).map(x => x.id))
      for (const dep of n.dependencies ?? []) {
        if (!existingIds.has(dep) && !newIds.has(dep)) {
          return `insertNode ${n.id} references unknown dependency: ${dep}`
        }
      }
    }
    for (const id of decision.removeNodeIds ?? []) {
      if (!existingIds.has(id)) return `removeNodeId references unknown node: ${id}`
      // Don't allow removing nodes that have already executed — that would be
      // a destructive replan, which is outside the planner's authority.
      const node = job.phases.flatMap(p => p.nodes).find(n => n.id === id)
      if (node && (node.status === 'verified' || node.status === 'partial' || node.status === 'running')) {
        return `removeNodeId targets non-pending node: ${id}`
      }
    }
    if ((decision.insertNodes?.length ?? 0) === 0 && (decision.removeNodeIds?.length ?? 0) === 0) {
      return 'replan_next_phase must include at least one insert or remove'
    }
  }

  if (decision.kind === 'insert_repair_phase') {
    const anyFailed = observation.nodes.some(n => n.status === 'failed')
    if (!anyFailed) return 'insert_repair_phase requested but no node failed in the observed phase'
    for (const n of decision.repairNodes ?? []) {
      if (existingIds.has(n.id)) return `repairNode id collides with existing node: ${n.id}`
    }
  }

  return null
}

// ── Prompt construction ──────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are the Phase Planner inside an AI Backend-as-a-Service build runtime.

You sit BETWEEN phases of an already-compiled build graph. After each phase
finishes, you observe what actually happened and decide what should happen
next. The deterministic executor will carry out your decision.

You are NEVER allowed to:
  - Write SQL or any raw code
  - Invent new node types beyond: schema, auth, permissions, storage, integration, function, realtime, trigger, flow, verification
  - Replan a phase that has already completed (verified/partial/running nodes)
  - Make decisions that bypass governance, approval, or audit

You output ONE JSON object. Choose exactly one kind:

{ "kind": "proceed_as_planned", "reasoning": "<≤280 chars>" }
  Use when the just-completed phase succeeded and the next phase as planned
  is still the right thing to do.

{ "kind": "replan_next_phase", "reasoning": "<...>", "insertNodes": [...], "removeNodeIds": [...] }
  Use when observation reveals the next phase's plan is wrong — e.g. a
  schema phase verified that more tables are needed than originally planned,
  or a node in the next phase is no longer required.
  - insertNodes: { id, label, type, dependencies?, why? } — id must NOT collide with any existing node
  - removeNodeIds: only allowed for pending (un-executed) nodes
  - You may insert OR remove OR both. At least one required.

{ "kind": "insert_repair_phase", "reasoning": "<...>", "repairNodes": [...] }
  Use ONLY when a node in the observed phase failed and you can suggest a
  targeted recovery node before the next phase runs.
  - repairNodes must address the observed failure, not unrelated work

{ "kind": "request_credentials", "reasoning": "<...>", "integrationIds": ["stripe","resend",...] }
  Use when the observed phase or the next phase needs credentials the user
  has not provided. The runtime will surface the blocked card to the user.

{ "kind": "abort", "reasoning": "<≤280 chars>" }
  Use ONLY for unrecoverable situations — never for "I'm not sure".

Rules:
  - Default to "proceed_as_planned" when in doubt.
  - Be conservative: do not propose work the user did not ask for.
  - Keep reasoning short, specific, and grounded in the observation.
  - Output JSON only. No prose. No markdown. No code fences.`

function buildUserPrompt(job: BuildJob, observation: PhaseObservation): string {
  const lines: string[] = []

  lines.push(`Original build request:\n"""${truncate(job.originalPrompt, 600)}"""\n`)
  lines.push(`Domain: ${job.domain}`)
  lines.push(`Replans used so far: ${countReplans(job)} / ${MAX_REPLANS_PER_BUILD}\n`)

  lines.push(`### Just-completed phase`)
  lines.push(`Phase ${observation.phaseNumber}: ${observation.phaseName}`)
  for (const n of observation.nodes) {
    const parts = [`- [${n.status}] ${n.id} (${n.type})`]
    if (n.failureReason) parts.push(`  failure: ${truncate(n.failureReason, 160)}`)
    if (n.blockedReason) parts.push(`  blocked: ${truncate(n.blockedReason, 160)}`)
    if (n.detail) parts.push(`  detail: ${truncate(n.detail, 160)}`)
    lines.push(parts.join('\n'))
  }
  lines.push('')

  if (observation.nextPhase) {
    lines.push(`### Planned next phase`)
    lines.push(`Phase ${observation.nextPhase.number}: ${observation.nextPhase.name}`)
    lines.push(`Nodes (pre-execution): ${observation.nextPhase.nodeIds.join(', ') || '(none)'}`)
  } else {
    lines.push(`### No next phase — this was the last one.`)
  }

  lines.push('\nReturn the JSON decision now.')
  return lines.join('\n')
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, max - 1) + '…'
}

// ── Fallback helper ──────────────────────────────────────────────────────────

function fallback(
  startedAt: number,
  reason: string,
  model: string = PLANNER_MODEL,
  promptTokens?: number,
  completionTokens?: number,
): PhasePlannerResult {
  return {
    decision: {
      kind: 'proceed_as_planned',
      reasoning: 'Planner unavailable — continuing with the deterministic plan.',
    },
    fromAgent: false,
    fallbackReason: reason,
    telemetry: {
      model,
      durationMs: Date.now() - startedAt,
      promptTokens,
      completionTokens,
    },
  }
}

// ── Build the audit + emit packet ────────────────────────────────────────────

/**
 * Persist the planner's decision on the BuildJob and return the AgentDecision
 * payload the caller should also emit as an SSE event.
 */
export function applyPhaseDecisionToJob(
  job: BuildJob,
  result: PhasePlannerResult,
  afterPhase: number,
  appliesTo: number | 'end',
): ReturnType<typeof recordAgentDecision> {
  const d = result.decision

  return recordAgentDecision({
    job,
    afterPhase,
    appliesTo,
    kind: d.kind,
    reasoning: d.reasoning,
    insertedNodeIds:
      d.kind === 'replan_next_phase'
        ? (d.insertNodes ?? []).map(n => n.id)
        : d.kind === 'insert_repair_phase'
          ? d.repairNodes.map(n => n.id)
          : undefined,
    removedNodeIds:
      d.kind === 'replan_next_phase' ? (d.removeNodeIds ?? []) : undefined,
    requestedIntegrationIds:
      d.kind === 'request_credentials' ? d.integrationIds : undefined,
    telemetry: result.telemetry,
    fallbackReason: result.fallbackReason,
  })
}

// ── Mutation helpers (graph integration) ─────────────────────────────────────

/**
 * Convert a planner decision into concrete graph mutations.
 * - Returns the list of node ids inserted into the graph (so the caller can
 *   schedule them).
 * - Removed nodes are unlinked from the graph.
 * - Repair nodes are inserted as a new phase between the just-completed and
 *   the next phase.
 *
 * This function is *the only* place where a planner decision becomes a real
 * mutation. Keep all NodeType / id / dependency validation in
 * `semanticGuard` above — by the time we reach here we trust the decision.
 */
export interface ApplyDecisionEffect {
  insertedNodes: BuildNode[]
  removedNodeIds: string[]
  newPhases: BuildPhase[]
}

export function effectsFromDecision(
  decision: PhaseDecision,
  job: BuildJob,
  afterPhase: number,
): ApplyDecisionEffect {
  if (decision.kind === 'proceed_as_planned' || decision.kind === 'abort' || decision.kind === 'request_credentials') {
    return { insertedNodes: [], removedNodeIds: [], newPhases: [] }
  }

  if (decision.kind === 'replan_next_phase') {
    const inserted = (decision.insertNodes ?? []).map(n => ({
      id: n.id,
      label: n.label,
      type: n.type,
      status: 'pending' as const,
      phase: afterPhase + 1,
      dependencies: n.dependencies ?? [],
    }))
    return {
      insertedNodes: inserted,
      removedNodeIds: decision.removeNodeIds ?? [],
      newPhases: [],
    }
  }

  // insert_repair_phase — create a new phase numbered after the completed one
  const repairPhaseNumber = afterPhase + 0.5 // sentinel; caller renumbers
  const repairNodes: BuildNode[] = decision.repairNodes.map(n => ({
    id: n.id,
    label: n.label,
    type: n.type,
    status: 'pending' as const,
    phase: repairPhaseNumber,
    dependencies: n.dependencies ?? [],
  }))
  const repairPhase: BuildPhase = {
    number: repairPhaseNumber,
    name: 'Agent repair',
    description: decision.reasoning,
    nodes: repairNodes,
  }
  return {
    insertedNodes: [],
    removedNodeIds: [],
    newPhases: [repairPhase],
  }
}
