'use client'

/**
 * Restore to this point: the backend as it was right after one change, or
 * when a version was published.
 *
 * It lists what it would undo, newest first, before anything runs
 * (GET …/changes/restore-to). Running it undoes those changes one by one, each
 * an ordinary restore with its own proof and its own record
 * (lib/changes/range.ts), and stops at the first one that needs a person,
 * which opens in its own Restore dialog. What it restored before stopping
 * stays restored.
 */

import { useEffect, useState } from 'react'
import { AlertCircle, AlertTriangle, Check } from 'lucide-react'
import { KitButton, KitModal, KitNote, Skeleton } from '@/components/inspector/kit'
import type { RangeOutcome, RangePlan, RangeStop } from '@/lib/changes/range'

export type RestorePoint = { after: number; label: string; detail: string } | { version: number; label: string; detail: string }

type Phase =
  | { kind: 'loading' }
  | { kind: 'ready'; plan: RangePlan }
  | { kind: 'running'; plan: RangePlan }
  | { kind: 'done'; outcome: RangeOutcome; versionCurrent: boolean }
  | { kind: 'error'; message: string }

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

function StepList({ items }: { items: Array<{ seq: number; summary: string; tail?: string }> }) {
  return (
    <ul className="max-h-[248px] divide-y divide-white/[0.05] overflow-y-auto rounded-[8px] border border-white/[0.07]">
      {items.map((s, i) => (
        <li key={`${s.seq}-${i}`} className="grid grid-cols-[2.75rem_minmax(0,1fr)_auto] items-baseline gap-x-2 px-3 py-2 text-[12.5px]">
          <span className="font-mono tabular-nums text-faint">#{s.seq}</span>
          <span className="truncate text-zinc-200" title={s.summary}>{s.summary}</span>
          {s.tail && <span className="text-faint">{s.tail}</span>}
        </li>
      ))}
    </ul>
  )
}

