/**
 * PHASE 9 — STRUCTURED PROJECT MEMORY AND MULTI-TURN CONTINUITY
 * ==============================================================
 * Strongly-typed, domain-aware project memory that persists across sessions.
 * Replaces the previous weakly-typed blob with:
 *   - Typed domain + template tracking
 *   - Typed completed and open goals (with subgoal detail)
 *   - Per-integration active/verified status
 *   - Typed security status
 *   - Typed architectural decisions by category
 *   - Structured prompt injection (not prose blobs)
 *   - Incremental updates after subgoals, not only at build end
 */

// ── Local types (previously imported from intent-planner) ─────────────────────

interface IntentGraph {
  entities: Array<{ entity: string }>
  relations: unknown[]
  actions: Array<{ action: string; entity: string }>
  decision?: { app_type?: string; app_pattern?: string }
}

// ── Typed sub-structures ───────────────────────────────────────────────────────

export interface IntegrationStatus {
  /** Integration name: 'stripe', 'sendgrid', 'twilio', 'resend', etc. */
  name: string
  active: boolean
  /** verified = key stored AND tested end-to-end at least once */
  verified: boolean
  addedAt: string
  lastVerifiedAt?: string
}

export interface SecurityStatus {
  authEnabled: boolean
  /** Row-Level Security policies active */
  rlsEnabled: boolean
  /** Any API keys marked as rotated / re-issued */
  apiKeysRotated: boolean
  /** Project JWT secret is non-default */
  jwtConfigured: boolean
  lastCheckedAt?: string
}

export interface CompletedGoal {
  id: string
  /** Human-readable summary of what was achieved */
  description: string
  completedAt: string
  entitiesCreated: string[]
  /** AI action verbs executed: CREATE_TABLE, GENERATE_API, ENABLE_AUTH, … */
  actionsPerformed: string[]
  /** Original user request — kept full, never truncated in storage */
  originalIntent: string
}

export interface OpenGoal {
  id: string
  /** What was requested but not fully completed (truncated build) */
  description: string
  startedAt: string
  stepsCompleted: number
  totalSteps: number
  /** Subgoal descriptions still pending */
  pendingSubgoals: string[]
  /** Original user request */
  originalIntent: string
}

export type DecisionCategory =
  | 'schema'
  | 'auth'
  | 'integration'
  | 'api'
  | 'security'
  | 'function'
  | 'trigger'
  | 'other'

export interface ArchitecturalDecision {
  id: string
  when: string
  category: DecisionCategory
  /** What was decided (concise) */
  decision: string
  /** Why — derived from user intent */
  rationale: string
  entitiesAffected: string[]
}

// ── Main ProjectMemory interface ───────────────────────────────────────────────

export interface ProjectMemory {
  // ── Identity
  /** Detected domain: 'ecommerce', 'saas', 'marketplace', 'blog', 'fintech', etc. */
  domain?: string
  /** Domain templates applied during initial build */
  templatesUsed: string[]
  appType?: string
  appPattern?: string

  // ── Schema state
  /** All table names successfully created */
  builtSoFar: string[]
  /** Tables that have generated REST APIs */
  tablesWithApis: string[]

  // ── Security
  security: SecurityStatus

  // ── Integrations (active and verified)
  integrations: IntegrationStatus[]

  // ── Goals
  /** Goals fully achieved — cap at 20 most recent */
  completedGoals: CompletedGoal[]
  /** Goals started but not finished (e.g. truncated builds) — cap at 5 */
  openGoals: OpenGoal[]

  // ── Architectural decisions — cap at 30
  decisions: ArchitecturalDecision[]

  // ── Backward-compat shim (mirrors security.authEnabled)
  authEnabled: boolean

  lastBuildAt?: string
  /** Schema version: bump when interface shape changes for safe migration */
  _v: 2
}

// ── Defaults ───────────────────────────────────────────────────────────────────

function emptyMemory(): ProjectMemory {
  return {
    templatesUsed: [],
    builtSoFar: [],
    tablesWithApis: [],
    security: {
      authEnabled: false,
      rlsEnabled: false,
      apiKeysRotated: false,
      jwtConfigured: false,
    },
    integrations: [],
    completedGoals: [],
    openGoals: [],
    decisions: [],
    authEnabled: false,
    _v: 2,
  }
}

// ── Persistence ────────────────────────────────────────────────────────────────

