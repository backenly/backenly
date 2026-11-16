'use client'

import { useEffect, useSyncExternalStore } from 'react'
import { sharedRead } from '@/lib/client/shared-read'

/**
 * useWaitingCount: how many things in this project wait on a person's
 * decision.
 *
 * One count for every surface that says so: the top bar's inbox (its amber ◆),
 * Overview's "Waiting on you" and the heading of Autonomy's queue. They counted
 * three ways before (the Overview loop left agent calls out, the inbox read a
 * truncated preview), so a parked call could read 0 on one page and 1 on the
 * next. Counted from GET /api/projects/[id]/health, uncapped:
 *
 *   held          findings Backenly is holding for approval (needsAttention;
 *                 the preview's pending rows only from a server without it)
 *   agentCalls    calls the coding agent parked for approval (agentApprovalsPending)
 *   architecture  architecture changes Backenly prepared (architectureRequestsPending)
 *
 * One read and one 30 s poll per project however many surfaces ask, through
 * sharedRead, so it also joins a page's own /health read in the same moment.
 * Asked again when the window regains focus, and on demand after a decision
 * (refreshWaitingCount). A failed read keeps the last count rather than
 * reading as "nothing waiting"; before any count, `total` is null and
 * `error` says whether the first read failed.
 */

export interface WaitingParts {
  held: number
  agentCalls: number
  architecture: number
}

export interface WaitingCount extends WaitingParts {
  /** Everything waiting on a person. Null until the first count. */
  total: number | null
  loading: boolean
  /** The last read failed. With a total, that total is the last good one. */
  error: boolean
}

export const WAITING_POLL_MS = 30_000

const LOADING: WaitingCount = { total: null, held: 0, agentCalls: 0, architecture: 0, loading: true, error: false }
const NO_PROJECT: WaitingCount = { ...LOADING, loading: false }

const count = (n: unknown): number => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0)

/** The count rule, from the `data` of a /health answer. Null when it is not one. */
export function waitingFromHealth(data: unknown): (WaitingParts & { total: number }) | null {
  if (!data || typeof data !== 'object') return null
  const d = data as {
    needsAttention?: unknown
    findings?: Array<{ status?: unknown }>
    agentApprovalsPending?: unknown
    architectureRequestsPending?: unknown
  }
  // needsAttention is counted from the full set. The findings array is a
  // 50-row preview, read only from a server that predates the field.
  const held =
    typeof d.needsAttention === 'number'
      ? count(d.needsAttention)
      : Array.isArray(d.findings)
        ? d.findings.filter((f) => f?.status === 'pending_approval').length
        : 0
  const agentCalls = count(d.agentApprovalsPending)
  const architecture = count(d.architectureRequestsPending)
  return { held, agentCalls, architecture, total: held + agentCalls + architecture }
}

interface Entry {
  state: WaitingCount
  inflight: Promise<void> | null
  watchers: number
  timer: ReturnType<typeof setInterval> | null
}

const entries = new Map<string, Entry>()
const listeners = new Set<() => void>()
const subscribers = new Map<string, (listener: () => void) => () => void>()

function entryFor(projectId: string): Entry {
  let entry = entries.get(projectId)
  if (!entry) {
    entry = { state: LOADING, inflight: null, watchers: 0, timer: null }
    entries.set(projectId, entry)
  }
  return entry
}

function emit() {
  listeners.forEach((l) => l())
}

const sameCount = (a: WaitingCount, b: WaitingCount) =>
  a.total === b.total &&
  a.held === b.held &&
  a.agentCalls === b.agentCalls &&
  a.architecture === b.architecture &&
  a.loading === b.loading &&
  a.error === b.error

/**
 * Count again, or join the count already on its way. Call it with
 * `{ fresh: true }` after a decision, so the inbox clears at once.
 */
export function refreshWaitingCount(projectId: string, opts: { fresh?: boolean } = {}): Promise<void> {
  const entry = entryFor(projectId)
  if (entry.inflight) return entry.inflight
  entry.inflight = (async () => {
    let parts: ReturnType<typeof waitingFromHealth> = null
    try {
      const res = await sharedRead<{ data?: unknown }>(`/api/projects/${projectId}/health`, { fresh: opts.fresh })
      if (res.ok) parts = waitingFromHealth(res.data?.data)
    } catch {
      // A dropped request: handled below like any other unanswered read.
    }
    const previous = entry.state
    const next: WaitingCount = parts
      ? { ...parts, loading: false, error: false }
      : { ...previous, loading: false, error: true }
    // The same answer keeps the same object, so a poll that changes nothing re-renders nothing.
    if (!sameCount(previous, next)) entry.state = next
    entry.inflight = null
    emit()
  })()
  return entry.inflight
}

/** The count as it stands, without asking for one. */
export function readWaitingCount(projectId: string): WaitingCount {
  return entries.get(projectId)?.state ?? LOADING
}

/** Forget every count and stop every poll. For tests, which share this module across cases. */
export function clearWaitingCountCache(): void {
  for (const entry of entries.values()) if (entry.timer) clearInterval(entry.timer)
  entries.clear()
  emit()
}

/**
 * Subscribing to a project starts its one poll; the last surface to leave
 * stops it. Kept per project so React sees the same function every render.
 */
function subscribeTo(projectId: string): (listener: () => void) => () => void {
  let subscribe = subscribers.get(projectId)
  if (!subscribe) {
    subscribe = (listener) => {
      listeners.add(listener)
      const entry = entryFor(projectId)
      entry.watchers += 1
      if (!entry.timer) entry.timer = setInterval(() => void refreshWaitingCount(projectId), WAITING_POLL_MS)
      return () => {
        listeners.delete(listener)
        const current = entries.get(projectId)
        if (!current) return
        current.watchers = Math.max(0, current.watchers - 1)
        if (current.watchers === 0 && current.timer) {
          clearInterval(current.timer)
          current.timer = null
        }
      }
    }
    subscribers.set(projectId, subscribe)
  }
  return subscribe
}

const subscribeNothing = () => () => {}

export function useWaitingCount(projectId: string | null | undefined): WaitingCount {
  const state = useSyncExternalStore(
    projectId ? subscribeTo(projectId) : subscribeNothing,
    () => (projectId ? readWaitingCount(projectId) : NO_PROJECT),
    () => LOADING,
  )

  useEffect(() => {
    if (!projectId) return
    const entry = entries.get(projectId)
    if (!entry || (entry.state.loading && !entry.inflight) || (!entry.inflight && entry.state.error)) {
      void refreshWaitingCount(projectId)
    }
    const onFocus = () => void refreshWaitingCount(projectId)
    const onVisible = () => {
      if (!document.hidden) void refreshWaitingCount(projectId)
    }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [projectId])

  return state
}
