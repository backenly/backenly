'use client'

/**
 * AutonomyGuardrailsSettings: the Autonomy page.
 *
 * THE one autonomy surface (2026-07-18): what's waiting on you right now
 * (ReviewQueuePanel, folded in from the deleted /review-queue page), the mode,
 * what is always gated, a trust scoreboard, the changes Backenly made with
 * their way back and the recent-activity feed. Restoring the state before any
 * change is History.
 *
 * Rebuilt 2026-10-02 on the console kit, and again 2026-11-03 so it reads as
 * one product rather than a stack of explained cards: the mode is a switch in
 * the header with its one-sentence meaning as the page's lede, every section
 * carries its heading above its panel, every list uses the same row
 * (components/autonomy/rows.tsx), and the activity feed shows what Backenly
 * did in words, with the loop's own bookkeeping folded away. The upgrade link
 * goes to Billing, which exists only on Cloud.
 */

import { useEffect, useState, useCallback } from 'react'
import Link from 'next/link'
import { Activity, AlertTriangle, CheckCircle2, Layers, Lock, RefreshCw, Undo2, Wrench } from 'lucide-react'
import {
  EmptyState,
  KitButton,
  KitCard,
  KitNote,
  PageHeader,
  Segmented,
  Skeleton,
  Spinner,
  StatusDot,
  type StatusTone,
} from '@/components/inspector/kit'
import { FOCUS, FOCUS_INSET, PAGE_GUTTER, PAGE_WIDTH } from '@/components/console/tokens'
import { EmptyLine, Panel, Section } from '@/components/autonomy/rows'
import { CLOUD_CONTROL_PLANE } from '@cloud/control-plane'
import { ReviewQueuePanel } from '@/components/ReviewQueuePanel'
import { DetectedFindingsPanel } from '@/components/DetectedFindingsPanel'
import { AppliedChangesPanel, type AppliedChange } from '@/components/AppliedChangesPanel'
import { MaintenanceLadderPanel } from '@/components/MaintenanceLadderPanel'
import { ArchitectureChangesPanel } from '@/components/autonomy/ArchitectureChangesPanel'
import { ArchitectureLookNow } from '@/components/autonomy/ArchitectureLookNow'
import { onArchitectureChange } from '@/components/autonomy/architecture-decisions'
import type { ArchitectureChangeView } from '@/lib/evolution-engine/views'

type Level = 'OFF' | 'CONSERVATIVE' | 'BALANCED' | 'AGGRESSIVE'

interface TrustReport {
  level: Level
  cap: Level
  /** User-facing plan label (Free / Pro / Enterprise) — the cap can't tell Pro from Enterprise. */
  plan: string
  scoreboard: {
    windowDays: number
    autonomousFixes: number
    rollbacks: number
    verifiedRate: number | null
  }
  recentActivity: Array<{ at: string; action: string; kind: string; summary: string; repeat?: number }>
  pendingApprovals: Array<{ id: string }>
  /** Optional on the wire so a response predating the field renders no panel
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
// rows render as Autopilot; a legacy OFF row lights neither card and shows
// "Off" in the header until the owner picks a mode.
const LEVELS: { id: Level; label: string; blurb: string }[] = [
  { id: 'CONSERVATIVE', label: 'Review-only', blurb: 'Visible changes wait for your one-click approval. Silent additive repairs (indexes, API definitions) still apply.' },
  {
    id: 'AGGRESSIVE',
    label: 'Autopilot',
    blurb: 'Backenly applies every safe fix on its own. Auth and destructive changes still wait for you.',
  },
]

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
// future plan re-caps the dial, the lock UI degrades to a Pro upsell instead
// of a dead button.
function nextPlanFor(level: Level): { name: string; cadence: string } | null {
  if (level === 'BALANCED' || level === 'AGGRESSIVE') {
    return { name: 'Pro', cadence: 'every-minute scans' }
  }
  return null
}

function timeAgo(iso: string): string {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 5) return 'just now'
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

// ── Shell ─────────────────────────────────────────────────────────────────────

function Shell({
  level,
  shadow,
  description = 'Choose what Backenly may fix on its own and what waits for your approval. Auth, destructive and irreversible changes always wait, in every mode.',
  actions,
  children,
}: {
  level?: Level
  shadow?: boolean
  /** The mode's meaning in one sentence, once the mode is known. */
  description?: string
  /** The mode switch. */
  actions?: React.ReactNode
  children: React.ReactNode
}) {
  // Shadow wins over the dial. The dial is what the owner ASKED for; the mode
  // is what the deployment is doing, and rendering the ask as though it were
  // the outcome is what let a backend read "Autopilot" while the loop could
  // not apply a single fix.
  const badge: { label: string; tone: StatusTone } | undefined = shadow
    ? { label: 'Shadow', tone: 'attention' }
    : level === 'OFF'
      // The mode switch in the header says which mode is on; a badge says so
      // only for a legacy OFF row, which lights neither option.
      ? { label: labelFor(level), tone: 'paused' }
      : undefined
  return (
    <div className={`${PAGE_WIDTH} ${PAGE_GUTTER} pb-16`}>
      <PageHeader
        className="!px-0"
        title="Autonomy"
        meta={badge ? <StatusDot tone={badge.tone} label={badge.label} /> : undefined}
        description={description}
        actions={actions}
      />
      {children}
    </div>
  )
}

