'use client'

/**
 * AutonomyGuardrailsSettings: the Autonomy page.
 *
 * Backenly's own loop and nothing else: whether it is checking, what waits on
 * you, what it found, what it changed (with the result and Undo), and the
 * mode. Restoring the state before any change is History.
 *
 * Approved by the founder on 2026-11-03 ("this is professional use this") and
 * improved in place on 2026-11-16, keeping that structure (the mode switch in
 * the header with its one-sentence meaning, headings above panels, one row
 * anatomy from components/autonomy/rows.tsx):
 *   - a heartbeat in the header, "◔ Checked 40 s ago" (LoopMark), the page's one violet
 *     mark, read from what the loop's last pass could check (/health
 *     `sensors`); and a Checks section with the daily scan's [Scan now] and the
 *     architecture review's [Look now];
 *   - every row leads with its state; a decision's result replaces the row's
 *     buttons instead of a banner;
 *   - "Changes Backenly made" is the one record of each fix (its statement,
 *     its result, Why, Undo), with the 30-day tally in its heading; the old
 *     Activity feed, which printed the same fix again, is its Full log;
 *   - no success note after a mode change: the sentence under the title
 *     changes, and is announced;
 *   - the page re-reads every 30 s and when the window regains focus, instead
 *     of a refresh icon per section;
 *   - people who cannot decide read one sentence where the buttons were
 *     (useProjectRole); rows carry anchors Overview links to.
 */

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { AlertTriangle } from 'lucide-react'
import { KitNote, PageHeader, Segmented, StatusGlyph, Skeleton } from '@/components/inspector/kit'
import { FOCUS, PAGE_GUTTER, PAGE_WIDTH } from '@/components/console/tokens'
import { formatTime, fullTime } from '@/components/console/format'
import { useNow } from '@/components/console/Time'
import { ErrorRow } from '@/components/console/states'
import { Panel, RowSkeleton, Section } from '@/components/autonomy/rows'
import { CLOUD_CONTROL_PLANE } from '@cloud/control-plane'
import { ReviewQueuePanel } from '@/components/ReviewQueuePanel'
import { DetectedFindingsPanel } from '@/components/DetectedFindingsPanel'
import { AppliedChangesPanel, type ActivityEntry, type AppliedChange, type Scoreboard } from '@/components/AppliedChangesPanel'
import { ArchitectureChangesPanel } from '@/components/autonomy/ArchitectureChangesPanel'
import { ChecksPanel, type HealthPulse } from '@/components/autonomy/ChecksPanel'
import { onArchitectureChange } from '@/components/autonomy/architecture-decisions'
import { useHashTarget } from '@/components/autonomy/useHashTarget'
import { sharedRead } from '@/lib/client/shared-read'
import { useProjectRole } from '@/lib/hooks/useProjectRole'
import { useWaitingCount } from '@/lib/hooks/useWaitingCount'
import type { ArchitectureChangeView } from '@/lib/evolution-engine/views'
import { LoopMark } from '@/components/console/LoopMark'

type Level = 'OFF' | 'CONSERVATIVE' | 'BALANCED' | 'AGGRESSIVE'

interface TrustReport {
  level: Level
  cap: Level
  /** User-facing plan label (Free / Pro / Enterprise) — the cap can't tell Pro from Enterprise. */
  plan: string
  scoreboard: Scoreboard
  recentActivity: ActivityEntry[]
  pendingApprovals: Array<{ id: string }>
  /** Optional on the wire so a response predating the field renders no rows
   *  rather than crashing the page. */
  appliedChanges?: AppliedChange[]
  /** Approved architecture changes and what became of them. Optional for the
   *  same reason: an older server sends none and the card does not render. */
  architectureChanges?: ArchitectureChangeView[]
  /**
   * Whether the loop is really applying repairs.
   *
   * Optional for the same reason as above. Absent means an older server, and
   * the page then says nothing rather than guessing - which is the honest
   * fallback, since guessing "live" is exactly the bug this field fixes.
   */
  executionMode?: {
    mode: 'live' | 'shadow'
    reason: 'live' | 'loop_off' | 'deployment_flag_off' | 'project_dial_off'
    explanation: string
    repairsAreApplied: boolean
  }
}

