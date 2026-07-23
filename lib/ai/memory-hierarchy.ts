/**
 * MEMORY HIERARCHY
 * ================
 * Unified access to all four memory layers, loaded in a single call.
 *
 * The audit found Backenly uses "conversation history only" — missing three
 * other critical memory tiers that Replit/Lovable rely on.
 *
 * Four layers (from most to least persistent):
 *
 *   LONG-TERM  (days–months)
 *     → User patterns: coding style, preferred stack, timezone, domain expertise
 *     → Sourced from: AgentMemory + ProjectPreference patterns
 *
 *   PROJECT    (project lifetime)
 *     → Architecture: schema, table purposes, key decisions, deployment URL
 *     → Sourced from: BackendGraph + ArchitecturalMemory + BuildLedger
 *
 *   WORKING    (hours — survives page reload, not days)
 *     → Current state: pending tasks, active blockers, last built entities
 *     → Sourced from: SessionState + StickyIntentStore + WorkflowState
 *
 *   SESSION    (single browser session)
 *     → Recent turns: last 10 conversation messages for pronoun resolution
 *     → Sourced from: ConversationMessage rows
 *
 * Usage:
 *   const mem = await loadMemoryHierarchy(projectId, userId)
 *   // mem.working.pendingTask       — what the user was building
 *   // mem.working.activeBlocker     — what is currently blocked
 *   // mem.project.tableNames        — all tables in this project
 *   // mem.session.recentTurns       — last N conversation turns
 *   // mem.longTerm.preferredStack   — learned stack preferences
 */

import { prisma } from '@/lib/db/prisma'
import { getSessionState } from './workflow-session-state'
import { getLastBuildIntent } from './sticky-intent-store'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface LongTermMemory {
  /** Technologies/patterns the user consistently uses */
  preferredStack: string[]
  /** Known domain expertise (ecommerce, saas, social, etc.) */
  domainExpertise: string[]
  /** User's typical build velocity (rough estimate) */
  totalBuildsCompleted: number
  /** Most common build patterns from AgentMemory */
  successPatterns: string[]
}

export interface ProjectMemory {
  /** All tables currently in this project */
  tableNames: string[]
  /** Auth configuration summary */
  authSummary: string
  /** Storage buckets */
  bucketNames: string[]
  /** Key architectural decisions made */
  keyDecisions: Array<{ what: string; why: string }>
  /** Project purpose (inferred or stated) */
  projectPurpose: string | null
  /** Connected integrations */
  integrations: string[]
  /** API count */
  apiCount: number
  /** Whether the project has been deployed */
  deployed: boolean
}

export interface WorkingMemory {
  /** What the AI is currently trying to build */
  pendingTask: {
    originalRequest: string
    description: string
    completedActions: string[]
    remainingActions: string[]
  } | null
  /** What is currently blocking progress */
  activeBlocker: {
    type: string
    description: string
    requiredInput: string
    integrationId?: string
  } | null
  /** Entities built in the last turn */
  lastBuiltEntities: string[]
  /** Components that failed in the last build */
  lastFailedComponents: string[]
  /** Current session phase */
  sessionPhase: string
  /** Last build intent (for continuation) */
  lastBuildIntent: string | null
}

export interface SessionMemory {
  /** Last N conversation turns */
  recentTurns: Array<{ role: 'user' | 'assistant'; content: string }>
  /** The last user message */
  lastUserMessage: string | null
  /** The last assistant response */
  lastAssistantResponse: string | null
}

export interface MemoryHierarchy {
  longTerm: LongTermMemory
  project: ProjectMemory
  working: WorkingMemory
  session: SessionMemory
}

// ── Loader ────────────────────────────────────────────────────────────────────

/**
 * Loads all four memory tiers in parallel.
 * Non-fatal — any tier failure returns sensible defaults.
 */
export async function loadMemoryHierarchy(
  projectId: string,
  userId: string,
): Promise<MemoryHierarchy> {
  const [longTerm, project, working, session] = await Promise.all([
    loadLongTermMemory(userId),
    loadProjectMemory(projectId),
    loadWorkingMemory(projectId),
    loadSessionMemory(projectId),
  ])

  return { longTerm, project, working, session }
}

// ── Layer loaders ─────────────────────────────────────────────────────────────