export async function loadProjectMemory(projectId: string): Promise<ProjectMemory> {
  const { prisma } = await import('@/lib/db/prisma')
  try {
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { architecturalMemory: true },
    })
    if (!project?.architecturalMemory) return emptyMemory()
    const raw = JSON.parse(project.architecturalMemory)
    // Migrate v1 → v2: fill in missing typed fields
    if (!raw._v || raw._v < 2) return migrateV1(raw)
    return raw as ProjectMemory
  } catch {
    return emptyMemory()
  }
}

// Hard cap: never let the architecturalMemory blob exceed 512 KB.
// Individual array caps (decisions: 30, completedGoals: 20, openGoals: 5) are the
// first line of defence.  This guard trims aggressively only when those caps are
// somehow circumvented or when future fields are added without their own caps.
const MAX_MEMORY_BYTES = 512 * 1024

function trimMemoryToSizeLimit(memory: ProjectMemory): ProjectMemory {
  let serialized = JSON.stringify(memory)
  if (serialized.length <= MAX_MEMORY_BYTES) return memory

  // Trim in order of least-critical to most-critical
  const trimmed = { ...memory }

  // 1. Decisions → keep most recent 10
  if (trimmed.decisions.length > 10) {
    trimmed.decisions = trimmed.decisions.slice(-10)
    serialized = JSON.stringify(trimmed)
  }

  // 2. completedGoals → keep most recent 5
  if (serialized.length > MAX_MEMORY_BYTES && trimmed.completedGoals.length > 5) {
    trimmed.completedGoals = trimmed.completedGoals.slice(-5)
    serialized = JSON.stringify(trimmed)
  }

  // 3. openGoals → keep most recent 3
  if (serialized.length > MAX_MEMORY_BYTES && trimmed.openGoals.length > 3) {
    trimmed.openGoals = trimmed.openGoals.slice(-3)
    serialized = JSON.stringify(trimmed)
  }

  // 4. builtSoFar → keep most recent 100 table names
  if (serialized.length > MAX_MEMORY_BYTES && trimmed.builtSoFar.length > 100) {
    trimmed.builtSoFar = trimmed.builtSoFar.slice(-100)
    trimmed.tablesWithApis = trimmed.tablesWithApis.slice(-100)
  }

  return trimmed
}

export async function saveProjectMemory(projectId: string, memory: ProjectMemory): Promise<void> {
  const { prisma } = await import('@/lib/db/prisma')
  try {
    const safe = trimMemoryToSizeLimit(memory)
    await prisma.project.update({
      where: { id: projectId },
      data: { architecturalMemory: JSON.stringify(safe) },
    })
  } catch (err) {
    console.warn('[ProjectMemory] Failed to save:', err)
  }
}

/** Upgrade v1 blob to v2 typed structure — preserves all old data */
function migrateV1(old: Record<string, any>): ProjectMemory {
  const m = emptyMemory()
  m.builtSoFar = old.builtSoFar ?? []
  m.tablesWithApis = old.tablesWithApis ?? []
  m.authEnabled = old.authEnabled ?? false
  m.security.authEnabled = old.authEnabled ?? false
  m.appType = old.appType
  m.appPattern = old.appPattern
  m.lastBuildAt = old.lastBuildAt

  // Migrate old decisions array → ArchitecturalDecision[]
  const oldDecisions: any[] = old.decisions ?? []
  m.decisions = oldDecisions.map((d, i) => ({
    id: `migrated-${i}`,
    when: d.when ?? new Date().toISOString().slice(0, 10),
    category: inferCategory(d.what ?? ''),
    decision: d.what ?? '',
    rationale: (d.why ?? '').slice(0, 300),
    entitiesAffected: d.entitiesAdded ?? [],
  }))

  return m
}

function inferCategory(text: string): DecisionCategory {
  const t = text.toLowerCase()
  if (/auth|login|jwt|password|session/.test(t)) return 'auth'
  if (/api|endpoint|rest/.test(t)) return 'api'
  if (/stripe|email|sendgrid|twilio|integration/.test(t)) return 'integration'
  if (/permission|rls|role|policy|security/.test(t)) return 'security'
  if (/function|compute|transform/.test(t)) return 'function'
  if (/trigger|cron|schedule|event/.test(t)) return 'trigger'
  if (/table|column|schema|relation/.test(t)) return 'schema'
  return 'other'
}

