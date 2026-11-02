'use client'

/**
 * History: every change to the backend, newest first, under the day it was made.
 *
 *   Today
 *   (D)  Added column likes to posts                          ✓ Verified   2h ago  ⋯
 *        demo@example.com, approving Claude Code's request  [Database]  #184
 *   (✦)  Created bucket avatars                   ● Recovered automatically  1h ago  ⋯
 *        Backenly  [Storage]  #185
 *        Production healthy · View details
 *   ── Published v3 · Added billing                                       2d ago  ⋯
 *
 * Who made a change is the row's mark: a person's initial, the agent, or
 * Backenly. A change that applied and verified, which is most of them, says so
 * quietly; only a state that asks for a look (restored, recovered, waiting,
 * failed) is set as a status.
 *
 * One history for the schema and the rest of the backend: buckets, functions,
 * webhooks, environment, keys, auth and integrations are rows here like a
 * table is (lib/changes/resources). Most changes need nothing from anyone, so
 * most rows are two short lines. A third appears only when there is something
 * to know (it was recovered, it is waiting for a decision) and it says it in a
 * sentence. The ways back are in the row's ⋯ menu: "Restore previous state"
 * undoes that change, "Restore to this point" undoes everything after it; a
 * published version's marker offers the same for that version. Everything
 * technical is behind View details. A restore is itself recorded, so the state
 * it replaced is protected, but it is not a row of its own: it is how the
 * change it restored ended.
 */

import { Fragment, useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { AlertTriangle, Bot, Check, FileText, History, Redo2, Rocket, RotateCcw, Undo2 } from 'lucide-react'
import { EmptyState, KitButton, KitConfirmDialog, KitNote, OverflowMenu, Skeleton, StatusDot, Tag } from '@/components/inspector/kit'
import { BrandMark } from '@/components/site/BrandMark'
import { FOCUS_INSET } from '@/components/console/tokens'
import type { ChangeSummary } from '@/lib/changes/history'
import type { PublishedVersion } from '@/lib/deployment/published-versions'
import { ChangeDetails } from './ChangeDetails'
import { RestoreDialog } from './RestoreDialog'
import { RestoreToDialog, type RestorePoint } from './RestoreToDialog'
import { RESOURCES, ago, awaitsDecision, outcomeOf, resourceLabels } from './present'

interface Page {
  changes: ChangeSummary[]
  windowDays: number
  nextBeforeSeq: number | null
  canManage?: boolean
}

/** Who made the change, as the row's mark: a person's initial, the agent, or Backenly. */
function ActorMark({ actor }: { actor: ChangeSummary['actor'] }) {
  const base = 'flex h-[30px] w-[30px] flex-shrink-0 items-center justify-center'
  if (actor.type === 'person') {
    return (
      <span aria-hidden className={`${base} rounded-full border border-white/[0.10] bg-zinc-800 text-[12.5px] font-medium uppercase text-zinc-200`}>
        {(actor.label.trim()[0] ?? '?').toUpperCase()}
      </span>
    )
  }
  if (actor.type === 'agent') {
    return (
      <span aria-hidden className={`${base} rounded-[8px] border border-white/[0.08] bg-white/[0.035]`}>
        <Bot className="h-[15px] w-[15px] text-zinc-300" strokeWidth={1.75} />
      </span>
    )
  }
  return (
    <span aria-hidden className={base}>
      <BrandMark size={30} />
    </span>
  )
}

/** "demo@example.com, approving Claude Code's request": the who, then the rest. */
function ActorWords({ label }: { label: string }) {
  const at = label.indexOf(', ')
  if (at === -1) return <span className="text-zinc-300">{label}</span>
  return (
    <>
      <span className="text-zinc-300">{label.slice(0, at)}</span>
      {label.slice(at)}
    </>
  )
}

/** A change that applied and verified says so quietly; anything else is a status. */
function Outcome({ c, className = '' }: { c: ChangeSummary; className?: string }) {
  const s = outcomeOf(c)
  if (c.outcome.state === 'healthy') {
    return (
      <span className={`inline-flex items-center gap-1.5 text-[12.5px] leading-[16px] text-faint ${className}`}>
        <Check className="h-3.5 w-3.5 text-zinc-500" strokeWidth={2} aria-hidden />
        Verified
      </span>
    )
  }
  if (c.outcome.state === 'restored') {
    return (
      <span className={`inline-flex items-center gap-1.5 text-[12.5px] leading-[16px] text-zinc-200 ${className}`}>
        <RotateCcw className="h-3.5 w-3.5 text-zinc-400" strokeWidth={1.75} aria-hidden />
        {s.label}
      </span>
    )
  }
  return <StatusDot tone={s.tone} label={s.label} className={`!text-[12.5px] ${className}`} />
}

/** The day a change belongs under: Today, Yesterday, or "Sun 2 Nov". */
function dayOf(iso: string): string {
  const d = new Date(iso)
  const today = new Date()
  const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const days = Math.round((start(today) - start(d)) / 86_400_000)
  if (days === 0) return 'Today'
  if (days === 1) return 'Yesterday'
  return d.toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    ...(d.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}),
  })
}

