'use client'

/**
 * PROJECT DATABASE SNAPSHOTS
 *
 * One project's schema and rows, and deliberately not more. The panel says what
 * a snapshot excludes before it offers to take one, because the failure this
 * product family is most prone to is an operator seeing something called
 * "Backup", concluding their server is safe, and finding out otherwise on the
 * only day it matters.
 *
 * That is why this is never labelled "Backup" on its own. On a self-hosted
 * deployment it names its sibling: deployment recovery lives in account
 * Settings and covers the machine. A snapshot covers a project. Backenly Cloud
 * has no Recovery page, so there the panel does not point at one.
 *
 * ── Restore states what it replaces, in the dialog ──────────────────────────
 *
 * Restoring replaces every table in the project, and the confirmation says so
 * along with the snapshot's own timestamp - a dialog that asked "are you sure?"
 * over an unnamed snapshot would be a worse guard than none, because it looks
 * like one.
 */

import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, Camera, CheckCircle2, Info, RotateCcw } from 'lucide-react'
import { EmptyState, KitButton, KitConfirmDialog, KitNote, Skeleton, StatusDot } from '@/components/inspector/kit'
import { EDGE, RULE, R_PANEL } from '@/components/console/tokens'
import { CLOUD_CONTROL_PLANE } from '@cloud/control-plane'

interface Snapshot {
  id: string
  filename: string
  sizeBytes: number
  status: string
  error: string | null
  createdAt: string
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`
}

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

export function DatabaseSnapshots({ projectId }: { projectId: string }) {
  const [snapshots, setSnapshots] = useState<Snapshot[]>([])
  const [loading, setLoading] = useState(true)
  const [taking, setTaking] = useState(false)
  const [restoring, setRestoring] = useState<string | null>(null)
  const [message, setMessage] = useState<{ tone: 'danger' | 'success'; text: string } | null>(null)
  const [confirmRestore, setConfirmRestore] = useState<Snapshot | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}/backup`)
      const data = await res.json()
      if (res.ok) setSnapshots(data.data ?? [])
    } catch {
      // A list that cannot load is not worth an error banner over the action
      // that still works. The empty state below reads honestly either way.
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => {
    load()
  }, [load])

  async function takeSnapshot() {
    setTaking(true)
    setMessage(null)
    try {
      const res = await fetch(`/api/projects/${projectId}/backup`, { method: 'POST' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'The snapshot failed.')
      setMessage({ tone: 'success', text: 'Snapshot taken.' })
      await load()
    } catch (err) {
      setMessage({ tone: 'danger', text: err instanceof Error ? err.message : 'The snapshot failed.' })
    } finally {
      setTaking(false)
    }
  }

  async function restore(snapshot: Snapshot) {
    setRestoring(snapshot.id)
    setMessage(null)
    try {
      const res = await fetch(`/api/projects/${projectId}/backup`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ backupId: snapshot.id }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'The restore failed.')
      setMessage({ tone: 'success', text: 'Restored. Reload to see the current tables.' })
      await load()
    } catch (err) {
      setMessage({ tone: 'danger', text: err instanceof Error ? err.message : 'The restore failed.' })
    } finally {
      setRestoring(null)
      setConfirmRestore(null)
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto">
      <div className={`flex h-[44px] flex-shrink-0 items-center justify-between gap-3 border-b ${RULE} pl-4 pr-2 sm:pl-5`}>
        <div className="flex min-w-0 items-baseline gap-2">
          <h2 className="text-[13px] font-medium text-zinc-100">Snapshots</h2>
          {!loading && snapshots.length > 0 && (
            <span className="text-[12px] tabular-nums text-zinc-500">{snapshots.length}</span>
          )}
        </div>
        <KitButton size="sm" icon={Camera} onClick={takeSnapshot} loading={taking}>
          {taking ? 'Taking snapshot…' : 'Take snapshot'}
        </KitButton>
      </div>

      <div className="w-full max-w-[860px] flex-1 space-y-5 px-4 py-5 sm:px-5">
        <KitNote icon={Info} title="What a snapshot holds">
          This project&rsquo;s tables, rows, indexes, constraints and row-level security policies, end users
          included. Not its stored files, Backenly account data, API keys, project configuration or function
          source. Use it to roll a project back or move it, not as a whole-server backup.
          {!CLOUD_CONTROL_PLANE && (
            <> Recovering the whole deployment is in account Settings, under Recovery.</>
          )}
        </KitNote>

        {message && (
          <KitNote tone={message.tone} icon={message.tone === 'success' ? CheckCircle2 : AlertTriangle}>
            {message.text}
          </KitNote>
        )}

        {loading ? (
          <div className={`overflow-hidden border ${EDGE} ${R_PANEL}`} aria-hidden>
            {[0, 1, 2].map((i) => (
              <div key={i} className={`flex items-center gap-4 px-4 py-3.5 ${i > 0 ? `border-t ${RULE}` : ''}`}>
                <Skeleton className="h-[12px] w-40" />
                <Skeleton className="ml-auto h-[12px] w-16" />
              </div>
            ))}
          </div>
        ) : snapshots.length === 0 ? (
          <div className={`border ${EDGE} ${R_PANEL}`}>
            <EmptyState
              icon={Camera}
              title="No snapshots yet"
              description="A snapshot reads the project's schema and rows as they are now. Take one before a risky change."
              action={
                <KitButton size="sm" icon={Camera} onClick={takeSnapshot} loading={taking}>
                  Take snapshot
                </KitButton>
              }
            />
          </div>
        ) : (
          <ul className={`overflow-hidden border ${EDGE} ${R_PANEL}`}>
            {snapshots.map((snapshot, i) => {
              const ok = snapshot.status === 'completed'
              return (
                <li
                  key={snapshot.id}
                  className={`flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 ${i > 0 ? `border-t ${RULE}` : ''}`}
                >
                  <StatusDot tone={ok ? 'operational' : 'failed'} label={ok ? 'Completed' : 'Failed'} className="w-[92px]" />
                  <div className="min-w-0 flex-1">
                    <p className="text-[13px] tabular-nums text-zinc-200">{formatWhen(snapshot.createdAt)}</p>
                    {snapshot.error && <p className="mt-0.5 text-[12px] text-rose-300/90">{snapshot.error}</p>}
                  </div>
                  <span className="text-[12.5px] tabular-nums text-zinc-500">{formatBytes(snapshot.sizeBytes)}</span>
                  {ok && (
                    <KitButton
                      size="sm"
                      variant="ghost"
                      icon={RotateCcw}
                      onClick={() => setConfirmRestore(snapshot)}
                      disabled={restoring !== null}
                      loading={restoring === snapshot.id}
                    >
                      Restore
                    </KitButton>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </div>

      <KitConfirmDialog
        open={!!confirmRestore}
        danger
        busy={restoring !== null}
        title="Restore this snapshot?"
        // Named plainly. Everything in the project's schema is replaced by
        // what the snapshot held, and rows written since are not merged in.
        description={
          confirmRestore
            ? `Every table in this project is replaced by the snapshot taken ${formatWhen(confirmRestore.createdAt)}. ` +
              `Rows written since then are not kept. The live schema is renamed aside first, so a restore ` +
              `that fails leaves the current data in place.`
            : undefined
        }
        confirmLabel="Restore"
        onConfirm={() => confirmRestore && restore(confirmRestore)}
        onCancel={() => {
          if (restoring === null) setConfirmRestore(null)
        }}
      />
    </div>
  )
}
