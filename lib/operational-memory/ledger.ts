import { prisma } from '@/lib/db'
import type { ExecutionChange } from '@/lib/orchestration/atomic-executor'
import { recordPattern, resolveProjectType, patternTypeForEventType } from '@/lib/patterns/cross-project-learning'

export const BACKEND_EVENT_TYPES = [
  'product_requirement_created',
  'schema_created',
  'schema_changed',
  'api_created',
  'api_changed',
  'auth_rule_created',
  'auth_changed',
  'storage_created',
  'function_created',
  'health_check_failed',
  'migration_created',
  'rollback_created',
  'user_approved_change',
] as const

export type BackendEventType = typeof BACKEND_EVENT_TYPES[number]
export type BackendActorType = 'user' | 'backenly_agent' | 'system'
export type BackendRiskLevel = 'low' | 'medium' | 'high'
// 'dismissed' = a proposed change the user declined in the Review Queue. It is a
// terminal state for the paired BackendEvent so Memory stops rendering it as
// still-pending once the decision is made.
export type BackendEventStatus = 'proposed' | 'approved' | 'applied' | 'failed' | 'rolled_back' | 'dismissed'

export interface CreateBackendEventInput {
  projectId: string
  eventType: BackendEventType
  actorType: BackendActorType
  actorId?: string | null
  summary: string
  beforeState?: unknown
  afterState?: unknown
  reason?: string | null
  riskLevel?: BackendRiskLevel
  status?: BackendEventStatus
  receiptId?: string | null
}

export interface CreateChangeReceiptInput {
  projectId: string
  eventIds: string[]
  title: string
  summary: string
  resourcesChanged?: unknown
  riskLevel?: BackendRiskLevel
  rollbackAvailable?: boolean
  rollbackId?: string | null
}

export interface RecordExecutionMemoryInput {
  projectId: string
  actorId?: string | null
  actorType?: BackendActorType
  userMessage: string
  canonicalIntent?: unknown
  beforeState?: unknown
  afterState?: unknown
  changes: ExecutionChange[]
  executionId?: string
  rollbackAvailable?: boolean
  rollbackId?: string | null
}

export interface RecordRollbackMemoryInput {
  projectId: string
  actorId?: string | null
  actorType?: BackendActorType
  summary: string
  reason?: string
  beforeState?: unknown
  afterState?: unknown
  rollbackId?: string | null
}

export interface RecordToolExecutionMemoryInput {
  projectId: string
  actorId?: string | null
  userMessage: string
  tools: string[]
  /**
   * Per-tool outcome, aligned by index to `tools`. This is the truth layer:
   * a tool that ran and returned ok is 'applied' even if a LATER step in the
   * same turn (the verification model call, a subsequent tool) failed. Memory
   * records what actually happened to each action — never one batch verdict
   * smeared across work that already landed. Missing/short entries fall back
   * to `status`.
   */
  toolStatuses?: BackendEventStatus[]
  /** Batch fallback used only when a tool has no explicit per-tool status. */
  status?: BackendEventStatus
  summary?: string
}

function asJson(value: unknown): unknown {
  if (value === undefined) return undefined
  return JSON.parse(JSON.stringify(value))
}

function truncate(value: string, max = 240): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (normalized.length <= max) return normalized
  return `${normalized.slice(0, max - 3)}...`
}

function maxRisk(a: BackendRiskLevel, b: BackendRiskLevel): BackendRiskLevel {
  const order: Record<BackendRiskLevel, number> = { low: 1, medium: 2, high: 3 }
  return order[b] > order[a] ? b : a
}

export function riskForChange(change: ExecutionChange): BackendRiskLevel {
  if (change.action === 'deleted') return 'high'
  if (change.type === 'auth' && change.action === 'disabled') return 'high'
  if (change.type === 'deployment') return 'medium'
  if (change.action === 'modified') return 'medium'
  if (change.type === 'column') return 'medium'
  if (change.type === 'capability' || change.type === 'job') return 'medium'
  return 'low'
}

