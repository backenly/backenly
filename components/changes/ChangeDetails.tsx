'use client'

/**
 * View details: everything technical about one change, and only here.
 *
 * What it did to each object, the protected checks and what each found, the
 * lifecycle with who requested, authorised and executed each step, the restore
 * point and the data kept, the SQL, and each restore that acted on it with its
 * own checks. The list row stays one line; this is where the evidence lives.
 */

import { useEffect, useState } from 'react'
import { AlertTriangle, Check, ChevronDown, ChevronRight, HelpCircle, X } from 'lucide-react'
import { KitButton, KitModal, KitNote, Skeleton, StatusDot } from '@/components/inspector/kit'
import type { ChangeDetail, ChangeSummary } from '@/lib/changes/history'
import type { PreservedEntry } from '@/lib/changes/types'
import type { VerificationCheck } from '@/lib/changes/verify'
import { EVENT, outcomeOf, when } from './present'

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-[11.5px] font-medium uppercase tracking-[0.06em] text-zinc-500">{title}</h3>
      {children}
    </section>
  )
}

function CheckRow({ check }: { check: VerificationCheck }) {
  const tone =
    check.outcome === 'confirmed'
      ? 'bg-emerald-400/15 text-emerald-300'
      : check.outcome === 'contradicted'
        ? 'bg-rose-400/15 text-rose-300'
        : 'bg-amber-400/15 text-amber-300'
  const Icon = check.outcome === 'confirmed' ? Check : check.outcome === 'contradicted' ? X : HelpCircle
  return (
    <li className="flex items-start gap-2.5">
      <span className={`mt-[2px] flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full ${tone}`} aria-label={check.outcome}>
        <Icon className="h-[11px] w-[11px]" strokeWidth={2.5} />
      </span>
      <span className="min-w-0">
        <span className="block text-[13px] text-zinc-200">{check.label}</span>
        {check.detail && <span className="block text-[12px] leading-[18px] text-zinc-500 [overflow-wrap:anywhere]">{check.detail}</span>}
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
        className="inline-flex items-center gap-1 text-[12.5px] font-medium text-zinc-400 hover:text-zinc-100"
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
      <p className="text-[12.5px] text-zinc-500">
        {quoted ? 'No statements were recorded.' : 'Not recorded here: this project’s data, including the SQL that ran, stays in its own region.'}
      </p>
    )
  }
  return (
    <pre className="max-h-[260px] overflow-auto rounded-[8px] border border-white/[0.06] bg-black/30 p-3 font-mono text-[11.5px] leading-[18px] text-zinc-300">
      {statements.map((s) => s.sql.trim()).join(';\n\n')}
    </pre>
  )
}

function keptLine(e: PreservedEntry): string {
  if (e.kind === 'table') return `Table ${e.table}${e.rows !== null ? `, ${e.rows} row${e.rows === 1 ? '' : 's'}` : ''}`
  const why = e.reason === 'dropped' ? 'dropped' : e.reason === 'retyped' ? 'retyped' : 'rewritten'
  return `Column ${e.table}.${e.column} (${why})${e.rows !== null ? `, ${e.rows} value${e.rows === 1 ? '' : 's'}` : ''}`
}

