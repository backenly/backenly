'use client'

/**
 * The Getting Started guide itself: progress, the steps, and the one thing to
 * do next. Rendered as a card on /app and inside the drawer in a project; the
 * content is the same, only the arrangement changes.
 *
 * Every action here goes to the real surface that does the work (Connect,
 * Deploy, Autonomy). The guide never mints a key, publishes or approves
 * anything itself, so it cannot drift from how those surfaces behave.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import {
  AlertTriangle,
  ArrowRight,
  Check,
  Loader2,
  Plus,
  EyeOff,
  ChevronDown,
  LifeBuoy,
} from 'lucide-react'
import { CLOUD_CONTROL_PLANE } from '@cloud/control-plane'
import type { GuideProgress, GuideStep, StepId, StepStatus } from '@/lib/onboarding/guide'
import { useGuideStore } from '@/lib/stores/use-guide-store'
import { STEP_COPY } from './guide-copy'
import { StarterPrompt } from './StarterPrompt'
import { AutonomyLoop } from './AutonomyLoop'
import { ago } from './time'

type Variant = 'card' | 'drawer'

interface PanelProps {
  progress: GuideProgress
  variant: Variant
  /** Opens the real New project dialog. Absent outside /app, where the guide links there instead. */
  onCreateProject?: () => void
  /** Called before the guide navigates away, so a drawer can close itself. */
  onNavigate?: () => void
  /** Id for the panel heading, so a dialog can label itself with it. */
  headingId?: string
  /** Extra controls beside Hide (the card's collapse toggle). */
  headerExtra?: ReactNode
}

// ── Progress ────────────────────────────────────────────────────────────────

export function GuideProgressBar({ completed, total, className = '' }: { completed: number; total: number; className?: string }) {
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0
  return (
    <div
      role="progressbar"
      aria-label="Getting started progress"
      aria-valuemin={0}
      aria-valuemax={total}
      aria-valuenow={completed}
      aria-valuetext={`${completed} of ${total} steps complete`}
      className={`h-1 overflow-hidden rounded-full bg-white/[0.06] ${className}`}
    >
      <div
        className="h-full rounded-full bg-violet-300/80 motion-safe:transition-[width] motion-safe:duration-500"
        style={{ width: `${pct}%` }}
      />
    </div>
  )
}

// ── Steps ───────────────────────────────────────────────────────────────────

const STATUS_LABEL: Record<StepStatus, string> = {
  done: 'Complete',
  todo: 'Not started',
  waiting: 'Waiting',
  in_progress: 'In progress',
  failed: 'Needs attention',
}

function StatusMark({ status, current }: { status: StepStatus; current: boolean }) {
  if (status === 'done') {
    return (
      <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-emerald-400/15 ring-1 ring-emerald-400/30">
        <Check className="h-3 w-3 text-emerald-300" strokeWidth={2.5} aria-hidden />
      </span>
    )
  }
  if (status === 'failed') {
    return (
      <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-rose-400/10 ring-1 ring-rose-400/30">
        <AlertTriangle className="h-2.5 w-2.5 text-rose-300" aria-hidden />
      </span>
    )
  }
  if (status === 'in_progress') {
    return (
      <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full ring-1 ring-amber-400/30">
        <Loader2 className="h-3 w-3 text-amber-300 motion-safe:animate-spin" aria-hidden />
      </span>
    )
  }
  return (
    <span
      className={`relative flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full ring-1 ${
        current ? 'ring-violet-300/60' : 'ring-white/[0.14]'
      }`}
    >
      {current && <span className="h-1.5 w-1.5 rounded-full bg-violet-300" aria-hidden />}
      {status === 'waiting' && (
        <span className="absolute inset-0 rounded-full ring-1 ring-violet-300/40 motion-safe:animate-ping" aria-hidden />
      )}
    </span>
  )
}