export function eventTypeForChange(change: ExecutionChange): BackendEventType {
  if (change.type === 'table') {
    return change.action === 'created' ? 'schema_created' : 'schema_changed'
  }
  if (change.type === 'column') return 'schema_changed'
  if (change.type === 'api') {
    return change.action === 'created' ? 'api_created' : 'api_changed'
  }
  if (change.type === 'auth') {
    return change.action === 'created' || change.action === 'enabled'
      ? 'auth_rule_created'
      : 'auth_changed'
  }
  if (change.type === 'storage') return 'storage_created'
  if (change.type === 'job') return 'function_created'
  if (change.type === 'capability') {
    const text = `${change.target} ${change.details?.capabilityType ?? ''}`.toLowerCase()
    if (text.includes('function')) return 'function_created'
    return 'migration_created'
  }
  return 'migration_created'
}

export function summarizeChange(change: ExecutionChange): string {
  const action = change.action.replace('_', ' ')
  if (change.type === 'table') return `${capitalize(action)} table ${change.target}`
  if (change.type === 'column') return `${capitalize(action)} field ${change.target}`
  if (change.type === 'api') return `${capitalize(action)} API ${change.details?.path || change.target}`
  if (change.type === 'auth') return `${capitalize(action)} auth rule ${change.target}`
  if (change.type === 'storage') return `${capitalize(action)} storage ${change.details?.bucketName || change.target}`
  if (change.type === 'job') return `${capitalize(action)} function ${change.target}`
  if (change.type === 'deployment') return `${capitalize(action)} deployment ${change.target}`
  return `${capitalize(action)} capability ${change.target}`
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1)
}

export function summarizeResources(changes: ExecutionChange[]) {
  const resources = {
    tables: changes.filter(c => c.type === 'table').map(c => c.target),
    fields: changes.filter(c => c.type === 'column').map(c => c.target),
    apis: changes.filter(c => c.type === 'api').map(c => c.details?.path || c.target),
    auth: changes.filter(c => c.type === 'auth').map(c => c.target),
    storage: changes.filter(c => c.type === 'storage').map(c => c.details?.bucketName || c.target),
    functions: changes
      .filter(c => c.type === 'job' || (`${c.target} ${c.details?.capabilityType ?? ''}`.toLowerCase().includes('function')))
      .map(c => c.target),
    deployments: changes.filter(c => c.type === 'deployment').map(c => c.target),
    capabilities: changes.filter(c => c.type === 'capability').map(c => c.target),
  }

  return {
    ...resources,
    total:
      resources.tables.length +
      resources.fields.length +
      resources.apis.length +
      resources.auth.length +
      resources.storage.length +
      resources.functions.length +
      resources.deployments.length +
      resources.capabilities.length,
  }
}

export function receiptTitleForChanges(changes: ExecutionChange[], userMessage: string): string {
  const resources = summarizeResources(changes)
  if (resources.tables.length > 1) return `Created ${resources.tables.length}-table backend foundation`
  if (resources.tables.length === 1 && resources.total <= 3) return `Created ${resources.tables[0]} backend resource`
  if (resources.total > 0) return `Updated ${resources.total} backend resources`
  return `Recorded backend requirement: ${truncate(userMessage, 80)}`
}