// TWO modes, not three (founder, 2026-07-18: "the off also not needed — just
// review only and auto pilot"). The dial is one decision: does Backenly apply
// safe fixes itself, or hold everything for you? Persisted values
// (OFF/CONSERVATIVE/BALANCED/AGGRESSIVE) stay valid across the DB, billing
// caps, and breaker logic in lib/autonomy/autonomy-level.ts — legacy BALANCED
// rows render as Autopilot; a legacy OFF row lights neither option and says
// "Off" in the header until the owner picks a mode.
//
// `sentence` is the mode's meaning under the title; `blurb` is the option's
// tooltip. Review-only never promises that every change waits: silent
// additive repairs still apply (maxAutoTier(CONSERVATIVE) is 0).
const LEVELS: { id: Level; label: string; sentence: string; blurb: string }[] = [
  {
    id: 'CONSERVATIVE',
    label: 'Review-only',
    sentence: 'Every visible fix waits for you. Indexes and API definitions still apply.',
    blurb: 'Visible changes wait for your one-click approval. Silent additive repairs (indexes, API definitions) still apply.',
  },
  {
    id: 'AGGRESSIVE',
    label: 'Autopilot',
    sentence: 'Backenly ships safe fixes on its own. Auth and destructive changes wait for you.',
    blurb: 'Backenly applies every safe fix on its own. Auth and destructive changes still wait for you.',
  },
]

const OFF_SENTENCE = 'Off. Backenly finds problems but fixes nothing until you pick a mode.'

const LEVEL_RANK: Record<Level, number> = { OFF: 0, CONSERVATIVE: 1, BALANCED: 2, AGGRESSIVE: 3 }

/** Legacy BALANCED renders as (and clicks through to) Autopilot. */
function displayLevel(level: Level): Level {
  return level === 'BALANCED' ? 'AGGRESSIVE' : level
}

function labelFor(level: Level): string {
  const norm = displayLevel(level)
  if (norm === 'OFF') return 'Off' // legacy rows only — no longer offered on the dial
  return LEVELS.find((l) => l.id === norm)?.label ?? level
}

// The upgrade target for a locked mode. Since 2026-07-18 every plan seeds the
// full dial, so no mode is plan-locked anymore. Kept as defence in depth: if a
// future plan re-caps the dial, the lock degrades to a Pro pointer instead of
// a dead button.
function nextPlanFor(level: Level): { name: string; cadence: string } | null {
  if (level === 'BALANCED' || level === 'AGGRESSIVE') {
    return { name: 'Pro', cadence: 'every-minute scans' }
  }
  return null
}

/** How often the page re-reads what it shows. */
const POLL_MS = 30_000

/**
 * A number that goes up every 30 s and whenever the window comes back into
 * view: each panel re-reads quietly when it changes.
 */
function useRefreshTick(): number {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const bump = () => setTick((t) => t + 1)
    const timer = setInterval(() => {
      if (!document.hidden) bump()
    }, POLL_MS)
    const onVisible = () => {
      if (!document.hidden) bump()
    }
    window.addEventListener('focus', bump)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', bump)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])
  return tick
}

