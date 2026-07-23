'use client'

/**
 * Assistant panel state — shared by TopBar (toggle button + ⌘J) and
 * ProjectShell (content padding + panel mount).
 *
 * The Assistant is a Q&A helper, not the product's front door: it answers
 * platform questions and points at the right section, and it never builds or
 * mutates anything. Building happens through the user's coding agent over MCP
 * (Connect) or the Database section UI. Accordingly it defaults CLOSED and
 * only opens when the user asks for it; the choice is persisted per project.
 */

import { create } from 'zustand'

const keyFor = (projectId: string) => `backenly_assistant_${projectId}`

interface AssistantState {
  projectId: string | null
  open: boolean
  /** Load the persisted open state for a project. No-op if already hydrated. */
  hydrate: (projectId: string) => void
  setOpen: (open: boolean) => void
  toggle: () => void
}

export const useAssistantStore = create<AssistantState>((set, get) => ({
  projectId: null,
  open: false,

  hydrate: (projectId) => {
    if (!projectId || get().projectId === projectId) return
    let open = false
    try {
      open = localStorage.getItem(keyFor(projectId)) === '1'
    } catch {
      /* SSR / storage blocked — keep default */
    }
    set({ projectId, open })
  },

  setOpen: (open) => {
    const { projectId } = get()
    if (projectId) {
      try {
        localStorage.setItem(keyFor(projectId), open ? '1' : '0')
      } catch {
        /* non-fatal */
      }
    }
    set({ open })
  },

  toggle: () => get().setOpen(!get().open),
}))