function outcomeNote(d: ChangeDetail): { tone: 'success' | 'warn' | 'danger' | 'info'; text: string } | null {
  const by = d.outcome.by ? ` by ${d.outcome.by.label}` : ''
  const at = d.outcome.at ? `, ${when(d.outcome.at)}` : ''
  switch (d.outcome.state) {
    case 'recovered':
      return { tone: 'success', text: `This change failed a check, so Backenly restored the state before it and verified the result${at}. Production is healthy.${d.outcome.note ? ` What failed: ${d.outcome.note}` : ''}` }
    case 'restored':
      return { tone: 'info', text: `The state before this change was restored${by}${at}, and verified.` }
    case 'awaiting_approval':
      return { tone: 'warn', text: `This change failed a check. Restoring the state before it would affect data written since, so it waits for a person.${d.outcome.note ? ` What failed: ${d.outcome.note}` : ''}` }
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

export function ChangeDetails({
  projectId,
  changeId,
  canManage,
  onClose,
  onRestore,
}: {
  projectId: string
  changeId: string
  canManage: boolean
  onClose: () => void
  /** Open the restore dialog for this change. */
  onRestore: (summary: ChangeSummary) => void
}) {
  const [detail, setDetail] = useState<ChangeDetail | null>(null)
  const [failed, setFailed] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch(`/api/projects/${projectId}/changes/${changeId}`, { credentials: 'include' })
      .then(async (res) => ({ ok: res.ok, body: await res.json().catch(() => ({})) }))
      .then(({ ok, body }) => {
        if (cancelled) return
        if (ok && body.change) setDetail(body.change)
        else setFailed(body.error || 'Could not load this change.')
      })
      .catch(() => { if (!cancelled) setFailed('Could not reach Backenly.') })
    return () => { cancelled = true }
  }, [projectId, changeId])

  const d = detail && detail.id === changeId ? detail : null
  const status = d ? outcomeOf(d) : null
  const note = d ? outcomeNote(d) : null
  const restorable = !!d && canManage && !!d.action?.available

  return (
    <KitModal
      open
      onClose={onClose}
      width="max-w-2xl"
      title={d ? <span className="[overflow-wrap:anywhere]">#{d.seq} · {d.summary}</span> : 'Change details'}
      description={
        d ? (
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <StatusDot tone={status!.tone} label={status!.label} />
            <span className="text-zinc-600">·</span>
            <span>{d.actor.label}</span>
            <span className="text-zinc-600">·</span>
            <span>{when(d.createdAt)}</span>
          </span>
        ) : undefined
      }
      footer={
        <>
          <KitButton variant="ghost" onClick={onClose}>Close</KitButton>
          {restorable && (
            <KitButton onClick={() => onRestore(d!)}>
              {d!.action!.kind === 'reapply' ? 'Reapply this change' : 'Restore previous state'}
            </KitButton>
          )}
        </>
      }
    >
      {failed ? (
        <KitNote tone="danger" icon={AlertTriangle}>{failed}</KitNote>
      ) : !d ? (
        <div className="space-y-3" aria-hidden>
          <Skeleton className="h-[14px] w-2/3" />
          <Skeleton className="h-[14px] w-1/2" />
          <Skeleton className="h-[120px] w-full" />
        </div>
      ) : (
        <div className="space-y-6">
          {note && (
            <KitNote tone={note.tone} icon={note.tone === 'success' ? Check : AlertTriangle}>
              <span className="[overflow-wrap:anywhere]">{note.text}</span>
            </KitNote>
          )}

          {d.title && d.title !== d.summary && (
            <Section title="Asked for">
              <p className="text-[13px] leading-[20px] text-zinc-300 [overflow-wrap:anywhere]">{d.title}</p>
            </Section>
          )}

          <Section title="What changed">
            {d.footprint.length === 0 ? (
              <p className="text-[13px] text-zinc-500">Nothing in the schema changed.</p>
            ) : (
              <ul className="space-y-3">
                {d.footprint.map((t, i) => (
                  <li key={i}>
                    <p className="text-[13px] text-zinc-200">
                      <span className="font-mono text-[12.5px]">{t.after ?? t.before}</span>
                      <span className="ml-2 text-[12px] text-zinc-500">
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
          </Section>

          <Section title="Checks">
            {d.verification ? (
              <ul className="space-y-2">
                {d.verification.checks.map((c) => <CheckRow key={c.id} check={c} />)}
              </ul>
            ) : (
              <p className="text-[13px] text-zinc-500">Not checked yet.</p>
            )}
          </Section>

          <Section title="Timeline">
            <ol className="space-y-1.5">
              {d.events.map((e, i) => (
                <li key={i} className="flex items-baseline justify-between gap-3 text-[12.5px]">
                  <span className="text-zinc-300">{EVENT[e.type] ?? e.type}</span>
                  <span className="flex-shrink-0 tabular-nums text-zinc-500">{when(e.at)}</span>
                </li>
              ))}
            </ol>
          </Section>

          <Section title="Restore point">
            <p className="text-[12.5px] leading-[19px] text-zinc-400">
              {d.checkpoint.intact ? 'Taken before the change and intact.' : 'Failed its integrity check, so it cannot be used.'}
              {d.checkpoint.parentSeq !== null && ` Follows change #${d.checkpoint.parentSeq}.`}
              {d.checkpoint.hash && <span className="ml-1 font-mono text-[11.5px] text-zinc-500">sha256:{d.checkpoint.hash.slice(0, 12)}</span>}
            </p>
            {d.action && !d.action.available && d.action.reason && (
              <p className="text-[12.5px] text-zinc-500">{d.action.reason}</p>
            )}
            {d.action?.available && d.action.expiresAt && (
              <p className="text-[12.5px] text-zinc-500">Can be restored until {new Date(d.action.expiresAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}.</p>
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
              <p className="text-[12.5px] text-zinc-400">
                {r.summary} · {r.actor.label} · {when(r.createdAt)}
              </p>
              {r.verification && (
                <ul className="space-y-2">
                  {r.verification.checks.map((c) => <CheckRow key={c.id} check={c} />)}
                </ul>
              )}
              {r.preserved && r.preserved.entries.length > 0 && (
                <ul className="space-y-0.5">
                  {r.preserved.entries.map((e, i) => (
                    <li key={i} className="font-mono text-[11.5px] leading-[18px] text-zinc-500 [overflow-wrap:anywhere]">Kept: {keptLine(e)}</li>
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
    </KitModal>
  )
}