/** What the loop's last pass could check, from GET /health (shared with the inbox's read). */
function useHealthPulse(projectId: string, tick: number): [HealthPulse | null, () => void] {
  const [pulse, setPulse] = useState<HealthPulse | null>(null)
  const [own, setOwn] = useState(0)
  useEffect(() => {
    let cancelled = false
    void sharedRead<{ data?: HealthPulse }>(`/api/projects/${projectId}/health`, { fresh: tick + own > 0 })
      .then((res) => {
        if (!cancelled && res.ok) setPulse(res.data?.data ?? {})
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [projectId, tick, own])
  return [pulse, () => setOwn((n) => n + 1)]
}

/** The header's one fact: when Backenly last checked, or why it is not repairing. */
function Heartbeat({ shadow, level, pulse }: { shadow: boolean; level: Level | null; pulse: HealthPulse | null }) {
  const now = useNow()
  // Shadow wins over the dial. The dial is what the owner ASKED for; the mode
  // is what the deployment is doing, and rendering the ask as though it were
  // the outcome is what let a backend read "Autopilot" while the loop could
  // not apply a single fix.
  const badge = shadow
    ? { label: 'Watching only', glyph: 'paused' as const }
    : level === 'OFF'
      ? { label: 'Off', glyph: 'paused' as const }
      : null
  if (badge) {
    return (
      <span className="inline-flex items-center gap-[6px] text-[13px] text-zinc-300">
        <StatusGlyph state={badge.glyph} label="" />
        {badge.label}
      </span>
    )
  }
  if (!pulse) return <Skeleton className="h-[12px] w-[112px]" />
  const at = pulse.sensors?.at ?? pulse.lastReconciledAt ?? null
  return (
    <span className="inline-flex items-center gap-[6px] text-[13px] text-zinc-300">
      {/* The page's one violet mark: the loop's ring, filling toward its next pass. */}
      <LoopMark lastPassAt={at} state={at ? 'running' : 'still'} />
      {at ? (
        <time dateTime={at} title={fullTime(at)} className="tabular-nums">
          Checked {formatTime(at, 'ago', { now: now ?? Date.now() })}
        </time>
      ) : (
        'Not checked yet'
      )}
    </span>
  )
}

export function AutonomyGuardrailsSettings({ projectId }: { projectId: string }) {
  const [data, setData] = useState<TrustReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [retrying, setRetrying] = useState(false)
  const [saving, setSaving] = useState<Level | null>(null)
  const [gate, setGate] = useState<string | null>(null)
  const [readAt, setReadAt] = useState<string | null>(null)
  const role = useProjectRole(projectId)
  const waiting = useWaitingCount(projectId)
  const tick = useRefreshTick()
  const [pulse, rereadPulse] = useHealthPulse(projectId, tick)

  const fetchReport = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}/autonomy`, { credentials: 'include' })
      if (!res.ok) throw new Error('fetch failed')
      setData(await res.json())
      setError(false)
      setReadAt(new Date().toISOString())
    } catch {
      // A failed re-read keeps what is on screen; a failed first read says so.
      setError(true)
    } finally {
      setLoading(false)
      setRetrying(false)
    }
  }, [projectId])

  useEffect(() => {
    void fetchReport()
  }, [fetchReport, tick])
  // An architecture change decided in the queue moves onto the card below.
  useEffect(() => onArchitectureChange('card', () => { void fetchReport() }), [fetchReport])

  useHashTarget(!!data && !role.loading)

  const setLevel = async (level: Level) => {
    if (!data || level === data.level || saving) return
    if (LEVEL_RANK[level] > LEVEL_RANK[data.cap]) {
      const next = nextPlanFor(level)
      setGate(next ? `${labelFor(level)} is included in ${next.name} (${next.cadence}).` : `Your plan's ceiling is ${labelFor(data.cap)}.`)
      return
    }
    setGate(null)
    setSaving(level)
    try {
      const res = await fetch(`/api/projects/${projectId}/autonomy`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ level }),
      })
      // No success note: the sentence under the title changes, and is announced.
      if (res.ok) await fetchReport()
      else {
        const j = await res.json().catch(() => ({}))
        setGate(j?.error || 'The mode did not change. Try again in a moment.')
      }
    } finally {
      setSaving(null)
    }
  }

  const shadow = data?.executionMode?.mode === 'shadow'
  const current = data ? displayLevel(data.level) : null
  const sentence = current === 'OFF' ? OFF_SENTENCE : LEVELS.find((l) => l.id === current)?.sentence

  const modeControl = data ? (
    role.canWrite ? (
      <div className="flex flex-wrap items-center gap-2.5">
        <span className="text-[12.5px] text-faint">Mode</span>
        <Segmented<Level>
          label="Autonomy mode"
          value={current as Level}
          onChange={(l) => void setLevel(l)}
          options={LEVELS.map((l) => {
            const locked = LEVEL_RANK[l.id] > LEVEL_RANK[data.cap]
            const next = locked ? nextPlanFor(l.id) : null
            return {
              value: l.id,
              title: locked && next ? `${l.label} is included in ${next.name} (${next.cadence}).` : l.blurb,
              label: saving === l.id ? `${l.label}…` : l.label,
            }
          })}
        />
      </div>
    ) : (
      // People who cannot change the mode read it.
      <p className="text-[12.5px] text-faint">
        Mode <span className="ml-1.5 text-zinc-200">{labelFor(data.level)}</span>
      </p>
    )
  ) : undefined

  const header = (
    <PageHeader
      flush
      title="Autonomy"
      meta={data || pulse ? <Heartbeat shadow={shadow} level={data?.level ?? null} pulse={pulse} /> : undefined}
      description={
        sentence ? (
          <span aria-live="polite">{sentence}</span>
        ) : undefined
      }
      actions={modeControl}
    />
  )

  if (loading || role.loading) {
    return (
      <div className={`${PAGE_WIDTH} ${PAGE_GUTTER} pb-16`}>
        {header}
        <div className="space-y-9">
          {['Waiting on you', 'Changes Backenly made'].map((t) => (
            <Section key={t} id={`autonomy-skeleton-${t}`} title={t}>
              <Panel>
                <RowSkeleton rows={2} />
              </Panel>
            </Section>
          ))}
        </div>
      </div>
    )
  }

  if (!data) {
    return (
      <div className={`${PAGE_WIDTH} ${PAGE_GUTTER} pb-16`}>
        {header}
        <Panel>
          <ErrorRow
            things="Autonomy"
            stillWorks="Your guardrails still apply."
            retrying={retrying}
            onRetry={() => {
              setRetrying(true)
              void fetchReport()
            }}
          />
        </Panel>
      </div>
    )
  }

  const reread = () => {
    void fetchReport()
    rereadPulse()
  }

  return (
    <div className={`${PAGE_WIDTH} ${PAGE_GUTTER} pb-16`}>
      {header}
      <div className="space-y-9">
        {gate && (
          <p role="status" className="-mt-4 text-[12.5px] leading-[18px] text-faint">
            {gate}{' '}
            {CLOUD_CONTROL_PLANE && (
              <Link href="/app/billing" className={`rounded-[3px] font-medium text-zinc-200 underline decoration-white/25 underline-offset-2 hover:text-white ${FOCUS}`}>
                Compare plans
              </Link>
            )}
          </p>
        )}
        {error && readAt && (
          <ErrorRow things="Autonomy" staleAt={readAt} onRetry={() => void fetchReport()} className="-mt-4 !border-b-0 !px-0" />
        )}

        {/* ── Shadow is stated, not implied ────────────────────────────
             With live execution off the loop evaluates every invariant,
             decides what it would repair, writes an audit row that looks like
             work, and applies nothing. Placed above the queues deliberately:
             everything below it is a list of things that are NOT being acted
             on, and reading those first gives exactly the wrong impression. ── */}
        {data.executionMode && !data.executionMode.repairsAreApplied && (
          <KitNote tone="warn" icon={AlertTriangle} title="Watching, not repairing">
            {data.executionMode.explanation}
          </KitNote>
        )}

        <ReviewQueuePanel projectId={projectId} refreshKey={tick} canDecideAgent={role.canAdminister} canFix={role.canWrite} />
        <DetectedFindingsPanel projectId={projectId} level={data.level} refreshKey={tick} canFix={role.canWrite} />

        <AppliedChangesPanel
          projectId={projectId}
          changes={data.appliedChanges ?? []}
          scoreboard={data.scoreboard}
          activity={data.recentActivity}
          onReverted={reread}
          canUndo={role.canWrite}
          canUndoSchema={role.canAdminister}
        />

        {/* Renders nothing until a person has approved an architecture change. */}
        <ArchitectureChangesPanel projectId={projectId} changes={data.architectureChanges ?? []} onChanged={reread} />

        <ChecksPanel
          projectId={projectId}
          health={pulse}
          waiting={waiting.total}
          canScan={role.canWrite}
          canLook={role.canAdminister}
          onScanned={reread}
          onLooked={reread}
        />
      </div>
    </div>
  )
}
