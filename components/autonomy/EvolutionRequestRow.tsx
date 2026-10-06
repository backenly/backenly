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
 * already has the badge, the count and the dismiss path. What it did not have
 * is a way to give consent that is bound to one exact plan version, so this row
 * carries exactly that and nothing more.
 *
 * WHAT A PERSON SEES BY DEFAULT
 * -----------------------------
 * The headline, what changes and why, three small facts (how risky, that
 * existing apps keep working, that it can be undone), whether it was rehearsed
 * on a copy, and two buttons. A change that stopped part-way asks a different
 * question (resume it, or undo it) and says why it stopped in one sentence.
 *
 * Everything else, the steps with their exact SQL, the evidence, what this
 * change deliberately does not decide and what someone would have to migrate
 * before the old columns could ever be removed, sits behind one "Technical
 * details" toggle. Internal lifecycle states are never shown, and nothing here
 * ever offers to remove the old columns: that step is planned and explained,
 * never run by software, and so never a button.
 *
 * WHERE THE DECISIONS GO
 * ----------------------
 *   Approve   POST /api/projects/[id]/architecture { action: 'approve', findingId, planVersion }
 *             The plan version is the one on screen. A 409 means the world moved
 *             (the table changed and Backenly re-checked it, or someone else is
 *             already approving): the row says so and asks the queue to re-read,
 *             so the next click consents to what the person is now looking at.
 *   Resume /  POST /api/projects/[id]/architecture { action, decisionId }
 *   Undo      Undo asks once more before it runs.
 *   Not now   POST /api/projects/[id]/health { findingId } (the queue's dismiss;
 *             a 409 means someone already decided it, and the queue re-reads)
 *
 * Never /health/approve or /approvals: both refuse this type, and neither can
 * bind consent to a plan version.
 */

