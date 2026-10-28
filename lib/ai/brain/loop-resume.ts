/**
 * LOOP RESUME — "continue" AFTER AN AGENT-LOOP TURN STOPPED UNFINISHED
 * ====================================================================
 * An agent-loop turn that runs out of steps, out of time budget, or loses its
 * model after applying changes tells the caller to say "continue". Only the
 * blueprint executor saved anything to resume from, so "continue" reached the
 * classifier as CONFIRM with nothing pending and got "nothing is waiting".
 *
 * This is the resume point for the loop: the request that was being worked on
 * and what already landed. It is the original request, saved at the moment the
 * turn stopped, not a search of the history for something that looks like it.
 *
 * Storage: ProjectPreference (type='pending_plan', key='loop_resume'), one per
 * project, with the same 30-minute TTL as the other resumable states so a stale
 * "continue" the next day cannot pick up work the person has forgotten.
 *
 * That row is in the home region's platform database. A project kept in another
 * region keeps its words there (lib/data-plane/residency.ts), so its marker
 * stores neither the request nor the applied titles, which can name an end
 * user; the resumed turn finds both in the conversation, which stays in the
 * project's region. The one reader that needs the request itself is the
 * architect's retry after it failed on the build (runBrain), so for that marker
 * alone the request is kept in the region, as a `loop_resume` body: one per
 * project, written before the marker, removed with it, and pruned with the
 * region's logs if the marker lapses or is replaced first. The marker names the
 * body it was saved with (`resumeId`), so a body an older marker left is never
 * read as this one's.
 */

import { prisma } from '@/lib/db/prisma'
import { quotesKeptHere } from '@/lib/data-plane/residency'
import { regionalBodiesFor } from '@/lib/data-plane/regional-bodies'
import { randomUUID } from 'crypto'

const PREF_TYPE = 'pending_plan'
const PREF_KEY = 'loop_resume'
const TTL_MS = 30 * 60 * 1000
/** Bounds what one marker can carry, so a long run cannot grow the row without limit. */
const MAX_REQUEST_CHARS = 8000
const MAX_APPLIED = 200
/** Where a project kept in another region keeps the request its architect retry needs. */
const REGIONAL_KIND = 'loop_resume'

export interface LoopResume {
  /** The request the stopped turn was working on, as the person put it. Empty when kept in its region. */
  request: string
  /** Titles of the changes that already landed, across every turn of this request. Empty when kept in its region. */
  applied: string[]
  /** Set for a project kept in another region: the request and titles stayed out of this row. */
  keptInRegion?: true
  /** The architect failed on the build this turn started, so "continue" tries its design again (runBrain). */
  architectFailed?: true
  /** Kept in its region with architectFailed: names the request written there, so a stale one is never read. */
  resumeId?: string
  /** Why the turn stopped, for the model's context. */
  reason: string
  createdAt: string
  expiresAt: string
}

export type LoopStop = 'step_budget' | 'time_budget' | 'model_failure' | 'interrupted'

const STOP_REASON: Record<LoopStop, string> = {
  step_budget: 'it ran out of steps',
  time_budget: 'it stopped to keep time for verification',
  model_failure: 'the AI model failed partway',
  // The process running it stopped (a deploy, a crash): lib/ai/brain/runs.ts.
  interrupted: 'Backenly restarted while it was running',
}

export async function saveLoopResume(
  projectId: string,
  request: string,
  applied: string[],
  stop: LoopStop,
  architectFailed = false,
): Promise<void> {
  const now = Date.now()
  const quote = await quotesKeptHere(projectId)
  // Written before the marker that names it, so a marker never names nothing.
  // A region that cannot take it costs only the retry: the marker is saved
  // without it and resumes the loop.
  let resumeId: string | undefined
  if (!quote && architectFailed) {
    const id = randomUUID()
    const payload = { request: request.slice(0, MAX_REQUEST_CHARS), resumeId: id }
    resumeId = await regionalBodiesFor(projectId)
      .then((bodies) => bodies.set(REGIONAL_KIND, projectId, { payload }))
      .then(
        () => id,
        (err) => {
          console.error('[Brain] could not keep the resume request in its region:', err)
          return undefined
        },
      )
  }
  const marker: LoopResume = {
    request: quote ? request.slice(0, MAX_REQUEST_CHARS) : '',
    applied: quote ? applied.slice(-MAX_APPLIED) : [],
    ...(quote ? {} : { keptInRegion: true as const }),
    ...(architectFailed ? { architectFailed: true as const } : {}),
    ...(resumeId ? { resumeId } : {}),
    reason: STOP_REASON[stop],
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + TTL_MS).toISOString(),
  }
  await prisma.projectPreference.upsert({
    where: { projectId_type_key: { projectId, type: PREF_TYPE, key: PREF_KEY } },
    create: { projectId, type: PREF_TYPE, key: PREF_KEY, value: JSON.stringify(marker), confidence: 1 },
    update: { value: JSON.stringify(marker), confidence: 1, lastSeen: new Date() },
  })
}