async function loadLongTermMemory(userId: string): Promise<LongTermMemory> {
  try {
    const [patterns, prefs] = await Promise.allSettled([
      prisma.agentMemory.findMany({ orderBy: { usageCount: 'desc' }, take: 5, select: { sampleGoal: true } }),
      prisma.projectPreference.findMany({ where: { type: 'user_preference' }, take: 20 }),
    ])

    const successPatterns = patterns.status === 'fulfilled'
      ? patterns.value.map(m => m.sampleGoal).filter(Boolean)
      : []

    const preferredStack: string[] = []
    const domainExpertise: string[] = []

    if (prefs.status === 'fulfilled') {
      for (const pref of prefs.value) {
        if (pref.key === 'preferred_stack') {
          try { preferredStack.push(...JSON.parse(pref.value)) } catch {}
        }
        if (pref.key === 'domain_expertise') {
          try { domainExpertise.push(...JSON.parse(pref.value)) } catch {}
        }
      }
    }

    return {
      preferredStack,
      domainExpertise,
      totalBuildsCompleted: successPatterns.length,
      successPatterns: successPatterns.slice(0, 5),
    }
  } catch {
    return { preferredStack: [], domainExpertise: [], totalBuildsCompleted: 0, successPatterns: [] }
  }
}

async function loadProjectMemory(projectId: string): Promise<ProjectMemory> {
  try {
    const [tables, project, buckets, integrations, apis, deployments, architecturalMemory] =
      await Promise.allSettled([
        prisma.table.findMany({ where: { projectId }, select: { name: true } }),
        prisma.project.findUnique({
          where: { id: projectId },
          select: { jwtSecret: true, authManifest: true, architecturalMemory: true },
        }),
        prisma.storageBucket.findMany({ where: { projectId }, select: { name: true } }),
        prisma.projectIntegrationKey.findMany({ where: { projectId }, select: { integrationId: true } }),
        prisma.apiDefinition.count({ where: { projectId } }),
        prisma.deployment.findFirst({ where: { projectId, status: 'active' } }),
        prisma.agentMemory.findFirst({ where: { fingerprint: `arch:${projectId}` } }),
      ])

    const tableNames = tables.status === 'fulfilled' ? tables.value.map(t => t.name) : []
    const proj = project.status === 'fulfilled' ? project.value : null
    const bucketNames = buckets.status === 'fulfilled' ? buckets.value.map(b => b.name) : []
    const integrationNames = integrations.status === 'fulfilled'
      ? integrations.value.map(i => i.integrationId)
      : []
    const apiCount = apis.status === 'fulfilled' ? apis.value : 0
    const deployed = deployments.status === 'fulfilled' ? !!deployments.value : false

    let authProviders: string[] = []
    try {
      const manifest = proj?.authManifest as Record<string, any> | null
      if (manifest?.providers) {
        authProviders = Object.entries(manifest.providers)
          .filter(([, v]: [string, any]) => v?.enabled)
          .map(([k]) => k)
      }
    } catch {}

    const authSummary = proj?.jwtSecret
      ? authProviders.length > 0
        ? `Enabled (${authProviders.join(', ')})`
        : 'Enabled (email/password)'
      : 'Not configured'

    let keyDecisions: Array<{ what: string; why: string }> = []
    let projectPurpose: string | null = null
    // Try architectural memory from project record first, then agent memory
    if (proj?.architecturalMemory) {
      try {
        const data = JSON.parse(proj.architecturalMemory)
        keyDecisions = data.decisions ?? []
        projectPurpose = data.projectPurpose ?? null
      } catch {}
    } else if (architecturalMemory.status === 'fulfilled' && architecturalMemory.value) {
      try {
        const data = JSON.parse(architecturalMemory.value.sampleGoal)
        keyDecisions = data.decisions ?? []
        projectPurpose = data.purpose ?? null
      } catch {}
    }

    return {
      tableNames,
      authSummary,
      bucketNames,
      keyDecisions,
      projectPurpose,
      integrations: integrationNames,
      apiCount,
      deployed,
    }
  } catch {
    return {
      tableNames: [],
      authSummary: 'Unknown',
      bucketNames: [],
      keyDecisions: [],
      projectPurpose: null,
      integrations: [],
      apiCount: 0,
      deployed: false,
    }
  }
}

