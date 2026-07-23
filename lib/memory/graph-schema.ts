/**
 * MEMORY LAYER — Graph Schema Extension (Pillar 5.1)
 * ===================================================
 * Extends BackendGraph.graphData with structured memory:
 *   - workflows     : multi-step business flows the AI detected or built
 *   - rlsPolicies   : applied row-level security policies per table
 *   - integrations  : stored integration keys and their inferred usage
 *   - knownIssues   : issues the observer found (mirrors HealthFinding summaries)
 *   - decisionLog   : every material decision the AI made, with reason + date
 *
 * These fields are overlaid onto the existing BackendStateGraph JSON blob.
 * Nothing here creates new Prisma models — it enriches the graphData column.
 *
 * Usage:
 *   const ext = await getExtendedGraph(projectId)
 *   await appendDecisionLog(projectId, { decided: '...', reason: '...' })
 */

import { getActiveGraph, saveNewGraph } from '@/lib/orchestration/graph-pointer'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface WorkflowStep {
  name: string
  action: string     // AIAction.action value, e.g. 'CREATE_TABLE', 'STORE_INTEGRATION_KEY'
  table?: string
}

export interface WorkflowDefinition {
  name: string
  steps: string[]                // ordered step names
  stepDetails?: WorkflowStep[]   // enriched step metadata
  invariants?: string[]          // e.g. "paid_order.status === 'paid'"
  detectedAt: string             // ISO date
  source: 'inferred' | 'user'    // did the AI detect it or did the user describe it?
}

export interface RlsPolicyRecord {
  tableName: string
  template: string               // 'own_rows' | 'public_read' | 'custom'
  using?: string                 // USING expression if custom
  appliedAt: string              // ISO date
  appliedBy: 'auto_fix' | 'ai_action' | 'user'
}

export interface IntegrationRecord {
  integrationId: string          // 'stripe' | 'resend' | 'sendgrid' | ...
  connectedAt: string            // ISO date
  webhookGenerated?: boolean
  triggerFunctionsCreated?: string[]
}

export interface KnownIssue {
  type: string                   // mirrors HealthFinding.type
  tableName?: string
  detectedAt: string             // ISO date
  status: 'open' | 'auto_fixed' | 'escalated'
  resolution?: string
}

export interface DecisionLogEntry {
  at: string                     // ISO date string
  decided: string                // human-readable description of what was decided
  reason: string                 // why — FK inference, user intent, auto-applied policy, etc.
  action: string                 // AIAction.action value that triggered this decision
  tableName?: string
  columnName?: string
  userOverrode?: boolean         // true if the user explicitly changed an AI default
}

/** Shape of the extended section inside graphData */
export interface GraphMemoryExtension {
  workflows?: WorkflowDefinition[]
  rlsPolicies?: RlsPolicyRecord[]
  integrations?: IntegrationRecord[]
  knownIssues?: KnownIssue[]
  decisionLog?: DecisionLogEntry[]
}

// ─── Accessors ────────────────────────────────────────────────────────────────

/**
 * Return the current active graphData cast to include the extension fields.
 * Returns null if no graph exists yet.
 */
export async function getExtendedGraph(
  projectId: string,
): Promise<(Record<string, unknown> & GraphMemoryExtension) | null> {
  const graph = await getActiveGraph(projectId)
  if (!graph) return null
  return graph as unknown as Record<string, unknown> & GraphMemoryExtension
}

/**
 * Persist a mutation to the extended graph fields.
 * Merges the patch into the existing graphData and saves a new version.
 * Non-fatal — errors are logged, never thrown.
 */
async function patchExtendedGraph(
  projectId: string,
  patch: Partial<GraphMemoryExtension>,
): Promise<void> {
  try {
    const graph = await getActiveGraph(projectId)
    if (!graph) return

    const updated = { ...graph, ...patch } as any
    await saveNewGraph(projectId, updated, undefined, { skipBillingCheck: true })
  } catch (err) {
    console.warn('[GraphMemory] patchExtendedGraph failed (non-fatal):', err)
  }
}

