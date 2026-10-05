'use client'

/**
 * StructuralEvolutionPanel — where a table's shape is allowed to change
 * =====================================================================
 *
 * Lives in the Database section on purpose. Moving a concern into its own table
 * creates a table, and AGENTS.md is explicit that only this section creates
 * backend reality. The Autonomy page shows what the loop REPAIRED; this shows
 * what the backend has OUTGROWN, which is a design decision and belongs with
 * the schema.
 *
 * ── What it asks of a person, in order ─────────────────────────────────────
 *
 *   1. Read the evidence. Every family that spoke, including the ones that
 *      could not look, and the measured cost. Never a score alone.
 *   2. Rehearse. The ladder runs for real on a copy of the table's rows and is
 *      rolled back; the panel shows every exercise. Approval stays disabled
 *      until a rehearsal of THIS spec passed, because consenting to SQL nobody
 *      has seen run is the thing the rehearsal exists to prevent.
 *   3. Approve one exact version. The version comes from the rehearsal, so a
 *      renamed satellite is approved as the plan it actually is.
 *   4. Run, watch, undo if wanted. Undo is lossless or refused, and says which.
 *
 * Retiring the old columns is never offered. It is listed, with everything a
 * person must migrate first, and left to them.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Check, ChevronDown, Eye, FlaskConical, Play, RefreshCw, Split, Undo2, X } from 'lucide-react'
import {
  EmptyState,
  IconButton,
  KIT,
  KitButton,
  KitConfirmDialog,
  Skeleton,
  StatusDot,
  Tag,
} from '@/components/inspector/kit'
import { EDGE, R_PANEL, RULE } from '@/components/console/tokens'

// ── Wire shapes (lib/structural-evolution/index.ts) ──────────────────────────

type Verdict = 'supports' | 'contradicts' | 'silent' | 'unavailable'

interface Step {
  ordinal: number
  kind: string
  tier: number
  capability: string
  title: string
  why: string
  sql: string[]
  rollback: { strategy: string; description: string } | null
}

interface Spec {
  host: string
  members: string[]
  satellite: string
  label: string
}

interface Proposal {
  key: string
  planId: string
  host: string
  label: string
  members: string[]
  state: 'proposed' | 'approved' | 'in_progress' | 'halted' | 'extracted' | 'rolled_back'
  verdict: string
  families: Array<{ family: string; verdict: Verdict; detail: string }>
  pressure: Array<{ kind: string; detail: string }>
  presenceRate: number | null
  priority: { score: number; label: 'high' | 'medium' | 'low' }
  spec: Spec
  plan: {
    planVersion: string
    validity: string
    blockedReasons: string[]
    contractBlockers: string[]
    caveats: string[]
    access: { readers: string[]; writers: string[] }
    steps: Step[]
    requiredTier: number
  }
  consent: { approvalId: string; planVersion: string; current: boolean; revoked: boolean } | null
  lastRun: { status: string; haltReason: string | null; at: string } | null
  clientMigration: Array<{ purpose: string; before: string; after: string }>
}

interface Watching {
  key: string
  host: string
  members: string[]
  verdict: string
}

interface Report {
  proposals: Proposal[]
  watching: Watching[]
  limits: string[]
  windowDays: number
}

interface Rehearsal {
  passed: boolean
  sampledRows: number
  exercises: Array<{ name: string; outcome: 'passed' | 'failed' | 'not_exercised'; detail: string }>
  notRehearsed: string[]
  error: string | null
}

const VERDICT_TONE: Record<Verdict, 'operational' | 'failed' | 'neutral' | 'attention'> = {
  supports: 'operational',
  contradicts: 'failed',
  silent: 'neutral',
  unavailable: 'attention',
}

const STATE_COPY: Record<Proposal['state'], { label: string; tone: 'neutral' | 'violet' | 'good' | 'warn' | 'bad' }> = {
  proposed: { label: 'Proposed', tone: 'violet' },
  approved: { label: 'Approved', tone: 'good' },
  in_progress: { label: 'In progress', tone: 'warn' },
  halted: { label: 'Halted', tone: 'bad' },
  extracted: { label: 'Extracted', tone: 'good' },
  rolled_back: { label: 'Reversed', tone: 'neutral' },
}

const TIER_COPY: Record<number, string> = {
  0: 'reads only',
  1: 'additive, closed',
  2: 'needs your approval',
  3: 'yours to do, never the robot',
}

const humanise = (s: string) => s.replace(/_/g, ' ')

// ── Panel ────────────────────────────────────────────────────────────────────

export function StructuralEvolutionPanel({ projectId }: { projectId: string }) {
  const [report, setReport] = useState<Report | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchReport = useCallback(async (): Promise<{ report: Report | null; error: string | null }> => {
    try {
      const res = await fetch(`/api/projects/${projectId}/structural-evolution`)
      const json = await res.json()
      if (!res.ok) throw new Error(json?.error ?? 'Could not analyse the schema.')
      return { report: json as Report, error: null }
    } catch (err) {
      // A failed read is not "the shape is right". Say so instead of
      // rendering the empty state.
      return { report: null, error: err instanceof Error ? err.message : 'Could not analyse the schema.' }
    }
  }, [projectId])

  const load = useCallback(async () => {
    setLoading(true)
    const r = await fetchReport()
    setReport(r.report)
    setError(r.error)
    setLoading(false)
  }, [fetchReport])

  useEffect(() => {
    let live = true
    void fetchReport().then(r => {
      if (!live) return
      setReport(r.report)
      setError(r.error)
      setLoading(false)
    })
    return () => {
      live = false
    }
  }, [fetchReport])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className={`flex h-[44px] flex-shrink-0 items-center justify-between gap-3 border-b ${RULE} pl-4 pr-2 sm:pl-5`}>
        <div className="flex min-w-0 items-baseline gap-2.5">
          <h2 className="text-[13px] font-medium text-zinc-100">Structural evolution</h2>
          {report && (
            <span className="text-[12px] tabular-nums text-zinc-500">
              {report.proposals.length} proposed · {report.watching.length} watching
            </span>
          )}
        </div>
        <IconButton
          icon={RefreshCw}
          label="Re-analyse"
          onClick={() => void load()}
          className={loading ? '[&_svg]:animate-spin' : ''}
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="w-full max-w-[920px] space-y-5 px-4 py-5 sm:px-5">
          <p className="max-w-[76ch] text-[13px] leading-[20px] text-zinc-400 [text-wrap:pretty]">
            Tables accumulate concerns: refunds on <span className="font-mono text-zinc-300">orders</span>, then
            coupons, then discounts. Backenly watches for a group of columns that behaves like its own thing and has
            started to cost something, and prepares a move into its own table that keeps every existing client
            working. Nothing changes until you rehearse it, approve that exact version, and run it.
          </p>

          {loading && !report ? (
            <div className="space-y-3">
              <Skeleton className="h-[120px] w-full" />
              <Skeleton className="h-[120px] w-full" />
            </div>
          ) : error ? (
            <p className="text-[13px] leading-[20px] text-rose-300/90">{error}</p>
          ) : report && report.proposals.length === 0 ? (
            <EmptyState
              icon={Split}
              title="No table has outgrown its shape"
              description={`Nothing carries a separate concern with a measured cost over the last ${report.windowDays} days. Cohesive groups that cost nothing yet are watched below.`}
            />
          ) : (
            report?.proposals.map(p => (
              <ProposalCard key={p.key} projectId={projectId} proposal={p} onChanged={load} />
            ))
          )}

          {report && report.watching.length > 0 && (
            <section className={`${R_PANEL} border ${EDGE} ${KIT.surface}`}>
              <div className={`flex items-center gap-2 border-b ${RULE} px-4 py-2.5`}>
                <Eye className="h-3.5 w-3.5 text-zinc-500" />
                <h3 className="text-[13px] font-medium text-zinc-200">Watching</h3>
              </div>
              <ul className="divide-y divide-white/[0.04]">
                {report.watching.map(w => (
                  <li key={w.key} className="px-4 py-2.5">
                    <p className="font-mono text-[12px] text-zinc-300">
                      {w.host}.{'{'}
                      {w.members.join(', ')}
                      {'}'}
                    </p>
                    <p className="mt-0.5 text-[12.5px] leading-[18px] text-zinc-500">{w.verdict}</p>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {report && report.limits.length > 0 && (
            <ul className="space-y-1">
              {report.limits.map(l => (
                <li key={l} className="text-[12px] leading-[18px] text-zinc-600">
                  {l}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}

// ── One proposal ─────────────────────────────────────────────────────────────

function ProposalCard({
  projectId,
  proposal: p,
  onChanged,
}: {
  projectId: string
  proposal: Proposal
  onChanged: () => Promise<void>
}) {
  const [satellite, setSatellite] = useState(p.spec.satellite)
  const [rehearsal, setRehearsal] = useState<{ forName: string; planVersion: string; report: Rehearsal } | null>(null)
  const [busy, setBusy] = useState<null | 'rehearse' | 'approve' | 'execute' | 'withdraw' | 'rollback'>(null)
  const [message, setMessage] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null)
  const [confirm, setConfirm] = useState<null | 'execute' | 'rollback'>(null)
  const [openStep, setOpenStep] = useState<number | null>(null)

  const editable = p.state === 'proposed' || p.state === 'rolled_back'
  const spec: Spec = useMemo(() => ({ ...p.spec, satellite: satellite.trim() }), [p.spec, satellite])
  const rehearsedThisSpec = rehearsal && rehearsal.forName === spec.satellite && rehearsal.report.passed

  const call = useCallback(
    async (kind: NonNullable<typeof busy>, init: RequestInit, url = `/api/projects/${projectId}/structural-evolution`) => {
      setBusy(kind)
      setMessage(null)
      try {
        const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...init })
        const json = await res.json().catch(() => ({}))
        return { ok: res.ok, json }
      } catch {
        return { ok: false, json: { error: 'Could not reach the server.' } }
      } finally {
        setBusy(null)
      }
    },
    [projectId],
  )

  const rehearse = async () => {
    const { ok, json } = await call('rehearse', { method: 'POST', body: JSON.stringify({ action: 'rehearse', spec }) })
    if (!ok) return setMessage({ tone: 'bad', text: json?.error ?? 'The rehearsal could not run.' })
    setRehearsal({ forName: spec.satellite, planVersion: json.planVersion, report: json.rehearsal })
  }

  const approve = async () => {
    if (!rehearsal) return
    const { ok, json } = await call('approve', {
      method: 'POST',
      body: JSON.stringify({ action: 'approve', spec, planVersion: rehearsal.planVersion }),
    })
    if (!ok) {
      setMessage({ tone: 'bad', text: json?.error ?? 'Could not record the approval.' })
      // The table moved since the rehearsal: the version shown is gone.
      setRehearsal(null)
      return
    }
    setMessage({ tone: 'good', text: `Approved version ${rehearsal.planVersion}.` })
    await onChanged()
  }

  const execute = async () => {
    setConfirm(null)
    const { json } = await call('execute', { method: 'POST', body: JSON.stringify({ action: 'execute', planId: p.planId }) })
    const status = String(json?.status ?? 'failed')
    setMessage({
      tone: status === 'completed' || status === 'awaiting_background_work' ? 'good' : 'bad',
      text:
        status === 'completed'
          ? `${spec.satellite} is live. Old and new clients both work; retiring the old columns is yours to do.`
          : status === 'awaiting_background_work'
            ? 'Copying existing rows in the background. Run again, or let the scheduler resume it, once it finishes.'
            : json?.haltReason ?? json?.error ?? 'The ladder stopped.',
    })
    await onChanged()
  }

  const withdraw = async () => {
    if (!p.consent) return
    const { ok, json } = await call(
      'withdraw',
      { method: 'DELETE' },
      `/api/projects/${projectId}/structural-evolution?approvalId=${encodeURIComponent(p.consent.approvalId)}`,
    )
    setMessage(ok ? { tone: 'good', text: 'Consent withdrawn. Nothing further will run.' } : { tone: 'bad', text: json?.error ?? 'Could not withdraw.' })
    await onChanged()
  }

  const rollback = async () => {
    setConfirm(null)
    const { json } = await call('rollback', { method: 'POST', body: JSON.stringify({ action: 'rollback', planId: p.planId }) })
    const status = String(json?.status ?? 'failed')
    setMessage({
      tone: status === 'rolled_back' || status === 'nothing_to_undo' ? 'good' : 'bad',
      text:
        status === 'rolled_back'
          ? `Reversed. ${p.host} is exactly as it was before the extraction.`
          : status === 'nothing_to_undo'
            ? 'There was nothing left to undo.'
            : json?.reason ?? json?.error ?? 'The rollback did not run.',
    })
    await onChanged()
  }

  const stateCopy = STATE_COPY[p.state]

  return (
    <section className={`${R_PANEL} border ${EDGE} ${KIT.surface}`}>
      {/* Head */}
      <div className={`flex flex-wrap items-center justify-between gap-2 border-b ${RULE} px-4 py-3`}>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Split className="h-3.5 w-3.5 flex-shrink-0 text-violet-300" />
          <span className="truncate font-mono text-[12.5px] text-zinc-100">
            {p.host}.{'{'}
            {p.members.join(', ')}
            {'}'} → {spec.satellite || '…'}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <Tag tone={stateCopy.tone}>{stateCopy.label}</Tag>
          <Tag tone={p.priority.label === 'high' ? 'warn' : 'neutral'}>{p.priority.label} priority</Tag>
        </div>
      </div>

      <div className="space-y-4 px-4 py-3.5">
        <p className="text-[13px] leading-[20px] text-zinc-300 [text-wrap:pretty]">{p.verdict}</p>

        {/* Evidence */}
        <div>
          <h4 className="mb-1.5 text-[12px] font-medium text-zinc-500">Evidence</h4>
          <ul className="space-y-1">
            {p.families.map(f => (
              <li key={f.family} className="flex items-start gap-2 text-[12.5px] leading-[18px]">
                <StatusDot tone={VERDICT_TONE[f.verdict]} label={<span className="w-[86px] text-zinc-300">{humanise(f.family)}</span>} />
                <span className="text-zinc-500">{f.detail}</span>
              </li>
            ))}
          </ul>
        </div>

        <div>
          <h4 className="mb-1.5 text-[12px] font-medium text-zinc-500">What keeping it on {p.host} costs</h4>
          {p.pressure.length === 0 ? (
            <p className="text-[12.5px] text-zinc-500">Nothing measured.</p>
          ) : (
            <ul className="space-y-1">
              {p.pressure.map(x => (
                <li key={x.kind} className="text-[12.5px] leading-[18px] text-zinc-400">
                  <span className="text-zinc-300">{humanise(x.kind)}</span> — {x.detail}
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Ladder */}
        <div>
          <h4 className="mb-1.5 text-[12px] font-medium text-zinc-500">
            The ladder · version <span className="font-mono">{p.plan.planVersion}</span>
          </h4>
          {p.plan.validity !== 'executable' && (
            <p className="mb-2 text-[12.5px] leading-[18px] text-amber-200/80">
              This plan is {humanise(p.plan.validity)}: {p.plan.blockedReasons.join('; ')}
            </p>
          )}
          <ol className={`divide-y divide-white/[0.04] ${R_PANEL} border ${RULE}`}>
            {p.plan.steps.map(s => (
              <li key={s.ordinal}>
                <button
                  type="button"
                  aria-expanded={openStep === s.ordinal}
                  onClick={() => setOpenStep(openStep === s.ordinal ? null : s.ordinal)}
                  className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left hover:bg-white/[0.02]"
                >
                  <span className="flex min-w-0 items-center gap-2.5">
                    <span className="w-3 text-[12px] tabular-nums text-zinc-600">{s.ordinal}</span>
                    <span className="truncate text-[12.5px] text-zinc-200">{s.title}</span>
                  </span>
                  <span className="flex flex-shrink-0 items-center gap-3">
                    <span className="hidden text-[12px] text-zinc-500 sm:inline">
                      tier {s.tier} · {TIER_COPY[s.tier] ?? ''}
                    </span>
                    <span className={`text-[12px] ${s.rollback ? 'text-emerald-400/70' : 'text-zinc-600'}`}>
                      {s.rollback ? (s.rollback.strategy === 'none_required' ? 'nothing to undo' : 'undoable') : 'no undo'}
                    </span>
                    <ChevronDown className={`h-3.5 w-3.5 text-zinc-600 transition-transform ${openStep === s.ordinal ? 'rotate-180' : ''}`} />
                  </span>
                </button>
                {openStep === s.ordinal && (
                  <div className="space-y-2 px-3 pb-3 pl-8">
                    <p className="text-[12.5px] leading-[18px] text-zinc-400">{s.why}</p>
                    {s.rollback && s.rollback.strategy !== 'none_required' && (
                      <p className="text-[12px] leading-[18px] text-zinc-500">Undo: {s.rollback.description}</p>
                    )}
                    {s.sql.length > 0 && (
                      <pre className={`max-h-[260px] overflow-auto ${R_PANEL} ${KIT.well} border ${RULE} p-2.5 font-mono text-[11.5px] leading-[17px] text-zinc-300`}>
                        {s.sql.join(';\n\n')};
                      </pre>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ol>
          {p.plan.access.readers.length + p.plan.access.writers.length > 0 && (
            <p className="mt-2 text-[12px] leading-[18px] text-zinc-500">
              Access mirrors {p.host}: read by {p.plan.access.readers.join(', ') || 'no role'}; written by{' '}
              {p.plan.access.writers.join(', ') || 'no role'}, under {p.host}&rsquo;s own row rules.
            </p>
          )}
        </div>

        {/* Clients */}
        <div>
          <h4 className="mb-1.5 text-[12px] font-medium text-zinc-500">Moving a client over, whenever it suits you</h4>
          <div className={`overflow-x-auto ${R_PANEL} border ${RULE}`}>
            <table className="w-full text-left">
              <tbody className="divide-y divide-white/[0.04]">
                {p.clientMigration.map(m => (
                  <tr key={m.purpose}>
                    <td className="whitespace-nowrap px-3 py-1.5 text-[12px] text-zinc-500">{m.purpose}</td>
                    <td className="px-3 py-1.5 font-mono text-[11.5px] text-zinc-500 line-through decoration-zinc-700">{m.before}</td>
                    <td className="px-3 py-1.5 font-mono text-[11.5px] text-zinc-200">{m.after}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Contract */}
        <details className="group">
          <summary className="cursor-pointer text-[12px] font-medium text-zinc-500 hover:text-zinc-300">
            Before you retire the old columns ({p.plan.contractBlockers.length})
          </summary>
          <ul className="mt-1.5 list-disc space-y-0.5 pl-5">
            {p.plan.contractBlockers.map(b => (
              <li key={b} className="text-[12px] leading-[18px] text-zinc-500">
                {b}
              </li>
            ))}
            {p.plan.caveats.map(c => (
              <li key={c} className="text-[12px] leading-[18px] text-zinc-600">
                {c}
              </li>
            ))}
          </ul>
        </details>

        {/* Rehearsal result */}
        {rehearsal && rehearsal.forName === spec.satellite && (
          <div className={`${R_PANEL} border ${RULE} ${KIT.well} px-3 py-2.5`}>
            <p className={`text-[12.5px] ${rehearsal.report.passed ? 'text-emerald-300/90' : 'text-rose-300/90'}`}>
              {rehearsal.report.error
                ? `The rehearsal could not run: ${rehearsal.report.error}`
                : rehearsal.report.passed
                  ? `Rehearsed on ${rehearsal.report.sampledRows} copied rows and rolled back. Every exercise reconciled.`
                  : 'The rehearsal found a difference. Nothing was changed.'}
            </p>
            <ul className="mt-1.5 space-y-0.5">
              {rehearsal.report.exercises.map(e => (
                <li key={e.name} className="flex items-start gap-2 text-[12px] leading-[17px]">
                  {e.outcome === 'passed' ? (
                    <Check className="mt-0.5 h-3 w-3 flex-shrink-0 text-emerald-400" />
                  ) : e.outcome === 'failed' ? (
                    <X className="mt-0.5 h-3 w-3 flex-shrink-0 text-rose-400" />
                  ) : (
                    <span className="mt-0.5 h-3 w-3 flex-shrink-0 text-center text-zinc-600">–</span>
                  )}
                  <span className="text-zinc-300">{humanise(e.name)}</span>
                  <span className="text-zinc-500">{e.detail}</span>
                </li>
              ))}
            </ul>
            {rehearsal.report.notRehearsed.length > 0 && (
              <p className="mt-1.5 text-[11.5px] leading-[16px] text-zinc-600">
                Not rehearsed: {rehearsal.report.notRehearsed.join('; ')}
              </p>
            )}
          </div>
        )}

        {p.lastRun?.haltReason && p.state !== 'extracted' && p.state !== 'rolled_back' && (
          <p className="text-[12.5px] leading-[18px] text-amber-200/80">Last run stopped: {p.lastRun.haltReason}</p>
        )}
        {message && (
          <p className={`text-[12.5px] leading-[18px] ${message.tone === 'good' ? 'text-emerald-300/90' : 'text-rose-300/90'}`}>
            {message.text}
          </p>
        )}
      </div>

      {/* Actions */}
      <div className={`flex flex-wrap items-center gap-2 border-t ${RULE} px-4 py-3`}>
        {editable && (
          <>
            <label className="flex items-center gap-2">
              <span className="text-[12px] text-zinc-500">New table</span>
              <input
                value={satellite}
                onChange={e => setSatellite(e.target.value)}
                spellCheck={false}
                className={`h-[28px] w-[180px] rounded-[7px] border ${EDGE} ${KIT.well} px-2 font-mono text-[12px] text-zinc-200 focus:border-violet-300/50 focus:outline-none`}
              />
            </label>
            <KitButton
              size="sm"
              icon={FlaskConical}
              onClick={rehearse}
              loading={busy === 'rehearse'}
              disabled={!!busy || p.plan.validity !== 'executable' || !spec.satellite}
            >
              Rehearse
            </KitButton>
            <KitButton
              size="sm"
              variant="primary"
              icon={Check}
              onClick={approve}
              loading={busy === 'approve'}
              disabled={!!busy || !rehearsedThisSpec}
              title={rehearsedThisSpec ? `Approve version ${rehearsal!.planVersion}` : 'Rehearse this exact plan first'}
            >
              Approve this version
            </KitButton>
          </>
        )}
        {(p.state === 'approved' || p.state === 'in_progress' || p.state === 'halted') && (
          <KitButton size="sm" variant="primary" icon={Play} onClick={() => setConfirm('execute')} loading={busy === 'execute'} disabled={!!busy}>
            {p.state === 'approved' ? 'Run now' : 'Resume'}
          </KitButton>
        )}
        {p.consent && !p.consent.revoked && p.state !== 'extracted' && (
          <KitButton size="sm" variant="ghost" onClick={withdraw} loading={busy === 'withdraw'} disabled={!!busy}>
            Withdraw consent
          </KitButton>
        )}
        {(p.state === 'extracted' || p.state === 'in_progress' || p.state === 'halted') && (
          <KitButton size="sm" variant="danger" icon={Undo2} onClick={() => setConfirm('rollback')} loading={busy === 'rollback'} disabled={!!busy}>
            Undo
          </KitButton>
        )}
        <span className="ml-auto text-[12px] text-zinc-600">Consent covers this version only.</span>
      </div>

      <KitConfirmDialog
        open={confirm === 'execute'}
        onCancel={() => setConfirm(null)}
        onConfirm={execute}
        title={`Run the extraction of ${p.label} from ${p.host}?`}
        description={`Creates ${spec.satellite}, keeps it in sync with ${p.host}, copies existing rows in the background and opens it to the roles that can use ${p.host}. Every rung can be undone. The old columns stay.`}
        confirmLabel="Run"
      />
      <KitConfirmDialog
        open={confirm === 'rollback'}
        onCancel={() => setConfirm(null)}
        onConfirm={rollback}
        danger
        title={`Undo the extraction and remove ${spec.satellite}?`}
        description={`Refused unless ${spec.satellite} holds nothing ${p.host} does not, so no write can be lost. Clients already using ${spec.satellite} will stop working.`}
        confirmLabel="Undo"
      />
    </section>
  )
}