// ── Phase 9.2 — Incremental subgoal update ────────────────────────────────────

export interface SubgoalProgressUpdate {
  goalIntent: string
  goalDescription: string
  stepsCompleted: number
  totalSteps: number
  pendingSubgoals: string[]
  completedSubgoals: string[]
  /** If true, the goal is fully done and should move from openGoals → completedGoals */
  isComplete: boolean
  entitiesCreated: string[]
  actionsPerformed: string[]
}

/**
 * Called after each subgoal completes inside the dynamic agent loop.
 * Updates open-goal progress incrementally — does NOT wait for the full loop end.
 * Fire-and-forget safe: failures are logged and silently swallowed.
 */
export async function updateMemoryAfterSubgoal(
  projectId: string,
  update: SubgoalProgressUpdate,
): Promise<void> {
  try {
    const memory = await loadProjectMemory(projectId)

    // Find existing open goal for this intent, or create one
    const goalId = slugify(update.goalIntent)
    const existingIdx = memory.openGoals.findIndex(g => g.id === goalId)

    if (update.isComplete) {
      // Move from openGoals → completedGoals
      if (existingIdx >= 0) memory.openGoals.splice(existingIdx, 1)

      const alreadyCompleted = memory.completedGoals.some(g => g.id === goalId)
      if (!alreadyCompleted) {
        memory.completedGoals.push({
          id: goalId,
          description: update.goalDescription,
          completedAt: new Date().toISOString(),
          entitiesCreated: unique(update.entitiesCreated),
          actionsPerformed: unique(update.actionsPerformed),
          originalIntent: update.goalIntent,
        })
        // Cap at 20 most recent
        if (memory.completedGoals.length > 20) {
          memory.completedGoals = memory.completedGoals.slice(-20)
        }
      }

      // Update builtSoFar with any new entities
      for (const e of update.entitiesCreated) {
        if (!memory.builtSoFar.includes(e)) memory.builtSoFar.push(e)
      }

      // Update tablesWithApis
      if (update.actionsPerformed.includes('GENERATE_API')) {
        for (const e of update.entitiesCreated) {
          if (!memory.tablesWithApis.includes(e)) memory.tablesWithApis.push(e)
        }
      }

    } else {
      // Update or create open goal entry
      const openGoal: OpenGoal = {
        id: goalId,
        description: update.goalDescription,
        startedAt: existingIdx >= 0
          ? memory.openGoals[existingIdx].startedAt
          : new Date().toISOString(),
        stepsCompleted: update.stepsCompleted,
        totalSteps: update.totalSteps,
        pendingSubgoals: update.pendingSubgoals,
        originalIntent: update.goalIntent,
      }
      if (existingIdx >= 0) {
        memory.openGoals[existingIdx] = openGoal
      } else {
        memory.openGoals.push(openGoal)
        // Cap at 5 open goals
        if (memory.openGoals.length > 5) {
          memory.openGoals = memory.openGoals.slice(-5)
        }
      }
    }

    memory.lastBuildAt = new Date().toISOString()
    await saveProjectMemory(projectId, memory)
  } catch (err) {
    console.warn('[ProjectMemory] Subgoal update failed (non-fatal):', err)
  }
}

/**
 * Called when a specific action succeeds, to update security or integration status.
 * Fire-and-forget safe.
 */
export async function updateMemoryAfterAction(
  projectId: string,
  action: string,
  params: Record<string, any>,
): Promise<void> {
  // Only care about security/integration actions — fast exit for everything else
  const tracked = ['ENABLE_AUTH', 'STORE_INTEGRATION_KEY', 'SET_PERMISSION', 'REVOKE_KEY', 'ROTATE_KEY']
  if (!tracked.includes(action)) return

  try {
    const memory = await loadProjectMemory(projectId)

    if (action === 'ENABLE_AUTH') {
      memory.security.authEnabled = true
      memory.authEnabled = true
      memory.security.lastCheckedAt = new Date().toISOString()
    }

    if (action === 'SET_PERMISSION') {
      memory.security.rlsEnabled = true
      memory.security.lastCheckedAt = new Date().toISOString()
    }

    if (action === 'ROTATE_KEY' || action === 'REVOKE_KEY') {
      memory.security.apiKeysRotated = true
      memory.security.lastCheckedAt = new Date().toISOString()
    }

    if (action === 'STORE_INTEGRATION_KEY') {
      const name = (params.integration || params.provider || params.name || '').toLowerCase()
      if (name) {
        const existing = memory.integrations.find(i => i.name === name)
        if (existing) {
          existing.active = true
          // Key was just (re)stored — reset verified until tested
          existing.verified = false
        } else {
          memory.integrations.push({
            name,
            active: true,
            verified: false,
            addedAt: new Date().toISOString(),
          })
        }
      }
    }

    await saveProjectMemory(projectId, memory)
  } catch (err) {
    console.warn('[ProjectMemory] Action update failed (non-fatal):', err)
  }
}

