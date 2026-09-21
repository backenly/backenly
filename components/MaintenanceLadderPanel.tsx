'use client'

/**
 * MaintenanceLadderPanel — the one place a person can authorise a schema rewrite
 * ==============================================================================
 *
 * A structural ladder is the heaviest thing the autonomy loop can do: it adds a
 * column, constrains it, installs a dual-write trigger, backfills every row,
 * verifies the two columns agree, and repoints the readers. It is gated on a
 * human saying yes, and until this panel existed there was no way to say it.
 * `maintenance_approvals` had a reader and no writer, so the scheduler asked on
 * every pass and the only documented answer was an operator typing an INSERT
 * into psql.
 *
 * ── What this shows, and why all of it ─────────────────────────────────────
 *
 * Every rung, its tier, and whether it can be undone. Not a summary. Consent to
 * "consolidate the lifecycle column" without seeing that rung 6 repoints live
 * readers, or that `contract` can never be undone, is not consent anybody could
 * meaningfully give. The irreversible rung is called out separately because it
 * is the one the robot will never run.
 *
 * ── Why it asks for columns ────────────────────────────────────────────────
 *
 * The planner emits abstract params on purpose and never a column name, so
 * somebody has to say which column is being replaced by which. A scheduler that
 * derived that would be guessing which column to migrate. The answers go to the
 * server, which composes the per-rung bindings — the browser does not build
 * them, so the dashboard and an agent posting raw bindings hit one authority.
 *
 * ── Nothing pending renders nothing ────────────────────────────────────────
 *
 * Most projects never see this panel. An empty card explaining a feature that
 * is not happening is the scaffolding this product does not ship.
 */

import { useCallback, useEffect, useState } from 'react'
import { Loader2, ShieldAlert, Undo2, AlertTriangle, Wrench } from 'lucide-react'
import { KIT, KitButton } from '@/components/inspector/kit'

const CARD =
  `relative overflow-hidden ${KIT.radius} border ${KIT.border} ${KIT.surface} ${KIT.inset}`

interface Rung {
  ordinal: number
  kind: string
  tier: number
  executable: boolean
  rollback: string | null
}

interface Ladder {
  findingId: string
  planId: string
  planVersion: string
  table: string
  diagnosis: { hypothesis?: unknown; verdict?: unknown }
  validity: string
  blockedReasons: string[]
  needsBinding: Rung[]
  humanOnly: Rung[]
  approval: { id: string; approvedBy: string; maxTier: number; createdAt: string } | null
  staleApproval: { id: string; planVersion: string } | null
}

/** The diagnosis carries a hypothesis object in some shapes and an id in others. */
function hypothesisLabel(d: Ladder['diagnosis']): string {
  const h = d?.hypothesis as { id?: string } | string | undefined
  if (typeof h === 'string') return h
  if (h && typeof h === 'object' && typeof h.id === 'string') return h.id
  return 'structural cause'
}

const TIER_COPY: Record<number, string> = {
  0: 'read-only',
  1: 'additive',
  2: 'needs your approval',
  3: 'you do this one, never the robot',
}

