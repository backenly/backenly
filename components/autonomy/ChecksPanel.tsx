'use client'

/**
 * Checks: proof that Backenly is looking, on data and routes that exist.
 *
 *   Every minute   27 of 27 checks ran 40 s ago. 1 open, 1 waiting on you.
 *   Every day      Daily scan ran today at 3:02 AM.               [Scan now]
 *   Every day      Architecture review ran 3 h ago.               [Look now]
 *
 * The page never said when Backenly last checked, although /health returns
 * `sensors` (what the loop's last pass could check) and `lastCheckedAt` (the
 * daily scan). This is the honest replacement for Overview's old loop ring.
 *
 * "Scan now" calls PATCH /health, which runs the scan synchronously and keeps
 * a budget of one a project every ten minutes (the server says when the next
 * may start, and that sentence is shown as it is). "Look now" is
 * ArchitectureLookNow, drawn as the third line.
 */

import { useState } from 'react'
import { KitButton } from '@/components/inspector/kit'
import { formatTime, fullTime } from '@/components/console/format'
import { useNow } from '@/components/console/Time'
import { Panel, Section } from '@/components/autonomy/rows'
import { ArchitectureLookNow } from '@/components/autonomy/ArchitectureLookNow'
import { CheckLine } from '@/components/autonomy/CheckLine'

/** The part of GET /health this section reads. */
export interface HealthPulse {
  lastCheckedAt?: string | null
  lastReconciledAt?: string | null
  actionableTotal?: number
  needsAttention?: number
  sensors?: {
    at: string
    total: number
    ran: number
    errored: Array<{ id: string; title: string; error: string }>
    disabled: Array<{ id: string; title: string; reason: string }>
  } | null
}

/** "today at 3:02 AM", "yesterday at 3:02 AM", "on Nov 14 at 3:02 AM". */
function when(iso: string, now: number | null): string {
  const day = formatTime(iso, 'day', { now: now ?? Date.now() })
  const clock = formatTime(iso, 'clock')
  if (day === 'Today') return `today at ${clock}`
  if (day === 'Yesterday') return `yesterday at ${clock}`
  return `on ${formatTime(iso, 'date')} at ${clock}`
}

export function ChecksPanel({
  projectId,
  health,
  waiting,
  canScan,
  canLook,
  onScanned,
  onLooked,
}: {
  projectId: string
  /** Null while /health has not answered. */
  health: HealthPulse | null
  /** What waits on a person (useWaitingCount), when counted. */
  waiting: number | null
  /** A scan takes a developer or above (PATCH /health's floor). */
  canScan: boolean
  /** A look takes an admin (the architecture route's floor). */
  canLook: boolean
  onScanned: () => void
  onLooked: () => void
}) {
  const now = useNow()
  const [scanning, setScanning] = useState(false)
  const [scanNote, setScanNote] = useState<{ text: string; refused: boolean } | null>(null)

  const scan = async () => {
    setScanning(true)
    setScanNote(null)
    try {
      const res = await fetch(`/api/projects/${projectId}/health`, { method: 'PATCH', credentials: 'include' })
      const j = await res.json().catch(() => ({} as any))
      if (res.status === 429) {
        // Not a failure: the server's own words say when the next may start.
        setScanNote({ text: j?.error || 'Backenly scanned this project in the last 10 minutes.', refused: false })
      } else if (!res.ok || !j?.success) {
        setScanNote({ text: j?.error || 'The scan did not run. Try again in a moment.', refused: true })
      } else if (j?.data?.notScanned) {
        setScanNote({ text: 'This project is checked by its own region on that region’s schedule.', refused: false })
      } else {
        const open = Math.max(0, (j?.data?.actionableTotal ?? 0) - (j?.data?.needsAttention ?? 0))
        setScanNote({ text: open > 0 ? `Scanned just now. ${open} open.` : 'Scanned just now. Nothing new.', refused: false })
        onScanned()
      }
    } catch {
      setScanNote({ text: 'Network error. Check your connection and try again.', refused: true })
    } finally {
      setScanning(false)
    }
  }

  const sensors = health?.sensors ?? null
  const loopAt = sensors?.at ?? health?.lastReconciledAt ?? null
  const open =
    typeof health?.actionableTotal === 'number' && typeof health?.needsAttention === 'number'
      ? Math.max(0, health.actionableTotal - health.needsAttention)
      : null
  const found = [open !== null && open > 0 ? `${open} open` : null, waiting && waiting > 0 ? `${waiting} waiting on you` : null].filter(Boolean)

  return (
    <Section id="autonomy-checks" title="Checks">
      <Panel>
        <ul className="divide-y divide-white/[0.06]">
          <CheckLine cadence="Every minute">
            {health === null ? (
              'Reading the last check…'
            ) : loopAt ? (
              <>
                {sensors ? `${sensors.ran} of ${sensors.total} checks ran ` : 'Checked '}
                <time dateTime={loopAt} title={fullTime(loopAt)}>
                  {formatTime(loopAt, 'ago', { now: now ?? Date.now() })}
                </time>
                . {found.length > 0 ? `${found.join(', ')}.` : 'Nothing found.'}
                {sensors && sensors.errored.length > 0 && (
                  <span className="mt-1 block text-[12.5px] leading-[18px] text-zinc-50">
                    {sensors.errored.length === 1 ? '1 check could not run: ' : `${sensors.errored.length} checks could not run: `}
                    {sensors.errored.map((e) => e.title).join(', ')}.
                  </span>
                )}
              </>
            ) : (
              'Not checked yet. Backenly starts checking once the backend has a table.'
            )}
          </CheckLine>
          <CheckLine
            cadence="Every day"
            action={
              canScan ? (
                <KitButton variant="secondary" size="sm" loading={scanning} onClick={() => void scan()}>
                  Scan now
                </KitButton>
              ) : undefined
            }
            note={scanNote?.text}
            noteTone={scanNote?.refused ? 'refused' : 'faint'}
          >
            {health?.lastCheckedAt ? (
              <>
                Daily scan ran{' '}
                <time dateTime={health.lastCheckedAt} title={fullTime(health.lastCheckedAt)}>
                  {when(health.lastCheckedAt, now)}
                </time>
                .
              </>
            ) : (
              'Daily scan has not run yet.'
            )}
          </CheckLine>
          <ArchitectureLookNow as="li" projectId={projectId} onLooked={onLooked} canLook={canLook} />
        </ul>
      </Panel>
    </Section>
  )
}
