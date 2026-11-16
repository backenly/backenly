'use client'

/**
 * PROJECT DATABASE SNAPSHOTS
 *
 * One project's schema and rows, and deliberately not more. The panel says
 * what a snapshot leaves out before it offers to take one, because the failure
 * this product family is most prone to is someone seeing "Backup", concluding
 * the server is safe, and learning otherwise on the only day it matters.
 * So it is never labelled "Backup" alone. Self-hosted, it names its sibling:
 * deployment recovery lives in account Settings, under Recovery, and covers
 * the machine. Backenly Cloud has no Recovery page, so there it does not.
 *
 * Restoring replaces every table, and the confirm says so with the snapshot's
 * own time: a dialog asking "are you sure?" about an unnamed snapshot would be
 * a worse guard than none, because it looks like one.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { Camera, RotateCcw } from 'lucide-react'
import { KitButton, KitConfirmDialog } from '@/components/inspector/kit'
import { EmptyLine, Fact, Facts, Panel, Row, RowList, RowSkeleton, ROW_TITLE, Section } from '@/components/autonomy/rows'
import { ErrorRow, RefusedLine } from '@/components/console/states'
import { Time } from '@/components/console/Time'
import { formatTime } from '@/components/console/format'
import { FOCUS } from '@/components/console/tokens'
import { CLOUD_CONTROL_PLANE } from '@cloud/control-plane'
import { regionLabel } from '@/lib/regions'

interface Snapshot {
  id: string
  filename: string
  sizeBytes: number
  status: string
  error: string | null
  createdAt: string
}

/** A snapshot or restore of a project kept in another region, which runs there; the panel waits on it. */
interface RegionalJob {
  id: string
  type: 'workspace_backup' | 'workspace_restore'
  status: string
  error: string | null
  region: string | null
  createdAt: string
}

