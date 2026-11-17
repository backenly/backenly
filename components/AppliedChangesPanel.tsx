'use client'

/**
 * AppliedChangesPanel: "Changes Backenly made", the one record of what
 * Backenly changed on its own, each with its way back.
 *
 * WHY THIS EXISTS
 * ---------------
 * `capturePreFixState` takes a PRE-fix snapshot before the executor runs,
 * `revertAutoFix` restores it, and `DELETE /api/projects/[id]/health/approve`
 * is wired straight to it. For months nothing in the product called it:
 * `auto_fixed` rows, the changes Backenly made WITHOUT being asked, rendered
 * nowhere, with no undo. This panel is that half of the queue.
 *
 * ONE RECORD (2026-11-16)
 * -----------------------
 * The same fix used to be printed twice on this page, with the same 30-word
 * "because" sentence: once here and once in an Activity feed below, while the
 * statement that actually ran sat behind a click. Now each row shows what ran
 * (its first statement, in mono), whether a re-check confirmed it, and when;
 * "Why" holds the reason, every statement and Copy. The 30-day scoreboard sits
 * in the heading, and the old feed folds into "Full log" at the foot of the
 * same panel.
 *
 * THE RULE THIS PANEL FOLLOWS
 * ---------------------------
 * An Undo button is only drawn when the engine will actually honour it.
 * `revertible` comes from `revertEligibility` in the auto-fix engine — the same
 * predicate `revertAutoFix` gates on. A fix recorded before the undo contract,
 * or one whose pre-fix snapshot capture failed, shows its reason instead.
 *
 * Undoing RLS is a protection REMOVAL, so it takes a second explicit
 * confirmation in-row rather than one silent click — the server enforces this
 * independently (409 + requiresConfirmation) and the UI mirrors it.
 */

import { useCallback, useState } from 'react'
import Link from 'next/link'
import { CopyButton, KitButton } from '@/components/inspector/kit'
import { FOCUS, FOCUS_INSET } from '@/components/console/tokens'
import { RefusedLine } from '@/components/console/states'
import { Time } from '@/components/console/Time'
import { CodeBlock, Disclosure, EmptyLine, Fact, Facts, Panel, Row, RowList, ROW_TEXT, ROW_TITLE, Section } from '@/components/autonomy/rows'
import { FIX_ICON } from '@/components/autonomy/row-icons'

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

/** The trust report's 30-day tally, said in the section's heading. */
export interface Scoreboard {
  windowDays: number
  autonomousFixes: number
  rollbacks: number
  verifiedRate: number | null
}

/** One line of the activity feed (trust report `recentActivity`). */
export interface ActivityEntry {
  at: string
  action: string
  kind: string
  summary: string
  repeat?: number
}

type RowState =
  | { phase: 'idle' }
  | { phase: 'confirming'; message: string }
  | { phase: 'reverting' }
  | { phase: 'reverted'; message: string }
  | { phase: 'error'; message: string }

/** A statement that changes the schema: undoing it restores the state before it, which takes an admin. */
const SCHEMA_SQL = /^\s*(CREATE|ALTER|DROP|COMMENT)\b/i

