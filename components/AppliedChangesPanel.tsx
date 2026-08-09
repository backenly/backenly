'use client'

/**
 * AppliedChangesPanel — what Backenly changed on its own, and the way back.
 *
 * WHY THIS EXISTS
 * ---------------
 * Every autonomy surface in this product has told users that "every autonomous
 * action is snapshotted, reversible, and written to the audit log". The engine
 * side of that was real and had been for months: `capturePreFixState` takes a
 * PRE-fix snapshot before the executor runs, `revertAutoFix` restores it,
 * `DELETE /api/projects/[id]/health/approve` is wired straight to it, and the
 * "rollback snapshot captured" line in the queue was telling the truth.
 *
 * Nothing in the product ever called it. The Review Queue is `pending_approval`
 * only; the Detected panel is `open` only; the activity feed renders AuditLog
 * rows, which carry no findingId to revert. So `auto_fixed` — the rows that
 * describe changes Backenly made WITHOUT being asked, the exact set a developer
 * most wants a way out of — rendered nowhere, with no undo, on a page whose
 * footer promised one. This panel is that half of the queue.
 *
 * THE RULE THIS PANEL FOLLOWS
 * ---------------------------
 * An Undo button is only drawn when the engine will actually honour it.
 * `revertible` comes from `revertEligibility` in the auto-fix engine — the same
 * predicate `revertAutoFix` gates on — so the button's precondition and the
 * engine's precondition are one function. A fix recorded before the undo
 * contract, or one whose pre-fix snapshot capture failed, renders its reason
 * instead of a button that would fail on click. This codebase has already
 * shipped the other version of that mistake once, as a "Fix now" button that
 * returned an error every time it was pressed.
 *
 * Undoing RLS is a protection REMOVAL, so it takes a second explicit
 * confirmation in-row rather than one silent click — the server enforces this
 * independently (409 + requiresConfirmation) and the UI mirrors it.
 *
 * Visual language: the locked flat inspector kit — #16171d surface, hairline
 * borders, mono numerals, no gradients. Undo is `danger` on RLS rows (it removes
 * protection) and `secondary` everywhere else (it restores a prior state).
 */

import { useCallback, useMemo, useState } from 'react'
import {
  History, Undo2, Loader2, XCircle, ShieldAlert, Lock, ChevronDown,
  ClipboardCopy, Check,
} from 'lucide-react'
import { KIT, KitButton } from '@/components/inspector/kit'

export interface AppliedChange {
  findingId: string
  type: string
  severity: string
  at: string
  summary: string
  resource?: string
  verified: boolean
  revertible: boolean
  requiresConfirmation: boolean
  revertBlockedReason?: string
  /** The statements this change ran. Empty when nothing was captured. */
  statements?: Array<{ sql: string; params?: string[] }>
}

type RowState =
  | { phase: 'idle' }
  | { phase: 'confirming'; message: string }
  | { phase: 'reverting' }
  | { phase: 'reverted'; message: string }
  | { phase: 'error'; message: string }

const CARD =
  `relative overflow-hidden ${KIT.radius} border ${KIT.border} ${KIT.surface} ${KIT.inset}`

function timeAgo(iso: string): string {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 5) return 'just now'
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

