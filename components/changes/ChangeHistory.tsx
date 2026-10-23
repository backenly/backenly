'use client'

/**
 * Database → Changes: every governed change to production, one line each.
 *
 *   #184  Added column likes to posts        Applied · Verified        2h ago  ⋯
 *   #185  Changed orders: retyped total      Recovered automatically   1h ago  ⋯
 *         Production healthy · View details
 *
 * Most changes need nothing from anyone, so most rows are one line. A second
 * line appears only when there is something to know (it was recovered, it is
 * waiting for a decision) and it says it in a sentence. The way back is in the
 * row's ⋯ menu ("Restore previous state"); everything technical is behind View
 * details. A restore is itself recorded, so the state it replaced is protected,
 * but it is not a row of its own: it is how the change it restored ended.
 */

import { useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { AlertTriangle, Bot, Check, FileText, History, Redo2, RotateCcw, Sparkles, User } from 'lucide-react'
import { EmptyState, KitButton, KitConfirmDialog, KitNote, OverflowMenu, Skeleton, StatusDot } from '@/components/inspector/kit'
import { FOCUS_INSET } from '@/components/console/tokens'
import type { ChangeSummary } from '@/lib/changes/history'
import { ChangeDetails } from './ChangeDetails'
import { RestoreDialog } from './RestoreDialog'
import { ago, awaitsDecision, outcomeOf } from './present'

interface Page {
  changes: ChangeSummary[]
  windowDays: number
  nextBeforeSeq: number | null
  canManage?: boolean
}

function ActorIcon({ type }: { type: ChangeSummary['actor']['type'] }) {
  const Icon = type === 'agent' ? Bot : type === 'person' ? User : Sparkles
  return <Icon className="h-3.5 w-3.5 flex-shrink-0 text-zinc-600" strokeWidth={1.75} aria-hidden />
}

/** The second line, when there is something to know. */
function SecondLine({ c, onDetails, onDecide }: { c: ChangeSummary; onDetails: () => void; onDecide: (() => void) | null }) {
  const link = (label: string, onClick: () => void) => (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onClick() }}
      className={`rounded-[4px] text-zinc-400 underline decoration-white/15 underline-offset-2 hover:text-zinc-100 hover:decoration-white/50 ${FOCUS_INSET}`}
    >
      {label}
    </button>
  )
  switch (c.outcome.state) {
    case 'recovered':
      return <>Production healthy · {link('View details', onDetails)}</>
    case 'restored':
      return <>{c.outcome.by ? `By ${c.outcome.by.label}` : 'Restored'}{c.outcome.at ? ` · ${ago(c.outcome.at)}` : ''}</>
    case 'awaiting_approval':
    case 'needs_attention':
      return (
        <>
          <span className="[overflow-wrap:anywhere]">{c.outcome.note ?? 'A person needs to decide what happens to this change.'}</span>
          {onDecide && <> · {link('Review', onDecide)}</>}
        </>
      )
    case 'kept':
    case 'unverified':
      return c.outcome.note ? <span className="[overflow-wrap:anywhere]">{c.outcome.note}</span> : null
    default:
      return null
  }
}