// ── End-of-build update ────────────────────────────────────────────────────────

/**
 * Called after every successful build (dynamic loop OR single intent graph).
 * Accepts either an IntentGraph or a DynamicAgentResult-shaped object.
 */
export async function updateMemoryAfterBuild(
  projectId: string,
  result: IntentGraph | DynamicBuildResult,
  userMessage: string,
): Promise<void> {
  try {
    const memory = await loadProjectMemory(projectId)

    if (isDynamicResult(result)) {
      await applyDynamicResult(memory, result, userMessage, projectId)
    } else {
      await applyIntentGraph(memory, result as IntentGraph, userMessage)
    }

    memory.lastBuildAt = new Date().toISOString()
    await saveProjectMemory(projectId, memory)
  } catch (err) {
    console.warn('[ProjectMemory] Failed to update after build:', err)
  }
}

// ── Shape helpers ──────────────────────────────────────────────────────────────

interface DynamicBuildResult {
  success: boolean
  completed: number
  steps: Array<{ action: string; entity: string; result: 'success' | 'failure'; message: string }>
  message: string
  truncated?: boolean
}

function isDynamicResult(r: any): r is DynamicBuildResult {
  return Array.isArray(r?.steps) && typeof r?.completed === 'number'
}

async function applyDynamicResult(
  memory: ProjectMemory,
  result: DynamicBuildResult,
  userMessage: string,
  projectId: string,
): Promise<void> {
  const successSteps = result.steps.filter(s => s.result === 'success')
  const entitiesAdded: string[] = []
  const actionsPerformed: string[] = []

  for (const step of successSteps) {
    actionsPerformed.push(step.action)

    if (step.action === 'CREATE_TABLE' && step.entity) {
      if (!memory.builtSoFar.includes(step.entity)) {
        memory.builtSoFar.push(step.entity)
        entitiesAdded.push(step.entity)
      }
    }
    if (step.action === 'GENERATE_API' && step.entity) {
      if (!memory.tablesWithApis.includes(step.entity)) {
        memory.tablesWithApis.push(step.entity)
      }
    }
    if (step.action === 'ENABLE_AUTH') {
      memory.security.authEnabled = true
      memory.authEnabled = true
    }
    if (step.action === 'SET_PERMISSION') {
      memory.security.rlsEnabled = true
    }
    if (step.action === 'STORE_INTEGRATION_KEY') {
      // Will be handled by updateMemoryAfterAction inline — just ensure active flag
    }
  }

  // Record as architectural decision if something meaningful happened
  if (entitiesAdded.length > 0 || successSteps.some(s => s.action === 'ENABLE_AUTH')) {
    addDecision(memory, {
      category: inferCategory(userMessage),
      decision: entitiesAdded.length > 0
        ? `Built: ${entitiesAdded.join(', ')}`
        : 'Enabled auth / permissions',
      rationale: userMessage,
      entitiesAffected: entitiesAdded,
    })
  }

  // If the build was truncated, ensure an open goal is recorded
  if (result.truncated) {
    const goalId = slugify(userMessage)
    const alreadyOpen = memory.openGoals.some(g => g.id === goalId)
    if (!alreadyOpen) {
      memory.openGoals.push({
        id: goalId,
        description: `Partial: ${userMessage.slice(0, 120)}`,
        startedAt: new Date().toISOString(),
        stepsCompleted: result.completed,
        totalSteps: result.steps.length,
        pendingSubgoals: [],
        originalIntent: userMessage,
      })
      if (memory.openGoals.length > 5) memory.openGoals = memory.openGoals.slice(-5)
    }
  } else {
    // Build fully completed — close any matching open goal
    const goalId = slugify(userMessage)
    const idx = memory.openGoals.findIndex(g => g.id === goalId)
    if (idx >= 0) memory.openGoals.splice(idx, 1)

    // Add to completed goals
    if (entitiesAdded.length > 0 || actionsPerformed.length > 0) {
      const alreadyDone = memory.completedGoals.some(g => g.id === goalId)
      if (!alreadyDone) {
        memory.completedGoals.push({
          id: goalId,
          description: entitiesAdded.length > 0
            ? `Built: ${entitiesAdded.join(', ')}`
            : userMessage.slice(0, 100),
          completedAt: new Date().toISOString(),
          entitiesCreated: entitiesAdded,
          actionsPerformed: unique(actionsPerformed),
          originalIntent: userMessage,
        })
        if (memory.completedGoals.length > 20) {
          memory.completedGoals = memory.completedGoals.slice(-20)
        }
      }
    }
  }
}

