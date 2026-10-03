'use client'

/**
 * BranchesPanel — the UI face of preview branches ("PRs for your backend").
 *
 * Talks to the routes shipped in app/api/projects/[id]/branches:
 *   GET    /branches            list
 *   POST   /branches {name, includeData}
 *                               create (schema clone; rows only when asked)
 *   GET    /branches/[id]       schema diff vs main
 *   POST   /branches/[id]       merge (additive auto, rest → review items)
 *   DELETE /branches/[id]       discard (drops the clone)
 *   POST   /branches/[id]/keys  issue a key bound to the branch (BranchPreviewCard)
 *
 * Built from the console kit like every other section. Discarding drops the
 * clone, so it asks first.
 */

import { useEffect, useState, useCallback } from 'react'
import { AlertTriangle, ArrowRight, Check, GitBranch, Plus, RefreshCw, Trash2, X } from 'lucide-react'
import { BranchPreviewCard, type BranchPreview } from './BranchPreviewCard'
import {
  EmptyState,
  IconButton,
  KitButton,
  KitCard,
  KitCardBody,
  KitCardHeader,
  KitConfirmDialog,
  KitField,
  KitInput,
  KitNote,
  OverflowMenu,
  SectionLabel,
  SettingsCard,
  Skeleton,
  Tag,
} from '@/components/inspector/kit'

interface Branch {
  id: string
  name: string
  status: 'active' | 'merged' | 'discarded'
  schemaName?: string
  createdAt: string
  mergedAt: string | null
  /** Present for an active branch: where to point an app at it. */
  preview?: BranchPreview
}

interface ColumnDiff { name: string; dataType: string }
interface TableAlteration {
  table: string
  addedColumns: ColumnDiff[]
  droppedColumns: string[]
  typeChanged: Array<{ column: string; from: string; to: string }>
}
interface SchemaDiff {
  addedTables: Array<{ tableName: string; columns: unknown[] }>
  droppedTables: string[]
  altered: TableAlteration[]
  identical: boolean
}

interface MergeResult {
  applied: string[]
  review: string[]
  fullyMerged: boolean
}

