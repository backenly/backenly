'use client'

/**
 * The guide on /app, in its two shapes.
 *
 *   GettingStartedWelcome  an account with no project yet. Replaces the empty
 *                          project grid: this is the first screen a new user
 *                          sees, so it carries the whole mental model (the
 *                          workflow diagram) and exactly one action.
 *   GettingStartedCard     once a project exists. Sits above the project grid,
 *                          collapsible to one line, hideable.
 */

import { useEffect, useRef } from 'react'
import { ArrowRight, BookOpen, ChevronDown, ChevronUp, Plus } from 'lucide-react'
import { CLOUD_CONTROL_PLANE } from '@cloud/control-plane'
import { useGuidePolling, useGuideStore, useVisibleGuide } from '@/lib/stores/use-guide-store'
import type { GuideProgress } from '@/lib/onboarding/guide'
import { STEP_COPY } from './guide-copy'
import { GuideChecklist, GuidePanel, GuideProgressBar } from './GuidePanel'
import { WorkflowDiagram } from './WorkflowDiagram'
import { guidePollMs } from './poll'

export function GettingStartedWelcome({
  progress,
  onCreateProject,
}: {
  progress: GuideProgress
  onCreateProject: () => void
}) {
  // A "Getting started" request from the account menu is answered by this
  // screen being here; clear it so it cannot pop the drawer open later.
  const panelOpen = useGuideStore((s) => s.panelOpen)
  const setPanelOpen = useGuideStore((s) => s.setPanelOpen)
  const track = useGuideStore((s) => s.track)
  useEffect(() => {
    if (panelOpen) setPanelOpen(false)
  }, [panelOpen, setPanelOpen])

  return (
    <section aria-labelledby="welcome-heading" className="w-full max-w-6xl py-4 sm:py-6">
      <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-violet-300/80">Welcome to Backenly</p>
      <h2 id="welcome-heading" className="mt-2 text-[22px] font-semibold tracking-[-0.015em] text-white sm:text-[26px]">
        Build your backend from your coding agent.
      </h2>
      <p className="mt-2 max-w-2xl text-[13.5px] leading-relaxed text-zinc-300">
        Your agent builds it through Backenly&apos;s MCP server. Backenly provisions and runs the backend, and keeps
        watching it after you publish.
      </p>
      <p className="mt-1.5 max-w-2xl text-[12.5px] leading-relaxed text-zinc-500">
        Describe what you want to your agent, not to this dashboard. Come here to review it, publish it and see what
        Backenly is doing.
      </p>

      <div className="mt-6">
        <WorkflowDiagram />
      </div>

      <div className="mt-6 overflow-hidden rounded-xl border border-white/[0.07] bg-[#16171d] shadow-[0_16px_44px_-28px_rgba(0,0,0,0.9)]">
        <div className="grid gap-0 md:grid-cols-[minmax(0,280px)_minmax(0,1fr)]">
          <div className="order-last border-t border-white/[0.06] p-4 md:order-none md:border-r md:border-t-0">
            <p className="mb-2 flex items-center justify-between px-2.5 text-[11.5px] text-zinc-500">
              <span className="font-medium text-zinc-300">Getting started</span>
              <span className="font-mono tabular-nums">
                {progress.completed}/{progress.total}
              </span>
            </p>
            <GuideProgressBar completed={progress.completed} total={progress.total} className="mx-2.5 mb-3" />
            <GuideChecklist progress={progress} selected={progress.currentStepId} />
          </div>

          <div className="flex flex-col justify-between gap-6 p-5">
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-600">Start here</p>
              <h3 className="mt-1 text-[15px] font-semibold tracking-[-0.01em] text-zinc-50">{STEP_COPY.project.title}</h3>
              <p className="mt-1 max-w-lg text-[12.5px] leading-relaxed text-zinc-400">{STEP_COPY.project.body}</p>
              {CLOUD_CONTROL_PLANE ? (
                <div className="mt-4 flex flex-wrap items-center gap-3">
                  <button
                    type="button"
                    onClick={() => {
                      track('cta_clicked', 'project')
                      onCreateProject()
                    }}
                    className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-white px-3.5 text-[13px] font-semibold text-black transition-colors hover:bg-zinc-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/35"
                  >
                    <Plus className="h-4 w-4" aria-hidden />
                    Create your first project
                  </button>
                  <span className="text-[11.5px] text-zinc-500">Next, you&apos;ll connect your agent to it.</span>
                </div>
              ) : (
                <p className="mt-4 max-w-lg rounded-lg border border-white/[0.07] bg-white/[0.02] px-3 py-2.5 text-[12px] leading-relaxed text-zinc-400">
                  This deployment hosts one project. Run{' '}
                  <code className="rounded bg-white/[0.06] px-1 py-0.5 font-mono text-[11px] text-zinc-200">npm run bootstrap</code>{' '}
                  on the server, then reload this page.
                </p>
              )}
            </div>
            <a
              href="/resources/how-backenly-works"
              target="_blank"
              rel="noreferrer"
              className="inline-flex w-fit items-center gap-1.5 text-[11.5px] text-zinc-500 transition-colors hover:text-zinc-200"
            >
              <BookOpen className="h-3.5 w-3.5" aria-hidden />
              How Backenly works
              <ArrowRight className="h-3 w-3" aria-hidden />
            </a>
          </div>
        </div>
      </div>
    </section>
  )
}

