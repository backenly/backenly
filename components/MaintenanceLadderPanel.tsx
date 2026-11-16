'use client'

/**
 * A structural migration waiting on a person: the one place a schema rewrite
 * is authorised.
 * ==============================================================================
 * A structural ladder is the heaviest thing the autonomy loop can do: it adds a
 * column, constrains it, installs a dual-write trigger, backfills every row,
 * verifies the two columns agree, and repoints the readers. It is gated on a
 * human saying yes. `maintenance_approvals` had a reader and no writer until
 * this existed, so the only documented answer was an operator typing an INSERT
 * into psql.
 *
 * Since 2026-11-16 it is a row of Autonomy's "Waiting on you" (it waits on you,
 * so it sits with the rest of what does), in the same row anatomy: the steps
 * behind a disclosure, the column form inline, white focus. It used to be a
 * card of its own with "tier 2 · …" strings and violet focus.
 *
 * ── What it shows, and why all of it ─────────────────────────────────────────
 * Every step and whether it can be undone, on request. Consent to "consolidate
 * the lifecycle column" without seeing that a step repoints live readers, or
 * that one can never be undone, is not consent anybody could give. The
 * irreversible step is said on the row itself: the robot never runs it.
 *
 * ── Why it asks for columns ──────────────────────────────────────────────────
 * The planner emits abstract params on purpose and never a column name, so
 * somebody has to say which column is replaced by which. The answers go to the
 * server, which composes the per-step bindings, so the dashboard and an agent
 * posting raw bindings hit one authority.
 *
 * ── Nothing pending renders nothing ──────────────────────────────────────────
 * Most projects never see this row.
 */

import { useCallback, useEffect, useId, useState } from 'react'
import { KitButton, KitInput } from '@/components/inspector/kit'
import { RefusedLine } from '@/components/console/states'
import { Disclosure, Fact, Facts, Row, ROW_TEXT, ROW_TITLE } from '@/components/autonomy/rows'
import { ARCHITECTURE_ICON } from '@/components/autonomy/row-icons'

interface Rung {
  ordinal: number
  kind: string
  tier: number
  executable: boolean
  rollback: string | null
}

export interface Ladder {
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
  const raw = typeof h === 'string' ? h : h && typeof h === 'object' && typeof h.id === 'string' ? h.id : 'structural cause'
  return raw.replace(/[_-]+/g, ' ')
}

/** What a step's tier means for whoever approves it. */
const TIER_WORDS: Record<number, string> = {
  0: 'Reads only',
  1: 'Adds, removes nothing',
  2: 'Needs your approval',
  3: 'You run this one yourself',
}

const words = (kind: string) => kind.replace(/_/g, ' ')

/**
 * The pending ladder, if any. `null` is the normal answer: nothing waits. A
 * failed read is also null (it renders nothing) but is never recorded as an
 * answer that all is well.
 */