export async function loadLoopResume(projectId: string): Promise<LoopResume | null> {
  const pref = await prisma.projectPreference
    .findUnique({ where: { projectId_type_key: { projectId, type: PREF_TYPE, key: PREF_KEY } } })
    .catch(() => null)
  if (!pref) return null
  try {
    const m = JSON.parse(pref.value) as LoopResume
    if (typeof m.request !== 'string') return null
    if (!m.request.trim() && m.keptInRegion !== true) return null
    if (!Array.isArray(m.applied)) m.applied = []
    if (Date.parse(m.expiresAt) < Date.now()) return null
    if (m.keptInRegion && m.resumeId) m.request = await requestKeptInRegion(projectId, m.resumeId)
    return m
  } catch {
    return null
  }
}

/**
 * The request a marker kept in its region names, for the architect's retry.
 * Unreadable or replaced, it is empty: the marker still resumes the loop, which
 * reads the conversation instead.
 */
async function requestKeptInRegion(projectId: string, resumeId: string): Promise<string> {
  try {
    const body = await (await regionalBodiesFor(projectId)).get(REGIONAL_KIND, projectId)
    const payload = body?.payload as { request?: unknown; resumeId?: unknown } | undefined
    return payload?.resumeId === resumeId && typeof payload.request === 'string' ? payload.request : ''
  } catch (err) {
    console.error('[Brain] could not read the resume request kept in its region:', err)
    return ''
  }
}

export async function clearLoopResume(projectId: string): Promise<void> {
  const pref = await prisma.projectPreference
    .findUnique({ where: { projectId_type_key: { projectId, type: PREF_TYPE, key: PREF_KEY } } })
    .catch(() => null)
  let keptInRegion = false
  try {
    keptInRegion = !!pref && (JSON.parse(pref.value) as LoopResume).keptInRegion === true
  } catch {
    // An unreadable marker is still deleted below.
  }
  // A request the marker kept in its region goes with it.
  if (keptInRegion) {
    await regionalBodiesFor(projectId)
      .then((bodies) => bodies.remove(REGIONAL_KIND, [projectId]))
      .catch((err) => console.error('[Brain] could not remove the resume request kept in its region:', err))
  }
  await prisma.projectPreference
    .deleteMany({ where: { projectId, type: PREF_TYPE, key: PREF_KEY } })
    .catch(() => {})
}

/**
 * The message the model is sent in place of a bare "continue". It carries the
 * original request and the applied list so finished work is not redone; the
 * person's own message is still what is stored in the conversation.
 */
export function resumePrompt(marker: LoopResume, said: string): string {
  if (marker.keptInRegion) {
    return (
      `The person said "${said.trim().slice(0, 200)}" to continue their previous request, which stopped unfinished because ${marker.reason}. ` +
      `That request and the changes it already made are in the conversation above; they stay in this project's region, so they are not repeated here.\n\n` +
      `The live backend state is given to you above, so compare it with the request and finish only what is still missing, then verify it. ` +
      `Do not redo what is already there, and do not start a different task.`
    )
  }
  const applied = marker.applied.length
    ? `ALREADY APPLIED — do not redo any of it:\n${marker.applied.map((t) => `  • ${t}`).join('\n')}`
    : 'Nothing was applied before it stopped.'
  return (
    `The person said "${said.trim().slice(0, 200)}" to continue the request below, which stopped unfinished because ${marker.reason}.\n\n` +
    `ORIGINAL REQUEST:\n${marker.request}\n\n` +
    `${applied}\n\n` +
    `The live backend state is given to you above, so compare it with the request and finish only what is still missing, then verify it. ` +
    `Do not start a different task.`
  )
}