export function receiptSummaryForChanges(changes: ExecutionChange[], userMessage: string): string {
  const resources = summarizeResources(changes)
  const parts: string[] = []

  if (resources.tables.length) parts.push(`${resources.tables.length} table${resources.tables.length === 1 ? '' : 's'}`)
  if (resources.fields.length) parts.push(`${resources.fields.length} field${resources.fields.length === 1 ? '' : 's'}`)
  if (resources.apis.length) parts.push(`${resources.apis.length} API route${resources.apis.length === 1 ? '' : 's'}`)
  if (resources.auth.length) parts.push(`${resources.auth.length} auth rule${resources.auth.length === 1 ? '' : 's'}`)
  if (resources.storage.length) parts.push(`${resources.storage.length} storage bucket${resources.storage.length === 1 ? '' : 's'}`)
  if (resources.functions.length) parts.push(`${resources.functions.length} function${resources.functions.length === 1 ? '' : 's'}`)
  if (resources.deployments.length) parts.push(`${resources.deployments.length} deployment change${resources.deployments.length === 1 ? '' : 's'}`)

  if (parts.length === 0) {
    return `Backenly recorded the requirement: "${truncate(userMessage, 180)}".`
  }

  return `Backenly changed ${joinHuman(parts)} based on the product request: "${truncate(userMessage, 180)}".`
}

function eventTypeForTool(tool: string): BackendEventType | null {
  if (tool === 'create_table') return 'schema_created'
  if (['add_column', 'create_index', 'rename_column', 'add_constraint', 'drop_table', 'drop_column', 'truncate_table'].includes(tool)) {
    return 'schema_changed'
  }
  if (['generate_api', 'generate_aggregate_api'].includes(tool)) return 'api_created'
  if (['enable_auth', 'add_rls', 'set_rls', 'add_oauth_provider'].includes(tool)) return 'auth_rule_created'
  if (['disable_oauth_provider', 'remove_permission', 'block_end_user', 'unblock_end_user', 'reset_end_user_password'].includes(tool)) {
    return 'auth_changed'
  }
  if (['create_bucket', 'set_bucket_public', 'delete_bucket', 'delete_file'].includes(tool)) return 'storage_created'
  if (['generate_function', 'create_cron_job', 'delete_ai_function', 'delete_cron_job', 'toggle_ai_function'].includes(tool)) {
    return 'function_created'
  }
  if (['trigger_deploy', 'set_env_var', 'delete_env_var'].includes(tool)) return 'migration_created'
  if (['rollback', 'rollback_deploy'].includes(tool)) return 'rollback_created'
  if (['resolve_finding', 'fix_backend'].includes(tool)) return 'health_check_failed'
  return null
}

function riskForTool(tool: string): BackendRiskLevel {
  if (['drop_table', 'drop_column', 'truncate_table', 'delete_bucket', 'delete_file', 'delete_env_var', 'rollback_deploy'].includes(tool)) {
    return 'high'
  }
  if (['add_rls', 'set_rls', 'disable_oauth_provider', 'remove_permission', 'trigger_deploy', 'set_env_var', 'generate_function', 'create_cron_job'].includes(tool)) {
    return 'medium'
  }
  return 'low'
}

function summarizeTool(tool: string): string {
  return tool
    .split('_')
    .filter(Boolean)
    .map(capitalize)
    .join(' ')
}

