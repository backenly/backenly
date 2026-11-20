'use client'

/**
 * History: every change to the backend, newest first, under the day it was
 * made, ending where the project began.
 *
 *   History  Restorable for 7 days                          [All changes ▾]
 *   Every schema and settings change is checked after it applies.
 *   Today
 *   (◇)  Created table reviews. Created bucket review-photos…   ✓  2:09 AM  ⋯
 *        Claude Code   Database, Storage, Secrets   #48
 *   Sat, Nov 14
 *    ↑   Published v5   7 tables updated                            6:02 AM  ⋯
 *   …
 *        Project created                                           Nov 8
 *
 * Who made a change leads its row (ChangeRow): a person's initial, the agent,
 * or Backenly. A change that applied and verified is the ✓ glyph alone; only a
 * state that asks for a look is written out. The ways back are in the row's ⋯
 * menu: "Undo this change" undoes that change, "Restore to this point" undoes
 * everything after it, "Keep as it is" settles one that waits on a decision; a
 * published version's marker offers "Restore to v5". A change opens beside the
 * list in a drawer (?change=), where everything technical lives.
 *
 * One history for the schema and the rest of the backend: buckets, functions,
 * webhooks, secrets, keys, auth and integrations are rows here like a table
 * is (lib/changes/resources), and one quiet filter (?part=) narrows it. A
 * restore is itself recorded, so the state it replaced is protected, but it
 * is not a row of its own: it is how the change it restored ended.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Rocket } from 'lucide-react'
import { KitButton, KitConfirmDialog, KitSelect, OverflowMenu, PageHeader } from '@/components/inspector/kit'
import { recordNav, useRecordParam } from '@/components/console/RecordDrawer'
import { ErrorRow } from '@/components/console/states'
import { Time } from '@/components/console/Time'
import { formatTime, groupByDay } from '@/components/console/format'
import { DayGroup } from '@/components/console/EventRow'
import { Panel, RowSkeleton } from '@/components/autonomy/rows'
import { getProject } from '@/lib/api/projects'
import type { ChangeSummary } from '@/lib/changes/history'
import type { PublishedVersion } from '@/lib/deployment/published-versions'
import { ChangeDrawer } from './ChangeDetails'
import { ChangeRow, type ChangeMenuItem } from './ChangeRow'
import { RestoreDialog } from './RestoreDialog'
import { RestoreToDialog, type RestorePoint } from './RestoreToDialog'
import { RESOURCES, awaitsDecision } from './present'

interface Page {
  changes: ChangeSummary[]
  windowDays: number
  nextBeforeSeq: number | null
  canManage?: boolean
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

/** "storage" → "No storage changes yet." */
function noneYet(resource: string | null): string {
  if (!resource) return 'No changes yet. Your agent’s first change will be #1.'
  const label = RESOURCES.find((r) => r.id === resource)?.label ?? resource
  const noun = label === 'API keys' ? 'API key' : label === 'Allowed origins' ? 'allowed origin' : label === 'Secrets' ? 'secret' : label.toLowerCase()
  return `No ${noun} changes yet.`
}

/** One line of the ledger that is not a change: a published version, or the project's beginning. */
function MarkerRow({
  lead,
  children,
  time,
  day,
  menu,
}: {
  lead?: React.ReactNode
  children: React.ReactNode
  time: string
  /** The heading it sits under: the clock when it is that day, else the date too. */
  day?: string
  menu?: React.ReactNode
}) {
  return (
    <li className="relative">
      <div className={`grid grid-cols-[24px_minmax(0,1fr)_auto] items-center gap-x-[12px] px-[16px] py-[10px] sm:px-[20px] ${menu ? 'pr-[48px] sm:pr-[56px]' : ''}`}>
        <span className="flex justify-center">{lead}</span>
        <span className="min-w-0 text-[12.5px] leading-[18px] text-zinc-300 [overflow-wrap:anywhere]">{children}</span>
        <span className="whitespace-nowrap text-right text-[12.5px] tabular-nums text-faint">
          <Time iso={time} mode={!day || formatTime(time, 'day') === day ? 'clock' : 'dateTime'} />
        </span>
      </div>
      {menu && <div className="absolute right-[8px] top-[6px] sm:right-[12px]">{menu}</div>}
    </li>
  )
}

