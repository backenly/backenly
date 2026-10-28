'use client'

/**
 * EvolutionRequestRow — one architecture change waiting on a person, as a row
 * in the existing "Waiting on you" queue.
 *
 * WHY IT IS A ROW AND NOT A PAGE
 * ------------------------------
 * The change itself arrives the same way every other held decision does: a
 * HealthFinding of type `architecture_evolution` with status
 * `pending_approval`, in the trust report's `pendingApprovals`, with its
 * `details.evolution` verbatim (lib/evolution-engine/request.ts). The queue
 * already has the badge and the count. What it did not have is a way to give
 * consent that is bound to one exact plan version, so this row carries exactly
 * that and nothing more. Backenly asks only for a change it can then carry
 * through on its own: approving is the one thing a person does.
 *
 * WHAT A PERSON SEES BY DEFAULT
 * -----------------------------
 * The headline, what changes and why (in plain words: never a count or a
 * score), the risk, that apps keep working and who may read the data (only
 * where the rehearsal checked it), what undo does, whether it was rehearsed on
 * a copy, and two buttons. Every sentence is on the page, never only in a
 * tooltip a keyboard or a phone cannot reach. A change that stopped asks a
 * different question, resume or undo, or, once it was in place, keep or undo,
 * and says why it stopped in one sentence.
 *
 * Everything else, the steps with their exact SQL, the evidence and its
 * numbers, what this change deliberately does not decide and what someone
 * would have to migrate before the old columns could ever be removed, sits
 * behind one "Technical details" toggle. Internal lifecycle states are never
 * shown, and nothing here ever offers to remove the old columns: that step is
 * planned and explained, never run by software, and so never a button.
 *
 * WHERE THE DECISIONS GO
 * ----------------------
 * Every one to POST /api/projects/[id]/architecture, which needs an
 * organization admin (a refusal says so, ADMIN_ONLY):
 *
 *   Approve   { action: 'approve', findingId, planVersion }  The plan version is
 *             the one on screen. A 409 means the world moved (the table changed
 *             and Backenly re-checked it, or someone else is already
 *             approving): the row says so and asks the queue to re-read, so the
 *             next click consents to what the person is now looking at.
 *   Decline   { action: 'dismiss', findingId }  Remembered: Backenly does not
 *             ask again unless something new is measured, and says so.
 *   Not now   the same, on a stopped change: the change stays as it is and the
 *             decision moves to the Architecture changes card.
 *   Resume /  { action: 'resume', decisionId }
 *   Keep it
 *   Undo      { action: 'undo', decisionId }  Asks once more, saying what undo
 *             removes and what stops working, before it runs.
 *
 * Never /health, /health/approve or /approvals: they refuse this type, and none
 * of them can bind consent to a plan version.
 */

import { useEffect, useRef, useState } from 'react'
import { CheckCircle2, ChevronDown, Info, Loader2, Undo2, XCircle } from 'lucide-react'
import { KitButton, Tag } from '@/components/inspector/kit'
import type { EvolutionRequestDetails } from '@/lib/evolution-engine/request'
import type { RiskLevel } from '@/lib/evolution-engine/policy'
import { ADMIN_ONLY, announceArchitectureChange } from './architecture-decisions'

/** The part of a queue row this component reads. PendingApproval satisfies it. */
export interface EvolutionQueueItem {
  id: string
  detectedAt: string
  reason?: string
  details: Record<string, unknown> | null
}

type Action = 'approve' | 'dismiss' | 'resume' | 'undo'

type RowState =
  | { phase: 'idle' }
  | { phase: 'confirm_undo' }
  | { phase: 'busy'; action: Action }
  | { phase: 'done'; message: string }
  /** The request was well-formed and the world said no; the queue re-reads. */
  | { phase: 'moved'; message: string }
  | { phase: 'error'; message: string }

