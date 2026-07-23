'use client'

/**
 * VERSION HISTORY — restore points
 * ================================
 * The rollback surface. Lives inside a KitCard on the Memory page, so it
 * speaks the inspector kit language: hairlines, mono numerals, dot badges,
 * violet reserved for the active version and the restore action.
 *
 * The restore flow is deliberately a *moment*, not a silent refresh:
 *   1. Two-step inline confirm — "Restore" arms the row, a second click runs
 *      it. The current version is snapshotted first, so this is always safe.
 *   2. On success the API's reconcile result (what actually came back —
 *      tables, columns, APIs, buckets, auth — and what deliberately did NOT)
 *      renders as a restore receipt pinned above the list. Honest by
 *      construction: failures show rose, skipped OAuth/functions show why.
 *
 * No window.reload, no alert() — the receipt IS the confirmation.
 */

import { motion, AnimatePresence } from 'framer-motion'
import { useState, useEffect, useCallback } from 'react'
import {
  RotateCcw, Check, ChevronDown, ChevronUp, X,
  Database, Columns, Cable, HardDrive, Shield, AlertTriangle,
} from 'lucide-react'

interface Version {
  id: string
  sequenceNumber: number
  message: string
  details: string[]
  createdAt: string
  canRestore: boolean
  isActive: boolean
  changeCount: number
}

// Mirrors lib/orchestration/graph-reconciler.ts ReconcileResult
interface ReconcileItem {
  kind: 'table' | 'column' | 'api' | 'bucket' | 'auth'
  target: string
  outcome: 'created' | 'failed' | 'skipped'
  message?: string
}
interface ReconcileResult {
  restored: ReconcileItem[]
  notRestored: Array<{ kind: 'oauth_provider' | 'function'; target: string; reason: string }>
}

interface RestoreReceipt {
  version: number
  reconcile: ReconcileResult
  at: string
}

interface VersionHistoryProps {
  projectId: string
  onRollback?: (version: Version) => void
}

const KIND_META: Record<ReconcileItem['kind'], { icon: typeof Database; label: string; plural: string }> = {
  table:  { icon: Database,  label: 'table',  plural: 'tables'  },
  column: { icon: Columns,   label: 'column', plural: 'columns' },
  api:    { icon: Cable,     label: 'API',    plural: 'APIs'    },
  bucket: { icon: HardDrive, label: 'bucket', plural: 'buckets' },
  auth:   { icon: Shield,    label: 'auth',   plural: 'auth'    },
}

const HAIRLINE = 'border-white/[0.06]'

function formatWhen(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

// ── Restore receipt ──────────────────────────────────────────────────────────
// Pinned above the list after a successful restore. Groups the reconcile
// result by kind and outcome so the user sees exactly what came back.

function ReceiptCard({ receipt, onDismiss }: { receipt: RestoreReceipt; onDismiss: () => void }) {
  const created = receipt.reconcile.restored.filter(r => r.outcome === 'created')
  const failed = receipt.reconcile.restored.filter(r => r.outcome === 'failed')
  const skipped = receipt.reconcile.notRestored

  // "2 tables · 5 APIs · auth" summary from the created items
  const counts = new Map<ReconcileItem['kind'], number>()
  for (const item of created) counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1)
  const summaryParts = Array.from(counts.entries()).map(([kind, n]) => {
    const meta = KIND_META[kind]
    if (kind === 'auth') return meta.label
    return `${n} ${n === 1 ? meta.label : meta.plural}`
  })

  return (
    <motion.div
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -6 }}
      transition={{ duration: 0.25, ease: 'easeOut' }}
      className={`relative overflow-hidden rounded-lg border border-white/[0.12] bg-white/[0.04]`}
    >
      <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-violet-300/50 to-transparent" />

      <div className="flex items-start gap-2.5 px-3.5 py-3">
        <span className="mt-0.5 flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-violet-500/15">
          <Check className="h-3 w-3 text-violet-300" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[12.5px] font-semibold text-zinc-100">
            Backend restored to version {receipt.version}
          </p>
          <p className="mt-0.5 text-[11.5px] leading-5 text-zinc-400">
            {created.length > 0
              ? <>Re-created {summaryParts.join(' · ')}. Nothing added since was deleted.</>
              : <>Everything from version {receipt.version} was already live — the version pointer moved, nothing needed re-creating.</>}
          </p>

          {created.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {created.map(item => {
                const Icon = KIND_META[item.kind].icon
                return (
                  <span
                    key={`${item.kind}:${item.target}`}
                    className="inline-flex items-center gap-1 rounded-md border border-white/[0.07] bg-white/[0.03] px-1.5 py-0.5 font-mono text-[10.5px] text-zinc-300"
                  >
                    <Icon className="h-2.5 w-2.5 text-zinc-500" />
                    {item.target}
                  </span>
                )
              })}
            </div>
          )}

          {failed.length > 0 && (
            <div className="mt-2 space-y-1">
              {failed.map(item => (
                <p key={`${item.kind}:${item.target}`} className="flex items-start gap-1.5 text-[11px] leading-4 text-rose-300/90">
                  <AlertTriangle className="mt-px h-3 w-3 flex-shrink-0" />
                  <span>
                    <span className="font-mono">{item.target}</span> could not be re-created
                    {item.message ? ` — ${item.message}` : ''}
                  </span>
                </p>
              ))}
            </div>
          )}

          {skipped.length > 0 && (
            <p className="mt-2 text-[11px] leading-4 text-zinc-500">
              Not restored automatically:{' '}
              {skipped.map(s => `${s.target} (${s.kind === 'oauth_provider' ? 'reconnect in Auth' : 'regenerate in Functions'})`).join(', ')}.
            </p>
          )}
        </div>
        <button
          onClick={onDismiss}
          aria-label="Dismiss restore receipt"
          className="flex-shrink-0 rounded-md p-1 text-zinc-600 transition-colors hover:bg-white/[0.05] hover:text-zinc-300"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </motion.div>
  )
}

