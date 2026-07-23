/**
 * AGENT TASK — persistent goal that lives across chat turns
 * =========================================================
 *
 * What this fixes:
 *   Backenly's pipeline historically restarted from scratch on every chat
 *   message — the agent could not "own" a goal across turns. If the fix-loop
 *   exited with `max_rounds` or `no_progress`, that state evaporated. The user
 *   had to type the right re-trigger phrase, get past the regex router, and
 *   hope the right loop reran.
 *
 *   Real agentic systems (Base44 / Lovable / Replit Agent / Cursor) keep the
 *   goal alive: "make this backend pass /scan green" is a task the agent owns
 *   until verifier convergence — across turns, browser refreshes, and idle
 *   gaps. This module is that task object.
 *
 * Scope:
 *   - Persistence only — saves / loads / clears agent tasks.
 *   - One active task per project. Starting a new task supersedes any prior.
 *   - TTL 24h so a task abandoned for a day stops haunting the next session.
 *   - Storage: `ProjectPreference` (type='agent_task', key='current').
 *     Same row pattern as workflow-session-state — no schema migration.
 *
 * Out of scope (deliberately):
 *   - Auto-resume policy lives in the pipeline stage, not here.
 *   - Long-horizon multi-task planning is a later move.
 */

import { prisma } from '@/lib/db/prisma'

// ── Types ─────────────────────────────────────────────────────────────────────

export type AgentTaskKind =
  /** "make this backend pass verification + scan" */
  | 'fix_to_green'
  /** "build the thing the user described" (multi-turn build with resumes) */
  | 'build_goal'

export type AgentTaskStatus =
  | 'in_progress'    // Agent worked on it last turn but didn't converge
  | 'awaiting_user'  // Needs user input (credentials, confirmation) to continue
  | 'completed'      // Reached its done-condition
  | 'abandoned'      // User explicitly walked away or TTL expired

export interface AgentTaskFailureSnapshot {
  /** Stable id from the failing check / finding */
  id: string
  /** Human-readable name */
  name: string
  /** What went wrong (first line of error / message, trimmed) */
  detail?: string
}

export interface AgentTask {
  /** Stable id — used in events / logs */
  id: string
  projectId: string
  /** What the user (or system) originally asked for */
  originalGoal: string
  kind: AgentTaskKind
  status: AgentTaskStatus
  /** How many fix-loop runs have already been tried */
  attempts: number
  /** Total fixes successfully applied across all attempts */
  appliedFixesTotal: number
  /** Last-seen failing checks / findings — drives the "still need to do" view */
  lastFailures: AgentTaskFailureSnapshot[]
  /** ISO timestamp this task was first created */
  startedAt: string
  /** ISO timestamp of the most recent attempt */
  lastTriedAt: string
  /** Optional reason the task is paused / awaiting */
  pauseReason?: string
}

// ── Constants ─────────────────────────────────────────────────────────────────

const PREF_TYPE = 'agent_task'
const PREF_KEY = 'current'
const TTL_MS = 24 * 60 * 60 * 1000 // 24h — anything older is abandoned
const MAX_ATTEMPTS = 8              // Hard ceiling — refuses to keep retrying forever

let _seq = 0
const nextId = (projectId: string) =>
  `task-${projectId.slice(0, 8)}-${Date.now()}-${++_seq}`

// ── Readers ───────────────────────────────────────────────────────────────────

export async function getActiveAgentTask(projectId: string): Promise<AgentTask | null> {
  try {
    const row = await prisma.projectPreference.findUnique({
      where: { projectId_type_key: { projectId, type: PREF_TYPE, key: PREF_KEY } },
    })
    if (!row) return null

    let task: AgentTask
    try {
      task = JSON.parse(row.value)
    } catch {
      return null
    }

    // TTL: drop tasks older than 24h
    const age = Date.now() - new Date(task.lastTriedAt).getTime()
    if (age > TTL_MS) {
      await clearAgentTask(projectId).catch(() => {})
      return null
    }

    // Completed / abandoned tasks are not "active"
    if (task.status === 'completed' || task.status === 'abandoned') {
      return null
    }

    return task
  } catch {
    return null
  }
}

export async function hasActiveAgentTask(projectId: string): Promise<boolean> {
  const t = await getActiveAgentTask(projectId)
  return !!t
}

// ── Writers ───────────────────────────────────────────────────────────────────

export interface StartAgentTaskOptions {
  projectId: string
  originalGoal: string
  kind: AgentTaskKind
}

/**
 * Create (or replace) the active task. Starting a new task always
 * supersedes any prior one — there is at most one active task per project.
 */
