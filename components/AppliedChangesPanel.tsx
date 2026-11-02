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
import { Undo2, Loader2, XCircle, ShieldAlert, Lock, Wrench, CheckCircle2 } from 'lucide-react'
import { CopyButton, KitButton, MetaCode, StatusDot } from '@/components/inspector/kit'
import { CodeBlock, Disclosure, Fact, Facts, Panel, Row, RowList, RowNote, ROW_TEXT, ROW_TITLE, Section } from '@/components/autonomy/rows'

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
    <Section id="autonomy-applied" title="Changes Backenly made" count={changes.length}>
      <Panel>
        <RowList>
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
        </RowList>
      </Panel>
    </Section>
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
  const statements = c.statements ?? []
  const { title, reason } = describe(c)

  if (state.phase === 'reverted') {
    return (
      <Row icon={CheckCircle2} tone="done" title={<p className={ROW_TITLE}>{title}</p>} className="animate-fade-in">
        <p className={ROW_TEXT}>{state.message}</p>
      </Row>
    )
  }

  const busy = state.phase === 'reverting'

  return (
    <Row
      icon={Wrench}
      busy={busy}
      className={state.phase === 'error' ? 'bg-rose-500/[0.03]' : ''}
      title={<p className={ROW_TITLE}>{title}</p>}
      actions={
        !c.revertible ? undefined : state.phase === 'confirming' ? (
          <>
            <KitButton variant="secondary" onClick={onCancel} disabled={busy}>
              Keep it
            </KitButton>
            <KitButton variant="danger" onClick={onConfirmUndo} disabled={busy}>
              <Undo2 className="size-3.5" /> Undo anyway
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
        )
      }
    >
      {reason && <p className={ROW_TEXT}>{reason}</p>}
      <Facts>
        {/* Never claim verification the kernel did not perform. Types no
            probe can re-detect are recorded honestly as unchecked. */}
        <StatusDot
          tone={c.verified ? 'operational' : 'neutral'}
          label={c.verified ? 'Re-checked and confirmed' : 'Not independently re-checked'}
        />
        {c.resource && <Fact><MetaCode>{c.resource}</MetaCode></Fact>}
        <Fact><span className="tabular-nums">{timeAgo(c.at)}</span></Fact>
      </Facts>

      {/* The exact statements, on demand. Collapsed by default because the
          sentence above is what most people want; expanded it is the answer
          to "what did it actually run". Absent when nothing was captured: a
          change applied before the recorder existed shows no toggle rather
          than an empty panel implying it ran nothing. */}
      {statements.length > 0 && (
        <>
          <Disclosure open={showSql} onToggle={() => setShowSql(v => !v)}>
            {statements.length === 1 ? 'Show the statement' : `Show ${statements.length} statements`}
          </Disclosure>
          {showSql && (
            <div className="relative">
              <CodeBlock className="pr-10">
                {statements.map((st, i) =>
                  `${st.sql}${st.params && st.params.length > 0 ? `\n-- ${st.params.map((p, j) => `$${j + 1} = ${p}`).join(', ')}` : ''}${i < statements.length - 1 ? '\n\n' : ''}`,
                ).join('')}
              </CodeBlock>
              <div className="absolute right-1.5 top-[16px]">
                <CopyButton value={statements.map(st => st.sql).join(';\n') + ';'} label="Copy the statements" />
              </div>
            </div>
          )}
        </>
      )}

      {state.phase === 'confirming' && (
        <RowNote tone="danger" icon={ShieldAlert}>{state.message}</RowNote>
      )}
      {state.phase === 'error' && (
        <RowNote tone="danger" icon={XCircle} role="alert">{state.message}</RowNote>
      )}
      {!c.revertible && c.revertBlockedReason && (
        <RowNote icon={Lock}>{c.revertBlockedReason}</RowNote>
      )}
    </Row>
  )
}

/**
 * The row's headline and its reason, from the server's one sentence
 * ("Backenly fixed slow query missing index on "events" because …"). An index
 * says what it is ("Added an index on events (customer)"), read from the
 * statement it ran; anything else keeps the server's words, split at "because".
 */
function describe(c: AppliedChange): { title: string; reason: string | null } {
  const at = c.summary.indexOf(' because ')
  const head = (at === -1 ? c.summary : c.summary.slice(0, at)).replace(/^Backenly\s+/, '')
  const reason = at === -1 ? null : capitalise(c.summary.slice(at + ' because '.length).trim())
  const statements = c.statements ?? []
  const indexes = statements.map(st => st.sql.match(INDEX_SQL)).filter((m): m is RegExpMatchArray => !!m)
  if (statements.length > 0 && indexes.length === statements.length) {
    const [, table, columns] = indexes[0]
    const cols = columns.split(',').map(x => x.trim().replace(/^"|"$/g, '')).join(', ')
    return { title: `Added an index on ${table} (${cols})`, reason }
  }
  return { title: capitalise(head), reason }
}

const INDEX_SQL = /^CREATE\s+(?:UNIQUE\s+)?INDEX\b[^(]*?\bON\s+(?:"[^"]+"\.)?"?([^"\s(]+)"?\s*\(([^)]+)\)/i

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}
