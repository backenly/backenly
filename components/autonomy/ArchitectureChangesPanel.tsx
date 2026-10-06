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
 * from the trust report's `architectureChanges`: the headline, one plain
 * status, the measured outcome when there is one, and when it last changed.
 * Never the internal lifecycle state, never SQL, never evidence; those are for
 * `GET /api/projects/[id]/architecture?detail=1` and the queue row's opt-in
 * technical details.
 *
 * WHAT IT LETS YOU DO
 * -------------------
 * Only what the engine says is possible now (`actions`), each through
 * POST /api/projects/[id]/architecture { action, decisionId }:
 *
 *   Undo     puts the table back exactly as it was; asks once more first
 *   Pause    stops before the next step
 *   Resume   carries on from where it stopped
 *
 * A change that is also waiting in the queue above (it has a `findingId` and
 * its status asks for attention) is shown here without buttons, so one
 * decision is never offered in two places with two sets of buttons. There is
 * no button to remove the old columns, here or anywhere: that step is planned
 * and explained, never run by software.
 */

import { useCallback, useState } from 'react'
import { Layers, Loader2, Pause, Play, Undo2, XCircle } from 'lucide-react'
import { KIT, KitButton, Tag } from '@/components/inspector/kit'
import type { ArchitectureChangeView } from '@/lib/evolution-engine/views'

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
  return !!c.findingId && c.status.tone === 'attention'
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
          return
        }
        setRow(c.decisionId, { phase: 'error', message: j.error || 'That did not go through. Try again in a moment.' })
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
        <span className="text-[12px] tabular-nums text-zinc-600">{shown.length}</span>
      </div>

      <ul className="divide-y divide-white/[0.04]">
        {shown.map(c => (
          <ChangeRow
            key={c.decisionId}
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
  change: c,
  state,
  onUndo,
  onConfirmUndo,
  onPause,
  onResume,
  onCancel,
}: {
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

  return (
    <li className={`px-5 py-3.5 ${state.phase === 'error' ? 'bg-rose-500/[0.03]' : ''}`}>
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-[12.5px] leading-snug text-zinc-100">{c.headline}</p>
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <Tag tone={TONE[c.status.tone] ?? 'neutral'}>{c.status.label}</Tag>
            <span className="text-[12px] tabular-nums text-zinc-600">{timeAgo(c.at)}</span>
          </div>
          {c.outcome?.summary && (
            <p className="mt-1.5 text-[12.5px] leading-snug text-zinc-400">{c.outcome.summary}</p>
          )}
          {queued && <p className="mt-1.5 text-[12px] text-zinc-500">Waiting on you in the queue above.</p>}
          {note && <p className="mt-1.5 text-[12.5px] leading-snug text-zinc-400">{note}</p>}

          {state.phase === 'confirm_undo' && (
            <div className="mt-2 flex items-start gap-2 rounded-md border border-white/[0.08] bg-white/[0.02] px-3 py-2">
              <Undo2 className="mt-px size-3.5 shrink-0 text-zinc-400" />
              <p className="text-[12.5px] leading-snug text-zinc-300">
                Undo puts {c.subject} back exactly as it was. Nothing is lost.
              </p>
            </div>
          )}

          {state.phase === 'error' && (
            <div className="mt-2 flex items-start gap-2">
              <XCircle className="mt-px size-3.5 shrink-0 text-rose-400" />
              <p className="text-[12.5px] leading-snug text-rose-300/90">{state.message}</p>
            </div>
          )}
        </div>

        {!queued && (
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
            {state.phase === 'error' ? (
              <KitButton variant="secondary" onClick={onCancel}>Try again</KitButton>
            ) : state.phase === 'confirm_undo' ? (
              <>
                <KitButton variant="secondary" onClick={onCancel}>Keep it</KitButton>
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
                {c.actions.resume && (
                  <KitButton variant="secondary" onClick={onResume} disabled={busy}>
                    {busyWith('resume') ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
                    Resume
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
