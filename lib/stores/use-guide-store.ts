'use client'

/**
 * Getting Started guide state, shared by every surface that shows it: the
 * welcome and card on /app, the sidebar launcher and drawer in a project, the
 * connection strip on Connect, and the "Getting started" account-menu item.
 *
 * One store so they never disagree about a step, and one in-flight request at a
 * time however many of them are mounted. Each surface asks for the poll rate it
 * needs through useGuidePolling; the fastest request wins and all of them stop
 * while the tab is hidden.
 */

import { useEffect } from 'react'
import { create } from 'zustand'
import {
  dismissGuide,
  fetchGuide,
  reopenGuide,
  trackGuide,
  GuideRequestError,
  type GuideAction,
  type GuideState,
} from '@/lib/api/onboarding'
import type { StepId } from '@/lib/onboarding/guide'

interface GuideStore {
  state: GuideState | null
  /** 'loading' only before the first answer; later refreshes keep the last one on screen. */
  status: 'idle' | 'loading' | 'ready' | 'error'
  /** A failed hide/reopen, shown next to the control that caused it. */
  actionError: string | null
  /** Hidden for this session only, when the preference could not be saved. */
  hiddenLocally: boolean
  /** The drawer (project workspace) or expanded card (/app) is open. */
  panelOpen: boolean
  /** The /app card is folded to one line. A per-device layout choice, kept in the browser. */
  collapsed: boolean
  /** The guide asked /app to open its New project dialog (it was clicked where that dialog does not exist). */
  newProjectRequested: boolean
  busy: boolean
  fetchedAt: number
  refresh: () => Promise<void>
  hide: () => Promise<void>
  /** Show the guide again (reopening it if hidden) and open its panel. */
  open: () => Promise<void>
  setPanelOpen: (open: boolean) => void
  setCollapsed: (collapsed: boolean) => void
  setNewProjectRequested: (requested: boolean) => void
  track: (event: GuideAction, step?: StepId | null) => void
}

let inflight: Promise<void> | null = null

const COLLAPSE_KEY = 'backenly_guide_collapsed'

function readCollapsed(): boolean {
  try {
    return typeof window !== 'undefined' && window.localStorage.getItem(COLLAPSE_KEY) === '1'
  } catch {
    return false
  }
}

function writeCollapsed(collapsed: boolean) {
  try {
    window.localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0')
  } catch {
    /* storage blocked: the choice lasts until reload */
  }
}

export const useGuideStore = create<GuideStore>((set, get) => ({
  state: null,
  status: 'idle',
  actionError: null,
  hiddenLocally: false,
  panelOpen: false,
  collapsed: readCollapsed(),
  newProjectRequested: false,
  busy: false,
  fetchedAt: 0,

  refresh: () => {
    if (inflight) return inflight
    if (get().status === 'idle') set({ status: 'loading' })
    inflight = fetchGuide()
      .then((state) => set({ state, status: 'ready', fetchedAt: Date.now() }))
      .catch(() => set((s) => ({ status: s.state ? 'ready' : 'error', fetchedAt: Date.now() })))
      .finally(() => {
        inflight = null
      })
    return inflight
  },

  hide: async () => {
    set({ busy: true, actionError: null })
    try {
      const state = await dismissGuide()
      set({ state, panelOpen: false })
    } catch (err) {
      // Not saved (the migration has not run yet, or the network failed). Honour
      // the choice for this session rather than ignoring the click.
      const unsaved = err instanceof GuideRequestError && err.code === 'PREFERENCE_UNAVAILABLE'
      set({ hiddenLocally: true, panelOpen: false, actionError: unsaved ? null : 'Could not save that. Hidden for now.' })
    } finally {
      set({ busy: false })
    }
  },

  open: async () => {
    writeCollapsed(false)
    set({ hiddenLocally: false, actionError: null, collapsed: false })
    const current = get().state
    if (current?.visible) {
      set({ panelOpen: true })
      return
    }
    set({ busy: true })
    try {
      const state = await reopenGuide()
      set({ state, status: 'ready', panelOpen: true, fetchedAt: Date.now() })
    } catch {
      set({ actionError: 'Could not open Getting started. Try again.' })
    } finally {
      set({ busy: false })
    }
  },

  setPanelOpen: (panelOpen) => set({ panelOpen }),

  setCollapsed: (collapsed) => {
    writeCollapsed(collapsed)
    set({ collapsed })
  },

  setNewProjectRequested: (newProjectRequested) => set({ newProjectRequested }),

  track: (event, step) => trackGuide(event, step),
}))

/** The guide as a surface should render it: visible, with progress, and not hidden this session. */
export function useVisibleGuide() {
  return useGuideStore((s) => (s.state?.visible && s.state.progress && !s.hiddenLocally ? s.state : null))
}

// ── Polling ─────────────────────────────────────────────────────────────────

const requested = new Map<number, number>()
let timer: ReturnType<typeof setTimeout> | null = null
let nextId = 0

function fastest(): number | null {
  let min: number | null = null
  for (const ms of requested.values()) if (min === null || ms < min) min = ms
  return min
}

function schedule() {
  if (timer) clearTimeout(timer)
  timer = null
  const ms = fastest()
  if (ms === null || typeof document === 'undefined') return
  timer = setTimeout(async () => {
    if (!document.hidden) await useGuideStore.getState().refresh()
    schedule()
  }, ms)
}

let visibilityBound = false
function bindVisibility() {
  if (visibilityBound || typeof document === 'undefined') return
  visibilityBound = true
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && requested.size > 0) {
      useGuideStore.getState().refresh()
      schedule()
    }
  })
}

/**
 * Keep the guide fresh while this component is mounted. `intervalMs` null means
 * "load once, no polling". Returns nothing; read state from useGuideStore.
 */
export function useGuidePolling(intervalMs: number | null) {
  useEffect(() => {
    const store = useGuideStore.getState()
    // Stale after a few seconds: a surface mounting on navigation should not
    // show a step that finished while the user was on another page.
    if (Date.now() - store.fetchedAt > 3_000) store.refresh()
    if (intervalMs === null) return
    bindVisibility()
    const id = nextId++
    requested.set(id, intervalMs)
    schedule()
    return () => {
      requested.delete(id)
      schedule()
    }
  }, [intervalMs])
}
