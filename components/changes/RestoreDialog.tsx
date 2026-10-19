'use client'

/**
 * Restore previous state: one question, four checks, one button.
 *
 * Backenly proves the restore first (POST …/preview, lib/changes/recovery.ts):
 * the restore point is intact, the current state is saved before anything
 * changes, the plan runs end to end without changing anything, and nothing
 * written since the change would be lost. When all four hold, the button
 * restores. When the restore would set aside or convert data written since,
 * the dialog says exactly what, and the person approves exactly that (the
 * server re-measures under lock and refuses if it grew). When it cannot run,
 * it says why and what would clear it. The statements are in View details,
 * not here.
 *
 * The same dialog reapplies a change a person restored, acting on the record
 * of that restore.
 */

import { useEffect, useState } from 'react'
import { AlertCircle, AlertTriangle, Check, ChevronDown, ChevronRight, X } from 'lucide-react'
import { KitButton, KitModal, KitNote, Skeleton } from '@/components/inspector/kit'
import type { ChangeSummary } from '@/lib/changes/history'
import type { RecoveryPreview } from '@/lib/changes/recovery'

/** What each effect of a restore on data written since is, in a few words. */
const EFFECT: Record<string, string> = {
  rows_set_aside: 'Rows set aside',
  values_set_aside: 'Values set aside',
  values_converted: 'Values converted back',
  restore_incomplete: 'Comes back without its data',
  unknown_since: 'New rows cannot be told apart',
  writes_kept: 'Changed since, kept as they are',
  rows_without_value: 'Written since, left empty',
}
/** The effects whose count is a number of rows or values. */
const COUNTED = new Set(['rows_set_aside', 'values_set_aside', 'values_converted', 'writes_kept', 'rows_without_value'])

type Phase =
  | { kind: 'checking' }
  | { kind: 'ready'; preview: RecoveryPreview }
  | { kind: 'running'; preview: RecoveryPreview }
  | { kind: 'done'; message: string }
  | { kind: 'error'; message: string; preview?: RecoveryPreview }