export function MaintenanceLadderPanel({ projectId }: { projectId: string }) {
  const [ladder, setLadder] = useState<Ladder | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [sourceColumn, setSourceColumn] = useState('')
  const [targetColumn, setTargetColumn] = useState('')
  const [targetType, setTargetType] = useState('text')
  const [allowedValues, setAllowedValues] = useState('')

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}/maintenance`)
      const json = await res.json()
      setLadder(json?.pending ? (json.ladder as Ladder) : null)
    } catch {
      // A failed read is not "nothing is wrong". It renders nothing either way,
      // but it must not be recorded as a healthy answer.
      setLadder(null)
    } finally {
      setLoaded(true)
    }
  }, [projectId])

  useEffect(() => {
    void load()
  }, [load])

  const approve = useCallback(async () => {
    if (!ladder) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/projects/${projectId}/maintenance`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          // The version as it was when this panel drew it. If the plan has
          // moved since, the server refuses rather than approving a ladder
          // that no longer exists.
          planVersion: ladder.planVersion,
          answers: {
            sourceColumn: sourceColumn.trim(),
            targetColumn: targetColumn.trim(),
            targetType: targetType.trim() || 'text',
            transform: { kind: 'identity' },
            allowedValues: allowedValues
              .split(',')
              .map(v => v.trim())
              .filter(Boolean),
          },
        }),
      })
      const json = await res.json()
      if (!res.ok) {
        setError(json?.error ?? 'Could not record the approval.')
        // A 409 means the world moved. Re-read so the panel stops showing a
        // version nobody can approve any more.
        if (res.status === 409) await load()
        return
      }
      await load()
    } catch {
      setError('Could not reach the server.')
    } finally {
      setBusy(false)
    }
  }, [ladder, projectId, sourceColumn, targetColumn, targetType, allowedValues, load])

  const withdraw = useCallback(async () => {
    if (!ladder?.approval) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(
        `/api/projects/${projectId}/maintenance?approvalId=${encodeURIComponent(ladder.approval.id)}`,
        { method: 'DELETE' },
      )
      if (!res.ok) {
        const json = await res.json().catch(() => ({}))
        setError(json?.error ?? 'Could not withdraw the approval.')
        return
      }
      await load()
    } catch {
      setError('Could not reach the server.')
    } finally {
      setBusy(false)
    }
  }, [ladder, projectId, load])

  // Nothing pending is the normal state. No card, no placeholder.
  if (!loaded || !ladder) return null

  const canApprove =
    ladder.validity === 'executable' && sourceColumn.trim() !== '' && targetColumn.trim() !== ''

  return (
    <section className={CARD}>
      <div className="flex items-center justify-between border-b border-white/[0.06] px-5 py-3.5">
        <div className="flex items-center gap-2">
          <Wrench className="size-3.5 text-amber-300" />
          <h3 className="text-[13px] font-semibold tracking-tight text-zinc-100">
            Structural maintenance
          </h3>
          <span className="font-mono text-[11px] tabular-nums text-zinc-600">{ladder.table}</span>
        </div>
        <span className="font-mono text-[10.5px] tabular-nums text-zinc-600">
          {ladder.planId}@{ladder.planVersion}
        </span>
      </div>

      <div className="border-b border-white/[0.06] px-5 py-2.5">
        <p className="text-[11.5px] leading-relaxed text-zinc-500">
          Backenly found a repeating structural problem in <span className="text-zinc-300">{ladder.table}</span>{' '}
          ({hypothesisLabel(ladder.diagnosis)}) and prepared a migration for it. It will not run
          until you approve it, and your approval covers this exact version only.
        </p>
      </div>

      {ladder.validity !== 'executable' && (
        <div className="flex items-start gap-2 border-b border-white/[0.06] bg-amber-500/[0.04] px-5 py-2.5">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-400" />
          <p className="text-[11.5px] leading-relaxed text-amber-200/80">
            This plan is {ladder.validity} and cannot be approved: {ladder.blockedReasons.join('; ')}
          </p>
        </div>
      )}

      <ol className="divide-y divide-white/[0.04]">
        {ladder.needsBinding.map(r => (
          <li key={r.ordinal} className="flex items-center justify-between px-5 py-2">
            <div className="flex items-center gap-2.5">
              <span className="font-mono text-[10.5px] tabular-nums text-zinc-600">{r.ordinal}</span>
              <span className="text-[12px] text-zinc-200">{r.kind.replace(/_/g, ' ')}</span>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-[10.5px] text-zinc-500">
                tier {r.tier} · {TIER_COPY[r.tier] ?? ''}
              </span>
              <span
                className={`font-mono text-[10px] ${r.rollback && r.rollback !== 'none_required' ? 'text-emerald-400/70' : 'text-zinc-600'}`}
              >
                {r.rollback === 'none_required'
                  ? 'read-only'
                  : r.rollback
                    ? `undo: ${r.rollback.replace(/_/g, ' ')}`
                    : 'no undo'}
              </span>
            </div>
          </li>
        ))}
      </ol>

      {ladder.humanOnly.length > 0 && (
        <div className="flex items-start gap-2 border-t border-white/[0.06] px-5 py-2.5">
          <ShieldAlert className="mt-0.5 size-3.5 shrink-0 text-zinc-500" />
          <p className="text-[11.5px] leading-relaxed text-zinc-500">
            {ladder.humanOnly.map(h => h.kind.replace(/_/g, ' ')).join(', ')} is irreversible and is
            never run automatically, at any autonomy mode. The ladder stops before it and waits for
            you to do it yourself.
          </p>
        </div>
      )}

      {ladder.approval ? (
        <div className="flex items-center justify-between border-t border-white/[0.06] bg-emerald-500/[0.03] px-5 py-3">
          <p className="text-[11.5px] text-zinc-400">
            Approved by <span className="text-zinc-200">{ladder.approval.approvedBy}</span>, up to
            tier {ladder.approval.maxTier}. The loop will run it on its next pass.
          </p>
          <KitButton variant="danger" onClick={withdraw} disabled={busy}>
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Undo2 className="size-3.5" />}
            Withdraw
          </KitButton>
        </div>
      ) : (
        <div className="border-t border-white/[0.06] px-5 py-3.5">
          {ladder.staleApproval && (
            <p className="mb-3 text-[11.5px] leading-relaxed text-amber-200/80">
              You approved version {ladder.staleApproval.planVersion}, but the plan has been rebuilt
              to {ladder.planVersion}. The schema, the ladder or the executor moved, so the old
              approval does not carry over.
            </p>
          )}
          <p className="mb-3 text-[11.5px] leading-relaxed text-zinc-500">
            Name the columns. Backenly deliberately does not guess these: approving
            &ldquo;consolidate the lifecycle column&rdquo; without saying which column is not an
            approval anybody could give.
          </p>
          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
            <Field label="Existing column" value={sourceColumn} onChange={setSourceColumn} placeholder="status" />
            <Field label="New column" value={targetColumn} onChange={setTargetColumn} placeholder="state" />
            <Field label="New column type" value={targetType} onChange={setTargetType} placeholder="text" />
            <Field
              label="Allowed values (comma separated)"
              value={allowedValues}
              onChange={setAllowedValues}
              placeholder="active, expired"
            />
          </div>
          {error && (
            <p className="mt-3 text-[11.5px] leading-relaxed text-rose-300/90">{error}</p>
          )}
          <div className="mt-3.5 flex items-center gap-3">
            <KitButton variant="primary" onClick={approve} disabled={busy || !canApprove}>
              {busy && <Loader2 className="size-3.5 animate-spin" />}
              Approve this migration
            </KitButton>
            <span className="text-[10.5px] text-zinc-600">
              Covers tier 2 and below, on version {ladder.planVersion} only.
            </span>
          </div>
        </div>
      )}
    </section>
  )
}

function Field({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder: string
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[10.5px] uppercase tracking-wide text-zinc-600">{label}</span>
      <input
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        className={`w-full rounded-md border border-white/[0.08] ${KIT.well} px-2.5 py-1.5 font-mono text-[12px] text-zinc-200 placeholder:text-zinc-600 focus:border-violet-400/40 focus:outline-none`}
      />
    </label>
  )
}