async function loadWorkingMemory(projectId: string): Promise<WorkingMemory> {
  try {
    const [sessionState, lastIntent] = await Promise.allSettled([
      getSessionState(projectId),
      getLastBuildIntent(projectId),
    ])

    const state = sessionState.status === 'fulfilled' ? sessionState.value : null
    const intent = lastIntent.status === 'fulfilled' ? lastIntent.value : null

    // Extract last built entities from recent build ledger
    let lastBuiltEntities: string[] = []
    let lastFailedComponents: string[] = []

    try {
      const { loadBuildLedger } = await import('./build-ledger')
      const ledger = await loadBuildLedger(projectId)
      lastBuiltEntities = (ledger.built ?? []).map((c: any) => c.name ?? c.id).filter(Boolean).slice(0, 5)
      lastFailedComponents = (ledger.failed ?? []).map((f: any) => f.name ?? f.id).filter(Boolean).slice(0, 3)
    } catch {}

    return {
      pendingTask: state?.pendingTask
        ? {
            originalRequest: state.pendingTask.originalRequest,
            description: state.pendingTask.description,
            completedActions: state.pendingTask.completedActions,
            remainingActions: state.pendingTask.remainingActions,
          }
        : null,
      activeBlocker: state?.activeBlocker
        ? {
            type: state.activeBlocker.type,
            description: state.activeBlocker.description,
            requiredInput: state.activeBlocker.requiredInput,
            integrationId: state.activeBlocker.integrationId,
          }
        : null,
      lastBuiltEntities,
      lastFailedComponents,
      sessionPhase: state?.phase ?? 'IDLE',
      lastBuildIntent: intent?.intent ?? null,
    }
  } catch {
    return {
      pendingTask: null,
      activeBlocker: null,
      lastBuiltEntities: [],
      lastFailedComponents: [],
      sessionPhase: 'IDLE',
      lastBuildIntent: null,
    }
  }
}

async function loadSessionMemory(projectId: string, limit = 10): Promise<SessionMemory> {
  try {
    const messages = await prisma.conversationMessage.findMany({
      where: { projectId, role: { in: ['user', 'assistant'] } },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: { role: true, content: true },
    })

    const recentTurns = messages
      .reverse()
      .map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }))

    const lastUserMessage = recentTurns.filter(t => t.role === 'user').at(-1)?.content ?? null
    const lastAssistantResponse = recentTurns.filter(t => t.role === 'assistant').at(-1)?.content ?? null

    return { recentTurns, lastUserMessage, lastAssistantResponse }
  } catch {
    return { recentTurns: [], lastUserMessage: null, lastAssistantResponse: null }
  }
}

// ── Context string builder ─────────────────────────────────────────────────────

/**
 * Converts the memory hierarchy into an enriched context string for system prompts.
 * Replaces the current sparse `projectMemory` string injection.
 */
export function buildMemoryContextString(mem: MemoryHierarchy): string {
  const parts: string[] = []

  if (mem.project.projectPurpose) {
    parts.push(`Project: ${mem.project.projectPurpose}`)
  }

  if (mem.project.tableNames.length > 0) {
    parts.push(`Tables (${mem.project.tableNames.length}): ${mem.project.tableNames.join(', ')}`)
  }

  parts.push(`Auth: ${mem.project.authSummary}`)

  if (mem.project.bucketNames.length > 0) {
    parts.push(`Storage: ${mem.project.bucketNames.join(', ')}`)
  }

  if (mem.project.integrations.length > 0) {
    parts.push(`Integrations: ${mem.project.integrations.join(', ')}`)
  }

  if (mem.working.pendingTask) {
    parts.push(`In progress: ${mem.working.pendingTask.description}`)
    if (mem.working.pendingTask.remainingActions.length > 0) {
      parts.push(`Remaining: ${mem.working.pendingTask.remainingActions.join(', ')}`)
    }
  }

  if (mem.working.activeBlocker) {
    parts.push(`Blocked on: ${mem.working.activeBlocker.description}`)
  }

  if (mem.working.lastBuiltEntities.length > 0) {
    parts.push(`Last built: ${mem.working.lastBuiltEntities.join(', ')}`)
  }

  if (mem.working.lastFailedComponents.length > 0) {
    parts.push(`Last failed: ${mem.working.lastFailedComponents.join(', ')}`)
  }

  return parts.join('\n')
}
