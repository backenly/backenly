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

const LIVE_POLL_MS = 4_000

export function AgentConnectionStatus({ projectId }: { projectId: string }) {
  const router = useRouter()
  const guide = useVisibleGuide()
  const track = useGuideStore((s) => s.track)
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

  const ring = tone === 'ok' ? 'border-emerald-400/20' : tone === 'bad' ? 'border-rose-400/25' : 'border-violet-300/20'

  return (
    <section
      aria-label="Agent connection"
      className={`mb-6 rounded-xl border ${ring} bg-[#16171d] px-4 py-3.5 shadow-[0_16px_44px_-28px_rgba(0,0,0,0.9)]`}
    >
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex h-5 w-5 flex-shrink-0 items-center justify-center" aria-hidden>
          {tone === 'ok' ? (
            <span className="flex h-5 w-5 items-center justify-center rounded-full bg-emerald-400/15 ring-1 ring-emerald-400/30">
              <Check className="h-3 w-3 text-emerald-300" strokeWidth={2.5} />
            </span>
          ) : tone === 'bad' ? (
            <span className="h-2 w-2 rounded-full bg-rose-400" />
          ) : (
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full rounded-full bg-violet-300/60 motion-safe:animate-ping" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-violet-300" />
            </span>
          )}
        </span>
        <div className="min-w-0 flex-1 space-y-2">
          <p className="text-[13px] font-semibold text-zinc-100" role="status" aria-live="polite">
            {title}
          </p>
          {body}
        </div>
      </div>
    </section>
  )
}
