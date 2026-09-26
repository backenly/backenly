'use client'

/**
 * The guide's verification step, on the page where the user does the work.
 *
 * Sits above the Connect page's setup funnel while a new user is between
 * "generate a key" and "first backend built", and answers the one question the
 * funnel cannot: did my agent actually reach Backenly? It turns to Connected
 * only when Backenly has RECORDED a call from one of the user's credentials
 * (lib/onboarding/guide.ts). There is no button to confirm it by hand.
 *
 * Shown only for the project the guide is pointing at, so its answer and the
 * page's keys are about the same project.
 */

import { useRouter } from 'next/navigation'
import { ArrowRight, Check } from 'lucide-react'
import { useGuidePolling, useGuideStore, useVisibleGuide } from '@/lib/stores/use-guide-store'
import { ConnectionTroubleshooting } from './GuidePanel'
import { StarterPrompt } from './StarterPrompt'
import { ago } from './time'
import { Eyebrow, Hairline, PANEL, QuietAction, SegmentedProgress } from './ui'

const LIVE_POLL_MS = 4_000

export function AgentConnectionStatus({ projectId }: { projectId: string }) {
  const router = useRouter()
  const guide = useVisibleGuide()
  const track = useGuideStore((s) => s.track)
  const setPanelOpen = useGuideStore((s) => s.setPanelOpen)
  const progress = guide?.progress
  const status = (id: string) => progress?.steps.find((s) => s.id === id)?.status
  const relevant =
    !!progress && progress.focus?.id === projectId && (status('agent') !== 'done' || status('backend') !== 'done' || status('publish') !== 'done')
  useGuidePolling(relevant ? LIVE_POLL_MS : null)

  if (!progress || !relevant) return null
  const keyDone = status('mcp_key') === 'done'
  const agent = status('agent')
  const backendDone = status('backend') === 'done'
  const failing = progress.failingCall

  let tone: 'wait' | 'ok' | 'bad' = 'wait'
  let title: string
  let body: React.ReactNode = null

  if (agent === 'done' && backendDone) {
    tone = 'ok'
    title = 'Your agent built your first backend'
    body = (
      <button
        type="button"
        onClick={() => {
          track('cta_clicked', 'publish')
          router.push(`/app/projects/${projectId}/deploy`)
        }}
        className="inline-flex items-center gap-1.5 text-[12px] font-medium text-zinc-200 hover:text-white focus:outline-none focus-visible:underline"
      >
        Next: publish it
        <ArrowRight className="h-3.5 w-3.5" aria-hidden />
      </button>
    )
  } else if (agent === 'done') {
    tone = 'ok'
    title = 'Your agent is connected'
    body = (
      <div className="space-y-3">
        <p className="text-[12px] leading-relaxed text-zinc-400">
          {progress.focus?.lastAgentCallAt && <>Backenly recorded its last call {ago(progress.focus.lastAgentCallAt)}. </>}
          Now describe the backend you want, in your agent. Here is a first one to try:
        </p>
        <StarterPrompt />
      </div>
    )
  } else if (agent === 'failed' && failing) {
    tone = 'bad'
    title = 'Your agent reached Backenly, but its calls are failing'
    body = (
      <div className="space-y-3">
        <p className="break-words text-[12px] leading-relaxed text-zinc-400">
          <span className="font-mono text-zinc-300">{failing.tool ?? failing.endpoint}</span> returned HTTP{' '}
          {failing.statusCode} {ago(failing.at)}
          {failing.error ? <>: {failing.error}</> : '.'}
        </p>
        <ConnectionTroubleshooting />
      </div>
    )
  } else if (keyDone) {
    title = 'Waiting for your agent’s first call'
    body = (
      <div className="space-y-3">
        <p className="text-[12px] leading-relaxed text-zinc-400">
          Paste the setup prompt below into your agent. This turns green when Backenly records a call from it. Keys
          are shown only once: if you no longer have yours, generate a new one below.
        </p>
        <ConnectionTroubleshooting />
      </div>
    )
  } else {
    title = 'Generate a key, then paste the prompt into your agent'
    body = (
      <p className="text-[12px] leading-relaxed text-zinc-400">
        The key is scoped to this project and shown once. Your agent uses it to call Backenly&apos;s tools; this panel
        confirms the moment it does.
      </p>
    )
  }

  const stepId = agent === 'done' ? (backendDone ? 'publish' : 'backend') : keyDone ? 'agent' : 'mcp_key'
  const stepNumber = progress.steps.findIndex((s) => s.id === stepId) + 1
  const eyebrowTone = tone === 'ok' ? 'ok' : tone === 'bad' ? 'bad' : 'live'

  return (
    <section aria-label="Agent connection" className={`${PANEL} mb-6`}>
      <Hairline />
      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_220px]">
        <div className="min-w-0 space-y-2.5 px-5 py-4">
          <Eyebrow tone={eyebrowTone} pulse={tone === 'wait'}>
            Getting started · Step {stepNumber} of {progress.total}
          </Eyebrow>
          <p className="text-[15px] font-semibold leading-snug tracking-[-0.01em] text-white" role="status" aria-live="polite">
            {tone === 'ok' && <Check className="mr-1.5 inline h-4 w-4 -translate-y-px text-emerald-300" strokeWidth={2.5} aria-hidden />}
            {title}
          </p>
          {body}
        </div>
        <div className="flex flex-col justify-center gap-2.5 border-t border-white/[0.06] bg-[#131419] px-5 py-4 lg:border-l lg:border-t-0">
          <p className="flex items-baseline justify-between text-[11.5px] text-zinc-500">
            Progress
            <span className="font-mono tabular-nums text-zinc-300">
              {progress.completed}/{progress.total}
            </span>
          </p>
          <SegmentedProgress completed={progress.completed} total={progress.total} />
          <QuietAction onClick={() => setPanelOpen(true)}>Open the guide</QuietAction>
        </div>
      </div>
    </section>
  )
}