/** The line under the meta, when there is something to know. */
function SecondLine({ c, onDetails, onDecide }: { c: ChangeSummary; onDetails: () => void; onDecide: (() => void) | null }) {
  const link = (label: string, onClick: () => void) => (
    // Above the row's own button (relative z-[1]), and 24px tall for a finger.
    <button
      type="button"
      onClick={onClick}
      className={`relative z-[1] inline-flex min-h-[24px] items-center rounded-[4px] text-zinc-400 underline decoration-white/15 underline-offset-2 hover:text-zinc-100 hover:decoration-white/50 ${FOCUS_INSET}`}
    >
      {label}
    </button>
  )
  switch (c.outcome.state) {
    case 'recovered':
      return <>Production healthy. {link('View details', onDetails)}</>
    case 'restored':
      return <>{c.outcome.by ? `Restored by ${c.outcome.by.label}` : 'Restored'}{c.outcome.at ? `, ${ago(c.outcome.at)}` : ''}</>
    case 'awaiting_approval':
    case 'needs_attention':
      return (
        <>
          <span className="[overflow-wrap:anywhere]">{c.outcome.note ?? 'A person needs to decide what happens to this change.'}</span>
          {onDecide && <>{' '}{link('Review', onDecide)}</>}
        </>
      )
    case 'kept':
    case 'unverified':
      return c.outcome.note ? <span className="[overflow-wrap:anywhere]">{c.outcome.note}</span> : null
    default:
      return null
  }
}

/** Where a published version sits in a newest-first list: above the first change made before it. */
function markersAt(changes: ChangeSummary[], versions: PublishedVersion[], complete: boolean): Map<number, PublishedVersion[]> {
  const at = new Map<number, PublishedVersion[]>()
  for (const v of versions) {
    if (v.version === null) continue
    const t = new Date(v.publishedAt).getTime()
    let i = changes.findIndex((c) => new Date(c.createdAt).getTime() <= t)
    // Older than every change loaded: it belongs further down, unless there is nothing further.
    if (i === -1) {
      if (!complete) continue
      i = changes.length
    }
    at.set(i, [...(at.get(i) ?? []), v])
  }
  return at
}

