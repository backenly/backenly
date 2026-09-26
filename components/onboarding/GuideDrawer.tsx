'use client'

/**
 * The guide inside a project: a compact launcher at the foot of the sidebar,
 * and the drawer it opens. The launcher is the "persistent checklist": always
 * there while the guide is, never in the way of the page.
 *
 * The drawer is a modal dialog: focus moves into it, Tab stays inside, Escape
 * and the backdrop close it, and focus returns to whatever opened it.
 */

import { useEffect, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Compass, X } from 'lucide-react'
import { useGuidePolling, useGuideStore, useVisibleGuide } from '@/lib/stores/use-guide-store'
import { STEP_COPY } from './guide-copy'
import { GuidePanel, GuideProgressBar } from './GuidePanel'
import { guidePollMs } from './poll'
import { Hairline } from './ui'

export function GuideLauncher() {
  const guide = useVisibleGuide()
  const setPanelOpen = useGuideStore((s) => s.setPanelOpen)
  const panelOpen = useGuideStore((s) => s.panelOpen)
  // Loads once either way; keeps polling only while there is a guide to show.
  useGuidePolling(panelOpen || !guide ? null : guidePollMs(guide.progress, false))

  const progress = guide?.progress
  if (!progress) return null
  const next = progress.currentStepId ? STEP_COPY[progress.currentStepId].title : 'You’re set up'

  return (
    <button
      type="button"
      onClick={() => setPanelOpen(true)}
      aria-haspopup="dialog"
      aria-expanded={panelOpen}
      className="relative w-full overflow-hidden rounded-lg border border-white/[0.08] bg-[#16171d] px-3 py-2.5 text-left transition-colors hover:border-white/[0.14] focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/35"
    >
      <Hairline />
      <span className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-[12px] font-medium text-zinc-200">
          <Compass className="h-3.5 w-3.5 text-violet-300/80" aria-hidden />
          Getting started
        </span>
        <span className="font-mono text-[11px] tabular-nums text-zinc-500">
          {progress.completed}/{progress.total}
        </span>
      </span>
      <GuideProgressBar completed={progress.completed} total={progress.total} className="mt-2" />
      <span className="mt-2 block truncate text-[11px] text-zinc-500">
        {progress.currentStepId ? 'Next: ' : ''}
        <span className="text-zinc-300">{next}</span>
      </span>
    </button>
  )
}

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea, input, select, summary, [tabindex]:not([tabindex="-1"])'

export function GuideDrawer() {
  const guide = useVisibleGuide()
  const open = useGuideStore((s) => s.panelOpen)
  const setPanelOpen = useGuideStore((s) => s.setPanelOpen)
  const panelRef = useRef<HTMLDivElement>(null)
  useGuidePolling(open ? guidePollMs(guide?.progress, true) : null)

  const progress = guide?.progress
  const isOpen = open && !!progress
  const close = () => setPanelOpen(false)

  useEffect(() => {
    if (!isOpen) return
    const opener = document.activeElement as HTMLElement | null
    const frame = requestAnimationFrame(() => panelRef.current?.focus())
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        setPanelOpen(false)
        return
      }
      if (e.key !== 'Tab' || !panelRef.current) return
      const items = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null,
      )
      if (items.length === 0) return
      const first = items[0]
      const last = items[items.length - 1]
      if (e.shiftKey && (document.activeElement === first || document.activeElement === panelRef.current)) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener('keydown', onKey)
      opener?.focus?.()
    }
  }, [isOpen, setPanelOpen])

  return (
    <AnimatePresence>
      {isOpen && progress && (
        <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-labelledby="guide-drawer-heading">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="absolute inset-0 bg-black/60"
            onClick={close}
            aria-hidden
          />
          <motion.div
            ref={panelRef}
            tabIndex={-1}
            initial={{ x: 24, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: 24, opacity: 0 }}
            transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
            className="absolute inset-y-0 right-0 flex w-full max-w-[480px] flex-col border-l border-white/[0.12] bg-[#16171d] shadow-[0_12px_32px_-16px_rgba(0,0,0,0.85)] focus:outline-none"
          >
            <Hairline />
            <div className="flex-1 overflow-y-auto px-5 pb-8 pt-5">
              <GuidePanel
                progress={progress}
                variant="drawer"
                onNavigate={close}
                headingId="guide-drawer-heading"
                headerExtra={
                  <button
                    type="button"
                    onClick={close}
                    aria-label="Close Getting started"
                    className="inline-flex h-7 w-7 items-center justify-center rounded-md text-zinc-500 transition-colors hover:bg-white/[0.04] hover:text-zinc-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/35"
                  >
                    <X className="h-4 w-4" aria-hidden />
                  </button>
                }
              />
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  )
}

/**
 * "Getting started" in an account menu: how a hidden guide comes back. Reopens
 * it if it was hidden, then opens it where the current page shows it.
 */
export function GettingStartedMenuItem({ onSelect }: { onSelect: () => void }) {
  const open = useGuideStore((s) => s.open)
  return (
    <button
      type="button"
      onClick={async () => {
        onSelect()
        await open()
      }}
      className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-zinc-300 transition-colors hover:bg-white/[0.05] hover:text-zinc-50"
    >
      <Compass className="h-3.5 w-3.5" aria-hidden />
      <span className="text-[12.5px] font-medium">Getting started</span>
    </button>
  )
}