// ─── Decision Log ─────────────────────────────────────────────────────────────

/**
 * Append one entry to graphData.decisionLog.
 * Capped at 500 entries (oldest dropped first) to keep graphData lean.
 */
export async function appendDecisionLog(
  projectId: string,
  entry: Omit<DecisionLogEntry, 'at'> & { at?: string },
): Promise<void> {
  const graph = await getActiveGraph(projectId)
  if (!graph) return

  const existing: DecisionLogEntry[] = ((graph as any).decisionLog ?? []) as DecisionLogEntry[]
  const newEntry: DecisionLogEntry = { at: new Date().toISOString(), ...entry }

  const updated = [...existing, newEntry].slice(-500)
  await patchExtendedGraph(projectId, { decisionLog: updated })
}

// ─── RLS Policies ─────────────────────────────────────────────────────────────

export async function recordRlsPolicy(
  projectId: string,
  record: Omit<RlsPolicyRecord, 'appliedAt'> & { appliedAt?: string },
): Promise<void> {
  const graph = await getActiveGraph(projectId)
  if (!graph) return

  const existing: RlsPolicyRecord[] = ((graph as any).rlsPolicies ?? []) as RlsPolicyRecord[]
  // Replace if same table already recorded
  const filtered = existing.filter((p) => p.tableName !== record.tableName)
  const newRecord: RlsPolicyRecord = {
    appliedAt: new Date().toISOString(),
    ...record,
  }
  await patchExtendedGraph(projectId, { rlsPolicies: [...filtered, newRecord] })
}

// ─── Workflows ────────────────────────────────────────────────────────────────

export async function recordWorkflow(
  projectId: string,
  workflow: Omit<WorkflowDefinition, 'detectedAt'> & { detectedAt?: string },
): Promise<void> {
  const graph = await getActiveGraph(projectId)
  if (!graph) return

  const existing: WorkflowDefinition[] = ((graph as any).workflows ?? []) as WorkflowDefinition[]
  const filtered = existing.filter((w) => w.name !== workflow.name)
  const newWorkflow: WorkflowDefinition = {
    detectedAt: new Date().toISOString(),
    ...workflow,
  }
  await patchExtendedGraph(projectId, { workflows: [...filtered, newWorkflow] })
}

// ─── Integrations ─────────────────────────────────────────────────────────────

export async function recordIntegration(
  projectId: string,
  record: Omit<IntegrationRecord, 'connectedAt'> & { connectedAt?: string },
): Promise<void> {
  const graph = await getActiveGraph(projectId)
  if (!graph) return

  const existing: IntegrationRecord[] = ((graph as any).integrations ?? []) as IntegrationRecord[]
  const filtered = existing.filter((i) => i.integrationId !== record.integrationId)
  const newRecord: IntegrationRecord = { connectedAt: new Date().toISOString(), ...record }
  await patchExtendedGraph(projectId, { integrations: [...filtered, newRecord] })
}

// ─── Known Issues ─────────────────────────────────────────────────────────────

export async function upsertKnownIssue(
  projectId: string,
  issue: Omit<KnownIssue, 'detectedAt'> & { detectedAt?: string },
): Promise<void> {
  const graph = await getActiveGraph(projectId)
  if (!graph) return

  const existing: KnownIssue[] = ((graph as any).knownIssues ?? []) as KnownIssue[]
  const key = `${issue.type}:${issue.tableName ?? ''}`
  const filtered = existing.filter(
    (i) => `${i.type}:${i.tableName ?? ''}` !== key,
  )
  const newIssue: KnownIssue = { detectedAt: new Date().toISOString(), ...issue }
  await patchExtendedGraph(projectId, { knownIssues: [...filtered, newIssue] })
}
