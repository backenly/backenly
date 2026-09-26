'use client'

/**
 * The Getting Started guide itself: progress, the steps, and the one thing to
 * do next. Rendered as a card on /app and inside the drawer in a project; the
 * content is the same, only the arrangement changes.
 *
 * Every action here goes to the real surface that does the work (Connect,
 * Deploy, Autonomy). The guide never mints a key, publishes or approves
 * anything itself, so it cannot drift from how those surfaces behave.
 *
 * Visual language is the console's (./ui, lifted from WorkspaceHome): a live
 * eyebrow, a headline that says what is next, discrete progress, a stepper
 * whose rail shows how far along the user is, telemetry-style statuses.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import { AlertTriangle, Check, Loader2, Plus, EyeOff, ChevronDown, LifeBuoy } from 'lucide-react'
import { CLOUD_CONTROL_PLANE } from '@cloud/control-plane'
import type { GuideProgress, GuideStep, StepId, StepStatus } from '@/lib/onboarding/guide'
import { useGuideStore } from '@/lib/stores/use-guide-store'
import { STEP_COPY } from './guide-copy'
import { StarterPrompt } from './StarterPrompt'
import { AutonomyLoop } from './AutonomyLoop'
import { Eyebrow, PrimaryAction, QuietAction, SecondaryAction, SegmentedProgress } from './ui'
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

/** Kept under its old name: the launcher and welcome draw the same progress. */
export const GuideProgressBar = SegmentedProgress

// ── Steps ───────────────────────────────────────────────────────────────────

const STATUS_LABEL: Record<StepStatus, string> = {
  done: 'Complete',
  todo: 'Not started',
  waiting: 'Waiting',
  in_progress: 'In progress',
  failed: 'Needs attention',
}

/** The number in the mark: data is mono in this console, so steps are counted, not bulleted. */
function StatusMark({ status, current, n }: { status: StepStatus; current: boolean; n: number }) {
  const base = 'relative z-10 flex h-[22px] w-[22px] flex-shrink-0 items-center justify-center rounded-full'
  if (status === 'done') {
    return (
      <span className={`${base} bg-[#16171d] ring-1 ring-emerald-400/35`}>
        <span className="absolute inset-0 rounded-full bg-emerald-400/10" />
        <Check className="relative h-3 w-3 text-emerald-300" strokeWidth={2.75} aria-hidden />
      </span>
    )
  }
  if (status === 'failed') {
    return (
      <span className={`${base} bg-[#16171d] ring-1 ring-rose-400/40`}>
        <span className="absolute inset-0 rounded-full bg-rose-400/10" />
        <AlertTriangle className="relative h-2.5 w-2.5 text-rose-300" aria-hidden />
      </span>
    )
  }
  if (status === 'in_progress') {
    return (
      <span className={`${base} bg-[#16171d] ring-1 ring-amber-400/35`}>
        <Loader2 className="h-3 w-3 text-amber-300 motion-safe:animate-spin" aria-hidden />
      </span>
    )
  }
  return (
    <span
      className={`${base} bg-[#16171d] font-mono text-[10px] tabular-nums ring-1 ${
        current ? 'text-violet-200 ring-violet-300/60' : 'text-zinc-500 ring-white/[0.12]'
      }`}
    >
      {current && status === 'waiting' && (
        <span className="absolute inset-0 rounded-full ring-1 ring-violet-300/40 motion-safe:animate-ping" aria-hidden />
      )}
      <span aria-hidden>{n}</span>
    </span>
  )
}