export async function startAgentTask(opts: StartAgentTaskOptions): Promise<AgentTask> {
  const now = new Date().toISOString()
  const task: AgentTask = {
    id: nextId(opts.projectId),
    projectId: opts.projectId,
    originalGoal: opts.originalGoal,
    kind: opts.kind,
    status: 'in_progress',
    attempts: 0,
    appliedFixesTotal: 0,
    lastFailures: [],
    startedAt: now,
    lastTriedAt: now,
  }
  await persist(task)
  return task
}

export interface RecordAttemptOptions {
  appliedFixesInAttempt: number
  failures: AgentTaskFailureSnapshot[]
  status: AgentTaskStatus
  pauseReason?: string
}

/**
 * Record the outcome of an attempt against the current task. Increments
 * `attempts`, updates `appliedFixesTotal` and `lastFailures`, sets status.
 * Returns the updated task, or null if there was no active task (so the
 * caller knows their attempt happened outside any tracked task).
 */
export async function recordAttempt(
  projectId: string,
  outcome: RecordAttemptOptions,
): Promise<AgentTask | null> {
  const current = await getActiveAgentTask(projectId)
  if (!current) return null

  const next: AgentTask = {
    ...current,
    attempts: current.attempts + 1,
    appliedFixesTotal: current.appliedFixesTotal + Math.max(0, outcome.appliedFixesInAttempt),
    lastFailures: outcome.failures,
    status: outcome.status,
    lastTriedAt: new Date().toISOString(),
    pauseReason: outcome.pauseReason,
  }

  // Cap attempts — protects against runaway loops if a caller forgets to
  // mark the task abandoned.
  if (next.attempts >= MAX_ATTEMPTS && next.status === 'in_progress') {
    next.status = 'abandoned'
    next.pauseReason = `Reached the ${MAX_ATTEMPTS}-attempt safety ceiling without converging.`
  }

  if (next.status === 'completed' || next.status === 'abandoned') {
    await clearAgentTask(projectId)
    return next
  }

  await persist(next)
  return next
}

export async function clearAgentTask(projectId: string): Promise<void> {
  try {
    await prisma.projectPreference.deleteMany({
      where: { projectId, type: PREF_TYPE, key: PREF_KEY },
    })
  } catch {
    // Non-fatal — task lookup will TTL-clean on the next read.
  }
}

// ── Convenience: stable readable summary ──────────────────────────────────────

export function summariseAgentTask(task: AgentTask): string {
  const lines: string[] = []
  lines.push(`**In-flight goal:** ${task.originalGoal}`)
  lines.push(
    `Attempts so far: ${task.attempts} · Fixes applied: ${task.appliedFixesTotal}`,
  )
  if (task.lastFailures.length > 0) {
    lines.push(`Still failing (${task.lastFailures.length}):`)
    for (const f of task.lastFailures.slice(0, 5)) {
      const short = f.detail ? ` — ${f.detail.slice(0, 120)}` : ''
      lines.push(`- ${f.name}${short}`)
    }
    if (task.lastFailures.length > 5) {
      lines.push(`- …and ${task.lastFailures.length - 5} more.`)
    }
  }
  if (task.pauseReason) {
    lines.push(`Paused: ${task.pauseReason}`)
  }
  return lines.join('\n')
}

// ── Resume-intent detector ────────────────────────────────────────────────────

/**
 * Returns true when the user's message clearly means "keep going with the
 * task you were already on" — not when they're starting something new.
 *
 * Kept narrow on purpose: a bare "fix it" is ambiguous (could be a new fix),
 * but "keep going" / "continue" / "try again" / "resume" are unambiguous.
 */
const RESUME_RE =
  /^\s*(continue|keep\s+going|keep\s+trying|try\s+again|retry|resume|pick\s+up|go\s+ahead|go\s+on|carry\s+on|proceed|do\s+it|finish\s+it|finish\s+the\s+job)\s*[.!?]?\s*$/i

export function isResumeIntent(message: string): boolean {
  return RESUME_RE.test(message)
}

// ── Internal ──────────────────────────────────────────────────────────────────

async function persist(task: AgentTask): Promise<void> {
  try {
    await prisma.projectPreference.upsert({
      where: { projectId_type_key: { projectId: task.projectId, type: PREF_TYPE, key: PREF_KEY } },
      create: {
        projectId: task.projectId,
        type: PREF_TYPE,
        key: PREF_KEY,
        value: JSON.stringify(task),
        confidence: 1.0,
      },
      update: {
        value: JSON.stringify(task),
        lastSeen: new Date(),
      },
    })
  } catch {
    // Persistence is best-effort — losing a task is annoying but not fatal.
  }
}