export function RestoreToDialog({
  projectId,
  point,
  onClose,
  onDone,
  onOpenChange,
}: {
  projectId: string
  point: RestorePoint
  onClose: () => void
  /** After anything was restored: re-read the list. */
  onDone: () => void
  /** Open one change's own Restore dialog: the step that stopped it. */
  onOpenChange: (id: string) => void
}) {
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' })
  const [note, setNote] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)
  const query = 'version' in point ? `version=${point.version}` : `after=${point.after}`
  const pointName = 'version' in point ? `v${point.version}` : `#${point.after}`

  useEffect(() => {
    let cancelled = false
    fetch(`/api/projects/${projectId}/changes/restore-to?${query}`, { credentials: 'include' })
      .then(async (res) => ({ ok: res.ok, body: await res.json().catch(() => ({})) }))
      .then(({ ok, body }) => {
        if (cancelled) return
        if (ok && body.plan) setPhase({ kind: 'ready', plan: body.plan })
        else setPhase({ kind: 'error', message: body.error || 'Could not read the history. Try again in a moment.' })
      })
      .catch(() => { if (!cancelled) setPhase({ kind: 'error', message: 'Could not reach Backenly. Try again in a moment.' }) })
    return () => { cancelled = true }
  }, [projectId, query, nonce])

  const run = async (plan: RangePlan) => {
    setPhase({ kind: 'running', plan })
    const res = await fetch(`/api/projects/${projectId}/changes/restore-to`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...('version' in point ? { version: point.version } : { after: point.after }), steps: plan.steps.map((s) => s.recordId) }),
    }).catch(() => null)
    const body = res ? await res.json().catch(() => ({})) : { error: 'Could not reach Backenly. Nothing was changed.' }
    if (res?.ok && body.success) {
      setPhase({ kind: 'done', outcome: body.outcome, versionCurrent: !!body.versionCurrent })
      if (body.outcome.restored.length > 0) onDone()
      return
    }
    if (body.code === 'STALE_PAGE') {
      setNote('The history changed since you opened this. This is what it would undo now.')
      setPhase({ kind: 'loading' })
      setNonce((n) => n + 1)
      return
    }
    setPhase({ kind: 'error', message: body.error || 'It did not run. Nothing was changed.' })
  }

  const plan = phase.kind === 'ready' || phase.kind === 'running' ? phase.plan : null
  const nothing = plan && plan.steps.length === 0 && !plan.stop

  const footer =
    phase.kind === 'done' || phase.kind === 'error' || nothing || (plan && plan.steps.length === 0) ? (
      <KitButton variant={phase.kind === 'done' && !phase.outcome.stoppedAt ? 'primary' : 'secondary'} onClick={onClose}>
        {phase.kind === 'done' && !phase.outcome.stoppedAt ? 'Done' : 'Close'}
      </KitButton>
    ) : plan ? (
      <>
        <KitButton variant="ghost" onClick={onClose} disabled={phase.kind === 'running'}>Cancel</KitButton>
        <KitButton variant="primary" onClick={() => void run(plan)} loading={phase.kind === 'running'}>
          {`Restore ${plural(plan.steps.length, 'change')}`}
        </KitButton>
      </>
    ) : (
      <KitButton variant="ghost" onClick={onClose}>Cancel</KitButton>
    )

  const stopNote = (stop: RangeStop, restoredCount: number | null) => (
    <KitNote
      tone="warn"
      icon={AlertTriangle}
      actions={
        stop.code === 'NEEDS_APPROVAL' || stop.code === 'BLOCKED' || stop.code === 'UNAVAILABLE' ? (
          <KitButton size="sm" variant="ghost" onClick={() => onOpenChange(stop.id)}>Review #{stop.seq}</KitButton>
        ) : undefined
      }
    >
      <span className="[overflow-wrap:anywhere]">
        {/* After a run, the title says where it stopped. */}
        {restoredCount === null ? `Stops at #${stop.seq}: ` : restoredCount > 0 ? `${plural(restoredCount, 'change')} restored before it. ` : ''}
        {stop.reason}
      </span>
    </KitNote>
  )

  return (
    <KitModal
      open
      onClose={phase.kind === 'running' ? () => {} : onClose}
      title={
        phase.kind === 'done'
          ? phase.outcome.stoppedAt ? `Stopped at #${phase.outcome.stoppedAt.seq}` : `Restored to ${pointName}`
          : `Restore to ${pointName}`
      }
      description={<span className="[overflow-wrap:anywhere]">{point.detail}</span>}
      footer={footer}
      width="max-w-lg"
    >
      {phase.kind === 'loading' ? (
        <div className="space-y-3 py-1" aria-busy="true" aria-label="Reading the history">
          <Skeleton className="h-[13px] w-4/5" />
          <Skeleton className="h-[96px] w-full" />
        </div>
      ) : phase.kind === 'error' ? (
        <KitNote tone="danger" icon={AlertTriangle}><span className="[overflow-wrap:anywhere]">{phase.message}</span></KitNote>
      ) : phase.kind === 'done' ? (
        <div className="space-y-4">
          {phase.outcome.stoppedAt ? (
            stopNote(phase.outcome.stoppedAt, phase.outcome.restored.length)
          ) : (
            <KitNote tone="success" icon={Check}>
              {phase.outcome.restored.length > 0
                ? `The backend is back to how it was ${'version' in point ? `when v${point.version} was published` : `after #${point.after}`}. ${plural(phase.outcome.restored.length, 'change')} restored, each one verified.`
                : 'Nothing needed restoring.'}
              {phase.versionCurrent ? ` v${'version' in point ? point.version : ''} is the current version again.` : ''}
            </KitNote>
          )}
          {phase.outcome.restored.length > 0 && (
            <StepList items={phase.outcome.restored.map((r) => ({ seq: r.seq, summary: r.summary, tail: r.action === 'reapply' ? 'Reapplied' : undefined }))} />
          )}
          {phase.outcome.kept.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-[12.5px] text-zinc-400">Stayed as {phase.outcome.kept.length === 1 ? 'it is' : 'they are'}:</p>
              <ul className="space-y-1.5">
                {phase.outcome.kept.map((k) => (
                  <li key={k.id} className="text-[12.5px] leading-[18px] [overflow-wrap:anywhere]">
                    <span className="text-zinc-200">#{k.seq} · {k.summary}</span>
                    <span className="block text-faint">{k.reason}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      ) : nothing ? (
        <KitNote tone="info" icon={AlertCircle}>
          Nothing has changed since {'version' in point ? `v${point.version} was published` : `#${point.after}`}. The backend is already as it was then.
        </KitNote>
      ) : plan ? (
        <div className="space-y-4">
          {note && <KitNote tone="info" icon={AlertCircle}>{note}</KitNote>}
          {plan.steps.length > 0 && (
            <>
              <p className="text-[13px] leading-[20px] text-zinc-300 [text-wrap:pretty]">
                Undoes the {plural(plan.steps.length, 'change')} made since, newest first. Each one is checked before it runs, and
                if one needs your approval, it stops there and asks.
              </p>
              <StepList items={plan.steps.map((s) => ({ seq: s.seq, summary: s.summary, tail: s.action === 'reapply' ? 'Reapply' : undefined }))} />
            </>
          )}
          {plan.stop && stopNote(plan.stop, null)}
        </div>
      ) : null}
    </KitModal>
  )
}