async function applyIntentGraph(
  memory: ProjectMemory,
  graph: IntentGraph,
  userMessage: string,
): Promise<void> {
  const entitiesAdded: string[] = []

  for (const entity of graph.entities) {
    if (!memory.builtSoFar.includes(entity.entity)) {
      memory.builtSoFar.push(entity.entity)
      entitiesAdded.push(entity.entity)
    }
  }

  for (const action of graph.actions) {
    if (action.action === 'GENERATE_API' && !memory.tablesWithApis.includes(action.entity)) {
      memory.tablesWithApis.push(action.entity)
    }
    if (action.action === 'ENABLE_AUTH') {
      memory.security.authEnabled = true
      memory.authEnabled = true
    }
  }

  if (graph.decision?.app_type && !memory.appType) memory.appType = graph.decision.app_type
  if (graph.decision?.app_pattern && !memory.appPattern) memory.appPattern = graph.decision.app_pattern

  if (entitiesAdded.length > 0 || graph.actions.some(a => a.action === 'ENABLE_AUTH')) {
    addDecision(memory, {
      category: inferCategory(userMessage),
      decision: `Built: ${entitiesAdded.join(', ') || '(no new tables)'}`,
      rationale: userMessage,
      entitiesAffected: entitiesAdded,
    })
  }

  // Mark as completed goal
  const goalId = slugify(userMessage)
  const alreadyDone = memory.completedGoals.some(g => g.id === goalId)
  if (!alreadyDone && (entitiesAdded.length > 0 || graph.actions.some(a => a.action === 'ENABLE_AUTH'))) {
    memory.completedGoals.push({
      id: goalId,
      description: `Built: ${entitiesAdded.join(', ')}`,
      completedAt: new Date().toISOString(),
      entitiesCreated: entitiesAdded,
      actionsPerformed: graph.actions.map(a => a.action),
      originalIntent: userMessage,
    })
    if (memory.completedGoals.length > 20) memory.completedGoals = memory.completedGoals.slice(-20)
  }
}

// ── Decision helper ────────────────────────────────────────────────────────────

function addDecision(
  memory: ProjectMemory,
  d: Omit<ArchitecturalDecision, 'id' | 'when'>,
): void {
  memory.decisions.push({
    id: `d-${Date.now()}`,
    when: new Date().toISOString().slice(0, 10),
    ...d,
    rationale: d.rationale.slice(0, 300),
  })
  if (memory.decisions.length > 30) memory.decisions = memory.decisions.slice(-30)
}

// ── Phase 9.3 — Structured prompt injection ────────────────────────────────────

/**
 * Returns a structured, YAML-like block for AI system-prompt injection.
 * The AI reads this as ground truth for the current project state.
 * Replaces the old prose-blob format with parseable typed sections.
 */
