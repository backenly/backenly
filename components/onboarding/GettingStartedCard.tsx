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
import { ChevronDown, ChevronUp, Plus } from 'lucide-react'
import { CLOUD_CONTROL_PLANE } from '@cloud/control-plane'
import { useGuidePolling, useGuideStore, useVisibleGuide } from '@/lib/stores/use-guide-store'
import type { GuideProgress } from '@/lib/onboarding/guide'
import { STEP_COPY } from './guide-copy'
import { GuideChecklist, GuidePanel, GuideProgressBar } from './GuidePanel'
import { WorkflowDiagram } from './WorkflowDiagram'
import { guidePollMs } from './poll'
import { Eyebrow, Hairline, PANEL, Panel, PrimaryAction, QuietAction } from './ui'

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
    <section aria-labelledby="welcome-heading" className="w-full py-2 sm:py-4">
      <Panel>
        <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_300px]">
          {/* ── The pitch, and the one thing to do ─────────────────────── */}
          <div className="flex flex-col justify-center px-5 py-6 sm:px-7 sm:py-7">
            <Eyebrow pulse>Welcome to Backenly</Eyebrow>
            <h2
              id="welcome-heading"
              className="mt-3 text-[22px] font-semibold leading-tight tracking-[-0.015em] text-white sm:text-[26px]"
            >
              Build your backend from your coding agent.
            </h2>
            <p className="mt-2.5 max-w-xl text-[13.5px] leading-6 text-zinc-300">
              Your agent builds it through Backenly&apos;s MCP server. Backenly provisions and runs the backend, and keeps
              watching it after you publish.
            </p>
            <p className="mt-1.5 max-w-xl text-[12.5px] leading-relaxed text-zinc-500">
              Describe what you want to your agent, not to this dashboard. Come here to review it, publish it and see
              what Backenly is doing.
            </p>

            <div className="mt-5">
              <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-600">
                Step {progress.steps.findIndex((s) => s.id === 'project') + 1} · {STEP_COPY.project.title}
              </p>
              {CLOUD_CONTROL_PLANE ? (
                <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-2">
                  <PrimaryAction
                    icon={Plus}
                    onClick={() => {
                      track('cta_clicked', 'project')
                      onCreateProject()
                    }}
                  >
                    Create your first project
                  </PrimaryAction>
                  <QuietAction href="/resources/how-backenly-works">How Backenly works</QuietAction>
                </div>
              ) : (
                <div className="mt-2.5 space-y-2.5">
                  <p className="max-w-lg rounded-lg border border-white/[0.07] bg-[#0f1015] px-3.5 py-2.5 text-[12px] leading-relaxed text-zinc-400">
                    This deployment hosts one project. Run{' '}
                    <code className="rounded bg-white/[0.06] px-1 py-0.5 font-mono text-[11px] text-zinc-200">npm run bootstrap</code>{' '}
                    on the server, then reload this page.
                  </p>
                  <QuietAction href="/resources/how-backenly-works">How Backenly works</QuietAction>
                </div>
              )}
              <p className="mt-3 max-w-lg text-[11.5px] leading-relaxed text-zinc-500">{STEP_COPY.project.body}</p>
            </div>
          </div>

          {/* ── Where this goes: the whole path, with progress ─────────── */}
          <div className="border-t border-white/[0.06] bg-[#131419] px-4 py-5 lg:border-l lg:border-t-0">
            <p className="flex items-baseline justify-between px-0.5 text-[12px]">
              <span className="font-semibold text-zinc-200">Getting started</span>
              <span className="font-mono text-[11px] tabular-nums text-zinc-500">
                {progress.completed}/{progress.total}
              </span>
            </p>
            <GuideProgressBar completed={progress.completed} total={progress.total} className="mb-3 mt-2.5 px-0.5" />
            <div className="-mx-2">
              <GuideChecklist progress={progress} selected={progress.currentStepId} />
            </div>
          </div>
        </div>

        {/* ── The model, in one picture ──────────────────────────────── */}
        <div className="border-t border-white/[0.06] px-4 py-4 sm:px-5 sm:py-5">
          <WorkflowDiagram bare />
        </div>
      </Panel>
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
      className={`${PANEL} mt-6 p-4 focus:outline-none sm:mt-7 sm:p-5`}
    >
      <Hairline />
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
            <GuideProgressBar completed={progress.completed} total={progress.total} className="mt-2.5 max-w-sm" />
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
