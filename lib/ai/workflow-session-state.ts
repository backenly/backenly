/**
 * WORKFLOW SESSION STATE MACHINE
 * ================================
 * The most impactful missing orchestration layer.
 *
 * Problem it solves:
 *   User: "add google auth"
 *   AI:   "paste Google credentials"
 *   User: "random text"
 *   AI:   "build complete"  ← WRONG — this was the failure mode
 *
 * With this module, the pipeline's first check is ALWAYS:
 *   "Is there an unresolved workflow for this project?"
 *
 * If YES → route through that workflow context, don't re-classify.
 * If NO  → normal intent classification.
 *
 * Session states (ordered by phase):
 *   IDLE               — no active work
 *   PLANNING           — AI is analyzing and planning
 *   BUILDING           — executor is running actions
 *   AWAITING_INPUT     — waiting for user credential / confirmation
 *   PARTIALLY_COMPLETE — some steps done, some blocked
 *   COMPLETE           — all requested work finished
 *   ERROR_RECOVERY     — last attempt failed, offering resolution path
 *
 * Persistence: ProjectPreference table (type='session_state')
 * TTL: 2 hours (enough to survive a browser refresh, not stale between days)
 */

import { prisma } from '@/lib/db/prisma'

// ── Types ─────────────────────────────────────────────────────────────────────

export type SessionPhase =
  | 'IDLE'
  | 'PLANNING'
  | 'BUILDING'
  | 'AWAITING_INPUT'
  | 'PARTIALLY_COMPLETE'
  | 'COMPLETE'
  | 'ERROR_RECOVERY'

export interface PendingTask {
  /** Original user request that started this task */
  originalRequest: string
  /** What the AI was trying to build */
  description: string
  /** When this task started */
  startedAt: string
  /** Actions already completed */
  completedActions: string[]
  /** Actions that still need to happen */
  remainingActions: string[]
}

export interface ActiveBlocker {
  /** What resource is missing */
  type: 'credential' | 'confirmation' | 'clarification'
  /** Human-readable description */
  description: string
  /** The specific thing the user must provide */
  requiredInput: string
  /** Pattern to match a valid user response */
  validationPattern?: string
  /** Integration ID, e.g. "stripe", "google" */
  integrationId?: string
  /** Which build step gets unblocked when this is resolved */
  unblocksAction?: string
}

export interface SessionState {
  phase: SessionPhase
  pendingTask?: PendingTask
  activeBlocker?: ActiveBlocker
  /** ISO timestamp of last update */
  updatedAt: string
  /** How many turns have elapsed in AWAITING_INPUT (prevents infinite wait) */
  waitingTurns: number
}

// ── Constants ─────────────────────────────────────────────────────────────────

const PREF_TYPE = 'session_state'
const PREF_KEY = 'current'
const TTL_MS = 2 * 60 * 60 * 1000 // 2 hours
const MAX_WAITING_TURNS = 3 // After 3 turns of random input, abandon the workflow

// ── Readers ───────────────────────────────────────────────────────────────────

export async function getSessionState(projectId: string): Promise<SessionState | null> {
  try {
    const pref = await prisma.projectPreference.findUnique({
      where: { projectId_type_key: { projectId, type: PREF_TYPE, key: PREF_KEY } },
    })
    if (!pref) return null

    let state: SessionState
    try {
      state = JSON.parse(pref.value)
    } catch {
      return null
    }

    // TTL check
    const age = Date.now() - new Date(state.updatedAt).getTime()
    if (age > TTL_MS) {
      await clearSessionState(projectId).catch(() => {})
      return null
    }

    return state
  } catch {
    return null
  }
}

/** Returns true if there is an active unresolved workflow blocking a build */
export async function hasUnresolvedWorkflow(projectId: string): Promise<boolean> {
  const state = await getSessionState(projectId)
  if (!state) return false
  return (
    state.phase === 'AWAITING_INPUT' ||
    state.phase === 'PARTIALLY_COMPLETE' ||
    state.phase === 'ERROR_RECOVERY'
  ) && !!state.activeBlocker
}

// ── Writers ───────────────────────────────────────────────────────────────────