const RISK_LABEL: Record<RiskLevel, string> = {
  low: 'Low risk',
  medium: 'Medium risk',
  high: 'High risk',
}

const RISK_TONE: Record<RiskLevel, 'good' | 'warn' | 'bad'> = {
  low: 'good',
  medium: 'warn',
  high: 'bad',
}

const VERDICT_LABEL: Record<string, string> = {
  supports: 'Supports',
  contradicts: 'Against',
  silent: 'No signal',
  unavailable: 'Could not check',
}

/** How long a settled row stays on screen before the queue re-reads. */
const SETTLE_MS = 2400

function timeAgo(iso: string): string {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 5) return 'just now'
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

/** `details.evolution`, when it is a shape this page can read. */
export function evolutionOf(item: EvolutionQueueItem): EvolutionRequestDetails | null {
  const ev = (item.details ?? {}).evolution as EvolutionRequestDetails | undefined
  if (!ev || ev.v !== 1 || !ev.summary || typeof ev.summary.headline !== 'string') return null
  return ev
}

/**
 * Mirrors the server: only a version that passed its own rehearsal can be
 * approved. The rehearsal line and the Approve button both read this, so the
 * row never says "rehearsed" next to a button the server would refuse.
 */
function rehearsedThisVersion(ev: EvolutionRequestDetails): boolean {
  return !!ev.rehearsal?.passed && ev.rehearsal.planVersion === ev.planVersion
}

/** What a refusal says, with a role refusal in words that name the role. */
function refusal(status: number, error: string | undefined, fallback: string): string {
  return status === 403 ? ADMIN_ONLY : error || fallback
}