import { useEffect, useRef, useState } from 'react'
import { CheckCircle2, ChevronDown, Info, Loader2, Undo2, XCircle } from 'lucide-react'
import { KitButton, Tag } from '@/components/inspector/kit'
import type { EvolutionRequestDetails } from '@/lib/evolution-engine/request'
import type { RiskLevel } from '@/lib/evolution-engine/policy'

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
  useEffect(() => () => { timers.current.forEach(clearTimeout) }, [])

  const ev = evolutionOf(request)

  const settle = (message: string) => {
    setState({ phase: 'done', message })
    onDecided?.(message)
    timers.current.push(setTimeout(() => { void onRefresh() }, SETTLE_MS))
  }

  const post = async (url: string, body: Record<string, unknown>) => {
    const res = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const j = await res.json().catch(() => ({} as Record<string, unknown>))
    return { res, j: (j ?? {}) as { ok?: boolean; message?: string; error?: string } }
  }

  const decide = async (action: 'approve' | 'resume' | 'undo') => {
    if (!ev) return
    setState({ phase: 'busy', action })
    try {
      const body =
        action === 'approve'
          ? { action, findingId: request.id, planVersion: ev.planVersion }
          : { action, decisionId: ev.decisionId }
      const { res, j } = await post(`/api/projects/${projectId}/architecture`, body)
      if (res.ok && j.ok) {
        settle(j.message || (action === 'undo' ? 'Undone.' : action === 'resume' ? 'Resumed.' : 'Approved.'))
        return
      }
      if (res.status === 409) {
        setState({ phase: 'moved', message: j.error || 'This change moved on since you opened it. Here is the current version.' })
        await onRefresh()
        return
      }
      setState({ phase: 'error', message: j.error || 'That did not go through. Try again in a moment.' })
    } catch {
      setState({ phase: 'error', message: 'Network error. Check your connection and try again.' })
    }
  }

  const notNow = async () => {
    setState({ phase: 'busy', action: 'dismiss' })
    try {
      const { res, j } = await post(`/api/projects/${projectId}/health`, { findingId: request.id })
      if (res.status === 409) {
        // Someone already decided it; show where it is now.
        setState({ phase: 'moved', message: j.error || 'This change was already decided.' })
        await onRefresh()
        return
      }
      if (!res.ok) {
        setState({ phase: 'error', message: 'Could not dismiss. Try again.' })
        return
      }
      await onRefresh()
    } catch {
      setState({ phase: 'error', message: 'Network error. Try again.' })
    }
  }

  // A row this page cannot read is still a row the person can clear.
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
              <p className="mt-1 text-[12.5px] leading-snug text-rose-300/90">{state.message}</p>
            )}
          </div>
          <KitButton variant="secondary" onClick={notNow} disabled={state.phase === 'busy'}>
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
          <p className="mt-1 text-[12.5px] leading-snug text-zinc-400">{state.message}</p>
        </div>
      </li>
    )
  }

  const asksApproval = ev.ask === 'approve'
  const rehearsed = rehearsedThisVersion(ev)

  return (
    <li className={`px-5 py-3.5 transition-colors ${state.phase === 'error' ? 'bg-rose-500/[0.03]' : ''}`}>
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
              {s.reason && <p className="mt-1 text-[12.5px] leading-snug text-zinc-500">{s.reason}</p>}
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                {RISK_LABEL[ev.risk] && <Tag tone={RISK_TONE[ev.risk]}>{RISK_LABEL[ev.risk]}</Tag>}
                <span title={s.compatibility || undefined}>
                  <Tag>Existing apps keep working</Tag>
                </span>
                <span title={s.rollback || undefined}>
                  <Tag>Can be undone</Tag>
                </span>
              </div>
              {rehearsed ? (
                <p className="mt-2 text-[12px] leading-snug text-zinc-500">
                  {ev.rehearsal.authorization === 'passed'
                    ? 'Rehearsed on a copy of your data, including who can read and change it.'
                    : 'Rehearsed on a copy of your data.'}
                </p>
              ) : (
                <p className="mt-2 text-[12px] leading-snug text-zinc-500">
                  Not rehearsed yet. Backenly rehearses a change on a copy of your data before it can be approved.
                </p>
              )}
            </>
          ) : (
            <p className="mt-1 text-[12.5px] leading-snug text-zinc-400">
              {ev.stoppedBecause ? `It stopped because ${lowerFirst(ev.stoppedBecause)}` : 'It stopped part-way.'}
              {' '}Resume it, or undo it.
            </p>
          )}

          <p className="mt-1.5 text-[12px] text-zinc-600">{timeAgo(request.detectedAt)}</p>

          <TechnicalDetails ev={ev} open={showTechnical} onToggle={() => setShowTechnical(v => !v)} />

          {state.phase === 'confirm_undo' && (
            <div className="mt-2 flex items-start gap-2 rounded-md border border-white/[0.08] bg-white/[0.02] px-3 py-2">
              <Undo2 className="mt-px size-3.5 shrink-0 text-zinc-400" />
              <p className="text-[12.5px] leading-snug text-zinc-300">
                Undo puts {ev.subject} back exactly as it was. Nothing is lost.
              </p>
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
              <p className="text-[12.5px] leading-snug text-rose-300/90">{state.message}</p>
            </div>
          )}
        </div>

        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
          {state.phase === 'error' ? (
            <KitButton variant="secondary" onClick={() => setState({ phase: 'idle' })}>
              Try again
            </KitButton>
          ) : state.phase === 'confirm_undo' ? (
            <>
              <KitButton variant="secondary" onClick={() => setState({ phase: 'idle' })}>
                Keep it
              </KitButton>
              <KitButton variant="danger" onClick={() => decide('undo')}>
                <Undo2 className="size-3.5" /> Undo
              </KitButton>
            </>
          ) : asksApproval ? (
            <>
              <KitButton variant="secondary" onClick={notNow} disabled={busy}>
                {busyWith('dismiss') ? <Loader2 className="size-3 animate-spin" /> : null}
                Not now
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
              <KitButton variant="secondary" onClick={notNow} disabled={busy}>
                {busyWith('dismiss') ? <Loader2 className="size-3 animate-spin" /> : null}
                Not now
              </KitButton>
              <KitButton variant="secondary" onClick={() => setState({ phase: 'confirm_undo' })} disabled={busy}>
                {busyWith('undo') ? <Loader2 className="size-3.5 animate-spin" /> : <Undo2 className="size-3.5" />}
                Undo
              </KitButton>
              <KitButton variant="primary" onClick={() => decide('resume')} disabled={busy}>
                {busyWith('resume') ? <><Loader2 className="size-3.5 animate-spin" /> Resuming…</> : 'Resume'}
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

function TechnicalDetails({
  ev,
  open,
  onToggle,
}: {
  ev: EvolutionRequestDetails
  open: boolean
  onToggle: () => void
}) {
  const [sqlOpen, setSqlOpen] = useState<Record<number, boolean>>({})
  const t = ev.technical
  if (!t) return null
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
                    {st.sql?.length > 0 && (
                      <div className="mt-1">
                        <button
                          type="button"
                          onClick={() => setSqlOpen(prev => ({ ...prev, [i]: !prev[i] }))}
                          aria-expanded={!!sqlOpen[i]}
                          className="inline-flex items-center gap-1 text-[12px] text-zinc-500 transition-colors hover:text-zinc-300"
                        >
                          SQL{st.sql.length > 1 ? ` (${st.sql.length} statements)` : ''}
                          <ChevronDown className={`size-3 transition-transform ${sqlOpen[i] ? 'rotate-180' : ''}`} />
                        </button>
                        {sqlOpen[i] && (
                          <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-words rounded-md border border-white/[0.07] bg-[#08090a] px-3 py-2 font-mono text-[12px] leading-relaxed text-zinc-300">
                            {st.sql.join('\n\n')}
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
                    <p className="font-mono text-[12px] text-zinc-600">before {m.before}</p>
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