export function AppliedChangesPanel({
  projectId,
  changes,
  onReverted,
}: {
  projectId: string
  changes: AppliedChange[]
  /** Refetch the trust report — the reverted row leaves `auto_fixed`. */
  onReverted: () => void
}) {
  const [rowState, setRowState] = useState<Record<string, RowState>>({})

  const setRow = useCallback((id: string, s: RowState) => {
    setRowState(prev => ({ ...prev, [id]: s }))
  }, [])

  /**
   * One revert. `confirm=true` is only ever sent after the user has seen the
   * server's own confirmation text and pressed again — never pre-emptively,
   * because that would defeat the gate the engine exists to enforce.
   */
  const revert = useCallback(async (c: AppliedChange, confirmed: boolean) => {
    setRow(c.findingId, { phase: 'reverting' })
    try {
      const qs = new URLSearchParams({ findingId: c.findingId })
      if (confirmed) qs.set('confirm', 'true')
      const res = await fetch(
        `/api/projects/${projectId}/health/approve?${qs.toString()}`,
        { method: 'DELETE', credentials: 'include' },
      )
      const j = await res.json().catch(() => ({} as any))

      if (res.status === 409 && j?.requiresConfirmation) {
        setRow(c.findingId, {
          phase: 'confirming',
          message: j?.error ?? 'This undo removes protection. Confirm to proceed.',
        })
        return
      }
      if (!res.ok || !j?.success) {
        setRow(c.findingId, {
          phase: 'error',
          message: j?.error ?? 'The undo could not be applied. Try again in a moment.',
        })
        return
      }

      setRow(c.findingId, {
        phase: 'reverted',
        message: j?.message ?? 'Change reverted.',
      })
      onReverted()
    } catch {
      setRow(c.findingId, {
        phase: 'error',
        message: 'Network error. Check your connection and try again.',
      })
    }
  }, [projectId, setRow, onReverted])

  const revertibleCount = useMemo(
    () => changes.filter(c => c.revertible).length,
    [changes],
  )

  // Nothing applied yet → render nothing. An empty card here would repeat the
  // "Nothing yet" the activity feed directly above already says.
  if (changes.length === 0) return null

  return (
    <section className={CARD}>
      <div className="flex items-center justify-between border-b border-white/[0.06] px-5 py-3.5">
        <div className="flex items-center gap-2">
          <History className="size-3.5 text-zinc-400" />
          <h3 className="text-[13px] font-semibold tracking-tight text-zinc-100">
            Changes Backenly made
          </h3>
          <span className="font-mono text-[11px] tabular-nums text-zinc-600">
            {changes.length}
          </span>
        </div>
        <span className="font-mono text-[10.5px] tabular-nums text-zinc-600">
          {revertibleCount} undoable
        </span>
      </div>

      <div className="border-b border-white/[0.06] px-5 py-2.5">
        <p className="text-[11.5px] leading-relaxed text-zinc-500">
          Applied without waiting for you, because each one was additive and snapshotted first.
          Undo restores the exact state captured before the fix ran.
        </p>
      </div>

      <ul className="divide-y divide-white/[0.04]">
        {changes.map(c => (
          <ChangeRow
            key={c.findingId}
            change={c}
            state={rowState[c.findingId] ?? { phase: 'idle' }}
            onUndo={() => revert(c, false)}
            onConfirmUndo={() => revert(c, true)}
            onCancel={() => setRow(c.findingId, { phase: 'idle' })}
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
  onCancel,
}: {
  change: AppliedChange
  state: RowState
  onUndo: () => void
  onConfirmUndo: () => void
  onCancel: () => void
}) {
  const [showSql, setShowSql] = useState(false)
  const [copied, setCopied] = useState<number | null>(null)
  const statements = c.statements ?? []

  const copySql = async (sql: string) => {
    const i = statements.findIndex(s => s.sql === sql)
    try {
      await navigator.clipboard.writeText(sql)
      setCopied(i)
      setTimeout(() => setCopied(null), 1800)
    } catch { /* clipboard blocked — no-op */ }
  }

  if (state.phase === 'reverted') {
    return (
      <li className="flex items-start gap-3 px-5 py-3.5 animate-fade-in">
        <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-emerald-400" />
        <div className="min-w-0 flex-1">
          <p className="text-[12.5px] font-medium text-zinc-200">{c.summary}</p>
          <p className="mt-1 font-mono text-[10.5px] text-zinc-500">{state.message}</p>
        </div>
      </li>
    )
  }

  const busy = state.phase === 'reverting'

  return (
    <li className={`px-5 py-3.5 ${state.phase === 'error' ? 'bg-rose-500/[0.03]' : ''}`}>
      <div className="flex items-start gap-3">
        <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-zinc-600" />
        <div className="min-w-0 flex-1">
          <p className="text-[12.5px] leading-snug text-zinc-100">{c.summary}</p>
          <p className="mt-1.5 font-mono text-[10.5px] text-zinc-600">
            {c.type}
            {c.resource && <> · <span className="text-zinc-500">{c.resource}</span></>}
            {' · '}{timeAgo(c.at)}
            {' · '}
            {/* Never claim verification the kernel did not perform. Types no
                probe can re-detect are recorded honestly as unchecked. */}
            <span className={c.verified ? 'text-emerald-400/80' : 'text-zinc-600'}>
              {c.verified ? 're-checked and confirmed' : 'not independently re-checked'}
            </span>
          </p>

          {/* The exact statements, on demand. Collapsed by default because the
              summary above is what most people want; expanded it is the answer
              to "what did it actually run", which used to require diffing two
              schema snapshots by hand. Absent when nothing was captured — a
              change applied before the recorder existed shows no toggle rather
              than an empty panel implying it ran nothing. */}
          {statements.length > 0 && (
            <div className="mt-2">
              <button
                onClick={() => setShowSql(v => !v)}
                aria-expanded={showSql}
                className="inline-flex items-center gap-1 text-[11.5px] font-medium text-zinc-500 transition-colors hover:text-zinc-300"
              >
                {statements.length === 1 ? '1 statement' : `${statements.length} statements`}
                <ChevronDown className={`size-3 transition-transform ${showSql ? 'rotate-180' : ''}`} />
              </button>
              {showSql && (
                <div className="mt-2 space-y-2">
                  {statements.map((st, i) => (
                    <div key={i} className="rounded-md border border-white/[0.07] bg-[#0f1015]">
                      <div className="flex items-start gap-2 px-3 py-2">
                        <pre className="min-w-0 flex-1 overflow-x-auto whitespace-pre-wrap break-words font-mono text-[10.5px] leading-relaxed text-zinc-300">
{st.sql}
                        </pre>
                        <button
                          onClick={() => copySql(st.sql)}
                          className="shrink-0 text-zinc-600 transition-colors hover:text-zinc-300"
                          aria-label="Copy statement"
                        >
                          {copied === i
                            ? <Check className="size-3 text-emerald-400" />
                            : <ClipboardCopy className="size-3" />}
                        </button>
                      </div>
                      {st.params && st.params.length > 0 && (
                        <p className="border-t border-white/[0.05] px-3 py-1.5 font-mono text-[10px] text-zinc-600">
                          {st.params.map((p, j) => `$${j + 1} = ${p}`).join('  ·  ')}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {state.phase === 'confirming' && (
            <div className="mt-2 flex items-start gap-2 rounded-md border border-rose-500/20 bg-rose-500/[0.05] px-3 py-2">
              <ShieldAlert className="mt-px size-3.5 shrink-0 text-rose-400" />
              <p className="text-[11.5px] leading-snug text-rose-200/90">{state.message}</p>
            </div>
          )}

          {state.phase === 'error' && (
            <div className="mt-2 flex items-start gap-2">
              <XCircle className="mt-px size-3.5 shrink-0 text-rose-400" />
              <p className="text-[11.5px] leading-snug text-rose-300/90">{state.message}</p>
            </div>
          )}

          {!c.revertible && c.revertBlockedReason && (
            <div className="mt-2 flex items-start gap-2">
              <Lock className="mt-px size-3 shrink-0 text-zinc-600" />
              <p className="text-[11.5px] leading-snug text-zinc-500">{c.revertBlockedReason}</p>
            </div>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {!c.revertible ? null : state.phase === 'confirming' ? (
            <>
              <KitButton variant="danger" onClick={onConfirmUndo} disabled={busy}>
                <Undo2 className="size-3.5" /> Undo anyway
              </KitButton>
              <KitButton variant="secondary" onClick={onCancel} disabled={busy}>
                Keep it
              </KitButton>
            </>
          ) : state.phase === 'error' ? (
            <KitButton variant="secondary" onClick={onCancel}>Try again</KitButton>
          ) : (
            <KitButton
              variant={c.requiresConfirmation ? 'danger' : 'secondary'}
              onClick={onUndo}
              disabled={busy}
            >
              {busy
                ? <><Loader2 className="size-3.5 animate-spin" /> Undoing…</>
                : <><Undo2 className="size-3.5" /> Undo</>}
            </KitButton>
          )}
        </div>
      </div>
    </li>
  )
}