export function GuideChecklist({
  progress,
  selected,
  onSelect,
}: {
  progress: GuideProgress
  selected: StepId | null
  onSelect?: (id: StepId) => void
}) {
  return (
    <ol className="space-y-0.5" aria-label="Getting started steps">
      {progress.steps.map((step) => {
        const copy = STEP_COPY[step.id]
        const current = step.id === progress.currentStepId
        const active = step.id === selected
        const note = step.status !== 'done' ? copy.status?.[step.status] : undefined
        const label = (
          <>
            <StatusMark status={step.status} current={current} />
            <span className="min-w-0 flex-1">
              <span
                className={`block truncate text-[12.5px] ${
                  step.status === 'done'
                    ? 'text-zinc-400'
                    : current || active
                      ? 'font-medium text-zinc-50'
                      : 'text-zinc-300'
                }`}
              >
                {step.status === 'done' ? copy.doneTitle : copy.title}
              </span>
              {note && (
                <span className={`block truncate text-[11px] ${step.status === 'failed' ? 'text-rose-300/90' : 'text-zinc-500'}`}>
                  {note}
                </span>
              )}
            </span>
            <span className="sr-only">, {STATUS_LABEL[step.status]}</span>
          </>
        )
        return (
          <li key={step.id} aria-current={current ? 'step' : undefined}>
            {onSelect ? (
              <button
                type="button"
                onClick={() => onSelect(step.id)}
                aria-pressed={active}
                className={`flex w-full items-center gap-2.5 rounded-md border px-2.5 py-2 text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/35 ${
                  active
                    ? 'border-white/[0.12] bg-white/[0.05]'
                    : 'border-transparent hover:border-white/[0.06] hover:bg-white/[0.03]'
                }`}
              >
                {label}
              </button>
            ) : (
              <div className="flex items-center gap-2.5 px-2.5 py-2">{label}</div>
            )}
          </li>
        )
      })}
    </ol>
  )
}

// ── One step, in detail ─────────────────────────────────────────────────────