export function useMaintenanceLadder(projectId: string, refreshKey = 0) {
  const [ladder, setLadder] = useState<Ladder | null>(null)
  const [loaded, setLoaded] = useState(false)
  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}/maintenance`)
      const json = await res.json().catch(() => null)
      setLadder(res.ok && json?.pending ? (json.ladder as Ladder) : null)
    } catch {
      setLadder(null)
    } finally {
      setLoaded(true)
    }
  }, [projectId])
  useEffect(() => {
    void load()
  }, [load, refreshKey])
  return { ladder, loaded, reload: load }
}

export function MaintenanceLadderRow({
  projectId,
  ladder,
  reload,
  canDecide = true,
}: {
  projectId: string
  ladder: Ladder
  reload: () => Promise<void>
  /** Approving a migration takes an owner or admin (the route's floor). */
  canDecide?: boolean
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showSteps, setShowSteps] = useState(false)
  const [sourceColumn, setSourceColumn] = useState('')
  const [targetColumn, setTargetColumn] = useState('')
  const [targetType, setTargetType] = useState('text')
  const [allowedValues, setAllowedValues] = useState('')

  const approve = async () => {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/projects/${projectId}/maintenance`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          // The version as this row drew it. If the plan has moved since, the
          // server refuses rather than approving a ladder that no longer exists.
          planVersion: ladder.planVersion,
          answers: {
            sourceColumn: sourceColumn.trim(),
            targetColumn: targetColumn.trim(),
            targetType: targetType.trim() || 'text',
            transform: { kind: 'identity' },
            allowedValues: allowedValues
              .split(',')
              .map((v) => v.trim())
              .filter(Boolean),
          },
        }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(json?.error ?? 'Could not record the approval.')
        // A 409 means the world moved: re-read so the row stops offering a version nobody can approve.
        if (res.status === 409) await reload()
        return
      }
      await reload()
    } catch {
      setError('Could not reach the server.')
    } finally {
      setBusy(false)
    }
  }

  const withdraw = async () => {
    if (!ladder.approval) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/projects/${projectId}/maintenance?approvalId=${encodeURIComponent(ladder.approval.id)}`, { method: 'DELETE' })
      if (!res.ok) {
        const json = await res.json().catch(() => ({}))
        setError(json?.error ?? 'Could not withdraw the approval.')
        return
      }
      await reload()
    } catch {
      setError('Could not reach the server.')
    } finally {
      setBusy(false)
    }
  }

  const executable = ladder.validity === 'executable'
  const canApprove = executable && sourceColumn.trim() !== '' && targetColumn.trim() !== ''
  const approved = !!ladder.approval

  return (
    <Row
      lead="well"
      icon={ARCHITECTURE_ICON}
      id={`approval-${ladder.findingId}`}
      title={
        <p className={ROW_TITLE}>
          Migrate <code className="font-mono text-[12.5px] text-zinc-100">{ladder.table}</code> to fix a repeating {hypothesisLabel(ladder.diagnosis)}
        </p>
      }
      actions={
        canDecide && approved ? (
          <KitButton variant="secondary" onClick={() => void withdraw()} loading={busy}>
            Withdraw
          </KitButton>
        ) : undefined
      }
    >
      <p className={ROW_TEXT}>
        {approved
          ? `Approved by ${ladder.approval!.approvedBy}. The loop runs it on its next pass.`
          : 'Backenly prepared a migration for it. It runs only after you approve this exact version.'}
      </p>
      {ladder.humanOnly.length > 0 && (
        <p className={ROW_TEXT}>
          {ladder.humanOnly.map((h) => words(h.kind)).join(', ')} can never be undone, so Backenly never runs it. The migration stops before it.
        </p>
      )}
      <Facts>
        <Fact>
          {ladder.needsBinding.length} {ladder.needsBinding.length === 1 ? 'step' : 'steps'}
        </Fact>
        <Fact>Version {ladder.planVersion}</Fact>
      </Facts>
      <Disclosure open={showSteps} onToggle={() => setShowSteps((v) => !v)}>
        {showSteps ? 'Hide the steps' : 'Show the steps'}
      </Disclosure>
      {showSteps && (
        <ul className="mt-2.5 divide-y divide-white/[0.06] border-y border-white/[0.06]">
          {ladder.needsBinding.map((r) => (
            <li key={r.ordinal} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 py-[7px] text-[12.5px] leading-[18px]">
              <span className="text-zinc-200 first-letter:uppercase">{words(r.kind)}</span>
              <span className="flex flex-wrap gap-x-4 text-faint">
                <span>{TIER_WORDS[r.tier] ?? ''}</span>
                <span>
                  {r.rollback === 'none_required' ? 'Nothing to undo' : r.rollback ? `Undo: ${words(r.rollback)}` : 'No undo'}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}

      {!executable && (
        <p className="mt-2.5 text-[12.5px] leading-[18px] text-zinc-50">
          This version cannot be approved: {ladder.blockedReasons.join('; ')}
        </p>
      )}
      {!approved && ladder.staleApproval && (
        <p className="mt-2.5 text-[12.5px] leading-[18px] text-zinc-50">
          You approved version {ladder.staleApproval.planVersion}, but the plan was rebuilt as {ladder.planVersion}. The old approval does not carry over.
        </p>
      )}

      {!approved && executable && canDecide && (
        <div className="mt-3">
          <p className="text-[12.5px] leading-[18px] text-faint">Name the columns. Backenly does not guess which column replaces which.</p>
          <div className="mt-2.5 grid max-w-[640px] grid-cols-1 gap-2.5 sm:grid-cols-2">
            <Field label="Existing column" value={sourceColumn} onChange={setSourceColumn} placeholder="status" />
            <Field label="New column" value={targetColumn} onChange={setTargetColumn} placeholder="state" />
            <Field label="New column type" value={targetType} onChange={setTargetType} placeholder="text" />
            <Field label="Allowed values, comma separated" value={allowedValues} onChange={setAllowedValues} placeholder="active, expired" />
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
            <KitButton variant="primary" onClick={() => void approve()} loading={busy} disabled={!canApprove}>
              Approve this migration
            </KitButton>
            <span className="text-[12px] text-faint">Covers version {ladder.planVersion} only.</span>
          </div>
        </div>
      )}
      {!canDecide && <p className="mt-2.5 text-[12.5px] leading-[18px] text-faint">Only admins can approve. Ask an owner or admin.</p>}
      {error && <RefusedLine className="mt-2.5">{error}</RefusedLine>}
    </Row>
  )
}

function Field({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (v: string) => void; placeholder: string }) {
  const id = useId()
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-[12px] leading-[16px] text-faint">
        {label}
      </label>
      <KitInput id={id} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className="font-mono" />
    </div>
  )
}
