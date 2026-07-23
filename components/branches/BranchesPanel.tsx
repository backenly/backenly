'use client'

/**
 * BranchesPanel — the UI face of preview branches ("PRs for your backend").
 *
 * Talks to the routes shipped in app/api/projects/[id]/branches:
 *   GET    /branches            list
 *   POST   /branches {name}     create (full structural + data clone)
 *   GET    /branches/[id]       schema diff vs main
 *   POST   /branches/[id]       merge (additive auto, rest → review items)
 *   DELETE /branches/[id]       discard (drops the clone)
 *
 * Aesthetic: components/inspector/kit primitives, #16171d panels, mono
 * numerals, violet only for action — same language as every other section.
 */

import { useEffect, useState, useCallback } from 'react'
import { GitBranch, Plus, RefreshCw, Loader2, Check, X, ArrowRight, AlertTriangle } from 'lucide-react'
import {
  KitCard, KitCardHeader, KitCardBody, KitButton, KitBadge, KitInput,
  ListRow, EmptyState, SectionLabel,
} from '@/components/inspector/kit'

interface Branch {
  id: string
  name: string
  status: 'active' | 'merged' | 'discarded'
  createdAt: string
  mergedAt: string | null
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
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [openDiff, setOpenDiff] = useState<{ id: string; name: string; diff: SchemaDiff } | null>(null)
  const [mergeOutcome, setMergeOutcome] = useState<{ name: string; result: MergeResult } | null>(null)

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
        body: JSON.stringify({ name }),
      })
      const j = await res.json()
      if (!res.ok || !j.success) { setError(j.error || 'Could not create branch.'); return }
      setNewName('')
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
      await load()
    } finally {
      setBusy(null)
    }
  }

  const active = branches.filter(b => b.status === 'active')

  return (
    <div className="space-y-4">
      {/* Create */}
      <KitCard>
        <KitCardHeader
          title="New preview branch"
          description="A full clone of your schema + data. Build against it, then merge back through the governed path"
        />
        <KitCardBody className="flex items-center gap-2">
          <div className="flex-1 max-w-xs">
            <KitInput
              placeholder="add-payments"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') create() }}
              disabled={creating}
            />
          </div>
          <KitButton variant="primary" icon={creating ? Loader2 : Plus} onClick={create} disabled={creating || !newName.trim()}>
            {creating ? 'Cloning…' : 'Create branch'}
          </KitButton>
          <span className="text-[11px] text-zinc-600">{active.length}/5 active</span>
        </KitCardBody>
      </KitCard>

      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-rose-500/20 bg-rose-500/[0.06] px-4 py-2.5">
          <AlertTriangle className="w-3.5 h-3.5 text-rose-300 flex-shrink-0" />
          <p className="text-[12px] text-rose-200">{error}</p>
        </div>
      )}

      {mergeOutcome && (
        <KitCard className="border-emerald-500/20">
          <KitCardHeader title={`Merged “${mergeOutcome.name}”`} description={mergeOutcome.result.fullyMerged ? 'fully merged' : 'partially merged; some changes need the governed path'} />
          <KitCardBody className="space-y-2">
            {mergeOutcome.result.applied.map((a, i) => (
              <p key={i} className="flex items-baseline gap-2 text-[12px] text-zinc-300"><Check className="w-3 h-3 text-emerald-400 self-center flex-shrink-0" />{a}</p>
            ))}
            {mergeOutcome.result.review.map((r, i) => (
              <p key={i} className="flex items-baseline gap-2 text-[12px] text-amber-200/90"><ArrowRight className="w-3 h-3 text-amber-400 self-center flex-shrink-0" />{r}</p>
            ))}
          </KitCardBody>
        </KitCard>
      )}

      {/* Diff detail */}
      {openDiff && (
        <KitCard className="border-violet-400/20">
          <KitCardHeader
            title={`“${openDiff.name}” vs main`}
            actions={<KitButton size="sm" variant="ghost" icon={X} onClick={() => setOpenDiff(null)}>Close</KitButton>}
          />
          <KitCardBody>
            {openDiff.diff.identical ? (
              <p className="text-[12.5px] text-zinc-500">No differences. This branch matches main.</p>
            ) : (
              <div className="space-y-3">
                {openDiff.diff.addedTables.length > 0 && (
                  <div>
                    <SectionLabel>New tables</SectionLabel>
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {openDiff.diff.addedTables.map(t => <KitBadge key={t.tableName} tone="operational">{t.tableName}</KitBadge>)}
                    </div>
                  </div>
                )}
                {openDiff.diff.altered.map(a => (
                  <div key={a.table}>
                    <SectionLabel>{a.table}</SectionLabel>
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {a.addedColumns.map(c => <KitBadge key={c.name} tone="operational">+ {c.name} {c.dataType}</KitBadge>)}
                      {a.droppedColumns.map(c => <KitBadge key={c} tone="failed">− {c}</KitBadge>)}
                      {a.typeChanged.map(t => <KitBadge key={t.column} tone="attention">{t.column}: {t.from}→{t.to}</KitBadge>)}
                    </div>
                  </div>
                ))}
                {openDiff.diff.droppedTables.length > 0 && (
                  <div>
                    <SectionLabel>Dropped tables</SectionLabel>
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {openDiff.diff.droppedTables.map(t => <KitBadge key={t} tone="failed">{t}</KitBadge>)}
                    </div>
                  </div>
                )}
                <p className="text-[11px] text-zinc-600 pt-1 leading-relaxed">
                  New tables merge automatically through the governed kernel. Column and type changes come back as review items in the approval path, never silent DDL.
                </p>
              </div>
            )}
          </KitCardBody>
        </KitCard>
      )}

      {/* List */}
      <KitCard>
        <KitCardHeader
          title="Branches"
          actions={<button onClick={load} className="text-zinc-600 hover:text-zinc-300 transition-colors" aria-label="Refresh"><RefreshCw className="w-3.5 h-3.5" /></button>}
        />
        {loading ? (
          <KitCardBody><p className="text-[12px] text-zinc-600">Loading…</p></KitCardBody>
        ) : active.length === 0 ? (
          <EmptyState
            icon={GitBranch}
            title="No preview branches"
            description="Create one to let an agent build against an isolated copy of your backend, then merge the changes back safely."
          />
        ) : (
          <div className="divide-y divide-white/[0.05]">
            {active.map(b => (
              <ListRow
                key={b.id}
                icon={GitBranch}
                iconTone="violet"
                title={b.name}
                subtitle={`created ${timeAgo(b.createdAt)}`}
                right={
                  <>
                    <KitButton size="sm" variant="ghost" onClick={() => viewDiff(b)} disabled={busy === b.id}>
                      {busy === b.id ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Diff'}
                    </KitButton>
                    <KitButton size="sm" variant="primary" onClick={() => merge(b)} disabled={busy === b.id}>Merge</KitButton>
                    <KitButton size="sm" variant="danger" onClick={() => discard(b)} disabled={busy === b.id}>Discard</KitButton>
                  </>
                }
              />
            ))}
          </div>
        )}
      </KitCard>
    </div>
  )
}
