'use client'

/**
 * ArchitectureChangesPanel — the architecture changes a person approved, and
 * what became of them, in plain sentences.
 *
 * WHY THIS EXISTS
 * ---------------
 * Approving an architecture change happens in the "Waiting on you" queue
 * (components/autonomy/EvolutionRequestRow.tsx). After that the request leaves
 * the queue, and without this card a person would have nowhere to see that the
 * change is running, that it finished, whether it helped, or to take it back.
 * It is one card on the Autonomy page, not a dashboard: it renders nothing at
 * all until there is a change to show, and at most five.
 *
 * WHAT IT SHOWS
 * -------------
 * Each row is an ArchitectureChangeView (lib/evolution-engine/views.ts), read
 * from the trust report's `architectureChanges`: a short headline ("Backenly
 * improved your Orders architecture."), the sentence under it (what was done,
 * that verification passed, that undo is available, or why it stopped), one
 * plain status, whether it helped in one clause, and when it last changed.
 * Never the internal lifecycle state, a step, SQL, evidence or a count.
 *
 * "View details" is the one way further in: the change's own history, each
 * sentence Backenly wrote about it, and the measured numbers behind the
 * outcome, read when asked (GET /api/projects/[id]/architecture?decision=).
 *
 * WHAT IT LETS YOU DO
 * -------------------
 * Only what the engine says is possible now (`actions`), each through
 * POST /api/projects/[id]/architecture { action, decisionId }, which needs an
 * organization admin:
 *
 *   Undo     says what it removes and what stops working; asks once more first
 *   Pause    stops before the next step, while the change carries itself on
 *   Resume   carries on from where it stopped, where nothing carries it on
 *   Keep it  a change that stopped after it was in place stays, watched again
 *
 * Pause and Resume are never offered together. A change that also has a row
 * waiting in the queue above is shown here without buttons, so one decision is
 * never offered in two places. There is no button to remove the old columns,
 * here or anywhere: that step is planned and explained, never run by software.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronDown, Layers, Loader2, Pause, Play, Undo2, XCircle } from 'lucide-react'
import { KIT, KitButton, Tag } from '@/components/inspector/kit'
import type { ArchitectureChangeView } from '@/lib/evolution-engine/views'
import { ADMIN_ONLY, announceArchitectureChange } from './architecture-decisions'

type Action = 'undo' | 'pause' | 'resume'

type RowState =
  | { phase: 'idle'; note?: string }
  | { phase: 'confirm_undo' }
  | { phase: 'busy'; action: Action }
  | { phase: 'error'; message: string }

/** How many changes the card lists. Older ones are in the activity feed. */
const MAX_ROWS = 5

const CARD = `relative overflow-hidden ${KIT.radius} border ${KIT.border} ${KIT.surface} ${KIT.inset}`

const TONE: Record<ArchitectureChangeView['status']['tone'], 'neutral' | 'warn' | 'violet' | 'good' | 'bad'> = {
  neutral: 'neutral',
  attention: 'warn',
  progress: 'violet',
  good: 'good',
  bad: 'bad',
}

function timeAgo(iso: string): string {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 5) return 'just now'
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

/** Waiting in the queue above: decided there, not here. */
function inQueue(c: ArchitectureChangeView): boolean {
  return !!c.findingId
}