// Human, countable nouns for tool runs. Without this the receipt summary
// repeats the tool name verbatim ("Generate Api, Generate Api, Generate Api…")
// once per invocation. Collapsing to counts reads as "11 API routes" instead.
const TOOL_NOUN: Record<string, { one: string; many: string }> = {
  create_table: { one: 'table', many: 'tables' },
  add_column: { one: 'field', many: 'fields' },
  create_index: { one: 'index', many: 'indexes' },
  rename_column: { one: 'field rename', many: 'field renames' },
  add_constraint: { one: 'constraint', many: 'constraints' },
  drop_table: { one: 'table drop', many: 'table drops' },
  drop_column: { one: 'field drop', many: 'field drops' },
  truncate_table: { one: 'table clear', many: 'table clears' },
  generate_api: { one: 'API route', many: 'API routes' },
  generate_aggregate_api: { one: 'aggregate API', many: 'aggregate APIs' },
  enable_auth: { one: 'auth setup', many: 'auth setups' },
  add_rls: { one: 'access rule', many: 'access rules' },
  set_rls: { one: 'access rule', many: 'access rules' },
  add_oauth_provider: { one: 'OAuth provider', many: 'OAuth providers' },
  create_bucket: { one: 'storage bucket', many: 'storage buckets' },
  set_bucket_public: { one: 'bucket change', many: 'bucket changes' },
  delete_bucket: { one: 'bucket removal', many: 'bucket removals' },
  delete_file: { one: 'file removal', many: 'file removals' },
  generate_function: { one: 'function', many: 'functions' },
  create_cron_job: { one: 'cron job', many: 'cron jobs' },
  delete_ai_function: { one: 'function removal', many: 'function removals' },
  delete_cron_job: { one: 'cron removal', many: 'cron removals' },
  toggle_ai_function: { one: 'function toggle', many: 'function toggles' },
  trigger_deploy: { one: 'deployment', many: 'deployments' },
  set_env_var: { one: 'env var', many: 'env vars' },
  delete_env_var: { one: 'env var removal', many: 'env var removals' },
  rollback: { one: 'rollback', many: 'rollbacks' },
  rollback_deploy: { one: 'deploy rollback', many: 'deploy rollbacks' },
}

function toolNounPhrases(tools: string[]): string[] {
  const grouped = new Map<string, { one: string; many: string; count: number }>()
  for (const tool of tools) {
    const fallbackWord = summarizeTool(tool).toLowerCase()
    const noun = TOOL_NOUN[tool] || { one: fallbackWord, many: `${fallbackWord}s` }
    const existing = grouped.get(noun.many)
    if (existing) existing.count += 1
    else grouped.set(noun.many, { ...noun, count: 1 })
  }
  return [...grouped.values()].map(noun => `${noun.count} ${noun.count === 1 ? noun.one : noun.many}`)
}

