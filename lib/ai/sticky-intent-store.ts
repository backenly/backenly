/**
 * STICKY INTENT STORE — Phase 5
 * ==============================
 * Persists the last actionable build intent per project so that
 * continuation triggers ("implement", "build it", "do it", etc.) always
 * bind to the real prior request, even after a page reload or new session.
 *
 * Storage: ProjectPreference (type='sticky_intent', key='last_build')
 * Serialized as JSON in the `value` field.
 *
 * Binding priority for CONTINUATION:
 *   1. Last unfinished build request (intentType = 'build_request')
 *   2. Last generated plan           (intentType = 'plan')
 *   3. Nothing → "No unfinished build plan found."
 *
 * Hard rule: NEVER return a generic scaffold or empty goal.
 */

import { prisma } from '@/lib/db/prisma'

// ── Types ─────────────────────────────────────────────────────────────────────

export type StickyIntentType = 'build_request' | 'plan'

export interface StickyIntent {
  intent: string          // The raw user message or plan summary (≤600 chars)
  intentType: StickyIntentType
  savedAt: string         // ISO timestamp
  executed: boolean       // true = already completed, skip on continuation
  /** M1 Fix: table count at save time for schema drift detection.
   *  If the project's table count shifts by ±2 or more since this intent was saved,
   *  continuation adds a drift note so the agent knows the schema changed. */
  tableCountAtSave: number
}

// ── Constants ─────────────────────────────────────────────────────────────────

const PREF_TYPE = 'sticky_intent'
const PREF_KEY = 'last_build'

/** Max age of a sticky intent before it is treated as stale (48 hours). */
const MAX_AGE_MS = 48 * 60 * 60 * 1000

// ── Continuation trigger detection ───────────────────────────────────────────

/**
 * Phrases that should trigger sticky-context lookup.
 * Ordered most specific → least specific.
 */
const CONTINUATION_TRIGGERS = [
  /^implement([\s!.,].*)?$/i,
  /^build it([\s!.,].*)?$/i,
  /^continue([\s!.,].*)?$/i,
  /^proceed([\s!.,].*)?$/i,
  /^do it([\s!.,].*)?$/i,
  /^implement that([\s!.,].*)?$/i,
  /^implement it([\s!.,].*)?$/i,
  /^build that([\s!.,].*)?$/i,
  /^make it([\s!.,].*)?$/i,
  /^go ahead([\s!.,].*)?$/i,
  /^run it([\s!.,].*)?$/i,
  /^execute([\s!.,].*)?$/i,
  /^apply([\s!.,].*)?$/i,
  /^apply it([\s!.,].*)?$/i,
  /^apply the plan([\s!.,].*)?$/i,
  /^let'?s (do it|build|go|continue)([\s!.,].*)?$/i,
  /^(yes|ok|okay|sure|yep|yeah),?\s+(build|implement|do|continue|proceed|apply|go ahead)([\s!.,].*)?$/i,
]

/**
 * Returns true if the message is purely a continuation trigger
 * with no additional build-specific context of its own.
 */
export function isContinuationTrigger(message: string): boolean {
  const trimmed = message.trim()
  return CONTINUATION_TRIGGERS.some(re => re.test(trimmed))
}

// ── Store API ─────────────────────────────────────────────────────────────────

/**
 * Persist a build intent so continuation phrases can bind to it later.
 * Overwrites any previously stored intent for the project.
 *
 * @param projectId  Backenly project ID
 * @param intent     The raw user message or plan summary (truncated to 600 chars)
 * @param intentType 'build_request' | 'plan'
 */
export async function saveBuildIntent(
  projectId: string,
  intent: string,
  intentType: StickyIntentType,
): Promise<void> {
  // M1 Fix: snapshot current table count so continuation can detect schema drift.
  let tableCountAtSave = 0
  try {
    tableCountAtSave = await prisma.table.count({ where: { projectId } })
  } catch { /* non-fatal */ }

  const payload: StickyIntent = {
    intent: intent.slice(0, 2000),
    intentType,
    savedAt: new Date().toISOString(),
    executed: false,
    tableCountAtSave,
  }
  try {
    await prisma.projectPreference.upsert({
      where: { projectId_type_key: { projectId, type: PREF_TYPE, key: PREF_KEY } },
      create: {
        projectId,
        type: PREF_TYPE,
        key: PREF_KEY,
        value: JSON.stringify(payload),
        confidence: 1.0,
      },
      update: {
        value: JSON.stringify(payload),
        confidence: 1.0,
        lastSeen: new Date(),
      },
    })
  } catch (err) {
    console.error('[StickyIntentStore] Failed to save build intent:', err)
  }
}

/**
 * Retrieve the last stored build intent for a project.
 * Returns null if:
 *   - no intent stored
 *   - intent is already marked executed
 *   - intent is older than MAX_AGE_MS
 */
export async function getLastBuildIntent(projectId: string): Promise<StickyIntent | null> {
  try {
    const pref = await prisma.projectPreference.findUnique({
      where: { projectId_type_key: { projectId, type: PREF_TYPE, key: PREF_KEY } },
    })
    if (!pref) return null

    let payload: StickyIntent
    try {
      payload = JSON.parse(pref.value)
    } catch {
      return null
    }

    if (payload.executed) return null

    const age = Date.now() - new Date(payload.savedAt).getTime()
    if (age > MAX_AGE_MS) return null

    return payload
  } catch (err) {
    console.error('[StickyIntentStore] Failed to read build intent:', err)
    return null
  }
}

/**
 * Mark the current sticky intent as executed so future continuations
 * do not rebind to an already-completed goal.
 */