export function ArchitectureChangesPanel({
  projectId,
  changes,
  onChanged,
}: {
  projectId: string
  changes: ArchitectureChangeView[]
  /** Refetch the trust report after an action, so the status is the server's. */
  onChanged: () => void
}) {
  const [rowState, setRowState] = useState<Record<string, RowState>>({})

  const setRow = useCallback((id: string, s: RowState) => {
    setRowState(prev => ({ ...prev, [id]: s }))
  }, [])

  const act = useCallback(
    async (c: ArchitectureChangeView, action: Action) => {
      setRow(c.decisionId, { phase: 'busy', action })
      try {
        const res = await fetch(`/api/projects/${projectId}/architecture`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action, decisionId: c.decisionId }),
        })
        const j = ((await res.json().catch(() => ({}))) ?? {}) as { ok?: boolean; message?: string; error?: string }
        if (res.ok && j.ok) {
          setRow(c.decisionId, { phase: 'idle', note: j.message })
          onChanged()
          announceArchitectureChange('card')
          return
        }
        setRow(c.decisionId, {
          phase: 'error',
          message: res.status === 403 ? ADMIN_ONLY : j.error || 'That did not go through. Try again in a moment.',
        })
        // A refusal means the change moved on (someone else decided, or the
        // table changed). Re-read so the buttons match what is possible now.
        if (res.status === 409) onChanged()
      } catch {
        setRow(c.decisionId, { phase: 'error', message: 'Network error. Check your connection and try again.' })
      }
    },
    [projectId, setRow, onChanged],
  )

  if (changes.length === 0) return null
  const shown = changes.slice(0, MAX_ROWS)

  return (
    <section className={CARD} aria-labelledby="architecture-changes">
      <div className="flex items-center gap-2 border-b border-white/[0.06] px-5 py-3.5">
        <Layers className="size-3.5 text-zinc-400" />
        <h3 id="architecture-changes" className="text-[13px] font-semibold tracking-tight text-zinc-100">
          Architecture changes
        </h3>
        <span className="text-[12px] tabular-nums text-zinc-400">{shown.length}</span>
      </div>

      <ul className="divide-y divide-white/[0.04]">
        {shown.map(c => (
          <ChangeRow
            key={c.decisionId}
            projectId={projectId}
            change={c}
            state={rowState[c.decisionId] ?? { phase: 'idle' }}
            onUndo={() => setRow(c.decisionId, { phase: 'confirm_undo' })}
            onConfirmUndo={() => act(c, 'undo')}
            onPause={() => act(c, 'pause')}
            onResume={() => act(c, 'resume')}
            onCancel={() => setRow(c.decisionId, { phase: 'idle' })}
          />
        ))}
      </ul>
    </section>
  )
}

// ── Row ──────────────────────────────────────────────────────────────────────

