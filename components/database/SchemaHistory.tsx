'use client'

/**
 * Schema history — the migration ledger, which was already being written.
 *
 * Every governed DDL action snapshots the schema into `SchemaVersion`, and the
 * list/get/rollback route has existed for as long as the ledger has. Nothing in
 * the dashboard read it, so an operator could see the current shape of their
 * database and no part of how it got there.
 *
 * ── Rollback is destructive and is presented as such ────────────────────────
 *
 * `rollbackToVersion` computes a diff against the live schema and executes DDL
 * to reach the target. Reaching an older shape means DROPPING what came after
 * it, and dropping a column drops its data. There is no undo for that beyond
 * the pre-rollback snapshot the server takes automatically.
 *
 * So the confirmation asks for the version number to be typed rather than
 * offering a button. A modal with a single "Confirm" is dismissed by reflex; a
 * field that has to be filled in cannot be.
 */

import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, CheckCircle2, History, RotateCcw } from 'lucide-react'
import { EmptyState, KIT, KitButton, KitField, KitInput, KitModal, KitNote, Skeleton } from '@/components/inspector/kit'
import { EDGE, FOCUS_INSET, RULE, R_PANEL } from '@/components/console/tokens'

interface VersionRow {
  id: string
  versionNum: number
  description: string
  triggeredBy: string
  createdAt: string
}

interface TableSnapshot {
  name: string
  columns?: Array<{ name: string; type: string }>
}