export async function markBuildIntentExecuted(projectId: string): Promise<void> {
  try {
    const pref = await prisma.projectPreference.findUnique({
      where: { projectId_type_key: { projectId, type: PREF_TYPE, key: PREF_KEY } },
    })
    if (!pref) return

    let payload: StickyIntent
    try {
      payload = JSON.parse(pref.value)
    } catch {
      return
    }

    payload.executed = true
    await prisma.projectPreference.update({
      where: { projectId_type_key: { projectId, type: PREF_TYPE, key: PREF_KEY } },
      data: { value: JSON.stringify(payload) },
    })
  } catch (err) {
    console.error('[StickyIntentStore] Failed to mark intent executed:', err)
  }
}

// ── AI Suggestion / Plan Item Store ──────────────────────────────────────────

const SUGGESTIONS_KEY = 'ai_suggestions'
const PLAN_ITEMS_KEY  = 'ai_plan_items'

/** Maximum age for saved suggestion/plan items before they're treated as stale (48h). */
const SUGGESTIONS_MAX_AGE_MS = 48 * 60 * 60 * 1000

interface AISuggestionPayload {
  items: string[]
  savedAt: string
}

/**
 * Persist the list of AI-generated suggestions (from background health or plan responses)
 * so that follow-ups like "implement the Potential Enhancements" can bind to them.
 */
export async function saveAISuggestions(projectId: string, items: string[]): Promise<void> {
  if (!items.length) return
  const payload: AISuggestionPayload = { items, savedAt: new Date().toISOString() }
  try {
    await prisma.projectPreference.upsert({
      where: { projectId_type_key: { projectId, type: PREF_TYPE, key: SUGGESTIONS_KEY } },
      create: { projectId, type: PREF_TYPE, key: SUGGESTIONS_KEY, value: JSON.stringify(payload), confidence: 1.0 },
      update: { value: JSON.stringify(payload), confidence: 1.0, lastSeen: new Date() },
    })
  } catch (err) {
    console.error('[StickyIntentStore] Failed to save AI suggestions:', err)
  }
}

/**
 * Retrieve AI-generated suggestion items saved for a project.
 * Returns null if none saved or if they are older than SUGGESTIONS_MAX_AGE_MS.
 */
export async function getAISuggestions(projectId: string): Promise<string[] | null> {
  try {
    const pref = await prisma.projectPreference.findUnique({
      where: { projectId_type_key: { projectId, type: PREF_TYPE, key: SUGGESTIONS_KEY } },
    })
    if (!pref) return null
    const payload: AISuggestionPayload = JSON.parse(pref.value)
    if (!payload?.items?.length) return null
    const age = Date.now() - new Date(payload.savedAt).getTime()
    if (age > SUGGESTIONS_MAX_AGE_MS) return null
    return payload.items
  } catch {
    return null
  }
}

/**
 * Persist the plan steps produced by generatePlanResponse so follow-ups like
 * "implement the suggestions" can bind to them even after a page reload.
 */
export async function saveAIPlanItems(projectId: string, steps: string[]): Promise<void> {
  if (!steps.length) return
  const payload: AISuggestionPayload = { items: steps, savedAt: new Date().toISOString() }
  try {
    await prisma.projectPreference.upsert({
      where: { projectId_type_key: { projectId, type: PREF_TYPE, key: PLAN_ITEMS_KEY } },
      create: { projectId, type: PREF_TYPE, key: PLAN_ITEMS_KEY, value: JSON.stringify(payload), confidence: 1.0 },
      update: { value: JSON.stringify(payload), confidence: 1.0, lastSeen: new Date() },
    })
  } catch (err) {
    console.error('[StickyIntentStore] Failed to save AI plan items:', err)
  }
}

/**
 * Retrieve AI plan steps saved for a project.
 * Returns null if none saved or stale.
 */
export async function getAIPlanItems(projectId: string): Promise<string[] | null> {
  try {
    const pref = await prisma.projectPreference.findUnique({
      where: { projectId_type_key: { projectId, type: PREF_TYPE, key: PLAN_ITEMS_KEY } },
    })
    if (!pref) return null
    const payload: AISuggestionPayload = JSON.parse(pref.value)
    if (!payload?.items?.length) return null
    const age = Date.now() - new Date(payload.savedAt).getTime()
    if (age > SUGGESTIONS_MAX_AGE_MS) return null
    return payload.items
  } catch {
    return null
  }
}

// ── Sticky Goal Resolver ──────────────────────────────────────────────────────

/**
 * Resolve a continuation trigger to its bound goal using the sticky store.
 *
 * Binding order:
 *   1. Last unfinished build_request
 *   2. Last generated plan
 *   3. null → caller must return "No unfinished build plan found."
 *
 * @returns enriched goal string, or null if nothing to bind to
 */
export async function resolveStickyGoal(
  projectId: string,
  triggerMessage: string,
): Promise<string | null> {
  const stored = await getLastBuildIntent(projectId)
  if (!stored) return null

  const label = stored.intentType === 'plan' ? 'planned' : 'requested'

  // M1 Fix: schema drift detection — if the table count changed significantly since the
  // intent was saved, inject a drift note so the agent doesn't re-create existing tables.
  let driftNote = ''
  try {
    const currentCount = await prisma.table.count({ where: { projectId } })
    const savedCount = stored.tableCountAtSave ?? 0
    const drift = Math.abs(currentCount - savedCount)
    if (drift >= 2) {
      driftNote = `\n\n[Schema drift: ${currentCount} tables now vs ${savedCount} when this intent was saved. Some steps may already be complete — check live state before recreating.]`
    }
  } catch { /* non-fatal */ }

  return `${stored.intent}\n\n[User confirmed: ${triggerMessage} — continuing ${label} build]${driftNote}`
}