const OPEN = new Set(['regional_pending', 'regional_running'])
const POLL_MS = 5_000

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`
}

export function DatabaseSnapshots({ projectId, canWrite = false, canAdminister = false }: { projectId: string; canWrite?: boolean; canAdminister?: boolean }) {
  const [snapshots, setSnapshots] = useState<Snapshot[]>([])
  const [jobs, setJobs] = useState<RegionalJob[]>([])
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [taking, setTaking] = useState(false)
  const [restoring, setRestoring] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ tone: 'done' | 'refused'; text: string } | null>(null)
  const [confirmRestore, setConfirmRestore] = useState<Snapshot | null>(null)
  // The jobs this panel queued, so their outcome is said once they finish.
  const watching = useRef(new Set<string>())

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}/backup`, { credentials: 'include' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error)
      setSnapshots(data.data ?? [])
      const current: RegionalJob[] = data.jobs ?? []
      setJobs(current)
      setState('ready')
      for (const job of current) {
        if (!watching.current.has(job.id) || OPEN.has(job.status)) continue
        watching.current.delete(job.id)
        const where = job.region ? ` in ${regionLabel(job.region)}` : ''
        setNotice(
          job.status === 'completed'
            ? { tone: 'done', text: job.type === 'workspace_restore' ? `Restored${where}. Reload to see the current tables.` : `Snapshot taken${where}.` }
            : { tone: 'refused', text: job.error ?? (job.type === 'workspace_restore' ? 'The restore did not finish.' : 'The snapshot was not taken.') },
        )
      }
    } catch {
      // A list that could not be read says so; it is never "No snapshots yet".
      setState((s) => (s === 'ready' ? s : 'failed'))
    }
  }, [projectId])

  useEffect(() => {
    void load()
  }, [load])

  // A queued snapshot or restore runs in the project's region: check on it until it finishes.
  const waiting = jobs.filter((job) => OPEN.has(job.status))
  useEffect(() => {
    if (waiting.length === 0) return
    const timer = setInterval(() => void load(), POLL_MS)
    return () => clearInterval(timer)
  }, [waiting.length, load])

  function queued(data: { jobId?: string; region?: string }, what: 'snapshot' | 'restore') {
    if (data.jobId) watching.current.add(data.jobId)
    const where = data.region ? regionLabel(data.region) : 'the project’s region'
    setNotice({
      tone: 'done',
      text: what === 'snapshot' ? `Snapshot queued in ${where}, where this project’s data is kept.` : `Restore queued in ${where}. It runs there within a few minutes.`,
    })
  }

  async function takeSnapshot() {
    setTaking(true)
    setNotice(null)
    try {
      const res = await fetch(`/api/projects/${projectId}/backup`, { method: 'POST', credentials: 'include' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error ?? 'The snapshot was not taken.')
      if (res.status === 202 && data.queued) queued(data, 'snapshot')
      else setNotice({ tone: 'done', text: 'Snapshot taken.' })
      await load()
    } catch (err) {
      setNotice({ tone: 'refused', text: err instanceof Error ? err.message : 'The snapshot was not taken.' })
    } finally {
      setTaking(false)
    }
  }

  async function restore(snapshot: Snapshot) {
    setRestoring(snapshot.id)
    setNotice(null)
    try {
      const res = await fetch(`/api/projects/${projectId}/backup`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ backupId: snapshot.id }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error ?? 'The restore did not finish.')
      if (res.status === 202 && data.queued) queued(data, 'restore')
      else setNotice({ tone: 'done', text: 'Restored. Reload to see the current tables.' })
      await load()
    } catch (err) {
      setNotice({ tone: 'refused', text: err instanceof Error ? err.message : 'The restore did not finish.' })
    } finally {
      setRestoring(null)
      setConfirmRestore(null)
    }
  }

  const link = `rounded-[3px] text-zinc-200 underline decoration-white/25 underline-offset-[3px] transition-colors duration-150 hover:text-white hover:decoration-white/60 ${FOCUS}`
  const restoreWaiting = waiting.some((job) => job.type === 'workspace_restore')

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="w-full max-w-[880px] px-[16px] py-[24px] sm:px-[24px]">
        <Section
          id="snapshots"
          title="Snapshots"
          count={snapshots.length}
          aside={
            canWrite && state !== 'failed' ? (
              <KitButton size="sm" icon={Camera} onClick={() => void takeSnapshot()} loading={taking}>
                Take snapshot
              </KitButton>
            ) : undefined
          }
          description={
            <>
              Tables, rows, indexes, constraints and RLS policies, end users included. Not files, keys, settings or function code. To undo one change, use{' '}
              <Link href={`/app/projects/${projectId}/changes`} className={link}>
                History
              </Link>
              .{' '}
              {CLOUD_CONTROL_PLANE ? null : <>Recovering the whole deployment is in account Settings, under Recovery. </>}
              To download a copy, use{' '}
              <Link href={`/app/projects/${projectId}/connect?tab=postgres`} className={link}>
                Postgres on the Connect page
              </Link>
              .
            </>
          }
        >
          {notice && (notice.tone === 'refused' ? <RefusedLine className="mb-[10px]">{notice.text}</RefusedLine> : <p role="status" className="mb-[10px] text-[12.5px] leading-[18px] text-zinc-300">{notice.text}</p>)}
          <Panel>
            {state === 'failed' ? (
              <ErrorRow things="snapshots" stillWorks={canWrite ? 'Taking one still works.' : undefined} onRetry={() => void load()} />
            ) : state === 'loading' ? (
              <RowSkeleton rows={3} />
            ) : snapshots.length === 0 && waiting.length === 0 ? (
              <EmptyLine>No snapshots yet. Take one before a risky change.</EmptyLine>
            ) : (
              <RowList>
                {waiting.map((job) => (
                  <Row
                    key={job.id}
                    lead="glyph"
                    glyph="busy"
                    glyphLabel="Running"
                    busy
                    title={
                      <span className={ROW_TITLE}>
                        {job.type === 'workspace_restore' ? 'Restore running' : 'Snapshot running'}
                        {job.region ? ` in ${regionLabel(job.region)}` : ''}
                      </span>
                    }
                  >
                    <Facts className="!mt-[4px]">
                      <Fact>
                        Asked <Time iso={job.createdAt} />
                      </Fact>
                    </Facts>
                  </Row>
                ))}
                {snapshots.map((s) => {
                  const ok = s.status === 'completed'
                  return (
                    <Row
                      key={s.id}
                      lead="glyph"
                      glyph={ok ? 'done' : 'failed'}
                      glyphLabel={ok ? 'Completed' : 'Failed'}
                      title={
                        <span className={ROW_TITLE}>
                          <Time iso={s.createdAt} mode="dateTime" />
                        </span>
                      }
                      actions={
                        ok && canAdminister ? (
                          <KitButton
                            size="sm"
                            variant="ghost"
                            icon={RotateCcw}
                            onClick={() => setConfirmRestore(s)}
                            disabled={restoring !== null || restoreWaiting}
                            loading={restoring === s.id}
                          >
                            Restore
                          </KitButton>
                        ) : undefined
                      }
                    >
                      <Facts className="!mt-[4px]">
                        {ok && <Fact>{formatBytes(s.sizeBytes)}</Fact>}
                        {!ok && <Fact>Failed</Fact>}
                      </Facts>
                      {s.error && <RefusedLine className="mt-[6px]">{s.error}</RefusedLine>}
                    </Row>
                  )
                })}
              </RowList>
            )}
          </Panel>
        </Section>
      </div>

      <KitConfirmDialog
        open={!!confirmRestore}
        danger
        busy={restoring !== null}
        title="Restore to this snapshot?"
        description={
          confirmRestore
            ? `Every table in this project is replaced by the snapshot from ${formatTime(confirmRestore.createdAt, 'dateTime')}. Rows written since then are not kept. The live schema is set aside first, so a restore that fails leaves today's data in place.`
            : undefined
        }
        confirmLabel="Restore"
        onConfirm={() => confirmRestore && void restore(confirmRestore)}
        onCancel={() => restoring === null && setConfirmRestore(null)}
      />
    </div>
  )
}