/**
 * The stepper. A rail runs through the marks, lit up to the last finished
 * step, so "how far along am I" is readable without counting ticks.
 */
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
    <ol className="relative" aria-label="Getting started steps">
      {progress.steps.map((step, i) => {
        const copy = STEP_COPY[step.id]
        const current = step.id === progress.currentStepId
        const active = step.id === selected
        const done = step.status === 'done'
        const note = !done ? copy.status?.[step.status] : undefined
        const last = i === progress.steps.length - 1
        const nextDone = !last && progress.steps[i + 1].status === 'done'
        const label = (
          <>
            <StatusMark status={step.status} current={current} n={i + 1} />
            <span className="min-w-0 flex-1 py-0.5">
              <span
                className={`block truncate text-[12.5px] leading-5 ${
                  done ? 'text-zinc-400' : current || active ? 'font-medium text-zinc-50' : 'text-zinc-300'
                }`}
              >
                {done ? copy.doneTitle : copy.title}
              </span>
              {note && (
                <span
                  className={`block truncate font-mono text-[10.5px] ${
                    step.status === 'failed' ? 'text-rose-300/90' : 'text-zinc-500'
                  }`}
                >
                  {note}
                </span>
              )}
            </span>
            <span className="sr-only">, {STATUS_LABEL[step.status]}</span>
          </>
        )
        return (
          <li key={step.id} aria-current={current ? 'step' : undefined} className="relative">
            {/* The rail segment to the next mark: violet where both ends are done. */}
            {!last && (
              <span
                aria-hidden
                className={`absolute left-[21px] top-[30px] bottom-[-6px] w-px ${
                  done && nextDone ? 'bg-violet-300/40' : 'bg-white/[0.08]'
                }`}
              />
            )}
            {onSelect ? (
              <button
                type="button"
                onClick={() => onSelect(step.id)}
                aria-pressed={active}
                className={`relative flex w-full items-start gap-3 rounded-lg px-2.5 py-2 text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/35 ${
                  active ? 'bg-white/[0.05] shadow-[inset_2px_0_0_rgba(196,181,253,0.7)]' : 'hover:bg-white/[0.03]'
                }`}
              >
                {label}
              </button>
            ) : (
              <div className="relative flex items-start gap-3 px-2.5 py-2">{label}</div>
            )}
          </li>
        )
      })}
    </ol>
  )
}

// ── One step, in detail ─────────────────────────────────────────────────────

function Callout({ tone, children }: { tone: 'info' | 'danger'; children: ReactNode }) {
  return (
    <div
      className={`rounded-lg border px-3.5 py-3 text-[12px] leading-relaxed ${
        tone === 'danger'
          ? 'border-rose-400/20 bg-rose-400/[0.05] text-zinc-300'
          : 'border-white/[0.07] bg-[#0f1015] text-zinc-400'
      }`}
    >
      {children}
    </div>
  )
}

/** A live dot and a sentence: what Backenly is waiting to see. */
function Listening({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-center gap-2.5 rounded-lg border border-violet-300/15 bg-violet-300/[0.04] px-3.5 py-2.5 text-[12px] text-zinc-300">
      <span className="relative flex h-2 w-2" aria-hidden>
        <span className="absolute inline-flex h-full w-full rounded-full bg-violet-300/60 motion-safe:animate-ping" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-violet-300" />
      </span>
      {children}
    </p>
  )
}

/** A confirmed fact, in the console's telemetry voice. */
function Confirmed({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-center gap-2 text-[12px] text-emerald-300/90">
      <Check className="h-3.5 w-3.5" strokeWidth={2.5} aria-hidden />
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
    <details className="group rounded-lg border border-white/[0.07] bg-[#0f1015] px-3.5 py-2.5">
      <summary className="flex cursor-pointer list-none items-center gap-2 text-[12px] font-medium text-zinc-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/35 [&::-webkit-details-marker]:hidden">
        <LifeBuoy className="h-3.5 w-3.5 text-zinc-500" aria-hidden />
        Not connecting?
        <ChevronDown className="ml-auto h-3.5 w-3.5 text-zinc-500 transition-transform group-open:rotate-180" aria-hidden />
      </summary>
      <ol className="mt-2.5 space-y-2 text-[11.5px] leading-relaxed text-zinc-400">
        {[
          <>
            Start a new agent session after adding the server. Agents load MCP servers when a session starts, so one
            that was already open will not see Backenly. In Claude Code, <Code>/mcp</Code> should list <Code>backenly</Code>.
          </>,
          <>
            Use the key that starts with <Code>mcp_live_</Code>. An app key from Settings is refused on the MCP server.
          </>,
          <>If the key was revoked or lost, generate a new one on Connect; each is shown only once.</>,
          <>
            Then ask your agent to call <Code>read_backend_state</Code>. This step completes on that first call.
          </>,
        ].map((item, i) => (
          <li key={i} className="flex gap-2.5">
            <span className="mt-px font-mono text-[10.5px] tabular-nums text-zinc-600" aria-hidden>
              {i + 1}
            </span>
            <span className="min-w-0">{item}</span>
          </li>
        ))}
      </ol>
    </details>
  )
}