async function post(url: string, body?: unknown): Promise<{ ok: boolean; status: number; body: any }> {
  const res = await fetch(url, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
  return { ok: res.ok, status: res.status, body: await res.json().catch(() => ({})) }
}

export function RestoreDialog({
  projectId,
  change,
  onClose,
  onDone,
  onOpenChange,
}: {
  projectId: string
  change: ChangeSummary
  onClose: () => void
  /** After a restore or reapply took effect: re-read the list. */
  onDone: () => void
  /** Open another change, e.g. a later one in the way. */
  onOpenChange: (id: string) => void
}) {
  const action = change.action
  const reapply = action?.kind === 'reapply'
  const recordId = action?.recordId ?? change.id
  const unavailable = !action || !action.available
  const [phase, setPhase] = useState<Phase>(
    unavailable ? { kind: 'error', message: action?.reason ?? 'This change cannot be restored.' } : { kind: 'checking' },
  )
  const [nonce, setNonce] = useState(0)
  // Why the checks were run again, when they were.
  const [note, setNote] = useState<string | null>(null)
  const [showAffected, setShowAffected] = useState(false)

  // The proof. State is set only once the answer is in.
  useEffect(() => {
    if (unavailable) return
    let cancelled = false
    post(`/api/projects/${projectId}/changes/${recordId}/preview`)
      .then(({ ok, body }) => {
        if (cancelled) return
        if (ok && body.preview) setPhase({ kind: 'ready', preview: body.preview })
        else setPhase({ kind: 'error', message: body.error || 'Could not check this restore. Try again in a moment.' })
      })
      .catch(() => { if (!cancelled) setPhase({ kind: 'error', message: 'Could not reach Backenly. Try again in a moment.' }) })
    return () => { cancelled = true }
  }, [projectId, recordId, unavailable, nonce])


  const run = async (preview: RecoveryPreview) => {
    setPhase({ kind: 'running', preview })
    const { ok, body } = await post(`/api/projects/${projectId}/changes/${recordId}/restore`, {
      seq: preview.seq,
      ...(preview.safety === 'needs_approval' && preview.acknowledgement ? { acknowledged: preview.acknowledgement } : {}),
    }).catch(() => ({ ok: false, status: 0, body: { error: 'Could not reach Backenly. Nothing was changed.' } }))
    if (ok && body.success) {
      const kept = (body.impact?.items ?? []).filter((i: { effect: string }) => i.effect === 'writes_kept').length > 0
      setPhase({
        kind: 'done',
        message: reapply
          ? 'The change is back in effect, and verified.'
          : `The state before #${change.seq} is back, and verified.${kept ? ' Data written since was kept.' : ''}`,
      })
      onDone()
      return
    }
    switch (body.code) {
      case 'IMPACT_CHANGED':
      case 'NEEDS_APPROVAL':
        // The data moved since the check: check again and show what it is now.
        setNote('The data changed since this was checked. This is what restoring would do now.')
        setPhase({ kind: 'checking' })
        setNonce((n) => n + 1)
        return
      case 'STALE_PAGE':
        onDone()
        setPhase({ kind: 'error', message: body.error, preview })
        return
      default:
        setPhase({ kind: 'error', message: body.error || 'The restore did not run. Nothing was changed.', preview })
    }
  }

  const preview = phase.kind === 'ready' || phase.kind === 'running' ? phase.preview : phase.kind === 'error' ? phase.preview : undefined
  const safety = preview?.safety

  const title =
    phase.kind === 'done'
      ? (reapply ? 'Change reapplied' : 'Previous state restored')
      : safety === 'needs_approval'
        ? 'Restore requires approval'
        : safety === 'blocked' || safety === 'unavailable' || (phase.kind === 'error' && !preview)
          ? (reapply ? 'Can’t reapply this change' : 'Can’t restore this change')
          : reapply
            ? 'Reapply this change'
            : 'Restore previous state'

  const affected = preview?.impact?.items.filter((i) => i.needsApproval) ?? []
  const keptSince = preview?.impact?.items.filter((i) => !i.needsApproval) ?? []
  const affectedRows = [...affected, ...keptSince]

  const footer =
    phase.kind === 'done' ? (
      <KitButton variant="primary" onClick={onClose}>Done</KitButton>
    ) : (phase.kind === 'ready' || phase.kind === 'running') && (safety === 'lossless' || safety === 'needs_approval') ? (
      <>
        <KitButton variant="ghost" onClick={onClose} disabled={phase.kind === 'running'}>Cancel</KitButton>
        <KitButton variant="primary" onClick={() => void run(phase.preview)} loading={phase.kind === 'running'}>
          {safety === 'needs_approval' ? 'Approve restore' : reapply ? 'Reapply change' : 'Restore previous state'}
        </KitButton>
      </>
    ) : phase.kind === 'checking' ? (
      <KitButton variant="ghost" onClick={onClose}>Cancel</KitButton>
    ) : (
      <KitButton onClick={onClose}>Close</KitButton>
    )

  return (
    <KitModal
      open
      onClose={phase.kind === 'running' ? () => {} : onClose}
      title={title}
      description={<span className="[overflow-wrap:anywhere]">#{change.seq} · {change.summary}</span>}
      footer={footer}
    >
      {phase.kind === 'done' ? (
        <KitNote tone="success" icon={Check}>{phase.message}</KitNote>
      ) : phase.kind === 'checking' ? (
        <ul className="space-y-3 py-1" aria-busy="true" aria-label="Checking">
          {['Restore point available', 'Current state protected', 'Recovery plan verified', 'No expected data loss'].map((label) => (
            <li key={label} className="flex items-center gap-2.5">
              <Skeleton className="h-4 w-4 rounded-full" />
              <span className="text-[13px] text-zinc-500">{label}</span>
            </li>
          ))}
        </ul>
      ) : (
        <div className="space-y-4">
          {phase.kind === 'ready' && note && <KitNote tone="info" icon={AlertCircle}>{note}</KitNote>}

          {preview && preview.checks.length > 0 && (
            <ul className="space-y-2.5">
              {preview.checks.map((c) => {
                const warn = !c.ok && c.id === 'data' && safety === 'needs_approval'
                const Icon = c.ok ? Check : warn ? AlertTriangle : X
                return (
                  <li key={c.id} className="flex items-start gap-2.5">
                    <span
                      className={`mt-[2px] flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full ${
                        c.ok ? 'bg-emerald-400/15 text-emerald-300' : warn ? 'bg-amber-400/15 text-amber-300' : 'bg-rose-400/15 text-rose-300'
                      }`}
                      aria-hidden
                    >
                      <Icon className="h-[11px] w-[11px]" strokeWidth={2.5} />
                    </span>
                    <span className="min-w-0">
                      <span className="block text-[13px] text-zinc-100">{warn ? 'Data written since would be affected' : c.label}</span>
                      {!c.ok && !warn && <span className="mt-0.5 block text-[12px] leading-[18px] text-zinc-500 [overflow-wrap:anywhere]">{c.detail}</span>}
                    </span>
                  </li>
                )
              })}
            </ul>
          )}

          {safety === 'needs_approval' && preview?.reason && (
            <KitNote tone="warn" icon={AlertTriangle}>
              <span className="[overflow-wrap:anywhere]">{preview.reason}</span>
            </KitNote>
          )}

          {safety === 'needs_approval' && (affected.length > 0 || keptSince.length > 0 || (preview?.unrecoverable.length ?? 0) > 0) && (
            <div>
              <button
                type="button"
                onClick={() => setShowAffected((v) => !v)}
                aria-expanded={showAffected}
                className="inline-flex items-center gap-1 text-[12.5px] font-medium text-zinc-300 hover:text-zinc-100"
              >
                {showAffected ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                Review affected data
              </button>
              {showAffected && (
                <div className="mt-2 overflow-hidden rounded-[8px] border border-white/[0.07]">
                  <ul className="divide-y divide-white/[0.05]">
                    {affectedRows.map((i, n) => (
                      <li key={n} className="flex items-baseline gap-3 px-3 py-2 text-[12.5px]">
                        <span className={`w-[11rem] flex-shrink-0 ${i.needsApproval ? 'text-zinc-200' : 'text-zinc-500'}`}>{EFFECT[i.effect] ?? i.effect}</span>
                        <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-zinc-400" title={`${i.table}${i.column ? `.${i.column}` : ''}`}>
                          {i.table}{i.column ? `.${i.column}` : ''}
                        </span>
                        {COUNTED.has(i.effect) && (
                          <span className="flex-shrink-0 tabular-nums text-zinc-300">{i.count.toLocaleString('en-US')}</span>
                        )}
                      </li>
                    ))}
                    {preview?.unrecoverable.map((u, n) => (
                      <li key={`u${n}`} className="px-3 py-2 text-[12.5px] leading-[18px] text-zinc-300 [overflow-wrap:anywhere]">{u}</li>
                    ))}
                  </ul>
                  <p className="border-t border-white/[0.05] bg-white/[0.015] px-3 py-2 text-[12px] leading-[17px] text-zinc-500">
                    Nothing is deleted. What is set aside is kept with this restore; reapplying the change brings it back.
                  </p>
                </div>
              )}
            </div>
          )}

          {safety === 'blocked' && preview && preview.blockedBy.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-[12.5px] text-zinc-400">A later change touched the same tables. Restore it first:</p>
              <ul className="space-y-1">
                {preview.blockedBy.map((b) => (
                  <li key={b.id}>
                    <button
                      type="button"
                      onClick={() => onOpenChange(b.id)}
                      className="text-left text-[12.5px] text-zinc-200 underline decoration-white/20 underline-offset-2 hover:decoration-white/60 [overflow-wrap:anywhere]"
                    >
                      #{b.seq} · {b.summary}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {phase.kind === 'error' && (
            <KitNote tone={preview ? 'danger' : 'info'} icon={preview ? AlertTriangle : AlertCircle}>
              <span className="[overflow-wrap:anywhere]">{phase.message}</span>
            </KitNote>
          )}
        </div>
      )}
    </KitModal>
  )
}