function ChangeRow({
  projectId,
  change: c,
  state,
  onUndo,
  onConfirmUndo,
  onPause,
  onResume,
  onCancel,
}: {
  projectId: string
  change: ArchitectureChangeView
  state: RowState
  onUndo: () => void
  onConfirmUndo: () => void
  onPause: () => void
  onResume: () => void
  onCancel: () => void
}) {
  const busy = state.phase === 'busy'
  const busyWith = (a: Action) => state.phase === 'busy' && state.action === a
  const queued = inQueue(c)
  const note = state.phase === 'idle' ? state.note : undefined
  const undoEffect = c.undoEffect || `Undo puts ${c.subject} back exactly as it was.`
  const buttons = useRef<HTMLDivElement>(null)
  const previous = useRef<RowState['phase']>('idle')

  // Keyboard focus follows the confirmation, as on the queue row.
  useEffect(() => {
    const all = () => [...(buttons.current?.querySelectorAll('button') ?? [])]
    if (state.phase === 'confirm_undo') all()[0]?.focus()
    else if (previous.current === 'confirm_undo' && state.phase === 'idle') all().find(b => /Undo/.test(b.textContent ?? ''))?.focus()
    previous.current = state.phase
  }, [state.phase])

  const announced = note ?? (state.phase === 'confirm_undo' ? `Undo? ${undoEffect}` : '')

  return (
    <li className={`px-5 py-3.5 ${state.phase === 'error' ? 'bg-rose-500/[0.03]' : ''}`}>
      <p className="sr-only" role="status" aria-live="polite">{announced}</p>
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-medium leading-snug text-zinc-100">{c.headline}</p>
          {c.detail && <p className="mt-1 text-[12.5px] leading-snug text-zinc-400">{c.detail}</p>}
          {c.waiting && <p className="mt-1 text-[12.5px] leading-snug text-zinc-400">{c.waiting}</p>}
          {c.outcome?.plain && <p className="mt-1 text-[12.5px] leading-snug text-zinc-300">{c.outcome.plain}</p>}
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <Tag tone={TONE[c.status.tone] ?? 'neutral'}>{c.status.label}</Tag>
            <span className="text-[12px] tabular-nums text-zinc-400">{timeAgo(c.at)}</span>
          </div>
          {queued && <p className="mt-1.5 text-[12px] text-zinc-400">Waiting on you in the queue above.</p>}
          {note && <p className="mt-1.5 text-[12.5px] leading-snug text-zinc-400">{note}</p>}

          <Details projectId={projectId} decisionId={c.decisionId} measured={c.outcome?.summary} />

          {state.phase === 'confirm_undo' && (
            <div className="mt-2 flex items-start gap-2 rounded-md border border-white/[0.08] bg-white/[0.02] px-3 py-2">
              <Undo2 className="mt-px size-3.5 shrink-0 text-zinc-400" />
              <p className="text-[12.5px] leading-snug text-zinc-300">{undoEffect}</p>
            </div>
          )}

          {state.phase === 'error' && (
            <div className="mt-2 flex items-start gap-2">
              <XCircle className="mt-px size-3.5 shrink-0 text-rose-400" />
              <p role="alert" className="text-[12.5px] leading-snug text-rose-300/90">{state.message}</p>
            </div>
          )}
        </div>

        {!queued && (
          <div ref={buttons} className="flex shrink-0 flex-wrap items-center justify-end gap-2">
            {state.phase === 'error' ? (
              <KitButton variant="secondary" onClick={onCancel}>Try again</KitButton>
            ) : state.phase === 'confirm_undo' ? (
              <>
                <KitButton variant="secondary" onClick={onCancel}>Cancel</KitButton>
                <KitButton variant="danger" onClick={onConfirmUndo}>
                  <Undo2 className="size-3.5" /> Undo
                </KitButton>
              </>
            ) : (
              <>
                {c.actions.pause && (
                  <KitButton variant="secondary" onClick={onPause} disabled={busy}>
                    {busyWith('pause') ? <Loader2 className="size-3.5 animate-spin" /> : <Pause className="size-3.5" />}
                    Pause
                  </KitButton>
                )}
                {(c.actions.resume || c.actions.keep) && (
                  <KitButton variant="secondary" onClick={onResume} disabled={busy}>
                    {busyWith('resume') ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
                    {c.actions.keep ? 'Keep it' : 'Resume'}
                  </KitButton>
                )}
                {c.actions.undo && (
                  <KitButton variant="secondary" onClick={onUndo} disabled={busy}>
                    {busyWith('undo') ? <Loader2 className="size-3.5 animate-spin" /> : <Undo2 className="size-3.5" />}
                    Undo
                  </KitButton>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </li>
  )
}

// ── View details (opt-in) ────────────────────────────────────────────────────

type History = { phase: 'closed' | 'loading' } | { phase: 'error' } | { phase: 'open'; entries: Array<{ at: string; sentence: string }> }

/**
 * The change's own history, read when asked: every sentence Backenly wrote for
 * a person about it, oldest first, and the numbers behind its outcome.
 */
function Details({ projectId, decisionId, measured }: { projectId: string; decisionId: string; measured?: string }) {
  const [history, setHistory] = useState<History>({ phase: 'closed' })
  const open = history.phase === 'open' || history.phase === 'loading'

  const toggle = async () => {
    if (open) return setHistory({ phase: 'closed' })
    setHistory({ phase: 'loading' })
    try {
      const res = await fetch(`/api/projects/${projectId}/architecture?decision=${encodeURIComponent(decisionId)}`, { credentials: 'include' })
      const j = (await res.json().catch(() => ({}))) as { trail?: Array<{ at: string; sentence: string; milestone: boolean }> }
      if (!res.ok || !Array.isArray(j.trail)) return setHistory({ phase: 'error' })
      setHistory({ phase: 'open', entries: j.trail.filter(t => t.milestone && t.sentence).map(t => ({ at: t.at, sentence: t.sentence })) })
    } catch {
      setHistory({ phase: 'error' })
    }
  }

  return (
    <div className="mt-1.5">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="inline-flex items-center gap-1 text-[12.5px] font-medium text-zinc-400 transition-colors hover:text-zinc-200"
      >
        View details
        <ChevronDown className={`size-3 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {history.phase === 'loading' && <p className="mt-1 text-[12.5px] text-zinc-400">Reading its history…</p>}
      {history.phase === 'error' && <p role="alert" className="mt-1 text-[12.5px] text-rose-300/90">Its history could not be read. Try again in a moment.</p>}
      {history.phase === 'open' && (
        <div className="mt-2 space-y-2 border-l border-white/[0.08] pl-3 text-[12.5px] leading-snug">
          {measured && (
            <div>
              <p className="font-medium text-zinc-300">What was measured</p>
              <p className="mt-0.5 text-zinc-400">{measured}</p>
            </div>
          )}
          <ol className="space-y-1">
            {history.entries.map((e, i) => (
              <li key={i} className="text-zinc-400">
                <span className="tabular-nums">{timeAgo(e.at)}</span> {e.sentence}
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  )
}