function when(iso: string): string {
  return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

export function SchemaHistory({ projectId }: { projectId: string }) {
  const [versions, setVersions] = useState<VersionRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [selected, setSelected] = useState<VersionRow | null>(null)
  const [snapshot, setSnapshot] = useState<TableSnapshot[] | null>(null)
  const [snapshotLoading, setSnapshotLoading] = useState(false)

  const [confirmFor, setConfirmFor] = useState<VersionRow | null>(null)
  const [typed, setTyped] = useState('')
  const [rollingBack, setRollingBack] = useState(false)
  const [outcome, setOutcome] = useState<{ ok: boolean; text: string } | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/projects/${projectId}/schema-versions`, { credentials: 'include' })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error || `Request failed with ${res.status}`)
      setVersions(body.versions ?? [])
    } catch (err: any) {
      // Cleared, so a stale list cannot be read as the current history.
      setVersions([])
      setError(err?.message || 'Could not load schema history')
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => {
    void load()
  }, [load])

  const openSnapshot = async (v: VersionRow) => {
    setSelected(v)
    setSnapshot(null)
    setSnapshotLoading(true)
    try {
      const res = await fetch(`/api/projects/${projectId}/schema-versions?versionId=${encodeURIComponent(v.id)}`, {
        credentials: 'include',
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error || 'Could not load that version')
      setSnapshot(body.version?.snapshot?.tables ?? [])
    } catch (err: any) {
      setSnapshot(null)
      setError(err?.message || 'Could not load that version')
    } finally {
      setSnapshotLoading(false)
    }
  }

  const rollback = async () => {
    if (!confirmFor || rollingBack) return
    setRollingBack(true)
    setOutcome(null)
    try {
      const res = await fetch(`/api/projects/${projectId}/schema-versions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ versionId: confirmFor.id }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok || body.success === false) {
        throw new Error(body.error || body.message || 'Rollback failed')
      }
      // The count is reported because "rolled back" with zero statements means
      // the schema already matched, which is a different outcome worth knowing.
      const n = Array.isArray(body.statementsExecuted) ? body.statementsExecuted.length : 0
      setOutcome({
        ok: true,
        text:
          n === 0
            ? `Schema already matched v${confirmFor.versionNum}. Nothing was changed.`
            : `Rolled back to v${confirmFor.versionNum}. ${n} ${n === 1 ? 'statement' : 'statements'} executed.`,
      })
      setConfirmFor(null)
      setTyped('')
      await load()
    } catch (err: any) {
      setOutcome({ ok: false, text: err?.message || 'Rollback failed' })
    } finally {
      setRollingBack(false)
    }
  }

  const closeConfirm = () => {
    if (rollingBack) return
    setConfirmFor(null)
    setTyped('')
  }

  return (
    <div className="flex h-full min-h-0 w-full flex-col md:flex-row">
      {/* Ledger */}
      <div className={`flex max-h-[45%] w-full flex-shrink-0 flex-col border-b ${RULE} md:max-h-none md:w-[300px] md:border-b-0 md:border-r ${KIT.rail}`}>
        <div className={`flex h-[44px] flex-shrink-0 items-center justify-between border-b ${RULE} pl-4 pr-3`}>
          <span className="text-[13px] font-medium text-zinc-200">Schema history</span>
          <span className="text-[12px] tabular-nums text-zinc-500">{versions.length}</span>
        </div>

        <div className="min-h-0 flex-1 overflow-auto">
          {error ? (
            <div className="p-2">
              <KitNote
                tone="danger"
                icon={AlertTriangle}
                actions={
                  <KitButton size="sm" variant="ghost" onClick={() => void load()}>
                    Try again
                  </KitButton>
                }
              >
                {error}
              </KitNote>
            </div>
          ) : loading ? (
            <div className="space-y-3 p-4" aria-hidden>
              {[0, 1, 2].map((i) => (
                <div key={i} className="space-y-1.5">
                  <Skeleton className="h-[12px] w-12" />
                  <Skeleton className="h-[11px] w-3/4" />
                </div>
              ))}
            </div>
          ) : versions.length === 0 ? (
            <EmptyState
              icon={History}
              title="No schema versions yet"
              description="A version is recorded every time the schema changes, so this fills in as you build."
              className="h-full !py-10"
            />
          ) : (
            <ul className="py-1.5">
              {versions.map((v) => {
                const active = selected?.id === v.id
                return (
                  <li key={v.id} className="px-2">
                    <button
                      type="button"
                      onClick={() => void openSnapshot(v)}
                      aria-current={active ? 'true' : undefined}
                      className={`block w-full rounded-[7px] px-2.5 py-2 text-left transition-colors ${FOCUS_INSET} ${
                        active ? 'bg-white/[0.07]' : 'hover:bg-white/[0.04]'
                      }`}
                    >
                      <span className="flex items-baseline justify-between gap-2">
                        <span className="font-mono text-[12.5px] font-medium text-zinc-100">v{v.versionNum}</span>
                        <span className="text-[12px] tabular-nums text-zinc-500">{when(v.createdAt)}</span>
                      </span>
                      <span className="mt-0.5 block truncate text-[12.5px] text-zinc-400">{v.description}</span>
                      <span className="mt-0.5 block truncate font-mono text-[11.5px] text-zinc-600">{v.triggeredBy}</span>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </div>

      {/* Snapshot */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {outcome && (
          <div className={`flex-shrink-0 border-b ${RULE} px-4 py-2.5 sm:px-5`}>
            <KitNote tone={outcome.ok ? 'success' : 'danger'} icon={outcome.ok ? CheckCircle2 : AlertTriangle}>
              {outcome.text}
            </KitNote>
          </div>
        )}

        {!selected ? (
          <div className="flex h-full items-center justify-center px-8 text-center">
            <p className="text-[13px] text-zinc-500">Select a version to see the schema it captured.</p>
          </div>
        ) : (
          <>
            <div className={`flex h-[44px] flex-shrink-0 items-center justify-between gap-3 border-b ${RULE} pl-4 pr-2 sm:pl-5`}>
              <div className="flex min-w-0 items-baseline gap-2.5">
                <h2 className="font-mono text-[13px] font-medium text-zinc-100">v{selected.versionNum}</h2>
                <span className="truncate text-[12.5px] text-zinc-500">{selected.description}</span>
              </div>
              <KitButton
                size="sm"
                icon={RotateCcw}
                onClick={() => {
                  setConfirmFor(selected)
                  setTyped('')
                  setOutcome(null)
                }}
              >
                Roll back to this
              </KitButton>
            </div>

            <div className="min-h-0 flex-1 overflow-auto px-4 py-5 sm:px-5">
              {snapshotLoading ? (
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" aria-hidden>
                  {[0, 1, 2].map((i) => (
                    <Skeleton key={i} className="h-[120px] w-full" />
                  ))}
                </div>
              ) : !snapshot || snapshot.length === 0 ? (
                <p className="text-[13px] text-zinc-500">This version captured no tables.</p>
              ) : (
                <div className="grid items-start gap-3 sm:grid-cols-2 xl:grid-cols-3">
                  {snapshot.map((t) => (
                    <div key={t.name} className={`overflow-hidden border ${EDGE} ${R_PANEL}`}>
                      <div className={`flex items-baseline justify-between gap-2 border-b ${RULE} ${KIT.gridHead} px-3.5 py-2`}>
                        <span className="truncate font-mono text-[12.5px] font-medium text-zinc-100">{t.name}</span>
                        <span className="text-[11.5px] tabular-nums text-zinc-500">
                          {(t.columns ?? []).length} {(t.columns ?? []).length === 1 ? 'column' : 'columns'}
                        </span>
                      </div>
                      <table className="w-full">
                        <tbody>
                          {(t.columns ?? []).map((c) => (
                            <tr key={c.name}>
                              <td className="border-b border-white/[0.04] px-3.5 py-1.5 font-mono text-[12px] text-zinc-300">
                                {c.name}
                              </td>
                              <td className="border-b border-white/[0.04] px-3.5 py-1.5 text-right font-mono text-[11.5px] text-zinc-500">
                                {c.type}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {/* Typed confirmation, not a button. Reaching an older shape means
          dropping what came after it, and dropping a column drops its data. */}
      <KitModal
        open={!!confirmFor}
        onClose={closeConfirm}
        title={confirmFor ? `Roll back to v${confirmFor.versionNum}?` : 'Roll back'}
        description="Tables and columns added after this version will be dropped, and dropping a column drops its data. A snapshot of the current schema is taken first."
        footer={
          <>
            <KitButton variant="ghost" onClick={closeConfirm} disabled={rollingBack}>
              Cancel
            </KitButton>
            <KitButton
              variant="danger"
              icon={RotateCcw}
              onClick={() => void rollback()}
              loading={rollingBack}
              disabled={!confirmFor || typed.trim() !== String(confirmFor.versionNum)}
            >
              Roll back
            </KitButton>
          </>
        }
      >
        {confirmFor && (
          <KitField
            label={
              <>
                Type <span className="font-mono text-zinc-100">{confirmFor.versionNum}</span> to confirm
              </>
            }
          >
            <KitInput
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && typed.trim() === String(confirmFor.versionNum)) void rollback()
              }}
              aria-label="Type the version number to confirm"
              className="font-mono"
              inputMode="numeric"
            />
          </KitField>
        )}
      </KitModal>
    </div>
  )
}
