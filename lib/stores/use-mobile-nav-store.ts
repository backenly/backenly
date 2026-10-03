'use client'

import { create } from 'zustand'

interface MobileNavState {
  isOpen: boolean
  setOpen: (open: boolean) => void
  toggle: () => void
  close: () => void
}

export const useMobileNavStore = create<MobileNavState>((set) => ({
  isOpen: false,
  setOpen: (isOpen) => set({ isOpen }),
  toggle: () => set((state) => ({ isOpen: !state.isOpen })),
  close: () => set({ isOpen: false }),
}))
