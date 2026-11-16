'use client'

/**
 * One change, opened beside the list: everything technical about it, and only
 * here (project decision 6: a record from a list you keep scanning opens in a
 * right drawer, ?change= in the URL, ↑/↓ moves, Esc closes).
 *
 * What it did to each object, the protected checks and what each found, the
 * lifecycle with who requested, authorised and executed each step, the restore
 * point and the data kept, the SQL, and each restore that acted on it with its
 * own checks. The list row stays short; this is where the evidence lives. The
 * drawer's title is the summary; its facts are the status, who, when and #48.
 */

import { useEffect, useState } from 'react'
import { AlertTriangle, ChevronDown, ChevronRight } from 'lucide-react'
import { KitButton, KitNote, StatusGlyph } from '@/components/inspector/kit'
import { RecordDrawer } from '@/components/console/RecordDrawer'
import { formatTime } from '@/components/console/format'
import { Time } from '@/components/console/Time'
import { ErrorRow } from '@/components/console/states'
import { Fact, Facts } from '@/components/autonomy/rows'
import type { ChangeDetail, ChangeSummary } from '@/lib/changes/history'
import type { PreservedEntry } from '@/lib/changes/types'
import type { VerificationCheck } from '@/lib/changes/verify'
import { ChangeOutcome } from './ChangeRow'
import { EVENT } from './present'

/** "Nov 16, 2:09:41 AM": a lifecycle step, to the second. */
function stamp(iso: string): string {
  return `${formatTime(iso, 'date')}, ${formatTime(iso, 'clockSeconds')}`
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-[12px] font-medium leading-[16px] text-faint">{title}</h3>
      {children}
    </section>
  )
}

function CheckRow({ check }: { check: VerificationCheck }) {
  const state = check.outcome === 'confirmed' ? 'done' : check.outcome === 'contradicted' ? 'failed' : 'waiting'
  const word = check.outcome === 'confirmed' ? 'Confirmed' : check.outcome === 'contradicted' ? 'Contradicted' : 'Could not tell'
  return (
    <li className="flex items-start gap-2.5">
      <StatusGlyph state={state} label={word} className="mt-[4px]" />
      <span className="min-w-0">
        <span className="block text-[13px] text-zinc-200">{check.label}</span>
        {check.detail && <span className="block text-[12px] leading-[18px] text-faint [overflow-wrap:anywhere]">{check.detail}</span>}
      </span>
    </li>
  )
}

