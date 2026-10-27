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
 * project's region.
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

export interface LoopResume {
  /** The request the stopped turn was working on, as the person put it. Empty when kept in its region. */
  request: string
  /** Titles of the changes that already landed, across every turn of this request. Empty when kept in its region. */
  applied: string[]
  /** Set for a project kept in another region: the request and titles stayed out of this row. */
  keptInRegion?: true
  /** Why the turn stopped, for the model's context. */
  architectFailed?: true
  resumeId?: string
  reason: string
  createdAt: string
  expiresAt: string
}

export type LoopStop = 'step_budget' | 'time_budget' | 'model_failure'

const STOP_REASON: Record<LoopStop, string> = {
  step_budget: 'it ran out of steps',
  time_budget: 'it stopped to keep time for verification',
  model_failure: 'the AI model failed partway',
}

export async function saveLoopResume(
  projectId: string,
  request: string,
  applied: string[],
  stop: LoopStop,
  architectFailed = false,
): Promise<void> {
  const now = Date.now()
  const resumeId = randomUUID()
  const quote = await quotesKeptHere(projectId)
  const marker: LoopResume = {
    request: quote ? request.slice(0, MAX_REQUEST_CHARS) : '',
    applied: quote ? applied.slice(-MAX_APPLIED) : [],
    ...(quote ? {} : { keptInRegion: true as const }),
    ...(architectFailed ? { architectFailed: true as const } : {}),
    resumeId,
    reason: STOP_REASON[stop],
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + TTL_MS).toISOString(),
  }

  if (!quote) {
    const bodies = await regionalBodiesFor(projectId)

    await bodies.set('conversation_message', `brain-loop-resume:${resumeId}`, {
      payload: {
        request: request.slice(0, MAX_REQUEST_CHARS),
        resumeId,
      },
    })
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

    if (m.keptInRegion) {
      if (!m.resumeId) return null

      const bodies = await regionalBodiesFor(projectId)
      const body = await bodies.get(
        'conversation_message',
        `brain-loop-resume:${m.resumeId}`,
      )

      const payload = body?.payload as
        | { request?: unknown; resumeId?: unknown }
        | undefined

      if (
        !payload ||
        typeof payload.request !== 'string' ||
        payload.resumeId !== m.resumeId
      ) {
        return null
      }

      m.request = payload.request
    }

    return m

  } catch {
    return null
  }
}


export async function clearLoopResume(projectId: string): Promise<void> {
  const marker = await prisma.projectPreference.findFirst({
    where: { projectId, type: PREF_TYPE, key: PREF_KEY },
  }).catch(() => null)

  let data: LoopResume | null = null
  try {
    if (marker) data = JSON.parse(marker.value) as LoopResume
  } catch {
    // The marker is invalid; still delete the project preference below.
  }

  if (data?.keptInRegion && data.resumeId) {
    const bodies = await regionalBodiesFor(projectId)

    await bodies.remove(
      'conversation_message',
      [`brain-loop-resume:${data.resumeId}`],
    ).catch((err) => {
      console.error('[Brain] could not clean up regional resume body:', err)
    })
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
      `Read the live backend state, then finish only what is still missing and verify it. ` +
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
    `Read the live backend state, then finish only what is still missing and verify it. ` +
    `Do not start a different task.`
  )
}