// The agent's free-text result can contain markdown (**bold**, `code`, # headings)
// that renders as literal asterisks in the timeline. Strip it before storing.
function stripMarkdown(value: string): string {
  return value.replace(/\*\*/g, '').replace(/`+/g, '').replace(/^#+\s*/gm, '').trim()
}

function receiptTitleForTools(tools: string[]): string {
  const eventful = tools.filter(tool => eventTypeForTool(tool))
  if (eventful.length === 0) return 'Recorded backend requirement'
  const phrases = toolNounPhrases(eventful)
  if (phrases.length === 1) return `Applied ${phrases[0]}`
  return `Applied ${eventful.length} backend actions`
}

function receiptSummaryForTools(tools: string[], userMessage: string, summary?: string): string {
  const eventful = tools.filter(tool => eventTypeForTool(tool))
  const phrases = toolNounPhrases(eventful)
  const base = phrases.length
    ? `Backenly applied ${joinHuman(phrases)} based on the product request: "${truncate(userMessage, 180)}".`
    : `Backenly recorded the product request: "${truncate(userMessage, 180)}".`

  return summary ? `${base} Result: ${truncate(stripMarkdown(summary), 240)}` : base
}

function joinHuman(parts: string[]): string {
  if (parts.length <= 1) return parts[0] || ''
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`
  return `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}`
}

export async function createBackendEvent(input: CreateBackendEventInput) {
  const data: Record<string, unknown> = {
    projectId: input.projectId,
    eventType: input.eventType,
    actorType: input.actorType,
    actorId: input.actorId ?? null,
    summary: input.summary,
    reason: input.reason ?? null,
    riskLevel: input.riskLevel ?? 'low',
    status: input.status ?? 'applied',
    receiptId: input.receiptId ?? null,
  }

  const beforeState = asJson(input.beforeState)
  const afterState = asJson(input.afterState)
  if (beforeState !== undefined) data.beforeState = beforeState
  if (afterState !== undefined) data.afterState = afterState

  return (prisma as any).backendEvent.create({ data })
}

export async function createChangeReceipt(input: CreateChangeReceiptInput) {
  const receipt = await (prisma as any).changeReceipt.create({
    data: {
      projectId: input.projectId,
      eventIds: input.eventIds,
      title: input.title,
      summary: input.summary,
      resourcesChanged: asJson(input.resourcesChanged),
      riskLevel: input.riskLevel ?? 'low',
      rollbackAvailable: input.rollbackAvailable ?? false,
      rollbackId: input.rollbackId ?? null,
    },
  })

  if (input.eventIds.length > 0) {
    await (prisma as any).backendEvent.updateMany({
      where: {
        projectId: input.projectId,
        id: { in: input.eventIds },
      },
      data: { receiptId: receipt.id },
    })
  }

  return receipt
}

export async function recordBackendExecutionMemory(input: RecordExecutionMemoryInput) {
  const actorType = input.actorType ?? 'backenly_agent'
  const riskLevel = input.changes.reduce<BackendRiskLevel>(
    (risk, change) => maxRisk(risk, riskForChange(change)),
    'low',
  )

  const events = []

  events.push(await createBackendEvent({
    projectId: input.projectId,
    eventType: 'product_requirement_created',
    actorType: 'user',
    actorId: input.actorId,
    summary: `User asked: "${truncate(input.userMessage)}"`,
    beforeState: input.beforeState,
    afterState: input.canonicalIntent,
    reason: 'Captured as the source requirement for this backend change.',
    riskLevel: 'low',
    status: 'applied',
  }))

  for (const change of input.changes) {
    events.push(await createBackendEvent({
      projectId: input.projectId,
      eventType: eventTypeForChange(change),
      actorType,
      actorId: input.actorId,
      summary: summarizeChange(change),
      beforeState: {
        resourceType: change.type,
        resource: change.target,
      },
      afterState: change.details,
      reason: `Backenly applied this because of the request: "${truncate(input.userMessage, 180)}".`,
      riskLevel: riskForChange(change),
      status: 'applied',
    }))
  }

  const receipt = await createChangeReceipt({
    projectId: input.projectId,
    eventIds: events.map(event => event.id),
    title: receiptTitleForChanges(input.changes, input.userMessage),
    summary: receiptSummaryForChanges(input.changes, input.userMessage),
    resourcesChanged: {
      ...summarizeResources(input.changes),
      executionId: input.executionId,
    },
    riskLevel,
    rollbackAvailable: input.rollbackAvailable ?? input.changes.length > 0,
    rollbackId: input.rollbackId ?? input.executionId ?? null,
  })

  // Phase 6 — anonymized cross-project pattern collection. Best-effort;
  // recordPattern never throws, so this can't affect the real memory record.
  const projectType = resolveProjectType(input.userMessage)
  for (const change of input.changes) {
    const patternType = patternTypeForEventType(eventTypeForChange(change))
    if (!patternType) continue
    await recordPattern({
      projectType,
      patternType,
      resourceType: change.target,
      patternSummary: summarizeChange(change),
      outcome: 'success',
      riskLevel: riskForChange(change),
    })
  }

  return { events, receipt }
}

export async function recordToolExecutionMemory(input: RecordToolExecutionMemoryInput) {
  const fallbackStatus = input.status ?? 'applied'
  // Zip each tool with its real per-run outcome BEFORE filtering, so the status
  // stays aligned to the tool it belongs to. This is what keeps the ledger
  // honest: an action that landed (create_table/generate_api returned ok) is
  // recorded 'applied' even when a later model call in the same turn timed out
  // — instead of every action inheriting a single "the turn didn't cleanly
  // finish" verdict, which is what turned applied work into a wall of "failed".
  const eventful = input.tools
    .map((tool, i) => ({ tool, status: input.toolStatuses?.[i] ?? fallbackStatus }))
    .filter(entry => eventTypeForTool(entry.tool))
  if (eventful.length === 0) return null

  const eventfulTools = eventful.map(e => e.tool)
  const anyApplied = eventful.some(e => e.status === 'applied')

  const riskLevel = eventfulTools.reduce<BackendRiskLevel>(
    (risk, tool) => maxRisk(risk, riskForTool(tool)),
    'low',
  )

  const events = []
  events.push(await createBackendEvent({
    projectId: input.projectId,
    eventType: 'product_requirement_created',
    actorType: 'user',
    actorId: input.actorId,
    summary: `User asked: "${truncate(input.userMessage)}"`,
    afterState: { tools: eventfulTools },
    reason: 'Captured as the source requirement for this backend action.',
    riskLevel: 'low',
    status: 'applied',
  }))

  for (const { tool, status } of eventful) {
    events.push(await createBackendEvent({
      projectId: input.projectId,
      eventType: eventTypeForTool(tool)!,
      actorType: 'backenly_agent',
      actorId: input.actorId,
      summary: summarizeTool(tool),
      afterState: { tool },
      reason: `Backenly ran this action because of the request: "${truncate(input.userMessage, 180)}".`,
      riskLevel: riskForTool(tool),
      status,
    }))
  }

  const receipt = await createChangeReceipt({
    projectId: input.projectId,
    eventIds: events.map(event => event.id),
    title: receiptTitleForTools(eventfulTools),
    summary: receiptSummaryForTools(eventfulTools, input.userMessage, input.summary),
    resourcesChanged: {
      tools: eventfulTools,
      total: eventfulTools.length,
    },
    riskLevel,
    // Rollback is offered whenever at least one action actually landed —
    // there is real state to revert even if the turn also had a failed step.
    rollbackAvailable: anyApplied && eventfulTools.length > 0,
    rollbackId: null,
  })

  // Phase 6 — anonymized cross-project pattern collection (see note above).
  const toolProjectType = resolveProjectType(input.userMessage)
  for (const { tool, status } of eventful) {
    const patternType = patternTypeForEventType(eventTypeForTool(tool)!)
    if (!patternType) continue
    await recordPattern({
      projectType: toolProjectType,
      patternType,
      resourceType: tool,
      patternSummary: summarizeTool(tool),
      outcome: status === 'applied' ? 'success' : 'failure',
      riskLevel: riskForTool(tool),
    })
  }

  return { events, receipt }
}

// ── Phase 4 — shared risk classification for the executor gate ─────────────
// Single source of truth for which AIAction names (as dispatched by
// lib/ai/minimal-executor.ts, regardless of whether the caller was the brain
// tool loop or the orchestration atomic-executor) are risky enough to pause
// for approval instead of applying immediately.

const HIGH_RISK_EXECUTOR_ACTIONS = new Set([
  'DROP_TABLE', 'TRUNCATE_TABLE', 'DROP_COLUMN', 'ROLLBACK_DEPLOY',
  'DELETE_FILE', 'DELETE_BUCKET', 'ROLLBACK_TO_VERSION', 'DELETE_ENV_VAR',
  'DISCONNECT_FRONTEND',
])

const MEDIUM_RISK_EXECUTOR_ACTIONS = new Set([
  'REVOKE_KEY', 'ROTATE_KEY', 'DELETE_TRIGGER', 'DELETE_AI_FUNCTION',
  'DELETE_CRON_JOB', 'REMOVE_INTEGRATION_KEY', 'BLOCK_USER',
  'REMOVE_PERMISSION', 'DISABLE_REALTIME', 'DISABLE_PROVIDER',
  'TRIGGER_DEPLOY', 'SET_ENV_VAR', 'RESET_PASSWORD',
])

export function riskLevelForExecutorAction(action: string): BackendRiskLevel {
  if (HIGH_RISK_EXECUTOR_ACTIONS.has(action)) return 'high'
  if (MEDIUM_RISK_EXECUTOR_ACTIONS.has(action)) return 'medium'
  return 'low'
}

export interface QueuePendingActionInput {
  projectId: string
  action: string
  params: Record<string, unknown>
  target?: string
  riskLevel: BackendRiskLevel
  source: 'brain-risk' | 'orchestration-risk'
  reason: string
}

/** Best-effort BackendEvent category for a gated AIAction name — Memory-timeline display only. */
function eventTypeForExecutorAction(action: string): BackendEventType {
  if (['CREATE_TABLE', 'ADD_COLUMN', 'DROP_TABLE', 'DROP_COLUMN', 'CREATE_INDEX', 'RENAME_COLUMN', 'ADD_CONSTRAINT'].includes(action)) {
    return 'schema_changed'
  }
  if (action === 'GENERATE_API') return 'api_changed'
  if (['ENABLE_AUTH', 'ADD_PROVIDER', 'DISABLE_PROVIDER', 'SET_PERMISSION', 'REMOVE_PERMISSION', 'BLOCK_USER', 'UNBLOCK_USER', 'RESET_PASSWORD', 'CREATE_KEY', 'REVOKE_KEY', 'ROTATE_KEY'].includes(action)) {
    return 'auth_changed'
  }
  if (['CREATE_BUCKET', 'DELETE_BUCKET', 'DELETE_FILE', 'SET_BUCKET_PUBLIC'].includes(action)) return 'storage_created'
  if (action === 'ROLLBACK_DEPLOY' || action === 'ROLLBACK_TO_VERSION') return 'rollback_created'
  return 'migration_created'
}

/**
 * Create a HealthFinding of type 'ai_action_pending' so a risk-flagged action
 * shows up in the Review Queue (GET /api/projects/[id]/autonomy) instead of
 * applying silently. Approving it re-runs the exact action via
 * lib/core/auto-fix-engine.ts's buildFixAction passthrough case.
 *
 * Also pairs a BackendEvent so this shows up in the Memory timeline — a
 * HealthFinding alone is invisible there (Memory reads BackendEvent rows).
 */
export async function queuePendingActionFinding(input: QueuePendingActionInput) {
  const label = input.action.replace(/_/g, ' ').toLowerCase()
  const title = `${capitalize(label)}${input.target ? ` on ${input.target}` : ''}`

  // Dedup: if an identical action+target is already awaiting approval, reuse
  // it instead of stacking duplicates. Without this, a user repeatedly asking
  // the AI to run a gated action (without ever confirming) would flood both
  // the Review Queue and the Memory timeline with copies of the same request.
  const duplicate = await prisma.healthFinding.findFirst({
    where: {
      projectId: input.projectId,
      type: 'ai_action_pending',
      status: 'pending_approval',
      AND: [
        { details: { path: ['executorAction'], equals: input.action } },
        ...(input.target ? [{ details: { path: ['location'], equals: input.target } }] : []),
      ],
    },
    select: { id: true },
  }).catch(() => null)

  if (duplicate) return duplicate

  // Record the "proposed" event FIRST so we can stitch its id onto the finding.
  // That id is the durable link between the Review Queue (HealthFinding) and the
  // Memory timeline (BackendEvent): approving/dismissing the finding later flips
  // this exact event out of the 'proposed' state instead of leaving it stale.
  let backendEventId: string | null = null
  try {
    const proposedEvent = await createBackendEvent({
      projectId: input.projectId,
      eventType: eventTypeForExecutorAction(input.action),
      actorType: 'system',
      summary: `Held for your approval: ${title}.`,
      afterState: { executorAction: input.action, target: input.target },
      reason: `User approval required — ${input.reason}`,
      riskLevel: input.riskLevel,
      status: 'proposed',
      receiptId: null,
    })
    backendEventId = proposedEvent.id
  } catch (error) {
    // Non-fatal: the finding still gates the action even if the memory event
    // fails to write. It just won't self-resolve in the timeline.
    console.error('[Operational Memory] Failed to record guardrail-blocked event:', error)
  }

  const finding = await prisma.healthFinding.create({
    data: {
      projectId: input.projectId,
      type: 'ai_action_pending',
      severity: input.riskLevel === 'high' ? 'critical' : 'warning',
      status: 'pending_approval',
      autoFixed: false,
      details: {
        title,
        description: input.reason,
        location: input.target,
        source: input.source,
        executorAction: input.action,
        executorParams: input.params,
        backendEventId,
      } as any,
    },
  })

  return finding
}

/**
 * Reconcile a Review-Queue decision back into the Memory timeline.
 *
 * The Review Queue (HealthFinding) and Memory (BackendEvent) are two views of
 * the same pending change. When the user approves or dismisses a finding, the
 * paired 'proposed' event must advance too — otherwise Memory shows a change as
 * forever-pending that the user already acted on, and the two surfaces disagree.
 *
 * - approved  → flip the paired event to 'applied' AND record a durable
 *   `user_approved_change` event (this is what makes the "User approvals" stat
 *   real — nothing else in the system writes that event type).
 * - dismissed → flip the paired event to 'dismissed' (terminal, no new event —
 *   a declined proposal is not a backend change worth its own timeline row).
 *
 * Best-effort: never throws, so it can't turn a successful approval into a 500.
 */
export async function resolvePendingActionMemory(input: {
  projectId: string
  finding: { id: string; type: string; details: unknown }
  decision: 'approved' | 'dismissed'
  actorId?: string | null
}): Promise<void> {
  try {
    const details = (input.finding.details ?? {}) as Record<string, unknown>
    const backendEventId =
      typeof details.backendEventId === 'string' ? details.backendEventId : null
    const label =
      (typeof details.title === 'string' && details.title) ||
      input.finding.type.replace(/_/g, ' ')

    if (backendEventId) {
      await (prisma as any).backendEvent
        .update({
          where: { id: backendEventId },
          data: { status: input.decision === 'approved' ? 'applied' : 'dismissed' },
        })
        .catch(() => {
          // Event may have been pruned or never recorded — nothing to reconcile.
        })
    }

    if (input.decision === 'approved') {
      await createBackendEvent({
        projectId: input.projectId,
        eventType: 'user_approved_change',
        actorType: 'user',
        actorId: input.actorId,
        summary: `You approved: ${label}.`,
        afterState: { findingId: input.finding.id, backendEventId },
        reason: 'Applied after your approval in the Review Queue.',
        riskLevel: 'low',
        status: 'applied',
      })
    }
  } catch (error) {
    console.error('[Operational Memory] Failed to reconcile Review-Queue decision:', error)
  }
}

export async function recordRollbackMemory(input: RecordRollbackMemoryInput) {
  const event = await createBackendEvent({
    projectId: input.projectId,
    eventType: 'rollback_created',
    actorType: input.actorType ?? 'user',
    actorId: input.actorId,
    summary: input.summary,
    beforeState: input.beforeState,
    afterState: input.afterState,
    reason: input.reason ?? 'User requested rollback to a previously recorded backend state.',
    riskLevel: 'medium',
    status: 'applied',
  })

  const receipt = await createChangeReceipt({
    projectId: input.projectId,
    eventIds: [event.id],
    title: 'Rolled back backend state',
    summary: input.summary,
    resourcesChanged: {
      rollbackId: input.rollbackId,
    },
    riskLevel: 'medium',
    rollbackAvailable: false,
    rollbackId: input.rollbackId ?? null,
  })

  // Phase 6 — anonymized cross-project pattern collection. Rollback has no
  // natural-language request to classify a project type from, so this
  // bucket is deliberately generic rather than guessed.
  await recordPattern({
    projectType: 'general',
    patternType: 'rollback',
    resourceType: 'rollback',
    patternSummary: 'Rolled back a previous backend version.',
    outcome: 'success',
    riskLevel: 'medium',
  })

  return { event, receipt }
}