export function buildMemoryContext(memory: ProjectMemory): string {
  const hasContent =
    memory.builtSoFar.length > 0 ||
    memory.security.authEnabled ||
    memory.integrations.length > 0 ||
    memory.completedGoals.length > 0

  if (!hasContent) return ''

  const lines: string[] = ['\n## PROJECT MEMORY — treat as ground truth, never contradict']

  // ── Identity
  if (memory.domain) lines.push(`domain: ${memory.domain}`)
  if (memory.appType) {
    lines.push(`app_type: ${memory.appType}${memory.appPattern ? ` (${memory.appPattern})` : ''}`)
  }
  if (memory.templatesUsed.length > 0) {
    lines.push(`templates_used: [${memory.templatesUsed.join(', ')}]`)
  }

  // ── Schema
  lines.push('\n### Schema')
  if (memory.builtSoFar.length > 0) {
    lines.push(`tables_built: [${memory.builtSoFar.join(', ')}]`)
  }
  if (memory.tablesWithApis.length > 0) {
    lines.push(`tables_with_apis: [${memory.tablesWithApis.join(', ')}]`)
  }

  // ── Security
  lines.push('\n### Security')
  lines.push(`auth: ${memory.security.authEnabled ? 'enabled — DO NOT add ENABLE_AUTH again' : 'not yet enabled'}`)
  if (memory.security.rlsEnabled) lines.push('rls: enabled')
  if (memory.security.apiKeysRotated) lines.push('api_keys: rotated')

  // ── Integrations
  if (memory.integrations.length > 0) {
    lines.push('\n### Integrations')
    for (const i of memory.integrations) {
      const status = i.active ? (i.verified ? 'active, verified' : 'active, unverified') : 'inactive'
      const ts = i.lastVerifiedAt ? ` (verified ${i.lastVerifiedAt.slice(0, 10)})` : ''
      lines.push(`- ${i.name}: ${status}${ts}`)
    }
  }

  // ── Open goals (incomplete work — highest priority for continuity)
  if (memory.openGoals.length > 0) {
    lines.push('\n### Open Goals (incomplete — resume these before starting new work)')
    for (const g of memory.openGoals) {
      lines.push(`- [${g.startedAt.slice(0, 10)}] "${g.originalIntent.slice(0, 120)}"`)
      lines.push(`  progress: ${g.stepsCompleted}/${g.totalSteps} steps`)
      if (g.pendingSubgoals.length > 0) {
        lines.push(`  pending: ${g.pendingSubgoals.slice(0, 3).join(' | ')}`)
      }
    }
  }

  // ── Recent completed goals (last 5 — architectural context)
  if (memory.completedGoals.length > 0) {
    const recent = memory.completedGoals.slice(-5)
    lines.push('\n### Completed Goals')
    for (const g of recent) {
      const entities = g.entitiesCreated.length > 0 ? ` → [${g.entitiesCreated.join(', ')}]` : ''
      lines.push(`- [${g.completedAt.slice(0, 10)}]${entities} "${g.originalIntent.slice(0, 120)}"`)
    }
  }

  // ── Architectural decisions (last 6 — why things are the way they are)
  if (memory.decisions.length > 0) {
    const recent = memory.decisions.slice(-6)
    lines.push('\n### Architectural Decisions')
    for (const d of recent) {
      lines.push(`- [${d.category}] ${d.decision}`)
      lines.push(`  rationale: "${d.rationale.slice(0, 200)}"`)
      if (d.entitiesAffected.length > 0) {
        lines.push(`  entities: [${d.entitiesAffected.join(', ')}]`)
      }
    }
  }

  return lines.join('\n')
}

/**
 * Load the granular decision log from the active BackendGraph and format it
 * for injection into AI prompts. Returns empty string if no graph or no entries.
 *
 * This closes the memory loop: FK inference decisions, RLS policy choices, and
 * user overrides recorded by writeDecisionEntry() are now visible to Brain 1
 * and the dynamic agent loop on the NEXT request.
 */
export async function loadDecisionLogContext(projectId: string): Promise<string> {
  try {
    const { getExtendedGraph } = await import('@/lib/memory/graph-schema')
    const graph = await getExtendedGraph(projectId)
    const log = graph?.decisionLog
    if (!log?.length) return ''

    const recent = log.slice(-15)
    const lines: string[] = ['\n## AI Decision Memory (last decisions — never repeat mistakes or override user decisions)']
    for (const entry of recent) {
      const date = entry.at.slice(0, 10)
      const target = entry.tableName
        ? ` on ${entry.tableName}${entry.columnName ? `.${entry.columnName}` : ''}`
        : ''
      const override = entry.userOverrode ? ' ⚠ user overrode this default' : ''
      lines.push(`- [${date}] ${entry.action}${target}: ${entry.decided}${override}`)
      lines.push(`  reason: ${entry.reason}`)
    }
    return lines.join('\n')
  } catch {
    return ''
  }
}

// ── Utilities ──────────────────────────────────────────────────────────────────

function slugify(text: string): string {
  return text
    .toLowerCase()
    .slice(0, 60)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

function unique<T>(arr: T[]): T[] {
  return [...new Set(arr)]
}