export async function setSessionPhase(
  projectId: string,
  phase: SessionPhase,
  updates?: Partial<Omit<SessionState, 'phase' | 'updatedAt'>>,
): Promise<void> {
  const current = await getSessionState(projectId)

  const next: SessionState = {
    phase,
    pendingTask: updates?.pendingTask ?? current?.pendingTask,
    activeBlocker: updates?.activeBlocker ?? (phase === 'BUILDING' || phase === 'COMPLETE' ? undefined : current?.activeBlocker),
    waitingTurns: updates?.waitingTurns ?? (phase === 'AWAITING_INPUT' ? (current?.waitingTurns ?? 0) + 1 : 0),
    updatedAt: new Date().toISOString(),
  }

  try {
    await prisma.projectPreference.upsert({
      where: { projectId_type_key: { projectId, type: PREF_TYPE, key: PREF_KEY } },
      create: {
        projectId,
        type: PREF_TYPE,
        key: PREF_KEY,
        value: JSON.stringify(next),
        confidence: 1.0,
      },
      update: {
        value: JSON.stringify(next),
        lastSeen: new Date(),
      },
    })
  } catch {
    // Non-fatal — session state is an enhancement, not a hard requirement
  }
}

export async function setAwaitingInput(
  projectId: string,
  blocker: ActiveBlocker,
  pendingTask?: PendingTask,
): Promise<void> {
  const current = await getSessionState(projectId)
  await setSessionPhase(projectId, 'AWAITING_INPUT', {
    activeBlocker: blocker,
    pendingTask: pendingTask ?? current?.pendingTask,
    waitingTurns: 0,
  })
}

export async function clearSessionState(projectId: string): Promise<void> {
  try {
    await prisma.projectPreference.deleteMany({
      where: { projectId, type: PREF_TYPE, key: PREF_KEY },
    })
  } catch {}
}

// ── Blocker resolution ────────────────────────────────────────────────────────

/**
 * Checks if the user's message resolves the current blocker.
 * Returns the matched value if resolved, null if not.
 */
export function resolveBlocker(
  message: string,
  blocker: ActiveBlocker,
): string | null {
  if (!blocker.validationPattern) {
    // No pattern — any non-empty non-trivial response resolves it
    return message.trim().length > 3 ? message.trim() : null
  }

  try {
    const re = new RegExp(blocker.validationPattern, 'i')
    // Try to find the matching token
    const words = message.split(/[\s,;\n\r]+/).filter(Boolean)
    const match = words.find(w => re.test(w))
    if (match) return match

    // Try full message
    if (re.test(message.trim())) return message.trim()
  } catch {}

  return null
}

/**
 * Checks if the user wants to skip / cancel the current workflow.
 */
export function isWorkflowAbort(message: string): boolean {
  return /^\s*(skip|cancel|abort|stop|not now|later|skip for now|never mind|nvm|ignore|forget it)\s*$/i.test(
    message.trim(),
  )
}

/**
 * Determines if the session is stuck in AWAITING_INPUT too long.
 * After MAX_WAITING_TURNS of random input, we should abandon and reset.
 */
export function isSessionStuck(state: SessionState): boolean {
  return state.phase === 'AWAITING_INPUT' && (state.waitingTurns ?? 0) >= MAX_WAITING_TURNS
}

// ── Contextual response builder ───────────────────────────────────────────────

/**
 * Builds the reminder message shown when a user's message doesn't resolve
 * the current blocker. Keeps it calm and specific (never panicked).
 */
export function buildBlockerReminder(state: SessionState): string {
  const blocker = state.activeBlocker
  if (!blocker) return ''

  const task = state.pendingTask?.description
    ? `${state.pendingTask.description} — `
    : ''

  switch (blocker.type) {
    case 'credential': {
      const integration = blocker.integrationId
        ? blocker.integrationId.charAt(0).toUpperCase() + blocker.integrationId.slice(1)
        : 'the integration'
      return `${task}still waiting for your ${integration} API key. ${blocker.requiredInput}\n\nType "skip" to set this aside and continue building other parts.`
    }
    case 'confirmation':
      return `${task}waiting for confirmation. ${blocker.requiredInput}\n\nType "skip" to cancel this action.`
    case 'clarification':
      return blocker.requiredInput
  }
}

/**
 * Builds the stuck-session message when the user has ignored the blocker
 * for MAX_WAITING_TURNS turns. Resets the session gracefully.
 */
export function buildStuckSessionMessage(state: SessionState): string {
  const task = state.pendingTask?.description ?? 'the current setup'
  return `Setting aside ${task} for now — you can return to it later by pasting the required credential.\n\nWhat would you like to build next?`
}