export function ChangeHistory({ projectId, resource = null }: { projectId: string; resource?: string | null }) {
  const search = useSearchParams()
  const [changes, setChanges] = useState<ChangeSummary[]>([])
  const [versions, setVersions] = useState<PublishedVersion[]>([])
  const [nextBefore, setNextBefore] = useState<number | null>(null)
  const [canManage, setCanManage] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [detailsFor, setDetailsFor] = useState<string | null>(search?.get('change') ?? null)
  const [restoreFor, setRestoreFor] = useState<ChangeSummary | null>(null)
  const [restoreTo, setRestoreTo] = useState<RestorePoint | null>(null)
  const [keepFor, setKeepFor] = useState<ChangeSummary | null>(null)
  const [keeping, setKeeping] = useState(false)
  const [keepError, setKeepError] = useState<string | null>(null)

  const fetchPage = useCallback(async (before?: number): Promise<Page> => {
    const q = new URLSearchParams({ limit: '30' })
    if (before) q.set('before', String(before))
    if (resource) q.set('resource', resource)
    const res = await fetch(`/api/projects/${projectId}/changes?${q}`, { credentials: 'include' })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(body.error || `Request failed with ${res.status}`)
    return body as Page
  }, [projectId, resource])

  const apply = useCallback((page: Page) => {
    setChanges(page.changes ?? [])
    setNextBefore(page.nextBeforeSeq ?? null)
    setCanManage(!!page.canManage)
    setError(null)
  }, [])

  // First load. State is set only once the response is in. The History page
  // mounts a fresh list for each filter (key), so this runs once per list.
  useEffect(() => {
    let cancelled = false
    fetchPage()
      .then((page) => { if (!cancelled) apply(page) })
      .catch((err) => {
        if (cancelled) return
        // Cleared, so a stale list cannot be read as the current history.
        setChanges([])
        setError(err?.message || 'Could not load the history')
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [fetchPage, apply])

  // Published versions mark the whole backend, so they show on the unfiltered history only.
  useEffect(() => {
    if (resource) return
    let cancelled = false
    fetch(`/api/projects/${projectId}/rollback`, { credentials: 'include' })
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => { if (!cancelled && body?.versions) setVersions(body.versions) })
      .catch(() => { /* the history reads the same without them */ })
    return () => { cancelled = true }
  }, [projectId, resource])

  /** Re-read the list after something changed it. */
  const reload = useCallback(async () => {
    try {
      apply(await fetchPage())
    } catch (err: any) {
      setError(err?.message || 'Could not load the history')
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
    setRestoreTo(null)
    setRestoreFor(found ?? null)
    if (!found) setDetailsFor(id)
  }

  const menuFor = (c: ChangeSummary, newest: boolean) => {
    const items: Array<{ label: string; icon?: typeof RotateCcw; onClick: () => void }> = []
    if (canManage && c.action) {
      items.push(
        c.action.kind === 'reapply'
          ? { label: 'Reapply this change', icon: Redo2, onClick: () => setRestoreFor(c) }
          : { label: 'Restore previous state', icon: RotateCcw, onClick: () => setRestoreFor(c) },
      )
    }
    // Everything after it, back to how it was then. The newest change has nothing after it.
    if (canManage && !newest) {
      items.push({ label: 'Restore to this point', icon: Undo2, onClick: () => setRestoreTo({ after: c.seq, label: `#${c.seq}`, detail: `#${c.seq} · ${c.summary}` }) })
    }
    // Only where a person's decision is what the change waits on (keepChange).
    if (canManage && (c.status === 'awaiting_approval' || c.status === 'manual_intervention_required')) {
      items.push({ label: 'Keep as it is', icon: Check, onClick: () => { setKeepError(null); setKeepFor(c) } })
    }
    items.push({ label: 'View details', icon: FileText, onClick: () => setDetailsFor(c.id) })
    return items
  }

  const filterLabel = resource ? RESOURCES.find((r) => r.id === resource)?.label : null
  const markers = resource ? new Map<number, PublishedVersion[]>() : markersAt(changes, versions, !nextBefore)

  const marker = (v: PublishedVersion) => (
    <li key={`v${v.id}`} className="group relative">
      <div className="grid grid-cols-[30px_minmax(0,1fr)_auto] items-center gap-x-3.5 bg-white/[0.015] px-4 py-2.5 pr-12 sm:px-5 sm:pr-14">
        <span className="flex justify-center"><Rocket className="h-3.5 w-3.5 text-zinc-500" strokeWidth={1.75} aria-hidden /></span>
        <span className="min-w-0 truncate text-[12.5px] text-zinc-300">
          Published v{v.version}
          {v.changeSummary && v.changeSummary !== 'Published' && <span className="text-faint"> · {v.changeSummary}</span>}
        </span>
        <span className="w-[64px] text-right text-[12.5px] tabular-nums text-faint" title={new Date(v.publishedAt).toLocaleString()}>
          {ago(v.publishedAt)}
        </span>
      </div>
      {canManage && (
        <div className="absolute right-2 top-1.5 sm:right-3">
          <OverflowMenu
            label={`Actions for version ${v.version}`}
            width="w-[220px]"
            items={[{
              label: `Restore to v${v.version}`,
              icon: Undo2,
              onClick: () => setRestoreTo({ version: v.version!, label: `v${v.version}`, detail: `Published ${ago(v.publishedAt)}${v.changeSummary && v.changeSummary !== 'Published' ? ` · ${v.changeSummary}` : ''}` }),
            }]}
          />
        </div>
      )}
    </li>
  )

  return (
    // contain:inline-size keeps a long summary from widening the page on a phone.
    <div className="w-full [contain:inline-size]">
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
          title={filterLabel ? `No ${filterLabel === 'API keys' ? 'API key' : filterLabel.toLowerCase()} changes yet` : 'No changes yet'}
          description={
            filterLabel
              ? 'Changes to this part of your backend will show up here as they are made, each checked after it applies.'
              : 'Every change to your backend shows up here: from your coding agents, from Backenly, or from you. Each one is checked after it applies, and can be restored from here.'
          }
          className="!py-12"
        />
      ) : (
        <ul className="divide-y divide-white/[0.06]">
          {changes.map((c, idx) => {
            const s = outcomeOf(c)
            const decide = canManage && awaitsDecision(c) && c.action?.available ? () => setRestoreFor(c) : null
            const second = <SecondLine c={c} onDetails={() => setDetailsFor(c.id)} onDecide={decide} />
            const hasSecond = !['healthy', 'in_progress', 'failed'].includes(c.outcome.state) &&
              !((c.outcome.state === 'kept' || c.outcome.state === 'unverified') && !c.outcome.note)
            const day = dayOf(c.createdAt)
            const newDay = idx === 0 || dayOf(changes[idx - 1].createdAt) !== day
            return (
              <Fragment key={c.id}>
                {newDay && (
                  <li aria-hidden className="bg-white/[0.012] px-4 py-2 text-[12px] font-medium leading-[16px] text-faint sm:px-5">
                    {day}
                  </li>
                )}
                {(markers.get(idx) ?? []).map(marker)}
                <li className="group relative transition-colors hover:bg-white/[0.025]">
                  {/* The summary is the row's one button, stretched over the row (after:inset-0),
                      so the whole row opens the details while the links and the menu in it stay
                      their own controls, not controls inside a control. */}
                  <div className="grid grid-cols-[30px_minmax(0,1fr)_auto] items-start gap-x-3.5 px-4 py-3.5 pr-12 sm:px-5 sm:pr-14">
                    <ActorMark actor={c.actor} />
                    <span className="min-w-0">
                      <button
                        type="button"
                        onClick={() => setDetailsFor(c.id)}
                        aria-label={`Change #${c.seq}: ${c.summary}. ${s.label}`}
                        title={c.summary}
                        className="block w-full truncate text-left text-[13.5px] font-medium leading-[20px] tracking-[-0.006em] text-zinc-50 after:absolute after:inset-0 after:content-[''] focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-inset focus-visible:after:ring-violet-300/60"
                      >
                        {c.summary}
                      </button>
                      {/* Wraps rather than truncates: a name cut to "Y…" says nothing. */}
                      <span className="mt-1 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px] leading-[18px] text-faint">
                        <span className="min-w-0 [overflow-wrap:anywhere]">
                          <ActorWords label={c.actor.label} />
                        </span>
                        {!resource && <Tag>{resourceLabels(c.resources)}</Tag>}
                        <span className="tabular-nums">#{c.seq}</span>
                        {/* On a phone the status takes its own line under the meta. */}
                        <span className="basis-full sm:hidden">
                          <Outcome c={c} />
                        </span>
                      </span>
                      {hasSecond && <span className="mt-1 block text-[12.5px] leading-[18px] text-zinc-400">{second}</span>}
                    </span>
                    <span className="flex items-center gap-4 pt-[2px]">
                      <Outcome c={c} className="hidden sm:inline-flex" />
                      <span className="w-[64px] text-right text-[12.5px] tabular-nums text-faint" title={new Date(c.createdAt).toLocaleString()}>
                        {ago(c.createdAt)}
                      </span>
                    </span>
                  </div>
                  <div className="absolute right-2 top-3 z-[1] sm:right-3">
                    <OverflowMenu label={`Actions for change #${c.seq}`} items={menuFor(c, idx === 0 && !resource)} width="w-[220px]" />
                  </div>
                </li>
              </Fragment>
            )
          })}
          {(markers.get(changes.length) ?? []).map(marker)}
          {nextBefore && (
            <li className="px-4 py-3 sm:px-5">
              <KitButton size="sm" variant="ghost" onClick={() => void loadMore()} loading={loadingMore}>
                Load older changes
              </KitButton>
            </li>
          )}
        </ul>
      )}

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

      {restoreTo && (
        <RestoreToDialog
          key={'version' in restoreTo ? `v${restoreTo.version}` : `#${restoreTo.after}`}
          projectId={projectId}
          point={restoreTo}
          onClose={() => setRestoreTo(null)}
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
