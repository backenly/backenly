'use client'

import { useEffect, useSyncExternalStore } from 'react'

/**
 * useAgentConnection: is the signed-in user's coding agent connected to this
 * project over MCP?
 *
 * Every console section used to end its empty state in "Connect your agent",
 * unconditionally, and the top bar's primary action said the same, so a user
 * whose agent was already wired in was sent back to the Connect page from every
 * section. Each of those surfaces reads this instead.
 *
 * The answer comes from GET /api/projects/[id]/mcp/status, whose rule is
 * lib/mcp/agent-connection.ts. It is fetched once per project and shared by
 * every component that asks, since the top bar and the page under it both do,
 * and it is asked again when the window regains focus or becomes visible: the
 * usual way it changes is the user connecting their agent in another window
 * and coming back.
 *
 * `status`:
 *   - 'loading'      : no answer yet. Surfaces show neither state.
 *   - 'connected'    : surfaces drop the Connect step.
 *   - 'disconnected' : surfaces offer it. Also the answer when the first
 *                      request fails, which is what every surface did before
 *                      this existed. A later failure keeps the last answer.
 */

export type AgentConnectionStatus = 'loading' | 'connected' | 'disconnected'

export interface AgentConnectionState {
  status: AgentConnectionStatus
  /**
   * It called recently, as the server judged when it answered
   * (lib/mcp/agent-connection.ts ACTIVE_WITHIN_MS). Connected and not active is
   * idle: set up, so nothing asks to connect it again, but no green dot.
   */
  active: boolean
  /** ISO time the agent last reached Backenly. Null unless connected. */
  lastSeenAt: string | null
  /** The key's label or the OAuth client's name, when there is one. */
  client: string | null
}

/** "just now", "5 minutes ago", "6 days ago": how long since the agent's last call. */
export function lastCallAgo(iso: string, now: number = Date.now()): string {
  const minutes = Math.floor((now - new Date(iso).getTime()) / 60_000)
  if (minutes < 1) return 'just now'
  const [n, unit]: [number, string] =
    minutes < 60 ? [minutes, 'minute'] : minutes < 1440 ? [Math.floor(minutes / 60), 'hour'] : [Math.floor(minutes / 1440), 'day']
  return `${n} ${unit}${n === 1 ? '' : 's'} ago`
}

export interface UseAgentConnectionResult extends AgentConnectionState {
  connected: boolean
  /** Offer "Connect your agent": the answer is in and it is no. */
  needsConnect: boolean
}

const LOADING: AgentConnectionState = { status: 'loading', active: false, lastSeenAt: null, client: null }
const DISCONNECTED: AgentConnectionState = { status: 'disconnected', active: false, lastSeenAt: null, client: null }

/** An answer this recent is reused when another surface mounts. */
const FRESH_MS = 30_000

interface Entry {
  state: AgentConnectionState
  fetchedAt: number
  inflight: Promise<void> | null
}

const entries = new Map<string, Entry>()
const listeners = new Set<() => void>()

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function sameAnswer(a: AgentConnectionState, b: AgentConnectionState): boolean {
  return a.status === b.status && a.active === b.active && a.lastSeenAt === b.lastSeenAt && a.client === b.client
}

function parse(body: unknown): AgentConnectionState {
  const b = body as { connected?: unknown; active?: unknown; lastSeenAt?: unknown; client?: unknown } | null
  if (b?.connected !== true) return DISCONNECTED
  return {
    status: 'connected',
    active: b.active === true,
    lastSeenAt: typeof b.lastSeenAt === 'string' ? b.lastSeenAt : null,
    client: typeof b.client === 'string' && b.client ? b.client : null,
  }
}

/**
 * Ask the server again, or join the request already in flight. Call it after
 * anything that can change the answer, such as revoking a key.
 */
export function refreshAgentConnection(projectId: string): Promise<void> {
  const current = entries.get(projectId)
  if (current?.inflight) return current.inflight

  const previous = current?.state ?? LOADING
  // Registered before the request starts: should it settle synchronously (a
  // fetch that throws on the spot), its result replaces this entry rather than
  // being overwritten by it.
  const pending: Entry = { state: previous, fetchedAt: current?.fetchedAt ?? 0, inflight: null }
  entries.set(projectId, pending)
  pending.inflight = (async () => {
    let next: AgentConnectionState | null = null
    try {
      const res = await fetch(`/api/projects/${projectId}/mcp/status`, { credentials: 'include', cache: 'no-store' })
      if (res.ok) next = parse(await res.json())
    } catch {
      // Network failure: handled below like any other unanswered request.
    }
    // An unanswered refresh keeps the last answer, so a dropped request never
    // flips a connected user back to "Connect your agent". With no answer at
    // all, offer the step, as every surface did before this existed. The same
    // answer keeps the same object, so a refresh on focus re-renders nothing.
    const state = next
      ? sameAnswer(next, previous) ? previous : next
      : previous.status === 'loading' ? DISCONNECTED : previous
    entries.set(projectId, { state, fetchedAt: Date.now(), inflight: null })
    listeners.forEach((l) => l())
  })()
  return pending.inflight
}

/** The answer as it stands, without asking for one. */
export function readAgentConnection(projectId: string): AgentConnectionState {
  return entries.get(projectId)?.state ?? LOADING
}

/** Forget every answer. For tests, which share this module across cases. */
export function clearAgentConnectionCache(): void {
  entries.clear()
  listeners.forEach((l) => l())
}

export function useAgentConnection(projectId: string | null | undefined): UseAgentConnectionResult {
  const state = useSyncExternalStore(
    subscribe,
    // Without a project there is nothing to ask about: offer the step, as the
    // surfaces did before.
    () => (projectId ? readAgentConnection(projectId) : DISCONNECTED),
    () => LOADING,
  )

  useEffect(() => {
    if (!projectId) return
    const entry = entries.get(projectId)
    if (!entry || (!entry.inflight && Date.now() - entry.fetchedAt > FRESH_MS)) {
      void refreshAgentConnection(projectId)
    }
    const onFocus = () => {
      void refreshAgentConnection(projectId)
    }
    const onVisible = () => {
      if (!document.hidden) void refreshAgentConnection(projectId)
    }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [projectId])

  return {
    ...state,
    connected: state.status === 'connected',
    needsConnect: state.status === 'disconnected',
  }
}