function Code({ children }: { children: ReactNode }) {
  return <code className="rounded bg-white/[0.06] px-1 py-px font-mono text-[11px] text-zinc-200">{children}</code>
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
  const tone = done ? 'ok' : step.status === 'failed' ? 'bad' : 'live'

  let content: ReactNode = null
  switch (step.id) {
    case 'account':
      content = null
      break

    case 'project':
      content = done ? (
        focus && <SecondaryAction onClick={() => go('project', `/app/projects/${focus.id}`)}>Open {focus.name}</SecondaryAction>
      ) : CLOUD_CONTROL_PLANE ? (
        <PrimaryAction icon={Plus} onClick={newProject}>
          New project
        </PrimaryAction>
      ) : (
        <Callout tone="info">
          This deployment hosts one project. Run <Code>npm run bootstrap</Code> on the server, then reload this page.
        </Callout>
      )
      break

    case 'mcp_key':
      content = base && (
        <div className="space-y-3">
          {done && focus && focus.mcpKeys === 0 && focus.oauthConnections > 0 && (
            <Confirmed>Connected with OAuth, so no key was needed</Confirmed>
          )}
          {done ? (
            <SecondaryAction onClick={() => go('mcp_key', `${base}/connect`)}>Manage keys</SecondaryAction>
          ) : (
            <PrimaryAction onClick={() => go('mcp_key', `${base}/connect`)}>Generate a key on Connect</PrimaryAction>
          )}
        </div>
      )
      break

    case 'agent':
      content = (
        <div className="space-y-3">
          {done ? (
            <Confirmed>
              Connected
              {focus?.lastAgentCallAt && <span className="text-zinc-500">· last call {ago(focus.lastAgentCallAt)}</span>}
            </Confirmed>
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
          {base &&
            (done ? (
              <SecondaryAction onClick={() => go('agent', `${base}/connect`)}>Open Connect</SecondaryAction>
            ) : (
              <PrimaryAction onClick={() => go('agent', `${base}/connect`)}>Open setup instructions</PrimaryAction>
            ))}
          {!done && <ConnectionTroubleshooting />}
        </div>
      )
      break

    case 'backend':
      content = done ? (
        base && <SecondaryAction onClick={() => go('backend', `${base}/database`)}>Review it in Database</SecondaryAction>
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
          {done && focus?.deployedAt && <Confirmed>Published {ago(focus.deployedAt)}</Confirmed>}
          {base &&
            (done ? (
              <SecondaryAction onClick={() => go('publish', `${base}/deploy`)}>Open Deploy</SecondaryAction>
            ) : (
              <PrimaryAction onClick={() => go('publish', `${base}/deploy`)}>
                {step.status === 'failed' ? 'See what failed' : 'Open Deploy'}
              </PrimaryAction>
            ))}
        </div>
      )
      break

    case 'watching':
      content = (
        <div className="space-y-3">
          {done && focus?.lastCheckedAt ? (
            <Confirmed>Last checked {ago(focus.lastCheckedAt)}</Confirmed>
          ) : step.status === 'waiting' ? (
            <Listening>Waiting for the first check of your backend</Listening>
          ) : null}
          <AutonomyLoop stacked={variant === 'drawer'} />
          {base && (
            <div className="flex flex-wrap items-center gap-3">
              {!done && step.status !== 'todo' ? (
                <PrimaryAction onClick={() => go('watching', `${base}/autonomy`)}>Open Autonomy</PrimaryAction>
              ) : (
                <SecondaryAction onClick={() => go('watching', `${base}/autonomy`)}>Open Autonomy</SecondaryAction>
              )}
              <QuietAction onClick={() => go('watching', `${base}/monitoring`)}>Monitoring</QuietAction>
            </div>
          )}
        </div>
      )
      break
  }

  return (
    <section aria-labelledby={`guide-step-${step.id}`} className="min-w-0 space-y-4">
      <div>
        <Eyebrow tone={tone} pulse={step.status === 'waiting' || step.status === 'in_progress'}>
          <span>
            Step {index + 1} of {progress.total}
          </span>
          {statusText && (
            <span
              className={`font-mono normal-case tracking-normal ${
                done ? 'text-emerald-300/90' : step.status === 'failed' ? 'text-rose-300' : 'text-zinc-500'
              }`}
            >
              · {statusText}
            </span>
          )}
        </Eyebrow>
        <h3
          id={`guide-step-${step.id}`}
          className="mt-2.5 text-[17px] font-semibold leading-snug tracking-[-0.01em] text-white"
        >
          {done ? copy.doneTitle : copy.title}
        </h3>
        <p className="mt-1.5 max-w-xl text-[13px] leading-6 text-zinc-400">{copy.body}</p>
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
        <Eyebrow tone="ok">All {progress.total} steps complete</Eyebrow>
        <h3 id="guide-finished" className="mt-2.5 text-[19px] font-semibold leading-snug tracking-[-0.01em] text-white">
          You&apos;re set up.
        </h3>
        <p className="mt-1.5 max-w-xl text-[13px] leading-6 text-zinc-400">
          Your agent builds through Backenly&apos;s MCP server, and Backenly runs and watches what it builds. To change
          the backend, describe the change to your agent. Come here to review, publish and see what Backenly did.
        </p>
      </div>
      <AutonomyLoop stacked={variant === 'drawer'} />
      <div className="flex flex-wrap items-center gap-3">
        {focus && <PrimaryAction onClick={() => go('watching', `/app/projects/${focus.id}`)}>Open {focus.name}</PrimaryAction>}
        {CLOUD_CONTROL_PLANE && (
          <SecondaryAction icon={Plus} onClick={newProject}>
            Build another backend
          </SecondaryAction>
        )}
        {focus && <QuietAction onClick={() => go('watching', `/app/projects/${focus.id}/autonomy`)}>View Autonomy</QuietAction>}
        <button
          type="button"
          onClick={hide}
          disabled={busy}
          className="ml-auto inline-flex h-8 items-center rounded-lg px-3 text-[12px] font-medium text-zinc-500 transition-colors hover:bg-white/[0.04] hover:text-zinc-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/35 disabled:opacity-40"
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
  const next = progress.currentStepId ? STEP_COPY[progress.currentStepId].title : null

  return (
    <div>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <h2 id={headingId} className="flex items-baseline gap-2 text-[13px] font-semibold text-zinc-100">
            Getting started
            <span className="font-mono text-[11px] font-medium tabular-nums text-zinc-500">
              {progress.completed}/{progress.total}
            </span>
          </h2>
          <p className="mt-0.5 truncate text-[12px] text-zinc-500">
            {next ? (
              <>
                Next: <span className="text-zinc-300">{next}</span>
              </>
            ) : (
              'Every step is done.'
            )}
            <span className="text-zinc-600"> · updates as you go</span>
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
      <SegmentedProgress completed={progress.completed} total={progress.total} className="mt-3.5" />
      {actionError && <p className="mt-2 text-[11.5px] text-amber-300/90">{actionError}</p>}

      <div
        className={
          variant === 'card'
            ? 'mt-5 grid gap-6 lg:grid-cols-[minmax(0,272px)_minmax(0,1fr)]'
            : 'mt-5 space-y-5'
        }
      >
        <div className={variant === 'card' ? '-ml-2.5' : '-mx-2.5'}>
          <GuideChecklist progress={progress} selected={showFinished ? null : activeId} onSelect={select} />
        </div>
        <div
          className={
            variant === 'card'
              ? 'min-w-0 lg:border-l lg:border-white/[0.06] lg:pl-6'
              : 'border-t border-white/[0.06] pt-5'
          }
        >
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