export function GettingStartedCard({ onCreateProject }: { onCreateProject: () => void }) {
  const guide = useVisibleGuide()
  const panelOpen = useGuideStore((s) => s.panelOpen)
  const setPanelOpen = useGuideStore((s) => s.setPanelOpen)
  const collapsed = useGuideStore((s) => s.collapsed)
  const setCollapsed = useGuideStore((s) => s.setCollapsed)
  const ref = useRef<HTMLElement>(null)
  useGuidePolling(guide ? guidePollMs(guide.progress, !collapsed) : null)

  // "Getting started" from the account menu lands here. open() has already
  // expanded the card; bring it into view once it is on screen.
  useEffect(() => {
    if (!panelOpen || !guide || !ref.current) return
    ref.current.scrollIntoView({ behavior: 'smooth', block: 'start' })
    ref.current.focus({ preventScroll: true })
    setPanelOpen(false)
  }, [panelOpen, guide, setPanelOpen])

  const progress = guide?.progress
  if (!progress) return null
  const next = progress.currentStepId ? STEP_COPY[progress.currentStepId] : null

  return (
    <section
      ref={ref}
      tabIndex={-1}
      aria-labelledby="guide-heading"
      className="mt-6 rounded-xl border border-white/[0.07] bg-[#16171d] p-4 shadow-[0_16px_44px_-28px_rgba(0,0,0,0.9)] focus:outline-none sm:mt-7 sm:p-5"
    >
      {collapsed ? (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2">
              <h2 id="guide-heading" className="text-[13px] font-semibold text-zinc-100">
                Getting started
              </h2>
              <span className="font-mono text-[11px] tabular-nums text-zinc-500">
                {progress.completed}/{progress.total}
              </span>
            </div>
            <GuideProgressBar completed={progress.completed} total={progress.total} className="mt-2 max-w-md" />
          </div>
          <p className="min-w-0 truncate text-[12px] text-zinc-400 sm:max-w-[40%]">
            {next ? (
              <>
                Next: <span className="text-zinc-200">{next.title}</span>
              </>
            ) : (
              'You’re set up.'
            )}
          </p>
          <button
            type="button"
            onClick={() => setCollapsed(false)}
            aria-expanded={false}
            className="inline-flex h-8 flex-shrink-0 items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.04] px-3 text-[12px] font-medium text-zinc-200 transition-colors hover:border-white/20 hover:bg-white/[0.08] focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/35"
          >
            {next ? 'Continue' : 'Show'}
            <ChevronDown className="h-3.5 w-3.5" aria-hidden />
          </button>
        </div>
      ) : (
        <GuidePanel
          progress={progress}
          variant="card"
          onCreateProject={onCreateProject}
          headerExtra={
            <button
              type="button"
              onClick={() => setCollapsed(true)}
              aria-expanded
              aria-label="Collapse Getting started"
              className="inline-flex h-7 w-7 items-center justify-center rounded-md text-zinc-500 transition-colors hover:bg-white/[0.04] hover:text-zinc-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/35"
            >
              <ChevronUp className="h-4 w-4" aria-hidden />
            </button>
          }
        />
      )}
    </section>
  )
}