export function AppliedChangesPanel({
  projectId,
  changes,
  onReverted,
  scoreboard,
  activity = [],
  canUndo = true,
  canUndoSchema = true,
}: {
  projectId: string
  changes: AppliedChange[]
  /** Refetch the trust report — the reverted row leaves `auto_fixed`. */
  onReverted: () => void
  scoreboard?: Scoreboard
  /** The feed behind "Full log". */
  activity?: ActivityEntry[]
  /** Undo takes a developer or above… */
  canUndo?: boolean
  /** …and an admin when the fix changed the schema (health/approve's DELETE). */
  canUndoSchema?: boolean
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

  return (
    <Section
      id="autonomy-applied"
      title="Changes Backenly made"
      count={changes.length}
      aside={scoreboard && (scoreboard.autonomousFixes > 0 || scoreboard.rollbacks > 0) ? <Tally s={scoreboard} /> : undefined}
    >
      <Panel>
        {changes.length === 0 ? (
          <EmptyLine>None yet. Each fix shows here with its statement, its result and Undo.</EmptyLine>
        ) : (
          <RowList>
            {changes.map(c => {
              const touchesSchema = (c.statements ?? []).some(st => SCHEMA_SQL.test(st.sql))
              return (
                <ChangeRow
                  key={c.findingId}
                  projectId={projectId}
                  change={c}
                  canUndo={canUndo && (!touchesSchema || canUndoSchema)}
                  state={rowState[c.findingId] ?? { phase: 'idle' }}
                  onUndo={() => revert(c, false)}
                  onConfirmUndo={() => revert(c, true)}
                  onCancel={() => setRow(c.findingId, { phase: 'idle' })}
                />
              )
            })}
          </RowList>
        )}
        {activity.length > 0 && <FullLog activity={activity} />}
      </Panel>
    </Section>
  )
}

/** "Last 30 days  2 fixed  0 undone  2 re-checked", each its own fact. */
function Tally({ s }: { s: Scoreboard }) {
  const rechecked = s.verifiedRate === null ? null : Math.round(s.verifiedRate * s.autonomousFixes)
  return (
    <span className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12.5px] tabular-nums text-faint">
      <span>Last {s.windowDays} days</span>
      <span>{s.autonomousFixes.toLocaleString('en-US')} fixed</span>
      <span>{s.rollbacks.toLocaleString('en-US')} undone</span>
      {rechecked !== null && <span>{rechecked.toLocaleString('en-US')} re-checked</span>}
    </span>
  )
}

// ── Row ──────────────────────────────────────────────────────────────────────

function ChangeRow({
  projectId,
  change: c,
  canUndo,
  state,
  onUndo,
  onConfirmUndo,
  onCancel,
}: {
  projectId: string
  change: AppliedChange
  canUndo: boolean
  state: RowState
  onUndo: () => void
  onConfirmUndo: () => void
  onCancel: () => void
}) {
  const [showWhy, setShowWhy] = useState(false)
  const statements = c.statements ?? []
  const { title, reason } = describe(c)
  const reverted = state.phase === 'reverted'
  const busy = state.phase === 'reverting'
  const tableHref = c.resource && /^[A-Za-z_][A-Za-z0-9_]*$/.test(c.resource) ? `/app/projects/${projectId}/database?table=${encodeURIComponent(c.resource)}` : null

  return (
    <Row
      lead="well"
      icon={FIX_ICON}
      tone={reverted ? 'done' : 'neutral'}
      busy={busy}
      id={`fix-${c.findingId}`}
      title={<p className={ROW_TITLE}>{title}</p>}
      actions={
        reverted ? (
          <span className="pt-[2px] text-[12.5px] font-medium text-zinc-300">Undone</span>
        ) : !c.revertible || !canUndo ? undefined : state.phase === 'confirming' ? (
          <>
            <KitButton variant="secondary" onClick={onCancel} disabled={busy}>
              Keep it
            </KitButton>
            <KitButton variant="danger" onClick={onConfirmUndo} disabled={busy}>
              Undo anyway
            </KitButton>
          </>
        ) : state.phase === 'error' ? (
          <KitButton variant="secondary" onClick={onCancel}>Try again</KitButton>
        ) : (
          <KitButton variant={c.requiresConfirmation ? 'danger' : 'secondary'} onClick={onUndo} loading={busy}>
            {busy ? 'Undoing…' : 'Undo'}
          </KitButton>
        )
      }
    >
      {reverted ? (
        <p role="status" className={`${ROW_TEXT} !text-zinc-300`}>{state.message}</p>
      ) : (
        statements.length > 0 && (
          // What ran, in the row: the first statement, one line; all of them under Why.
          <p className="mt-1 truncate font-mono text-[12px] leading-[18px] text-zinc-400">{statements[0].sql}</p>
        )
      )}
      <Facts>
        {/* Never claim verification the kernel did not perform. Types no
            probe can re-detect are recorded honestly as unchecked. */}
        <Fact strong>{c.verified ? 'Re-checked: fixed' : 'Not independently re-checked'}</Fact>
        {c.resource && (
          <Fact>
            {tableHref ? (
              <Link href={tableHref} className={`rounded-[3px] font-mono text-[12px] text-zinc-300 underline decoration-white/20 underline-offset-2 hover:text-zinc-50 ${FOCUS}`}>
                {c.resource}
              </Link>
            ) : (
              <code className="font-mono text-[12px] text-zinc-400">{c.resource}</code>
            )}
          </Fact>
        )}
        <Fact><Time iso={c.at} mode="dateTime" /></Fact>
      </Facts>

      {(reason || statements.length > 0) && (
        <>
          <Disclosure open={showWhy} onToggle={() => setShowWhy(v => !v)}>
            Why
          </Disclosure>
          {showWhy && (
            <>
              {reason && <p className={ROW_TEXT}>{reason}</p>}
              {/* Absent when nothing was captured: a change applied before the
                  recorder existed shows no statements rather than an empty well
                  implying it ran nothing. */}
              {statements.length > 0 && (
                <div className="relative">
                  <CodeBlock className="pr-10">
                    {statements.map((st, i) =>
                      `${st.sql}${st.params && st.params.length > 0 ? `\n-- ${st.params.map((p, j) => `$${j + 1} = ${p}`).join(', ')}` : ''}${i < statements.length - 1 ? '\n\n' : ''}`,
                    ).join('')}
                  </CodeBlock>
                  <div className="absolute right-1.5 top-[16px]">
                    <CopyButton value={statements.map(st => st.sql).join(';\n') + ';'} label={statements.length === 1 ? 'Copy the statement' : 'Copy the statements'} />
                  </div>
                </div>
              )}
            </>
          )}
        </>
      )}

      {state.phase === 'confirming' && (
        <p className="mt-2.5 text-[12.5px] leading-[18px] text-rose-300">{state.message}</p>
      )}
      {state.phase === 'error' && <RefusedLine className="mt-2.5">{state.message}</RefusedLine>}
      {!c.revertible && c.revertBlockedReason && (
        <p className="mt-2.5 text-[12.5px] leading-[18px] text-faint">{c.revertBlockedReason}</p>
      )}
    </Row>
  )
}