function Action({
  children,
  onClick,
  primary = false,
  icon = ArrowRight,
  disabled = false,
}: {
  children: ReactNode
  onClick: () => void
  primary?: boolean
  icon?: typeof ArrowRight
  disabled?: boolean
}) {
  const Icon = icon
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-[12px] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/35 disabled:cursor-not-allowed disabled:opacity-40 ${
        primary
          ? 'bg-white font-semibold text-black hover:bg-zinc-200'
          : 'border border-white/10 bg-white/[0.04] font-medium text-zinc-200 hover:border-white/20 hover:bg-white/[0.08]'
      }`}
    >
      {children}
      <Icon className="h-3.5 w-3.5" aria-hidden />
    </button>
  )
}

function Callout({ tone, children }: { tone: 'info' | 'danger'; children: ReactNode }) {
  return (
    <div
      className={`rounded-lg border px-3 py-2.5 text-[11.5px] leading-relaxed ${
        tone === 'danger'
          ? 'border-rose-400/20 bg-rose-400/[0.05] text-zinc-300'
          : 'border-white/[0.07] bg-white/[0.02] text-zinc-400'
      }`}
    >
      {children}
    </div>
  )
}

/** A live dot and a sentence: what Backenly is waiting to see. */
function Listening({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-center gap-2 text-[12px] text-zinc-300">
      <span className="relative flex h-2 w-2" aria-hidden>
        <span className="absolute inline-flex h-full w-full rounded-full bg-violet-300/60 motion-safe:animate-ping" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-violet-300" />
      </span>
      {children}
    </p>
  )
}

/**
 * Why an agent is not showing up, in the order it usually is. The first item
 * is the cause of most reports: MCP hosts read their server list when a session
 * starts, so an agent that was already open does not have the tools yet.
 */
export function ConnectionTroubleshooting() {
  return (
    <details className="group rounded-lg border border-white/[0.07] bg-white/[0.015] px-3 py-2">
      <summary className="flex cursor-pointer list-none items-center gap-2 text-[11.5px] font-medium text-zinc-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/35 [&::-webkit-details-marker]:hidden">
        <LifeBuoy className="h-3.5 w-3.5 text-zinc-500" aria-hidden />
        Not connecting?
        <ChevronDown className="ml-auto h-3.5 w-3.5 text-zinc-500 transition-transform group-open:rotate-180" aria-hidden />
      </summary>
      <ul className="mt-2 list-disc space-y-1.5 pl-4 text-[11.5px] leading-relaxed text-zinc-400 marker:text-zinc-600">
        <li>
          Start a new agent session after adding the server. Agents load MCP servers when a session starts, so one
          that was already open will not see Backenly. In Claude Code, <code className="font-mono text-zinc-300">/mcp</code> should
          list <code className="font-mono text-zinc-300">backenly</code>.
        </li>
        <li>
          Use the key that starts with <code className="font-mono text-zinc-300">mcp_live_</code>. An app key from Settings is
          refused on the MCP server.
        </li>
        <li>If the key was revoked or lost, generate a new one on Connect; each is shown only once.</li>
        <li>
          Then ask your agent to call <code className="font-mono text-zinc-300">read_backend_state</code>. This step completes
          on that first call.
        </li>
      </ul>
    </details>
  )
}

function StepDetail({
  step,
  index,
  progress,
  variant,
  newProject,
  go,
}: {
  step: GuideStep
  index: number
  progress: GuideProgress
  variant: Variant
  newProject: () => void
  go: (step: StepId, path: string) => void
}) {
  const copy = STEP_COPY[step.id]
  const focus = progress.focus
  const base = focus ? `/app/projects/${focus.id}` : null
  const done = step.status === 'done'
  const statusText = done ? 'Done' : copy.status?.[step.status]

  let content: ReactNode = null
  switch (step.id) {
    case 'account':
      content = null
      break

    case 'project':
      content = done ? (
        focus && (
          <Action onClick={() => go('project', `/app/projects/${focus.id}`)}>Open {focus.name}</Action>
        )
      ) : CLOUD_CONTROL_PLANE ? (
        <Action
          primary
          icon={Plus}
          onClick={newProject}
        >
          New project
        </Action>
      ) : (
        <Callout tone="info">
          This deployment hosts one project. Run{' '}
          <code className="rounded bg-white/[0.06] px-1 py-0.5 font-mono text-[11px] text-zinc-200">npm run bootstrap</code> on
          the server, then reload this page.
        </Callout>
      )
      break

    case 'mcp_key':
      content = base && (
        <div className="flex flex-wrap items-center gap-2">
          <Action primary={!done} onClick={() => go('mcp_key', `${base}/connect`)}>
            {done ? 'Manage keys' : 'Generate a key on Connect'}
          </Action>
          {done && focus && focus.mcpKeys === 0 && focus.oauthConnections > 0 && (
            <span className="text-[11.5px] text-zinc-500">Connected with OAuth, so no key was needed.</span>
          )}
        </div>
      )
      break

    case 'agent':
      content = (
        <div className="space-y-3">
          {done ? (
            <p className="flex items-center gap-2 text-[12px] text-emerald-300/90">
              <Check className="h-3.5 w-3.5" aria-hidden />
              Connected
              {focus?.lastAgentCallAt && <span className="text-zinc-500">· last call {ago(focus.lastAgentCallAt)}</span>}
            </p>
          ) : step.status === 'failed' && progress.failingCall ? (
            <Callout tone="danger">
              <p className="font-medium text-rose-200">
                {progress.failingCall.tool ?? progress.failingCall.endpoint} returned HTTP {progress.failingCall.statusCode}{' '}
                <span className="font-normal text-zinc-500">· {ago(progress.failingCall.at)}</span>
              </p>
              {progress.failingCall.error && <p className="mt-1 break-words text-zinc-400">{progress.failingCall.error}</p>}
            </Callout>
          ) : step.status === 'waiting' ? (
            <Listening>Listening for your agent&apos;s first call</Listening>
          ) : null}
          {base && (
            <Action primary={!done} onClick={() => go('agent', `${base}/connect`)}>
              {done ? 'Open Connect' : 'Open setup instructions'}
            </Action>
          )}
          {!done && <ConnectionTroubleshooting />}
        </div>
      )
      break

    case 'backend':
      content = done ? (
        base && <Action onClick={() => go('backend', `${base}/database`)}>Review it in Database</Action>
      ) : (
        <StarterPrompt />
      )
      break

    case 'publish':
      content = (
        <div className="space-y-3">
          {step.status === 'failed' && focus?.deploymentError && (
            <Callout tone="danger">
              <p className="font-medium text-rose-200">Publish failed. Production is unchanged.</p>
              <p className="mt-1 break-words text-zinc-400">{focus.deploymentError}</p>
            </Callout>
          )}
          {step.status === 'in_progress' && <Listening>Publishing {focus?.name}</Listening>}
          {done && focus?.deployedAt && (
            <p className="text-[12px] text-zinc-400">Published {ago(focus.deployedAt)}.</p>
          )}
          {base && (
            <Action primary={!done} onClick={() => go('publish', `${base}/deploy`)}>
              {done ? 'Open Deploy' : step.status === 'failed' ? 'See what failed' : 'Open Deploy'}
            </Action>
          )}
        </div>
      )
      break

    case 'watching':
      content = (
        <div className="space-y-3">
          <AutonomyLoop stacked={variant === 'drawer'} />
          {done && focus?.lastCheckedAt ? (
            <p className="flex items-center gap-2 text-[12px] text-emerald-300/90">
              <Check className="h-3.5 w-3.5" aria-hidden />
              Last checked {ago(focus.lastCheckedAt)}
            </p>
          ) : step.status === 'waiting' ? (
            <Listening>Waiting for the first check of your backend</Listening>
          ) : null}
          {base && (
            <div className="flex flex-wrap gap-2">
              <Action primary={!done && step.status !== 'todo'} onClick={() => go('watching', `${base}/autonomy`)}>
                Open Autonomy
              </Action>
              <Action onClick={() => go('watching', `${base}/monitoring`)}>Monitoring</Action>
            </div>
          )}
        </div>
      )
      break
  }

  return (
    <section aria-labelledby={`guide-step-${step.id}`} className="min-w-0 space-y-3">
      <div>
        <p className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-600">
          Step {index + 1} of {progress.total}
          {statusText && (
            <span
              className={`normal-case tracking-normal ${
                done ? 'text-emerald-300/90' : step.status === 'failed' ? 'text-rose-300' : 'text-zinc-500'
              }`}
            >
              · {statusText}
            </span>
          )}
        </p>
        <h3 id={`guide-step-${step.id}`} className="mt-1 text-[15px] font-semibold tracking-[-0.01em] text-zinc-50">
          {done ? copy.doneTitle : copy.title}
        </h3>
        <p className="mt-1 max-w-xl text-[12.5px] leading-relaxed text-zinc-400">{copy.body}</p>
      </div>
      {content}
    </section>
  )
}

// ── Finished ────────────────────────────────────────────────────────────────

function Finished({
  progress,
  variant,
  newProject,
  go,
}: {
  progress: GuideProgress
  variant: Variant
  newProject: () => void
  go: (step: StepId, path: string) => void
}) {
  const hide = useGuideStore((s) => s.hide)
  const busy = useGuideStore((s) => s.busy)
  const focus = progress.focus
  return (
    <section aria-labelledby="guide-finished" className="space-y-4">
      <div>
        <p className="flex items-center gap-2 text-[12px] font-medium text-emerald-300/90">
          <Check className="h-3.5 w-3.5" aria-hidden />
          All {progress.total} steps complete
        </p>
        <h3 id="guide-finished" className="mt-1.5 text-[17px] font-semibold tracking-[-0.01em] text-zinc-50">
          You&apos;re set up.
        </h3>
        <p className="mt-1 max-w-xl text-[12.5px] leading-relaxed text-zinc-400">
          Your agent builds through Backenly&apos;s MCP server, and Backenly runs and watches what it builds. To change
          the backend, describe the change to your agent. Come here to review, publish and see what Backenly did.
        </p>
      </div>
      <AutonomyLoop stacked={variant === 'drawer'} />
      <div className="flex flex-wrap items-center gap-2">
        {focus && (
          <Action primary onClick={() => go('watching', `/app/projects/${focus.id}`)}>
            Open {focus.name}
          </Action>
        )}
        {CLOUD_CONTROL_PLANE && (
          <Action icon={Plus} onClick={newProject}>
            Build another backend
          </Action>
        )}
        {focus && <Action onClick={() => go('watching', `/app/projects/${focus.id}/autonomy`)}>View Autonomy</Action>}
        <button
          type="button"
          onClick={hide}
          disabled={busy}
          className="ml-auto inline-flex h-8 items-center rounded-lg px-3 text-[12px] font-medium text-zinc-400 transition-colors hover:bg-white/[0.04] hover:text-zinc-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/35 disabled:opacity-40"
        >
          {busy ? 'Closing…' : 'Close the guide'}
        </button>
      </div>
    </section>
  )
}

// ── The panel ───────────────────────────────────────────────────────────────

export function GuidePanel({
  progress,
  variant,
  onCreateProject,
  onNavigate,
  headingId = 'guide-heading',
  headerExtra,
}: PanelProps) {
  const router = useRouter()
  const hide = useGuideStore((s) => s.hide)
  const busy = useGuideStore((s) => s.busy)
  const actionError = useGuideStore((s) => s.actionError)
  const track = useGuideStore((s) => s.track)

  // Follow progress by default. A click pins another step, and the pin lapses
  // as soon as progress moves on, so a finished step never holds the view.
  const [pin, setPin] = useState<{ id: StepId; at: StepId | null } | null>(null)
  const selected = pin && pin.at === progress.currentStepId ? pin.id : null
  // Selecting the step already open returns to following progress (and, once
  // everything is done, to the summary).
  const select = (id: StepId) => setPin(selected === id ? null : { id, at: progress.currentStepId })

  // Announce completions to screen readers as they happen, not on first render.
  const [announcement, setAnnouncement] = useState('')
  const previous = useRef<GuideProgress | null>(null)
  useEffect(() => {
    const before = previous.current
    previous.current = progress
    if (!before) return
    const newlyDone = progress.steps.filter(
      (s) => s.status === 'done' && before.steps.find((b) => b.id === s.id)?.status !== 'done',
    )
    if (newlyDone.length > 0) {
      setAnnouncement(newlyDone.map((s) => `${STEP_COPY[s.id].doneTitle}.`).join(' '))
    }
  }, [progress])

  const go = (step: StepId, path: string) => {
    track('cta_clicked', step)
    onNavigate?.()
    router.push(path)
  }

  // The New project dialog lives on /app. Elsewhere, ask /app to open it.
  const newProject = () => {
    if (onCreateProject) {
      track('cta_clicked', 'project')
      onCreateProject()
      return
    }
    useGuideStore.getState().setNewProjectRequested(true)
    go('project', '/app')
  }

  const showFinished = progress.allDone && selected === null
  const activeId = selected ?? progress.currentStepId ?? 'watching'
  const activeIndex = progress.steps.findIndex((s) => s.id === activeId)
  const activeStep = progress.steps[activeIndex]

  return (
    <div>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <h2 id={headingId} className="text-[13px] font-semibold text-zinc-100">
            Getting started
          </h2>
          <p className="mt-0.5 text-[11.5px] text-zinc-500">
            <span className="font-mono tabular-nums text-zinc-300">{progress.completed}</span> of{' '}
            <span className="font-mono tabular-nums">{progress.total}</span> complete · updates as you go
          </p>
        </div>
        <div className="-mr-1 flex flex-shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={hide}
            disabled={busy}
            title="Hide the guide. Reopen it from your account menu."
            aria-label="Hide Getting started. You can reopen it from your account menu."
            className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[11.5px] text-zinc-500 transition-colors hover:bg-white/[0.04] hover:text-zinc-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/35 disabled:opacity-40"
          >
            <EyeOff className="h-3.5 w-3.5" aria-hidden />
            Hide guide
          </button>
          {headerExtra}
        </div>
      </div>
      <GuideProgressBar completed={progress.completed} total={progress.total} className="mt-3" />
      {actionError && <p className="mt-2 text-[11.5px] text-amber-300/90">{actionError}</p>}

      <div
        className={
          variant === 'card'
            ? 'mt-4 grid gap-5 lg:grid-cols-[minmax(0,260px)_minmax(0,1fr)]'
            : 'mt-4 space-y-4'
        }
      >
        <GuideChecklist progress={progress} selected={showFinished ? null : activeId} onSelect={select} />
        <div className={variant === 'card' ? 'min-w-0 lg:border-l lg:border-white/[0.06] lg:pl-5' : 'border-t border-white/[0.06] pt-4'}>
          {showFinished ? (
            <Finished progress={progress} variant={variant} newProject={newProject} go={go} />
          ) : (
            activeStep && (
              <StepDetail
                step={activeStep}
                index={activeIndex}
                progress={progress}
                variant={variant}
                newProject={newProject}
                go={go}
              />
            )
          )}
        </div>
      </div>

      <p className="sr-only" aria-live="polite">
        {announcement}
      </p>
    </div>
  )
}