export function AutonomyGuardrailsSettings({ projectId }: { projectId: string }) {
  const [data, setData] = useState<TrustReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [saving, setSaving] = useState<Level | null>(null)
  const [banner, setBanner] = useState<{ tone: 'ok' | 'gate'; text: string } | null>(null)
  const [showAll, setShowAll] = useState(false)

  const fetchReport = useCallback(async () => {
    setError(false)
    try {
      const res = await fetch(`/api/projects/${projectId}/autonomy`, { credentials: 'include' })
      if (!res.ok) throw new Error('fetch failed')
      setData(await res.json())
    } catch {
      setError(true)
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => {
    fetchReport()
  }, [fetchReport])
  // An architecture change decided in the queue moves onto the card below.
  useEffect(() => onArchitectureChange('card', () => { void fetchReport() }), [fetchReport])

  const setLevel = async (level: Level) => {
    if (!data || level === data.level || saving) return
    if (LEVEL_RANK[level] > LEVEL_RANK[data.cap]) {
      const next = nextPlanFor(level)
      setBanner({
        tone: 'gate',
        text: next
          ? `${labelFor(level)} is included in ${next.name} (${next.cadence}).`
          : `Your plan's ceiling is ${labelFor(data.cap)}.`,
      })
      setTimeout(() => setBanner(null), 6000)
      return
    }
    setSaving(level)
    try {
      const res = await fetch(`/api/projects/${projectId}/autonomy`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ level }),
      })
      if (res.ok) {
        await fetchReport()
        setBanner({ tone: 'ok', text: `Autonomy mode set to ${labelFor(level)}.` })
      }
    } finally {
      setSaving(null)
      setTimeout(() => setBanner(null), 5000)
    }
  }

  if (loading) {
    return (
      <Shell>
        <div className="space-y-4" aria-hidden>
          <Skeleton className="h-[120px] w-full rounded-[10px]" />
          <Skeleton className="h-[180px] w-full rounded-[10px]" />
          <Skeleton className="h-[88px] w-full rounded-[10px]" />
        </div>
      </Shell>
    )
  }

  if (error || !data) {
    return (
      <Shell>
        <KitCard>
          <EmptyState
            icon={AlertTriangle}
            title="Autonomy settings are unavailable"
            description="The autonomy service did not answer. Nothing has changed, and your guardrails are still enforced."
            action={
              <KitButton
                icon={RefreshCw}
                onClick={() => {
                  setLoading(true)
                  fetchReport()
                }}
              >
                Try again
              </KitButton>
            }
          />
        </KitCard>
      </Shell>
    )
  }

  const verified = data.scoreboard.verifiedRate
  const capLabel = labelFor(data.cap)
  const upgradeHref = '/app/billing'
  const current = displayLevel(data.level)
  const blurb = LEVELS.find((l) => l.id === current)?.blurb

  const modeSwitch = (
    <div className="flex flex-wrap items-center gap-2.5">
      <span id="autonomy-mode" className="text-[12.5px] text-faint">Mode</span>
      <Segmented<Level>
        label="Autonomy mode"
        value={current}
        onChange={(l) => void setLevel(l)}
        options={LEVELS.map((l) => {
          const locked = LEVEL_RANK[l.id] > LEVEL_RANK[data.cap]
          const next = locked ? nextPlanFor(l.id) : null
          return {
            value: l.id,
            icon: locked ? Lock : undefined,
            title: locked && next ? `${l.label} is included in ${next.name} (${next.cadence}).` : l.blurb,
            label: saving === l.id ? <><Spinner className="h-3 w-3" /> {l.label}</> : l.label,
          }
        })}
      />
    </div>
  )

  // The loop's own bookkeeping ("autonomy investigation", written by a step
  // with no sentence of its own) is folded away by default; what Backenly did,
  // in words, is the feed.
  const isBookkeeping = (a: TrustReport['recentActivity'][number]) =>
    (a.kind === 'other' || !a.kind) && a.summary.trim().toLowerCase() === a.action.replace(/[_-]+/g, ' ').trim().toLowerCase()
  const said = data.recentActivity.filter((a) => !isBookkeeping(a))
  const folded = data.recentActivity.length - said.length
  const activity = showAll ? data.recentActivity : said
  const stats = [
    { label: 'Fixed on its own', value: data.scoreboard.autonomousFixes.toLocaleString() },
    { label: 'Rolled back', value: data.scoreboard.rollbacks.toLocaleString() },
    { label: 'Verified after the fix', value: verified === null ? '—' : `${Math.round(verified * 100)}%` },
  ]
  const anyStats = data.scoreboard.autonomousFixes > 0 || data.scoreboard.rollbacks > 0 || verified !== null

  return (
    <Shell
      level={data.level}
      shadow={data.executionMode?.mode === 'shadow'}
      description={blurb ? `${blurb}${current === 'CONSERVATIVE' ? ' Auth, destructive and irreversible changes always wait.' : ''}` : undefined}
      actions={modeSwitch}
    >
      <div className="space-y-9">
        {banner && (
          <div role="status" aria-live="polite">
            <KitNote
              tone={banner.tone === 'ok' ? 'success' : 'info'}
              icon={banner.tone === 'ok' ? CheckCircle2 : Lock}
              actions={
                banner.tone === 'gate' && CLOUD_CONTROL_PLANE ? (
                  <Link href={upgradeHref} className={`text-[12.5px] font-medium text-zinc-100 hover:underline ${FOCUS}`}>
                    Compare plans
                  </Link>
                ) : undefined
              }
            >
              {banner.text}
            </KitNote>
          </div>
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

        {/* ── The one queue, in two halves: held for you, and detected ── */}
        <ReviewQueuePanel projectId={projectId} />
        <DetectedFindingsPanel projectId={projectId} level={data.level} />

        {/* A structural ladder renders nothing unless one is actually waiting. */}
        <MaintenanceLadderPanel projectId={projectId} />

        {/* ── Changes Backenly made, each with its way back ─────────── */}
        <AppliedChangesPanel projectId={projectId} changes={data.appliedChanges ?? []} onReverted={fetchReport} />

        {/* Renders nothing until a person has approved an architecture change. */}
        <ArchitectureChangesPanel
          projectId={projectId}
          changes={data.architectureChanges ?? []}
          onChanged={fetchReport}
        />

        {/* When Backenly last looked for architecture changes, and a look now. */}
        <ArchitectureLookNow projectId={projectId} onLooked={fetchReport} />

        {/* ── Activity: what Backenly did lately, and its track record ── */}
        <Section
          id="autonomy-activity"
          title="Activity"
          aside={<span className="text-[12.5px] tabular-nums text-faint">Last {data.scoreboard.windowDays} days</span>}
        >
          <Panel>
            {anyStats && (
              <dl className="grid grid-cols-3 divide-x divide-white/[0.06] border-b border-white/[0.06]">
                {stats.map((st) => (
                  <div key={st.label} className="px-5 py-3.5">
                    <dt className="text-[12px] leading-[16px] text-faint">{st.label}</dt>
                    <dd className="mt-1 text-[18px] font-semibold leading-[24px] tabular-nums tracking-[-0.01em] text-zinc-50">{st.value}</dd>
                  </div>
                ))}
              </dl>
            )}
            {activity.length === 0 ? (
              <EmptyLine icon={Activity}>Nothing yet. Backenly has not needed to act.</EmptyLine>
            ) : (
              <ul
                tabIndex={0}
                aria-label="Recent guardrail actions"
                className={`max-h-[420px] divide-y divide-white/[0.06] overflow-y-auto ${FOCUS_INSET}`}
              >
                {activity.map((a, i) => {
                  const Icon = KIND_ICON[a.kind] ?? Activity
                  return (
                    <li key={i} className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-6 px-5 py-3">
                      <span className="flex min-w-0 items-start gap-3">
                        <Icon className="mt-[3px] h-3.5 w-3.5 flex-shrink-0 text-zinc-500" strokeWidth={1.75} aria-hidden />
                        <span className="min-w-0 text-[13px] leading-[20px] text-zinc-300 [overflow-wrap:anywhere]">
                          {a.summary}
                          {/* An unresolved finding is re-escalated every tick, so
                              one decision you haven't made writes one row a
                              minute. Folded server-side; the count keeps the
                              fold honest rather than a truncation. */}
                          {(a.repeat ?? 1) > 1 && <span className="ml-1.5 tabular-nums text-faint">{a.repeat} times</span>}
                        </span>
                      </span>
                      <span className="pt-px text-[12.5px] tabular-nums text-faint">{timeAgo(a.at)}</span>
                    </li>
                  )
                })}
              </ul>
            )}
            {folded > 0 && (
              <button
                type="button"
                onClick={() => setShowAll((v) => !v)}
                aria-expanded={showAll}
                className={`block w-full border-t border-white/[0.06] px-5 py-2.5 text-left text-[12.5px] text-faint transition-colors hover:text-zinc-200 ${FOCUS_INSET}`}
              >
                {showAll ? 'Hide system events' : `Show ${folded} system ${folded === 1 ? 'event' : 'events'}`}
              </button>
            )}
          </Panel>
          {data.cap !== 'AGGRESSIVE' && CLOUD_CONTROL_PLANE && (
            <p className="mt-3 text-[12.5px] text-faint">
              Your plan goes up to {capLabel}.{' '}
              <Link href={upgradeHref} className="font-medium text-zinc-300 underline-offset-2 hover:underline">
                Compare plans
              </Link>
            </p>
          )}
        </Section>
      </div>
    </Shell>
  )
}

/** An activity row's mark: what kind of thing Backenly did. */
const KIND_ICON: Record<string, typeof Activity> = {
  rollback: Undo2,
  architecture: Layers,
  auto_fix: Wrench,
  fix: Wrench,
  repair: Wrench,
  escalation: AlertTriangle,
}