function Disclosure({ label, children }: { label: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="inline-flex items-center gap-1 rounded-[4px] text-[12.5px] font-medium text-zinc-400 hover:text-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
      >
        {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        {label}
      </button>
      {open && <div className="mt-2">{children}</div>}
    </div>
  )
}

function Sql({ statements, quoted = true }: { statements: Array<{ sql: string }>; quoted?: boolean }) {
  if (statements.length === 0) {
    return (
      <p className="text-[12.5px] text-faint">
        {quoted ? 'No statements were recorded.' : 'Not recorded here: this project’s data, including the SQL that ran, stays in its own region.'}
      </p>
    )
  }
  return (
    <pre tabIndex={0} className="max-h-[260px] overflow-auto rounded-[8px] border border-white/[0.06] bg-black/30 p-3 font-mono text-[11.5px] leading-[18px] text-zinc-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70">
      {statements.map((s) => s.sql.trim()).join(';\n\n')}
    </pre>
  )
}

function keptLine(e: PreservedEntry): string {
  if (e.kind === 'table') return `Table ${e.table}${e.rows !== null ? `, ${e.rows} row${e.rows === 1 ? '' : 's'}` : ''}`
  const why = e.reason === 'dropped' ? 'dropped' : e.reason === 'retyped' ? 'retyped' : e.reason === 'filled' ? 'filled in when added' : 'rewritten'
  return `Column ${e.table}.${e.column} (${why})${e.rows !== null ? `, ${e.rows} value${e.rows === 1 ? '' : 's'}` : ''}`
}

/**
 * A restore attempt as it ended. Its summary is written before it runs, so an
 * attempt that was rolled back, or later undone by a reapply, says so instead.
 */
function restoreLine(r: ChangeDetail['recoveries'][number]): string {
  switch (r.status) {
    case 'healthy':
      return r.summary
    case 'restored':
      return `${r.summary}; undone when the change was reapplied`
    case 'failed':
      return 'Did not complete: rolled back, so nothing changed'
    case 'verification_failed':
      return 'Ran, but the result did not match the restore point'
    case 'applying':
    case 'verifying':
      return 'In progress'
    default:
      return 'Applied, but not confirmed'
  }
}

function outcomeNote(d: ChangeDetail): { tone: 'success' | 'warn' | 'danger' | 'info'; text: string } | null {
  const by = d.outcome.by ? ` by ${d.outcome.by.label}` : ''
  const at = d.outcome.at ? `, ${formatTime(d.outcome.at, 'dateTime')}` : ''
  switch (d.outcome.state) {
    case 'recovered':
      return { tone: 'success', text: `This change failed a check, so Backenly restored the state before it and verified the result${at}. Production is healthy.${d.outcome.note ? ` What failed: ${d.outcome.note}` : ''}` }
    case 'restored':
      return { tone: 'info', text: `The state before this change was restored${by}${at}, and verified.` }
    case 'awaiting_approval':
      return { tone: 'warn', text: `This change failed a check, and Backenly cannot restore the state before it without a person's approval.${d.outcome.note ? ` What failed: ${d.outcome.note}` : ''}` }
    case 'kept':
      return { tone: 'warn', text: `This change failed a check and a person chose to keep it as it is. It can still be restored.${d.outcome.note ? ` What failed: ${d.outcome.note}` : ''}` }
    case 'needs_attention':
      return { tone: 'danger', text: `Automatic recovery stopped here and needs a person.${d.outcome.note ? ` ${d.outcome.note}` : ''}` }
    case 'unverified':
      return { tone: 'warn', text: `Applied, but not every check could run, so it is not marked verified.${d.outcome.note ? ` ${d.outcome.note}` : ''}` }
    default:
      return null
  }
}

export function ChangeDrawer({
  projectId,
  changeId,
  summary,
  canManage,
  onClose,
  onRestore,
  onPrev,
  onNext,
  position,
}: {
  projectId: string
  changeId: string
  /** The list's row for this change, so the title shows while the details load. */
  summary?: ChangeSummary | null
  canManage: boolean
  onClose: () => void
  /** Open the Undo (or Reapply) dialog for this change. */
  onRestore: (summary: ChangeSummary) => void
  onPrev?: (() => void) | null
  onNext?: (() => void) | null
  position?: { index: number; total: number }
}) {
  const [detail, setDetail] = useState<ChangeDetail | null>(null)
  const [failed, setFailed] = useState<{ id: string; message: string } | null>(null)
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    let cancelled = false
    fetch(`/api/projects/${projectId}/changes/${changeId}`, { credentials: 'include' })
      .then(async (res) => ({ ok: res.ok, body: await res.json().catch(() => ({})) }))
      .then(({ ok, body }) => {
        if (cancelled) return
        if (ok && body.change) {
          setDetail(body.change)
          setFailed(null)
        } else setFailed({ id: changeId, message: body.error || 'Could not load this change.' })
      })
      .catch(() => { if (!cancelled) setFailed({ id: changeId, message: 'Could not reach Backenly.' }) })
    return () => { cancelled = true }
  }, [projectId, changeId, nonce])

  const d = detail && detail.id === changeId ? detail : null
  const head: ChangeSummary | null = d ?? (summary && summary.id === changeId ? summary : null)
  const note = d ? outcomeNote(d) : null
  const restorable = !!d && canManage && !!d.action?.available
  const error = failed && failed.id === changeId ? failed.message : null

  return (
    <RecordDrawer
      open
      onClose={onClose}
      title={head ? <span className="[overflow-wrap:anywhere]">{head.summary}</span> : 'Change'}
      label={head ? `#${head.seq} ${head.summary}` : 'Change'}
      onPrev={onPrev}
      onNext={onNext}
      position={position}
      loading={!d && !error}
      facts={
        head ? (
          <Facts>
            <Fact strong>
              <ChangeOutcome c={head} />
              {head.outcome.state === 'healthy' && <span className="ml-1.5">Verified</span>}
            </Fact>
            <Fact>{head.actor.label}</Fact>
            <Fact><Time iso={head.createdAt} mode="dateTime" /></Fact>
            <Fact><span className="tabular-nums">#{head.seq}</span></Fact>
          </Facts>
        ) : undefined
      }
      footer={
        restorable ? (
          <KitButton onClick={() => onRestore(d!)}>
            {d!.action!.kind === 'reapply' ? 'Reapply this change' : 'Undo this change'}
          </KitButton>
        ) : undefined
      }
    >
      {error ? (
        <div className="-mx-[16px] -my-[16px] sm:-mx-[20px]">
          <ErrorRow things="this change" onRetry={() => setNonce((n) => n + 1)} />
        </div>
      ) : !d ? null : (
        <div className="space-y-6">
          {note &&
            (note.tone === 'warn' || note.tone === 'danger' ? (
              <KitNote tone={note.tone} icon={AlertTriangle}>
                <span className="[overflow-wrap:anywhere]">{note.text}</span>
              </KitNote>
            ) : (
              <p className="text-[13px] leading-[20px] text-zinc-300 [overflow-wrap:anywhere]">{note.text}</p>
            ))}

          {d.title && d.title !== d.summary && (
            <Section title="Asked for">
              <p className="text-[13px] leading-[20px] text-zinc-300 [overflow-wrap:anywhere]">{d.title}</p>
            </Section>
          )}

          <Section title="What changed">
            {d.footprint.length === 0 && d.resourceChanges.length === 0 && (
              <p className="text-[13px] text-faint">Nothing in the schema changed.</p>
            )}
            {d.footprint.length > 0 && (
              <ul className="space-y-3">
                {d.footprint.map((t, i) => (
                  <li key={i}>
                    <p className="text-[13px] text-zinc-200">
                      <span className="font-mono text-[12.5px]">{t.after ?? t.before}</span>
                      <span className="ml-2 text-[12px] text-faint">
                        {t.object ? t.object.replace('_', ' ') : 'table'} {t.kind}
                        {t.before && t.after && t.before !== t.after ? ` (was ${t.before})` : ''}
                      </span>
                    </p>
                    {t.details.length > 0 && (
                      <ul className="mt-1 space-y-0.5">
                        {t.details.map((line, j) => (
                          <li key={j} className="font-mono text-[11.5px] leading-[18px] text-zinc-400 [overflow-wrap:anywhere]">{line}</li>
                        ))}
                      </ul>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {/* The rest of the backend, in the order the summary names it: after the schema. */}
            {d.resourceChanges.length > 0 && (
              <ul className={`space-y-1 ${d.footprint.length > 0 ? 'mt-3' : ''}`}>
                {d.resourceChanges.map((line, i) => (
                  <li key={i} className="text-[13px] leading-[20px] text-zinc-200 [overflow-wrap:anywhere]">{line}</li>
                ))}
              </ul>
            )}
          </Section>

          <Section title="Checks">
            {d.verification ? (
              <ul className="space-y-2">
                {d.verification.checks.map((c) => <CheckRow key={c.id} check={c} />)}
              </ul>
            ) : (
              <p className="text-[13px] text-faint">Not checked yet.</p>
            )}
          </Section>

          <Section title="Timeline">
            <ol className="space-y-1.5">
              {d.events.map((e, i) => (
                <li key={i} className="flex items-baseline justify-between gap-3 text-[12.5px]">
                  <span className="text-zinc-300">{EVENT[e.type] ?? e.type}</span>
                  <span className="flex-shrink-0 tabular-nums text-faint">{stamp(e.at)}</span>
                </li>
              ))}
            </ol>
          </Section>

          <Section title="Restore point">
            <p className="text-[12.5px] leading-[19px] text-zinc-400">
              {d.checkpoint.intact ? 'Taken before the change and intact.' : 'Failed its integrity check, so it cannot be used.'}
              {d.checkpoint.parentSeq !== null && ` Follows change #${d.checkpoint.parentSeq}.`}
              {d.checkpoint.hash && <span className="ml-1 font-mono text-[11.5px] text-faint">sha256:{d.checkpoint.hash.slice(0, 12)}</span>}
            </p>
            {d.action && !d.action.available && d.action.reason && (
              <p className="text-[12.5px] text-faint">{d.action.reason}</p>
            )}
            {d.action?.available && d.action.expiresAt && (
              <p className="text-[12.5px] text-faint">Can be undone until {formatTime(d.action.expiresAt, 'date')}.</p>
            )}
            {d.preserved && d.preserved.entries.length > 0 && (
              <div className="pt-1">
                <p className="text-[12.5px] text-zinc-400">Data it removed or rewrote, kept{d.preserved.purgedAt ? ' until retention removed it' : ''}:</p>
                <ul className="mt-1 space-y-0.5">
                  {d.preserved.entries.map((e, i) => (
                    <li key={i} className="font-mono text-[11.5px] leading-[18px] text-zinc-400 [overflow-wrap:anywhere]">{keptLine(e)}</li>
                  ))}
                </ul>
              </div>
            )}
          </Section>

          {d.recoveries.map((r) => (
            <Section key={r.id} title={`Restore #${r.seq}`}>
              <Facts className="!mt-0">
                <Fact strong>{restoreLine(r)}</Fact>
                <Fact>{r.actor.label}</Fact>
                <Fact><Time iso={r.createdAt} mode="dateTime" /></Fact>
              </Facts>
              {r.verification && (
                <ul className="space-y-2">
                  {r.verification.checks.map((c) => <CheckRow key={c.id} check={c} />)}
                </ul>
              )}
              {r.preserved && r.preserved.entries.length > 0 && (
                <ul className="space-y-0.5">
                  {r.preserved.entries.map((e, i) => (
                    <li key={i} className="font-mono text-[11.5px] leading-[18px] text-faint [overflow-wrap:anywhere]">Kept: {keptLine(e)}</li>
                  ))}
                </ul>
              )}
              <Disclosure label="SQL">
                <Sql statements={r.statements} quoted={d.quoted} />
              </Disclosure>
            </Section>
          ))}

          <Section title="SQL">
            <Disclosure label={d.quoted ? `${d.statements.length} statement${d.statements.length === 1 ? '' : 's'}` : 'Statements'}>
              <Sql statements={d.statements} quoted={d.quoted} />
            </Disclosure>
            {d.error && <p className="font-mono text-[11.5px] leading-[18px] text-rose-300/80 [overflow-wrap:anywhere]">{d.error}</p>}
          </Section>
        </div>
      )}
    </RecordDrawer>
  )
}
