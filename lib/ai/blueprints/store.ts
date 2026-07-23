/**
 * PENDING PLAN STORE
 * ==================
 * When a BUILD turn matches a blueprint, the brain emits the plan to the
 * user AND persists the full executable step list. The next user message
 * ("go ahead") then routes to the deterministic executor, which loads the
 * pending plan and runs every step — no second LLM round-trip required to
 * remember the steps.
 *
 * Storage: ProjectPreference (type='pending_plan', key='active'). One
 * pending plan per project at a time. Replaced when a new plan is proposed,
 * cleared when execution finishes.
 *
 * 30-minute TTL — long enough for the user to confirm comfortably, short
 * enough that a forgotten plan never fires hours later in a new session.
 */

import { prisma } from '@/lib/db/prisma'
import type { Blueprint, BlueprintMatch } from './types'
import type { RequirementsLedger } from './ledger'

const PREF_TYPE = 'pending_plan'
const PREF_KEY = 'active'
const PREF_KEY_RESUME = 'resume'
const TTL_MS = 30 * 60 * 1000

export interface PendingPlan {
  blueprintDomain: Blueprint['domain']
  title: string
  match: BlueprintMatch
  steps: Blueprint['steps']
  createdAt: string
  expiresAt: string
  /**
   * Architect LLM tokens consumed designing this plan. Carried so the eventual
   * execute turn can bill the user once — at the moment the build actually
   * lands — instead of at proposal time (when the user can still reject it).
   * `0` for curated keyword matches that didn't call the architect.
   */
  architectTokens: number
  /**
   * Requirements extracted from the ORIGINAL build prompt at propose time.
   * The execute turn's message is just "go ahead" — without carrying the
   * ledger here, the coverage checklist would have nothing to reconcile
   * against. Optional: older serialized plans won't have it.
   */
  ledger?: RequirementsLedger
}

export async function savePendingPlan(
  projectId: string,
  blueprint: Blueprint,
  match: BlueprintMatch,
  architectTokens: number,
  ledger?: RequirementsLedger,
): Promise<PendingPlan> {
  const now = Date.now()
  const plan: PendingPlan = {
    blueprintDomain: blueprint.domain,
    title: blueprint.title,
    match,
    steps: blueprint.steps,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + TTL_MS).toISOString(),
    architectTokens,
    ...(ledger ? { ledger } : {}),
  }
  await prisma.projectPreference.upsert({
    where: { projectId_type_key: { projectId, type: PREF_TYPE, key: PREF_KEY } },
    create: {
      projectId,
      type: PREF_TYPE,
      key: PREF_KEY,
      value: JSON.stringify(plan),
      confidence: 1,
    },
    update: { value: JSON.stringify(plan), confidence: 1, lastSeen: new Date() },
  })
  return plan
}

export async function loadPendingPlan(projectId: string): Promise<PendingPlan | null> {
  const pref = await prisma.projectPreference.findUnique({
    where: { projectId_type_key: { projectId, type: PREF_TYPE, key: PREF_KEY } },
  }).catch(() => null)
  if (!pref) return null

  try {
    const plan = JSON.parse(pref.value) as PendingPlan
    if (Date.parse(plan.expiresAt) < Date.now()) return null
    // Back-fill for plans serialized before architectTokens existed (any plan
    // proposed in the current 30-minute window when this change ships). Treat
    // as a curated path — no architect cost — so we don't retroactively bill
    // tokens we don't actually have.
    if (typeof plan.architectTokens !== 'number') plan.architectTokens = 0
    return plan
  } catch {
    return null
  }
}

export async function clearPendingPlan(projectId: string): Promise<void> {
  await prisma.projectPreference.deleteMany({
    where: { projectId, type: PREF_TYPE, key: PREF_KEY },
  }).catch(() => {})
}

/**
 * Resume queue — steps from a blueprint that have NOT yet been applied (either
 * because the user paused or because some steps failed in the first pass and
 * a re-run is needed). The user's "continue" / "finish it" / "resume" turn
 * loads this queue and runs the remaining steps with the same deterministic
 * executor used for the first pass. Lifecycle:
 *
 *   blueprint completes with N failed steps  →  saveResumeQueue(failed steps)
 *   user says "continue"                     →  loadResumeQueue + execute
 *   queue runs to empty                      →  clearResumeQueue
 *
 * TTL is the same 30 min as the propose-plan TTL so a stale "continue" 24h
 * later cannot fire — it would fall back to the normal LLM loop instead.
 */
export interface ResumeQueue {
  domain: string
  /** Why these specific steps still need to run (carried for context in the chat). */
  reason: string
  steps: Blueprint['steps']
  createdAt: string
  expiresAt: string
}

export async function saveResumeQueue(
  projectId: string,
  domain: string,
  steps: Blueprint['steps'],
  reason: string,
): Promise<void> {
  if (!steps.length) return
  const now = Date.now()
  const queue: ResumeQueue = {
    domain,
    reason,
    steps,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + TTL_MS).toISOString(),
  }
  await prisma.projectPreference.upsert({
    where: { projectId_type_key: { projectId, type: PREF_TYPE, key: PREF_KEY_RESUME } },
    create: {
      projectId,
      type: PREF_TYPE,
      key: PREF_KEY_RESUME,
      value: JSON.stringify(queue),
      confidence: 1,
    },
    update: { value: JSON.stringify(queue), confidence: 1, lastSeen: new Date() },
  })
}

export async function loadResumeQueue(projectId: string): Promise<ResumeQueue | null> {
  const pref = await prisma.projectPreference.findUnique({
    where: { projectId_type_key: { projectId, type: PREF_TYPE, key: PREF_KEY_RESUME } },
  }).catch(() => null)
  if (!pref) return null
  try {
    const q = JSON.parse(pref.value) as ResumeQueue
    if (Date.parse(q.expiresAt) < Date.now()) return null
    return q
  } catch {
    return null
  }
}

export async function clearResumeQueue(projectId: string): Promise<void> {
  await prisma.projectPreference.deleteMany({
    where: { projectId, type: PREF_TYPE, key: PREF_KEY_RESUME },
  }).catch(() => {})
}