export function ChangeHistory({ projectId }: { projectId: string }) {
  const search = useSearchParams()
  const [changes, setChanges] = useState<ChangeSummary[]>([])
  const [nextBefore, setNextBefore] = useState<number | null>(null)
  const [canManage, setCanManage] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [detailsFor, setDetailsFor] = useState<string | null>(search?.get('change') ?? null)
  const [restoreFor, setRestoreFor] = useState<ChangeSummary | null>(null)
  const [keepFor, setKeepFor] = useState<ChangeSummary | null>(null)
  const [keeping, setKeeping] = useState(false)
  const [keepError, setKeepError] = useState<string | null>(null)

  const fetchPage = useCallback(async (before?: number): Promise<Page> => {
    const res = await fetch(`/api/projects/${projectId}/changes?limit=30${before ? `&before=${before}` : ''}`, { credentials: 'include' })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(body.error || `Request failed with ${res.status}`)
    return body as Page
  }, [projectId])

  const apply = useCallback((page: Page) => {
    setChanges(page.changes ?? [])
    setNextBefore(page.nextBeforeSeq ?? null)
    setCanManage(!!page.canManage)
    setError(null)
  }, [])

  // First load. State is set only once the response is in.
  useEffect(() => {
    let cancelled = false
    fetchPage()
      .then((page) => { if (!cancelled) apply(page) })
      .catch((err) => {
        if (cancelled) return
        // Cleared, so a stale list cannot be read as the current history.
        setChanges([])
        setError(err?.message || 'Could not load the changes')
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [fetchPage, apply])

  /** Re-read the list after something changed it. */
  const reload = useCallback(async () => {
    try {
      apply(await fetchPage())
    } catch (err: any) {
      setError(err?.message || 'Could not load the changes')
    }
  }, [apply, fetchPage])

  const loadMore = async () => {
    if (!nextBefore || loadingMore) return
    setLoadingMore(true)
    try {
      const page = await fetchPage(nextBefore)
      setChanges((cur) => [...cur, ...(page.changes ?? [])])
      setNextBefore(page.nextBeforeSeq ?? null)
    } catch {
      /* the button stays, so it can be tried again */
    } finally {
      setLoadingMore(false)
    }
  }

  const keep = async () => {
    if (!keepFor) return
    setKeeping(true)
    setKeepError(null)
    try {
      const res = await fetch(`/api/projects/${projectId}/changes/${keepFor.id}/keep`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ seq: keepFor.seq }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok || !body.success) throw new Error(body.error || 'Could not keep this change.')
      setKeepFor(null)
      await reload()
    } catch (err: any) {
      setKeepError(err?.message || 'Could not keep this change.')
    } finally {
      setKeeping(false)
    }
  }

  const openChange = (id: string) => {
    const found = changes.find((c) => c.id === id)
    setRestoreFor(found ?? null)
    if (!found) setDetailsFor(id)
  }

  const menuFor = (c: ChangeSummary) => {
    const items: Array<{ label: string; icon?: typeof RotateCcw; onClick: () => void }> = []
    if (canManage && c.action) {
      items.push(
        c.action.kind === 'reapply'
          ? { label: 'Reapply this change', icon: Redo2, onClick: () => setRestoreFor(c) }
          : { label: 'Restore previous state', icon: RotateCcw, onClick: () => setRestoreFor(c) },
      )
    }
    if (canManage && awaitsDecision(c)) {
      items.push({ label: 'Keep as it is', icon: Check, onClick: () => { setKeepError(null); setKeepFor(c) } })
    }
    items.push({ label: 'View details', icon: FileText, onClick: () => setDetailsFor(c.id) })
    return items
  }

  return (
    // contain:inline-size keeps a long summary from widening the page on a phone.
    <div className="flex h-full min-h-0 w-full flex-col [contain:inline-size]">
      <div className="min-h-0 flex-1 overflow-auto">
        {error ? (
          <div className="p-4">
            <KitNote
              tone="danger"
              icon={AlertTriangle}
              actions={<KitButton size="sm" variant="ghost" onClick={() => { setLoading(true); void reload().finally(() => setLoading(false)) }}>Try again</KitButton>}
            >
              {error}
            </KitNote>
          </div>
        ) : loading ? (
          <div className="space-y-5 p-5" aria-hidden>
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} className="flex items-center gap-4">
                <Skeleton className="h-[12px] w-[34px]" />
                <Skeleton className="h-[12px] flex-1" />
                <Skeleton className="h-[12px] w-[120px]" />
              </div>
            ))}
          </div>
        ) : changes.length === 0 ? (
          <EmptyState
            icon={History}
            title="No changes yet"
            description="Every change to your production backend shows up here: from your coding agents, from Backenly, or from you. Each one is checked after it applies."
            className="h-full !py-10"
          />
        ) : (
          <ul className="divide-y divide-white/[0.05]">
            {changes.map((c) => {
              const s = outcomeOf(c)
              const decide = canManage && awaitsDecision(c) && c.action?.available ? () => setRestoreFor(c) : null
              const second = <SecondLine c={c} onDetails={() => setDetailsFor(c.id)} onDecide={decide} />
              const hasSecond = !['healthy', 'in_progress', 'failed'].includes(c.outcome.state) &&
                !((c.outcome.state === 'kept' || c.outcome.state === 'unverified') && !c.outcome.note)
              return (
                <li key={c.id} className="group relative">
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => setDetailsFor(c.id)}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setDetailsFor(c.id) } }}
                    aria-label={`Change #${c.seq}: ${c.summary}. ${s.label}`}
                    className={`grid cursor-pointer grid-cols-[2.75rem_minmax(0,1fr)_auto] items-start gap-x-2 px-4 py-3 pr-12 transition-colors hover:bg-white/[0.025] sm:px-5 sm:pr-14 ${FOCUS_INSET}`}
                  >
                    <span className="pt-px font-mono text-[12.5px] tabular-nums text-faint">#{c.seq}</span>
                    <span className="min-w-0">
                      <span className="block truncate text-[13px] text-zinc-100" title={c.summary}>{c.summary}</span>
                      <span className="mt-1 flex min-w-0 items-center gap-1.5 text-[12px] text-faint">
                        <ActorIcon type={c.actor.type} />
                        <span className="truncate">{c.actor.label}</span>
                        {/* On a phone the status goes under the summary. */}
                        <span className="text-zinc-700 sm:hidden">·</span>
                        <StatusDot tone={s.tone} label={s.label} className="flex-shrink-0 sm:hidden" />
                      </span>
                      {hasSecond && <span className="mt-1 block text-[12px] leading-[18px] text-faint">{second}</span>}
                    </span>
                    <span className="flex items-center gap-4 pt-px">
                      <StatusDot tone={s.tone} label={s.label} className="hidden sm:inline-flex" />
                      <span className="w-[56px] text-right text-[12px] tabular-nums text-faint" title={new Date(c.createdAt).toLocaleString()}>
                        {ago(c.createdAt)}
                      </span>
                    </span>
                  </div>
                  <div className="absolute right-2 top-2.5 sm:right-3">
                    <OverflowMenu label={`Actions for change #${c.seq}`} items={menuFor(c)} width="w-[220px]" />
                  </div>
                </li>
              )
            })}
            {nextBefore && (
              <li className="px-4 py-3 sm:px-5">
                <KitButton size="sm" variant="ghost" onClick={() => void loadMore()} loading={loadingMore}>
                  Load older changes
                </KitButton>
              </li>
            )}
          </ul>
        )}
      </div>

      {detailsFor && (
        <ChangeDetails
          projectId={projectId}
          changeId={detailsFor}
          canManage={canManage}
          onClose={() => setDetailsFor(null)}
          onRestore={(summary) => {
            setDetailsFor(null)
            setRestoreFor(summary)
          }}
        />
      )}

      {restoreFor && (
        <RestoreDialog
          key={restoreFor.id}
          projectId={projectId}
          change={restoreFor}
          onClose={() => setRestoreFor(null)}
          onDone={() => void reload()}
          onOpenChange={openChange}
        />
      )}

      <KitConfirmDialog
        open={!!keepFor}
        onCancel={() => setKeepFor(null)}
        onConfirm={() => void keep()}
        busy={keeping}
        title="Keep this change as it is?"
        description={keepFor ? `#${keepFor.seq} · ${keepFor.summary}` : undefined}
        confirmLabel="Keep as it is"
      >
        <p className="text-[13px] leading-[20px] text-zinc-400">
          It stays in effect and its failed checks stay on record. You can still restore the previous state later.
        </p>
        {keepError && <p className="mt-2 text-[12.5px] text-rose-300">{keepError}</p>}
      </KitConfirmDialog>
    </div>
  )
}