// ── Full log ─────────────────────────────────────────────────────────────────

/**
 * What Backenly did lately, every line of it: the feed that used to be a
 * second panel. Every line is a sentence: the server leaves the loop's own
 * bookkeeping out rather than sending it by name (lib/autonomy/activity-sentences.ts).
 */
function FullLog({ activity }: { activity: ActivityEntry[] }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="border-t border-white/[0.06]">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        aria-expanded={open}
        className={`flex w-full items-center gap-2 px-[20px] py-[11px] text-left text-[13px] font-medium text-zinc-300 transition-colors hover:text-zinc-50 ${FOCUS_INSET}`}
      >
        Full log
        <span className="font-normal tabular-nums text-faint">{activity.length}</span>
        <svg aria-hidden viewBox="0 0 16 16" className={`h-3.5 w-3.5 text-zinc-500 transition-transform duration-150 ${open ? 'rotate-180' : ''}`} fill="none">
          <path d="m4 6 4 4 4-4" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <ul aria-label="What Backenly did" className="divide-y divide-white/[0.06] border-t border-white/[0.06]">
          {activity.map((a, i) => (
            <li key={i} className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-6 px-[20px] py-[10px]">
              <span className="min-w-0 text-[13px] leading-[20px] text-zinc-300 [overflow-wrap:anywhere]">
                {a.summary}
                {/* An unresolved finding is re-escalated every tick; folded
                    server-side, and the count keeps the fold honest. */}
                {(a.repeat ?? 1) > 1 && <span className="ml-1.5 tabular-nums text-faint">{a.repeat} times</span>}
              </span>
              <span className="pt-px text-[12.5px] text-faint">
                <Time iso={a.at} />
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
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