export function ChangeHistory({
  projectId,
  resource = null,
  onResource,
}: {
  projectId: string
  /** The part of the backend the list is narrowed to (?part=), or null for all. */
  resource?: string | null
  onResource?: (part: string | null) => void
}) {
  const [changes, setChanges] = useState<ChangeSummary[]>([])
  const [versions, setVersions] = useState<PublishedVersion[]>([])
  const [branches, setBranches] = useState<Array<{ id: string; name: string }>>([])
  const [selectedBranch, setSelectedBranch] = useState<string>('main')
  const [nextBefore, setNextBefore] = useState<number | null>(null)
  const [canManage, setCanManage] = useState(false)
  const [windowDays, setWindowDays] = useState<number | null>(null)
  const [createdAt, setCreatedAt] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [retrying, setRetrying] = useState(false)

  const [changeId, openChange, closeChange] = useRecordParam('change')
  const [restoreFor, setRestoreFor] = useState<ChangeSummary | null>(null)
  const [restoreTo, setRestoreTo] = useState<RestorePoint | null>(null)
  const [keepFor, setKeepFor] = useState<ChangeSummary | null>(null)
  const [keeping, setKeeping] = useState(false)
  const [keepError, setKeepError] = useState<string | null>(null)

  const fetchPage = useCallback(async (before?: number): Promise<Page> => {
    const q = new URLSearchParams({ limit: '30' })
    if (before) q.set('before', String(before))
    if (resource) q.set('resource', resource)
    if (selectedBranch && selectedBranch !== 'main') q.set('branch', selectedBranch)
    const res = await fetch(`/api/projects/${projectId}/changes?${q}`, { credentials: 'include' })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(body.error || `Request failed with ${res.status}`)
    return body as Page
  }, [projectId, resource, selectedBranch])

  // Load active preview branches for branch selector
  useEffect(() => {
    let cancelled = false
    fetch(`/api/projects/${projectId}/branches`, { credentials: 'include' })
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => {
        if (!cancelled && Array.isArray(body?.branches)) {
          setBranches(body.branches.map((b: any) => ({ id: b.id, name: b.name })))
        }
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [projectId])

  const apply = useCallback((page: Page) => {
    setChanges(page.changes ?? [])
    setNextBefore(page.nextBeforeSeq ?? null)
    setCanManage(!!page.canManage)
    setWindowDays(typeof page.windowDays === 'number' ? page.windowDays : null)
    setError(null)
  }, [])

  // First load. The History page mounts a fresh list for each filter (key), so this runs once per list.
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

  // Where the ledger begins: the project's own creation (shared with the shell's read).
  useEffect(() => {
    let cancelled = false
    getProject(projectId)
      .then((p) => {
        const at = p?.createdAt ? new Date(p.createdAt as unknown as string).toISOString() : null
        if (!cancelled) setCreatedAt(at)
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [projectId])

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

  /** A step a restore stopped at opens in its own Undo dialog. */
  const openStep = (id: string) => {
    const found = changes.find((c) => c.id === id)
    setRestoreTo(null)
    setRestoreFor(found ?? null)
    if (!found) openChange(id)
  }

  const menuFor = (c: ChangeSummary, newest: boolean): ChangeMenuItem[] => {
    const items: ChangeMenuItem[] = []
    if (canManage && c.action) {
      items.push(
        c.action.kind === 'reapply'
          ? { label: 'Reapply this change', onClick: () => setRestoreFor(c) }
          : { label: 'Undo this change', onClick: () => setRestoreFor(c) },
      )
    }
    // Everything after it, back to how it was then. The newest change has nothing after it.
    if (canManage && !newest) {
      items.push({ label: 'Restore to this point', onClick: () => setRestoreTo({ after: c.seq, label: `#${c.seq}`, detail: c.summary }) })
    }
    // Only where a person's decision is what the change waits on (keepChange).
    if (canManage && (c.status === 'awaiting_approval' || c.status === 'manual_intervention_required')) {
      items.push({ label: 'Keep as it is', onClick: () => { setKeepError(null); setKeepFor(c) } })
    }
    items.push({ label: 'View details', onClick: () => openChange(c.id) })
    return items
  }

  const nav = recordNav(changes, (c) => c.id, changeId, openChange)
  const markers = useMemo(
    () => (resource ? new Map<number, PublishedVersion[]>() : markersAt(changes, versions, !nextBefore)),
    [resource, changes, versions, nextBefore],
  )
  // The day groups, with each version marker in the group of the change it sits above.
  const groups = useMemo(() => groupByDay(changes.map((c, i) => ({ c, i })), (x) => x.c.createdAt), [changes])
  const empty = !loading && !error && changes.length === 0
  // The filter is hidden while there is nothing to narrow.
  const showFilter = !loading && (changes.length > 0 || !!resource)
  // The ledger ends where the project began, once the oldest change is loaded.
  const showCreated = !resource && !!createdAt && !nextBefore && !loading && !error

  const marker = (v: PublishedVersion, day?: string) => (
    <MarkerRow
      key={`v${v.id}`}
      lead={<Rocket aria-hidden className="h-[14px] w-[14px] text-zinc-500" strokeWidth={1.75} />}
      time={v.publishedAt}
      day={day}
      menu={
        canManage ? (
          <OverflowMenu
            label={`Actions for version ${v.version}`}
            width="w-[220px]"
            items={[{
              label: `Restore to v${v.version}`,
              onClick: () => setRestoreTo({
                version: v.version!,
                label: `v${v.version}`,
                detail: `Published ${formatTime(v.publishedAt, 'dateTime')}${v.changeSummary && v.changeSummary !== 'Published' ? `, ${v.changeSummary.toLowerCase()}` : ''}`,
              }),
            }]}
          />
        ) : undefined
      }
    >
      <span className="text-zinc-200">Published v{v.version}</span>
      {v.changeSummary && v.changeSummary !== 'Published' && <span className="ml-4 text-faint">{v.changeSummary}</span>}
    </MarkerRow>
  )

  const created = (day?: string) =>
    createdAt ? (
      <MarkerRow key="created" time={createdAt} day={day}>
        <span className="text-zinc-200">Project created</span>
      </MarkerRow>
    ) : null

  // The foot of the ledger: versions older than every loaded change, then the
  // project's creation, each under its own day.
  const tail = groupByDay(
    [
      ...(markers.get(changes.length) ?? []).map((v) => ({ at: v.publishedAt, node: (day: string) => marker(v, day) })),
      ...(showCreated && createdAt ? [{ at: createdAt, node: (day: string) => created(day) }] : []),
    ],
    (x) => x.at,
  )

  return (
    // contain:inline-size keeps a long summary from widening the page on a phone.
    <div className="w-full [contain:inline-size]">
      <PageHeader
        flush
        title="History"
        meta={windowDays ? <span className="text-[13px] text-faint">Restorable for {windowDays} {windowDays === 1 ? 'day' : 'days'}</span> : undefined}
        description="Every schema and settings change is checked after it applies."
        actions={
          <div className="flex flex-wrap items-center gap-[8px]">
            {branches.length > 0 && (
              <KitSelect
                aria-label="Branch"
                value={selectedBranch}
                onChange={(e) => setSelectedBranch(e.target.value)}
                wrapperClassName="w-[140px]"
              >
                <option value="main">Branch: main</option>
                {branches.map((b) => (
                  <option key={b.name} value={b.name}>
                    Branch: {b.name}
                  </option>
                ))}
              </KitSelect>
            )}
            {showFilter && (
              <KitSelect
                aria-label="Show changes to"
                value={resource ?? ''}
                onChange={(e) => onResource?.(e.target.value || null)}
                wrapperClassName="w-[180px]"
              >
                <option value="">All changes</option>
                {RESOURCES.map((r) => (
                  <option key={r.id} value={r.id}>{r.label}</option>
                ))}
              </KitSelect>
            )}
          </div>
        }
      />

      {!loading && !error && !canManage && changes.length > 0 && (
        <p className="mb-3 text-[12.5px] leading-[18px] text-faint">Only admins can undo changes.</p>
      )}

      <Panel>
        {error ? (
          <ErrorRow
            things="the history"
            retrying={retrying}
            onRetry={() => {
              setRetrying(true)
              void reload().finally(() => setRetrying(false))
            }}
          />
        ) : loading ? (
          <RowSkeleton rows={6} lead="actor" />
        ) : empty ? (
          <ul className="divide-y divide-white/[0.06]">
            <li className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-[20px] py-[14px]">
              <p className="text-[13px] leading-[20px] text-zinc-400">{noneYet(resource)}</p>
              {resource && (
                <KitButton size="sm" onClick={() => onResource?.(null)}>
                  Show all changes
                </KitButton>
              )}
            </li>
            {!resource && createdAt && (
              <li>
                <DayGroup label={formatTime(createdAt, 'day')}>{created(formatTime(createdAt, 'day'))}</DayGroup>
              </li>
            )}
          </ul>
        ) : (
          <div className="divide-y divide-white/[0.06]">
            {groups.map((g) => (
              <DayGroup key={g.key} label={g.label}>
                {g.items.map(({ c, i }) => (
                  <MarkersThenRow key={c.id} markers={(markers.get(i) ?? []).map((v) => marker(v, g.label))}>
                    <ChangeRow
                      change={c}
                      current={c.id === changeId}
                      onOpen={() => openChange(c.id)}
                      onDecide={canManage && awaitsDecision(c) && c.action?.available ? () => setRestoreFor(c) : null}
                      menu={menuFor(c, i === 0 && !resource)}
                      showParts={!resource}
                    />
                  </MarkersThenRow>
                ))}
              </DayGroup>
            ))}
            {tail.map((g) => (
              <DayGroup key={`tail-${g.key}`} label={g.label}>
                {g.items.map((x) => x.node(g.label))}
              </DayGroup>
            ))}
            {nextBefore && (
              <div className="px-[16px] py-[10px] sm:px-[20px]">
                <KitButton size="sm" variant="ghost" onClick={() => void loadMore()} loading={loadingMore}>
                  Load older changes
                </KitButton>
              </div>
            )}
          </div>
        )}
      </Panel>
      {!loading && !error && changes.length > 0 && (
        <p className="mt-3 flex items-center gap-1.5 text-[12.5px] leading-[18px] text-faint">
          <svg aria-hidden viewBox="0 0 12 12" className="h-[12px] w-[12px] text-zinc-500" fill="none">
            <path d="M2.6 6.2 5 8.5l4.4-5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Checked after it applied
        </p>
      )}

      {changeId && (
        <ChangeDrawer
          projectId={projectId}
          changeId={changeId}
          summary={nav.item}
          canManage={canManage}
          onClose={closeChange}
          onRestore={(summary) => setRestoreFor(summary)}
          onPrev={nav.onPrev}
          onNext={nav.onNext}
          position={nav.position}
        />
      )}

      {restoreFor && (
        <RestoreDialog
          key={restoreFor.id}
          projectId={projectId}
          change={restoreFor}
          onClose={() => setRestoreFor(null)}
          onDone={() => void reload()}
          onOpenChange={openStep}
        />
      )}

      {restoreTo && (
        <RestoreToDialog
          key={'version' in restoreTo ? `v${restoreTo.version}` : `#${restoreTo.after}`}
          projectId={projectId}
          point={restoreTo}
          onClose={() => setRestoreTo(null)}
          onDone={() => void reload()}
          onOpenChange={openStep}
        />
      )}

      <KitConfirmDialog
        open={!!keepFor}
        onCancel={() => setKeepFor(null)}
        onConfirm={() => void keep()}
        busy={keeping}
        title={keepFor ? `Keep #${keepFor.seq} as it is?` : 'Keep this change as it is?'}
        description={keepFor?.summary}
        confirmLabel="Keep as it is"
      >
        <p className="text-[13px] leading-[20px] text-zinc-400">
          It stays in effect and its failed checks stay on record. You can still undo it later.
        </p>
        {keepError && <p className="mt-2 text-[12.5px] text-rose-300">{keepError}</p>}
      </KitConfirmDialog>
    </div>
  )
}

/** A change row with the version markers that sit above it. */
function MarkersThenRow({ markers, children }: { markers: React.ReactNode[]; children: React.ReactNode }) {
  return (
    <>
      {markers}
      {children}
    </>
  )
}