export function EvolutionRequestRow({
  projectId,
  request,
  onRefresh,
  onDecided,
}: {
  projectId: string
  request: EvolutionQueueItem
  /** Re-read the queue. Called after a decision settles, and at once on a 409. */
  onRefresh: () => void | Promise<void>
  /** Optional: the panel's own banner, given the server's sentence. */
  onDecided?: (message: string) => void
}) {
  const [state, setState] = useState<RowState>({ phase: 'idle' })
  const [showTechnical, setShowTechnical] = useState(false)
  const timers = useRef<ReturnType<typeof setTimeout>[]>([])
  const actions = useRef<HTMLDivElement>(null)
  const previous = useRef<RowState['phase']>('idle')
  useEffect(() => () => { timers.current.forEach(clearTimeout) }, [])

  // Keyboard focus follows the confirmation: onto its safe choice when it
  // opens, back to Undo when it is cancelled, never lost with a button that
  // unmounted under it.
  useEffect(() => {
    const buttons = () => [...(actions.current?.querySelectorAll('button') ?? [])]
    if (state.phase === 'confirm_undo') buttons()[0]?.focus()
    else if (previous.current === 'confirm_undo' && state.phase === 'idle') buttons().find(b => /Undo/.test(b.textContent ?? ''))?.focus()
    previous.current = state.phase
  }, [state.phase])

  const ev = evolutionOf(request)

  const settle = (message: string) => {
    setState({ phase: 'done', message })
    onDecided?.(message)
    announceArchitectureChange('queue')
    timers.current.push(setTimeout(() => { void onRefresh() }, SETTLE_MS))
  }

  const post = async (body: Record<string, unknown>) => {
    const res = await fetch(`/api/projects/${projectId}/architecture`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const j = await res.json().catch(() => ({} as Record<string, unknown>))
    return { res, j: (j ?? {}) as { ok?: boolean; message?: string; error?: string } }
  }

  const run = async (action: Action, body: Record<string, unknown>, done: string) => {
    setState({ phase: 'busy', action })
    try {
      const { res, j } = await post(body)
      if (res.ok && j.ok) {
        settle(j.message || done)
        return
      }
      if (res.status === 409) {
        setState({ phase: 'moved', message: j.error || 'This change moved on since you opened it. Here is where it is now.' })
        await onRefresh()
        return
      }
      setState({ phase: 'error', message: refusal(res.status, j.error, 'That did not go through. Try again in a moment.') })
    } catch {
      setState({ phase: 'error', message: 'Network error. Check your connection and try again.' })
    }
  }

  const decide = (action: 'approve' | 'resume' | 'undo') => {
    if (!ev) return
    const body =
      action === 'approve' ? { action, findingId: request.id, planVersion: ev.planVersion } : { action, decisionId: ev.decisionId }
    return run(action, body, action === 'undo' ? 'Undone.' : action === 'resume' ? 'Done.' : 'Approved.')
  }

  const dismiss = () => run('dismiss', { action: 'dismiss', findingId: request.id }, 'Set aside.')

  // What a screen reader hears as the row changes: the outcome of a decision,
  // a version that moved, or the question an undo asks.
  const announced =
    state.phase === 'done' || state.phase === 'moved'
      ? state.message
      : state.phase === 'confirm_undo' && ev
        ? `Undo? ${ev.summary.rollback}`
        : ''

  // A row this page cannot read is still a row the person can set aside.
  if (!ev) {
    return (
      <li className="px-5 py-3.5">
        <div className="flex items-start gap-3">
          <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-zinc-500" />
          <div className="min-w-0 flex-1">
            <p className="text-[12.5px] leading-snug text-zinc-100">{request.reason || 'An architecture change is waiting'}</p>
            <p className="mt-1 text-[12.5px] leading-snug text-zinc-500">
              This page cannot read the request. Refresh, or set it aside.
            </p>
            {state.phase === 'error' && (
              <p role="alert" className="mt-1 text-[12.5px] leading-snug text-rose-300/90">{state.message}</p>
            )}
          </div>
          <KitButton variant="secondary" onClick={dismiss} disabled={state.phase === 'busy'}>
            Not now
          </KitButton>
        </div>
      </li>
    )
  }

  const s = ev.summary
  const busy = state.phase === 'busy'
  const busyWith = (a: Action) => state.phase === 'busy' && state.action === a

  if (state.phase === 'done') {
    return (
      <li className="flex items-start gap-3 px-5 py-3.5 animate-fade-in">
        <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-emerald-400" />
        <div className="min-w-0 flex-1">
          <p className="text-[12.5px] font-medium text-zinc-200">{s.headline}</p>
          <p role="status" aria-live="polite" className="mt-1 text-[12.5px] leading-snug text-zinc-400">{state.message}</p>
        </div>
      </li>
    )
  }

  const asksApproval = ev.ask === 'approve'
  // Stopped after it was already in place: there is nothing left to resume.
  const keeps = ev.ask === 'keep_or_undo'
  const rehearsed = rehearsedThisVersion(ev)
  const accessChecked = ev.rehearsal?.authorization === 'passed'

  return (
    <li className={`px-5 py-3.5 transition-colors ${state.phase === 'error' ? 'bg-rose-500/[0.03]' : ''}`}>
      <p className="sr-only" role="status" aria-live="polite">{announced}</p>
      <div className="flex items-start gap-3">
        <span
          className={`mt-1.5 size-1.5 shrink-0 rounded-full ${asksApproval ? 'bg-violet-400' : 'bg-amber-400'} ${
            busy ? 'animate-pulse' : ''
          }`}
        />
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-medium leading-snug text-zinc-100">{s.headline}</p>

          {asksApproval ? (
            <>
              {s.change && <p className="mt-1 text-[12.5px] leading-snug text-zinc-400">{s.change}</p>}
              {s.reason && <p className="mt-1 text-[12.5px] leading-snug text-zinc-400">{s.reason}</p>}
              {RISK_LABEL[ev.risk] && (
                <div className="mt-2">
                  <Tag tone={RISK_TONE[ev.risk]}>{RISK_LABEL[ev.risk]}</Tag>
                </div>
              )}
              <p className="mt-2 text-[12.5px] leading-snug text-zinc-400">
                {s.compatibility}{' '}
                {accessChecked
                  ? s.access ?? ''
                  : 'Who can read or change this data was not checked on the copy, so Backenly does not promise it stays the same.'}
              </p>
              {s.rollback && <p className="mt-1 text-[12.5px] leading-snug text-zinc-400">{s.rollback}</p>}
              {rehearsed ? (
                <p className="mt-2 text-[12px] leading-snug text-zinc-400">
                  {accessChecked
                    ? 'Rehearsed on a copy of your data, including who can read and change it.'
                    : 'Rehearsed on a copy of your data.'}
                </p>
              ) : (
                <p className="mt-2 text-[12px] leading-snug text-zinc-400">
                  Not rehearsed yet. Backenly rehearses a change on a copy of your data before it can be approved.
                </p>
              )}
            </>
          ) : (
            <p className="mt-1 text-[12.5px] leading-snug text-zinc-400">
              {ev.stoppedBecause ? `It stopped because ${lowerFirst(ev.stoppedBecause)}` : 'It stopped part-way.'}
              {keeps ? ' It is still in place. Keep it, or undo it.' : ' Resume it, or undo it.'}
            </p>
          )}

          <p className="mt-1.5 text-[12px] tabular-nums text-zinc-400">{timeAgo(request.detectedAt)}</p>

          <TechnicalDetails
            ev={ev}
            projectId={projectId}
            findingId={request.id}
            open={showTechnical}
            onToggle={() => setShowTechnical(v => !v)}
          />

          {state.phase === 'confirm_undo' && (
            <div className="mt-2 flex items-start gap-2 rounded-md border border-white/[0.08] bg-white/[0.02] px-3 py-2">
              <Undo2 className="mt-px size-3.5 shrink-0 text-zinc-400" />
              <p className="text-[12.5px] leading-snug text-zinc-300">{s.rollback || `Undo puts ${ev.subject} back exactly as it was.`}</p>
            </div>
          )}

          {state.phase === 'moved' && (
            <div className="mt-2 flex items-start gap-2">
              <Info className="mt-px size-3.5 shrink-0 text-amber-400" />
              <p className="text-[12.5px] leading-snug text-amber-200/90">{state.message}</p>
            </div>
          )}

          {state.phase === 'error' && (
            <div className="mt-2 flex items-start gap-2">
              <XCircle className="mt-px size-3.5 shrink-0 text-rose-400" />
              <p role="alert" className="text-[12.5px] leading-snug text-rose-300/90">{state.message}</p>
            </div>
          )}
        </div>

        <div ref={actions} className="flex shrink-0 flex-wrap items-center justify-end gap-2">
          {state.phase === 'error' ? (
            <KitButton variant="secondary" onClick={() => setState({ phase: 'idle' })}>
              Try again
            </KitButton>
          ) : state.phase === 'confirm_undo' ? (
            <>
              <KitButton variant="secondary" onClick={() => setState({ phase: 'idle' })}>
                Cancel
              </KitButton>
              <KitButton variant="danger" onClick={() => decide('undo')}>
                <Undo2 className="size-3.5" /> Undo
              </KitButton>
            </>
          ) : asksApproval ? (
            <>
              <KitButton variant="secondary" onClick={dismiss} disabled={busy}>
                {busyWith('dismiss') ? <Loader2 className="size-3 animate-spin" /> : null}
                Decline
              </KitButton>
              {rehearsed && (
                <KitButton variant="primary" onClick={() => decide('approve')} disabled={busy}>
                  {busyWith('approve') ? (
                    <><Loader2 className="size-3.5 animate-spin" /> Approving…</>
                  ) : (
                    <><CheckCircle2 className="size-3.5" /> Approve</>
                  )}
                </KitButton>
              )}
            </>
          ) : (
            <>
              <KitButton variant="secondary" onClick={dismiss} disabled={busy}>
                {busyWith('dismiss') ? <Loader2 className="size-3 animate-spin" /> : null}
                Not now
              </KitButton>
              <KitButton variant="secondary" onClick={() => setState({ phase: 'confirm_undo' })} disabled={busy}>
                {busyWith('undo') ? <Loader2 className="size-3.5 animate-spin" /> : <Undo2 className="size-3.5" />}
                Undo
              </KitButton>
              <KitButton variant="primary" onClick={() => decide('resume')} disabled={busy}>
                {busyWith('resume') ? (
                  <><Loader2 className="size-3.5 animate-spin" /> {keeps ? 'Keeping…' : 'Resuming…'}</>
                ) : keeps ? 'Keep it' : 'Resume'}
              </KitButton>
            </>
          )}
        </div>
      </div>
    </li>
  )
}

function lowerFirst(s: string): string {
  const t = s.trim()
  const sentence = t.endsWith('.') ? t : `${t}.`
  // Keep an acronym or a table name as written; lower only an ordinary word.
  return /^[A-Z][a-z]/.test(sentence) ? sentence[0].toLowerCase() + sentence.slice(1) : sentence
}

// ── Technical details (opt-in) ───────────────────────────────────────────────

/** A regional project's statements, read when asked for (GET /architecture?statements=). */
type LiveStatements = { phase: 'idle' | 'loading' } | { phase: 'error'; message: string } | { phase: 'shown'; current: boolean; steps: Array<{ sql: string[] }> }

function TechnicalDetails({
  ev,
  projectId,
  findingId,
  open,
  onToggle,
}: {
  ev: EvolutionRequestDetails
  projectId: string
  findingId: string
  open: boolean
  onToggle: () => void
}) {
  const [sqlOpen, setSqlOpen] = useState<Record<number, boolean>>({})
  const [live, setLive] = useState<LiveStatements>({ phase: 'idle' })
  const t = ev.technical
  if (!t) return null
  const showLive = async () => {
    setLive({ phase: 'loading' })
    try {
      const res = await fetch(`/api/projects/${projectId}/architecture?statements=${encodeURIComponent(findingId)}`, { credentials: 'include' })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) return setLive({ phase: 'error', message: j.error ?? 'The statements could not be read.' })
      setLive({ phase: 'shown', current: !!j.current, steps: Array.isArray(j.steps) ? j.steps : [] })
    } catch {
      setLive({ phase: 'error', message: 'The statements could not be read.' })
    }
  }
  // A project kept in another region keeps its statements there: read them
  // when asked, and only while they are still the version being approved.
  const sqlOf = (i: number, stored: string[] | undefined): string[] =>
    stored?.length ? stored : live.phase === 'shown' && live.current ? live.steps[i]?.sql ?? [] : []
  const steps = t.steps ?? []
  const evidence = t.evidence ?? []
  const pressure = t.pressure ?? []
  const blockers = t.contractBlockers ?? []
  const caveats = t.caveats ?? []
  const migration = t.clientMigration ?? []

  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="inline-flex items-center gap-1 text-[12.5px] font-medium text-zinc-500 transition-colors hover:text-zinc-300"
      >
        Technical details
        <ChevronDown className={`size-3 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="mt-2 space-y-3 border-l border-white/[0.08] pl-3 text-[12.5px] leading-snug">
          {steps.length > 0 && (
            <div>
              <p className="font-medium text-zinc-400">Steps</p>
              {t.sqlWithheld && (
                <p className="mt-0.5 text-zinc-500">
                  {live.phase === 'shown' && !live.current
                    ? 'The table changed since this was prepared. Backenly rehearses it again and asks about the new version.'
                    : live.phase === 'error'
                      ? live.message
                      : "This project's exact SQL stays in its region and is not stored outside it."}
                  {live.phase !== 'shown' && (
                    <>
                      {' '}
                      <button
                        type="button"
                        onClick={showLive}
                        disabled={live.phase === 'loading'}
                        className="font-medium text-zinc-400 transition-colors hover:text-zinc-200 disabled:opacity-50"
                      >
                        {live.phase === 'loading' ? 'Reading it…' : 'Show it'}
                      </button>
                    </>
                  )}
                </p>
              )}
              <ol className="mt-1 space-y-2">
                {steps.map((st, i) => (
                  <li key={i}>
                    <p className="text-zinc-300">
                      {i + 1}. {st.title}
                    </p>
                    {st.why && <p className="mt-0.5 text-zinc-500">{st.why}</p>}
                    {st.humanOnly && (
                      <p className="mt-0.5 text-zinc-500">Left to a person. Backenly never runs this step.</p>
                    )}
                    {sqlOf(i, st.sql).length > 0 && (
                      <div className="mt-1">
                        <button
                          type="button"
                          onClick={() => setSqlOpen(prev => ({ ...prev, [i]: !prev[i] }))}
                          aria-expanded={!!sqlOpen[i]}
                          className="inline-flex items-center gap-1 text-[12px] text-zinc-500 transition-colors hover:text-zinc-300"
                        >
                          SQL{sqlOf(i, st.sql).length > 1 ? ` (${sqlOf(i, st.sql).length} statements)` : ''}
                          <ChevronDown className={`size-3 transition-transform ${sqlOpen[i] ? 'rotate-180' : ''}`} />
                        </button>
                        {sqlOpen[i] && (
                          <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-words rounded-md border border-white/[0.07] bg-[#08090a] px-3 py-2 font-mono text-[12px] leading-relaxed text-zinc-300">
                            {sqlOf(i, st.sql).join('\n\n')}
                          </pre>
                        )}
                      </div>
                    )}
                  </li>
                ))}
              </ol>
            </div>
          )}

          {(evidence.length > 0 || pressure.length > 0) && (
            <div>
              <p className="font-medium text-zinc-400">Evidence</p>
              <ul className="mt-1 space-y-0.5">
                {evidence.map((e, i) => (
                  <li key={`e${i}`} className="text-zinc-500">
                    <span className="text-zinc-400">{VERDICT_LABEL[e.verdict] ?? e.verdict}:</span> {e.detail}
                  </li>
                ))}
                {pressure.map((p, i) => (
                  <li key={`p${i}`} className="text-zinc-500">
                    <span className="text-zinc-400">Cost:</span> {p.detail}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {t.semanticBoundary && (
            <div>
              <p className="font-medium text-zinc-400">What this does not decide</p>
              <p className="mt-1 text-zinc-500">{t.semanticBoundary}</p>
            </div>
          )}

          {caveats.length > 0 && (
            <ul className="space-y-0.5">
              {caveats.map((c, i) => (
                <li key={i} className="text-zinc-500">{c}</li>
              ))}
            </ul>
          )}

          {blockers.length > 0 && (
            <div>
              <p className="font-medium text-zinc-400">Before the old columns could ever be removed</p>
              <p className="mt-1 text-zinc-500">
                They stay in place after this change. Someone would first have to migrate:
              </p>
              <ul className="mt-1 list-disc space-y-0.5 pl-4">
                {blockers.map((b, i) => (
                  <li key={i} className="text-zinc-500">{b}</li>
                ))}
              </ul>
            </div>
          )}

          {migration.length > 0 && (
            <div>
              <p className="font-medium text-zinc-400">For your client code, when you are ready</p>
              <ul className="mt-1 space-y-1.5">
                {migration.map((m, i) => (
                  <li key={i}>
                    <p className="text-zinc-500">To {m.purpose}:</p>
                    <p className="font-mono text-[12px] text-zinc-500">before {m.before}</p>
                    <p className="font-mono text-[12px] text-zinc-400">after&nbsp; {m.after}</p>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