function timeAgo(iso: string): string {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

export function BranchesPanel({ projectId }: { projectId: string }) {
  const [branches, setBranches] = useState<Branch[]>([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [includeData, setIncludeData] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [openDiff, setOpenDiff] = useState<{ id: string; name: string; diff: SchemaDiff } | null>(null)
  const [mergeOutcome, setMergeOutcome] = useState<{ name: string; result: MergeResult } | null>(null)
  const [confirmDiscard, setConfirmDiscard] = useState<Branch | null>(null)
  const [openPreview, setOpenPreview] = useState<string | null>(null)

  const base = `/api/projects/${projectId}/branches`

  const load = useCallback(async () => {
    try {
      const res = await fetch(base, { credentials: 'include' })
      const j = await res.json()
      if (j.success) setBranches(j.branches)
    } catch {
      setError('Could not load branches.')
    } finally {
      setLoading(false)
    }
  }, [base])

  useEffect(() => { load() }, [load])

  const create = async () => {
    const name = newName.trim().toLowerCase()
    if (!name) return
    setCreating(true); setError(null)
    try {
      const res = await fetch(base, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, includeData }),
      })
      const j = await res.json()
      if (!res.ok || !j.success) { setError(j.error || 'Could not create branch.'); return }
      setNewName('')
      setIncludeData(false)
      await load()
    } catch {
      setError('Network error creating branch.')
    } finally {
      setCreating(false)
    }
  }

  const viewDiff = async (b: Branch) => {
    setBusy(b.id); setError(null); setMergeOutcome(null)
    try {
      const res = await fetch(`${base}/${b.id}`, { credentials: 'include' })
      const j = await res.json()
      if (!res.ok || !j.success) { setError(j.error || 'Could not diff branch.'); return }
      setOpenDiff({ id: b.id, name: b.name, diff: j.diff })
    } finally {
      setBusy(null)
    }
  }

  const merge = async (b: Branch) => {
    setBusy(b.id); setError(null)
    try {
      const res = await fetch(`${base}/${b.id}`, { method: 'POST', credentials: 'include' })
      const j = await res.json()
      if (!res.ok || !j.success) { setError(j.error || 'Merge failed.'); return }
      setMergeOutcome({ name: b.name, result: j })
      setOpenDiff(null)
      await load()
    } finally {
      setBusy(null)
    }
  }

  const discard = async (b: Branch) => {
    setBusy(b.id); setError(null)
    try {
      const res = await fetch(`${base}/${b.id}`, { method: 'DELETE', credentials: 'include' })
      const j = await res.json()
      if (!res.ok || !j.success) { setError(j.error || 'Could not discard branch.'); return }
      if (openDiff?.id === b.id) setOpenDiff(null)
      if (openPreview === b.id) setOpenPreview(null)
      await load()
    } finally {
      setBusy(null)
    }
  }

  const active = branches.filter((b) => b.status === 'active')
  const merged = branches.filter((b) => b.status === 'merged')
  const atLimit = active.length >= 5
  const previewing = active.find((b) => b.id === openPreview && b.preview)

  return (
    <div className="space-y-4">
      <SettingsCard
        title="New preview branch"
        description="A copy of this project's schema in its own isolated space, with the same row security and its own id sequences. It starts empty. An API key bound to the branch reads and writes it through the data API, while production keeps serving."
        onSubmit={create}
        footer={<span className="tabular-nums">{active.length} of 5 branches active</span>}
        actions={
          <KitButton type="submit" variant="primary" icon={Plus} loading={creating} disabled={!newName.trim() || atLimit}>
            {creating ? 'Cloning…' : 'Create branch'}
          </KitButton>
        }
      >
        <div className="max-w-[360px]">
          <KitField label="Branch name" hint="Lowercase letters, numbers and dashes.">
            <KitInput
              placeholder="add-payments"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              disabled={creating}
              className="font-mono"
              aria-label="Branch name"
            />
          </KitField>
        </div>
        <label className="mt-4 flex max-w-[560px] cursor-pointer items-start gap-3 rounded-[8px] border border-white/[0.07] bg-white/[0.02] px-3.5 py-3">
          <input
            type="checkbox"
            checked={includeData}
            onChange={(e) => setIncludeData(e.target.checked)}
            disabled={creating}
            className="mt-[3px] h-4 w-4 flex-shrink-0 accent-violet-400"
          />
          <span className="min-w-0">
            <span className="block text-[13px] font-medium text-zinc-100">Copy production rows</span>
            <span className="mt-0.5 block text-[12.5px] leading-[18px] text-zinc-500">
              Off by default. Turn on only to reproduce a problem that depends on real data: the copy includes your
              end users&apos; records, and anyone holding a key for this branch can read them.
            </span>
          </span>
        </label>
      </SettingsCard>

      {error && (
        <KitNote tone="danger" icon={AlertTriangle}>
          {error}
        </KitNote>
      )}

      {mergeOutcome && (
        <KitNote
          tone={mergeOutcome.result.fullyMerged ? 'success' : 'warn'}
          icon={mergeOutcome.result.fullyMerged ? Check : AlertTriangle}
          title={
            mergeOutcome.result.fullyMerged
              ? `Merged ${mergeOutcome.name}`
              : `Merged ${mergeOutcome.name} in part. Some changes need the review path.`
          }
          actions={<IconButton icon={X} label="Dismiss" onClick={() => setMergeOutcome(null)} />}
        >
          <ul className="mt-1 space-y-1">
            {mergeOutcome.result.applied.map((a, i) => (
              <li key={`a${i}`} className="flex items-start gap-2 text-zinc-300">
                <Check className="mt-[3px] h-3.5 w-3.5 flex-shrink-0 text-emerald-400" />
                {a}
              </li>
            ))}
            {mergeOutcome.result.review.map((r, i) => (
              <li key={`r${i}`} className="flex items-start gap-2 text-amber-100/90">
                <ArrowRight className="mt-[3px] h-3.5 w-3.5 flex-shrink-0 text-amber-300" />
                {r}
              </li>
            ))}
          </ul>
        </KitNote>
      )}

      {/* Preview endpoint */}
      {previewing && previewing.preview && (
        <BranchPreviewCard
          key={previewing.id}
          projectId={projectId}
          branch={{ id: previewing.id, name: previewing.name, schemaName: previewing.schemaName, preview: previewing.preview }}
          onClose={() => setOpenPreview(null)}
        />
      )}

      {/* Diff detail */}
      {openDiff && (
        <KitCard className="overflow-hidden">
          <KitCardHeader
            title={
              <span>
                <span className="font-mono">{openDiff.name}</span> compared with production
              </span>
            }
            actions={<IconButton icon={X} label="Close the comparison" onClick={() => setOpenDiff(null)} />}
          />
          <KitCardBody>
            {openDiff.diff.identical ? (
              <p className="text-[13px] text-zinc-500">No differences. This branch matches production.</p>
            ) : (
              <div className="space-y-4">
                {openDiff.diff.addedTables.length > 0 && (
                  <div>
                    <SectionLabel>New tables</SectionLabel>
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {openDiff.diff.addedTables.map((t) => (
                        <Tag key={t.tableName} tone="good" mono>
                          + {t.tableName}
                        </Tag>
                      ))}
                    </div>
                  </div>
                )}
                {openDiff.diff.altered.map((a) => (
                  <div key={a.table}>
                    <SectionLabel>
                      <span className="font-mono">{a.table}</span>
                    </SectionLabel>
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {a.addedColumns.map((c) => (
                        <Tag key={c.name} tone="good" mono>
                          + {c.name} {c.dataType}
                        </Tag>
                      ))}
                      {a.droppedColumns.map((c) => (
                        <Tag key={c} tone="bad" mono>
                          − {c}
                        </Tag>
                      ))}
                      {a.typeChanged.map((t) => (
                        <Tag key={t.column} tone="warn" mono>
                          {t.column}: {t.from} to {t.to}
                        </Tag>
                      ))}
                    </div>
                  </div>
                ))}
                {openDiff.diff.droppedTables.length > 0 && (
                  <div>
                    <SectionLabel>Dropped tables</SectionLabel>
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {openDiff.diff.droppedTables.map((t) => (
                        <Tag key={t} tone="bad" mono>
                          − {t}
                        </Tag>
                      ))}
                    </div>
                  </div>
                )}
                <p className="max-w-[72ch] text-[12.5px] leading-[19px] text-zinc-500">
                  New tables merge automatically through the governed kernel. Column and type changes come back as
                  review items in the approval path, never as silent DDL.
                </p>
              </div>
            )}
          </KitCardBody>
        </KitCard>
      )}

      {/* List */}
      <KitCard className="overflow-hidden">
        <KitCardHeader
          title={
            <span className="flex items-baseline gap-2">
              Active branches
              {!loading && <span className="text-[12px] font-normal tabular-nums text-zinc-500">{active.length}</span>}
            </span>
          }
          actions={<IconButton icon={RefreshCw} label="Refresh branches" onClick={load} />}
        />
        {loading ? (
          <div className="space-y-3 px-4 py-4" aria-hidden>
            <Skeleton className="h-[14px] w-40" />
            <Skeleton className="h-[14px] w-28" />
          </div>
        ) : active.length === 0 ? (
          <EmptyState
            icon={GitBranch}
            title="No preview branches"
            description="Create one to test against an isolated copy of your schema, then merge new tables back through the governed path."
          />
        ) : (
          <ul className="divide-y divide-white/[0.06]">
            {active.map((b) => (
              <li key={b.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <GitBranch className="h-4 w-4 flex-shrink-0 text-zinc-500" strokeWidth={1.75} />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-mono text-[13px] text-zinc-100">{b.name}</p>
                  <p className="text-[12px] text-zinc-500">Created {timeAgo(b.createdAt)}</p>
                </div>
                <div className="flex flex-shrink-0 items-center gap-1.5">
                  {b.preview && (
                    <KitButton
                      size="sm"
                      variant="ghost"
                      onClick={() => setOpenPreview(openPreview === b.id ? null : b.id)}
                    >
                      Preview
                    </KitButton>
                  )}
                  <KitButton size="sm" variant="ghost" onClick={() => viewDiff(b)} loading={busy === b.id && !confirmDiscard}>
                    Compare
                  </KitButton>
                  <KitButton size="sm" onClick={() => merge(b)} disabled={busy === b.id}>
                    Merge
                  </KitButton>
                  <OverflowMenu
                    label={`More actions for ${b.name}`}
                    items={[{ label: 'Discard branch', icon: Trash2, danger: true, onClick: () => setConfirmDiscard(b) }]}
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
      </KitCard>

      {/* History: a merged branch no longer answers its keys, but it happened. */}
      {merged.length > 0 && (
        <KitCard className="overflow-hidden">
          <KitCardHeader
            title={
              <span className="flex items-baseline gap-2">
                Merged
                <span className="text-[12px] font-normal tabular-nums text-zinc-500">{merged.length}</span>
              </span>
            }
          />
          <ul className="divide-y divide-white/[0.06]">
            {merged.map((b) => (
              <li key={b.id} className="flex items-center gap-3 px-4 py-2.5">
                <GitBranch className="h-4 w-4 flex-shrink-0 text-zinc-600" strokeWidth={1.75} />
                <p className="min-w-0 flex-1 truncate font-mono text-[13px] text-zinc-400">{b.name}</p>
                <span className="text-[12px] text-zinc-500">
                  Merged {b.mergedAt ? timeAgo(b.mergedAt) : ''}
                </span>
              </li>
            ))}
          </ul>
        </KitCard>
      )}

      <KitConfirmDialog
        open={!!confirmDiscard}
        danger
        busy={!!confirmDiscard && busy === confirmDiscard.id}
        title={confirmDiscard ? `Discard ${confirmDiscard.name}?` : 'Discard branch'}
        description="The branch's cloned schema and every row in it are dropped. Production is not touched. This cannot be undone."
        confirmLabel="Discard branch"
        onCancel={() => {
          if (!busy) setConfirmDiscard(null)
        }}
        onConfirm={async () => {
          if (!confirmDiscard) return
          await discard(confirmDiscard)
          setConfirmDiscard(null)
        }}
      />
    </div>
  )
}