// ── Main component ───────────────────────────────────────────────────────────

export function VersionHistory({ projectId, onRollback }: VersionHistoryProps) {
  const [versions, setVersions] = useState<Version[]>([])
  const [loading, setLoading] = useState(true)
  const [expandedVersion, setExpandedVersion] = useState<string | null>(null)
  const [armedVersion, setArmedVersion] = useState<string | null>(null)
  const [restoring, setRestoring] = useState<string | null>(null)
  const [receipt, setReceipt] = useState<RestoreReceipt | null>(null)
  const [error, setError] = useState<string | null>(null)

  const fetchVersions = useCallback(async () => {
    try {
      const response = await fetch(`/api/projects/${projectId}/timeline`, { credentials: 'include' })
      const data = await response.json()
      if (data.success) setVersions(data.timeline)
    } catch (err) {
      console.error('Failed to fetch versions:', err)
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => { fetchVersions() }, [fetchVersions])

  const handleRestore = async (version: Version) => {
    if (!version.canRestore || version.isActive) return

    setRestoring(version.id)
    setError(null)

    try {
      const response = await fetch(`/api/projects/${projectId}/restore`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ graphId: version.id }),
      })
      const data = await response.json()

      if (data.success) {
        setReceipt({
          version: version.sequenceNumber,
          reconcile: data.reconcile ?? { restored: [], notRestored: [] },
          at: new Date().toISOString(),
        })
        await fetchVersions()
        onRollback?.(version)
      } else {
        setError(data.error || 'Restore failed — nothing was changed. Try again.')
      }
    } catch {
      setError('Restore failed — nothing was changed. Check your connection and try again.')
    } finally {
      setRestoring(null)
      setArmedVersion(null)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <div className="h-4 w-4 animate-spin rounded-full border-2 border-white/10 border-t-violet-400" />
      </div>
    )
  }

  if (versions.length === 0) {
    return (
      <div className="px-4 py-8 text-center">
        <p className="text-[12px] text-zinc-600">
          No restore points yet — the first backend change creates one.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-3 p-4">
      <AnimatePresence>
        {receipt && <ReceiptCard receipt={receipt} onDismiss={() => setReceipt(null)} />}
      </AnimatePresence>

      {error && (
        <p className="flex items-start gap-1.5 text-[11.5px] leading-4 text-rose-300/90">
          <AlertTriangle className="mt-px h-3 w-3 flex-shrink-0" />
          {error}
        </p>
      )}

      <div className={`overflow-hidden rounded-lg border ${HAIRLINE}`}>
        {versions.map((version, idx) => {
          const isArmed = armedVersion === version.id
          const isRestoring = restoring === version.id
          const isExpanded = expandedVersion === version.id

          return (
            <div
              key={version.id}
              className={`${idx > 0 ? `border-t ${HAIRLINE}` : ''} ${
                version.isActive ? 'bg-white/[0.04]' : 'bg-transparent'
              }`}
            >
              <div className="flex items-center gap-2.5 px-3 py-2.5">
                {/* Sequence marker — mono numeral, violet check when active */}
                <span
                  className={`flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full font-mono text-[10.5px] font-medium tabular-nums ${
                    version.isActive
                      ? 'bg-violet-500/15 text-violet-300'
                      : 'border border-white/[0.07] text-zinc-500'
                  }`}
                >
                  {version.isActive ? <Check className="h-3 w-3" /> : version.sequenceNumber}
                </span>

                <button
                  type="button"
                  onClick={() => setExpandedVersion(isExpanded ? null : version.id)}
                  className="min-w-0 flex-1 text-left focus:outline-none"
                >
                  <p className={`truncate text-[12.5px] ${version.isActive ? 'text-zinc-100' : 'text-zinc-300'}`}>
                    {version.message}
                  </p>
                  <p className="mt-0.5 font-mono text-[10.5px] tabular-nums text-zinc-600">
                    v{version.sequenceNumber} · {formatWhen(version.createdAt)} · {version.changeCount} change{version.changeCount === 1 ? '' : 's'}
                  </p>
                </button>

                {version.isActive && (
                  <span className="inline-flex items-center gap-1.5 font-mono text-[10.5px] font-medium text-violet-300">
                    <span className="h-[5px] w-[5px] rounded-full bg-violet-300" />
                    current
                  </span>
                )}

                {/* Restore — two-step inline confirm */}
                {version.canRestore && !version.isActive && (
                  isArmed ? (
                    <div className="flex flex-shrink-0 items-center gap-1.5">
                      <button
                        onClick={() => handleRestore(version)}
                        disabled={isRestoring}
                        className="inline-flex h-7 items-center gap-1.5 rounded-lg bg-white px-2.5 text-[11.5px] font-semibold text-black transition-colors hover:bg-zinc-200 focus:outline-none focus:ring-2 focus:ring-violet-400/40 disabled:opacity-50"
                      >
                        {isRestoring ? (
                          <>
                            <span className="h-3 w-3 animate-spin rounded-full border border-white/40 border-t-white" />
                            Restoring…
                          </>
                        ) : (
                          <>
                            <RotateCcw className="h-3 w-3" />
                            Confirm restore
                          </>
                        )}
                      </button>
                      {!isRestoring && (
                        <button
                          onClick={() => setArmedVersion(null)}
                          className="inline-flex h-7 items-center rounded-lg px-2 text-[11.5px] text-zinc-500 transition-colors hover:bg-white/[0.04] hover:text-zinc-200 focus:outline-none"
                        >
                          Cancel
                        </button>
                      )}
                    </div>
                  ) : (
                    <button
                      onClick={() => setArmedVersion(version.id)}
                      className="inline-flex h-7 flex-shrink-0 items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.03] px-2.5 text-[11.5px] font-medium text-zinc-300 opacity-90 transition-colors hover:border-white/20 hover:bg-white/[0.07] hover:text-white focus:outline-none focus:ring-2 focus:ring-violet-400/35"
                    >
                      <RotateCcw className="h-3 w-3" />
                      Restore
                    </button>
                  )
                )}

                {version.details.length > 0 && (
                  <button
                    onClick={() => setExpandedVersion(isExpanded ? null : version.id)}
                    aria-label={isExpanded ? 'Collapse version details' : 'Expand version details'}
                    className="flex-shrink-0 rounded-md p-1 text-zinc-600 transition-colors hover:bg-white/[0.05] hover:text-zinc-300"
                  >
                    {isExpanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                  </button>
                )}
              </div>

              {/* Armed hint — one honest line about what restore does */}
              <AnimatePresence>
                {isArmed && !isRestoring && (
                  <motion.p
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    className="overflow-hidden px-3 pb-2 pl-[46px] text-[11px] leading-4 text-zinc-500"
                  >
                    Rebuilds anything from v{version.sequenceNumber} that&apos;s missing now. Additive only — nothing added since gets deleted, and the current state is saved as its own restore point first.
                  </motion.p>
                )}
              </AnimatePresence>

              {/* Expanded details */}
              <AnimatePresence>
                {isExpanded && version.details.length > 0 && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    className={`overflow-hidden border-t ${HAIRLINE} bg-black/[0.15]`}
                  >
                    <div className="space-y-1 px-3 py-2 pl-[46px]">
                      {version.details.map((detail, dIdx) => (
                        <div key={dIdx} className="flex items-center gap-2 text-[11px] text-zinc-500">
                          <span className="h-1 w-1 flex-shrink-0 rounded-full bg-zinc-700" />
                          <span>{detail}</span>
                        </div>
                      ))}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          )
        })}
      </div>

      <p className="font-mono text-[10px] text-zinc-700">
        version control for your backend — every change is a restore point
      </p>
    </div>
  )
}
