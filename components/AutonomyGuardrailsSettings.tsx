'use client'

/**
 * AutonomyGuardrailsSettings: the Autonomy page.
 *
 * THE one autonomy surface (2026-07-18): what's waiting on you right now
 * (ReviewQueuePanel, folded in from the deleted /review-queue page), the mode,
 * what is always gated, a trust scoreboard, the changes Backenly made with
 * their way back, the recent-activity feed and restore points.
 *
 * Rebuilt 2026-10-02 on the console kit: a document page with the standard
 * header, the mode as two radio cards, the scoreboard as one stat strip and
 * every section as a hairline panel. The upgrade link goes to Billing, which
 * exists only on Cloud, instead of a Settings tab that never existed.
 */

import { useEffect, useState, useCallback } from 'react'
import Link from 'next/link'
import { Activity, AlertTriangle, CheckCircle2, Lock, RefreshCw, ShieldCheck, Undo2 } from 'lucide-react'
import {
  EmptyState,
  KIT,
  KitButton,
  KitCard,
  KitCardHeader,
  KitNote,
  PageHeader,
  Skeleton,
  Spinner,
  Stat,
  StatStrip,
  StatusDot,
  type StatusTone,
} from '@/components/inspector/kit'
import { EDGE, FOCUS, PAGE_GUTTER, PAGE_WIDTH, RULE, R_PANEL } from '@/components/console/tokens'
import { CLOUD_CONTROL_PLANE } from '@cloud/control-plane'
import { VersionHistory } from '@/components/workspace/VersionHistory'
import { ReviewQueuePanel } from '@/components/ReviewQueuePanel'
import { DetectedFindingsPanel } from '@/components/DetectedFindingsPanel'
import { AppliedChangesPanel, type AppliedChange } from '@/components/AppliedChangesPanel'
import { MaintenanceLadderPanel } from '@/components/MaintenanceLadderPanel'

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
  { id: 'CONSERVATIVE', label: 'Review-only', blurb: 'Every change waits for your one-click approval.' },
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

function Shell({ level, shadow, children }: { level?: Level; shadow?: boolean; children: React.ReactNode }) {
  // Shadow wins over the dial. The dial is what the owner ASKED for; the mode
  // is what the deployment is doing, and rendering the ask as though it were
  // the outcome is what let a backend read "Autopilot" while the loop could
  // not apply a single fix.
  const badge: { label: string; tone: StatusTone } | undefined = shadow
    ? { label: 'Shadow', tone: 'attention' }
    : level
      ? { label: labelFor(level), tone: level === 'OFF' ? 'paused' : 'operational' }
      : undefined
  return (
    <div className={`${PAGE_WIDTH} ${PAGE_GUTTER} pb-16`}>
      <PageHeader
        className="!px-0"
        title="Autonomy"
        meta={badge ? <StatusDot tone={badge.tone} label={badge.label} /> : undefined}
        description="Your backend keeps working when nobody is asking. Choose what Backenly may change on its own and what always waits for you. The safety floor never moves, in any mode."
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

  return (
    <Shell level={data.level} shadow={data.executionMode?.mode === 'shadow'}>
      <div className="space-y-6">
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

        {/* ── Mode ───────────────────────────────────────────────── */}
        <section aria-labelledby="autonomy-mode" className={`overflow-hidden border ${EDGE} ${R_PANEL} ${KIT.surface}`}>
          <div className="flex flex-wrap items-start justify-between gap-3 px-5 pb-4 pt-5 sm:px-6">
            <div>
              <h2 id="autonomy-mode" className="text-[15px] font-semibold leading-[22px] tracking-[-0.012em] text-zinc-50">
                Mode
              </h2>
              <p className="mt-1 text-[13px] leading-[20px] text-zinc-400">
                How much Backenly may do between your visits.
              </p>
            </div>
            <p className="text-[12.5px] text-zinc-500">
              {data.plan} plan <span className="text-zinc-700">·</span> up to{' '}
              <span className="text-zinc-300">{capLabel}</span>
            </p>
          </div>

          <div role="radiogroup" aria-labelledby="autonomy-mode" className="grid grid-cols-1 gap-3 px-5 pb-5 sm:grid-cols-2 sm:px-6">
            {LEVELS.map((l) => {
              const active = displayLevel(data.level) === l.id
              const busy = saving === l.id
              const locked = LEVEL_RANK[l.id] > LEVEL_RANK[data.cap]
              const next = locked ? nextPlanFor(l.id) : null
              return (
                <button
                  key={l.id}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  disabled={saving !== null || locked}
                  onClick={() => setLevel(l.id)}
                  title={locked && next ? `${l.label} is included in ${next.name} (${next.cadence}).` : undefined}
                  className={`relative rounded-[9px] border p-4 text-left transition-[border-color,background-color] duration-150 disabled:cursor-not-allowed ${FOCUS} ${
                    active
                      ? 'border-white/[0.22] bg-white/[0.05] shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]'
                      : locked
                        ? 'border-white/[0.06] bg-white/[0.01] opacity-60'
                        : 'border-white/[0.08] bg-white/[0.015] hover:border-white/[0.16] hover:bg-white/[0.03]'
                  }`}
                >
                  <span className="flex items-center justify-between gap-3">
                    <span className="flex items-center gap-2.5">
                      <span
                        aria-hidden
                        className={`flex h-[16px] w-[16px] items-center justify-center rounded-full border ${
                          active ? 'border-zinc-100' : 'border-white/25'
                        }`}
                      >
                        {active && <span className="h-[8px] w-[8px] rounded-full bg-zinc-100" />}
                      </span>
                      <span className={`text-[14px] font-semibold tracking-[-0.01em] ${locked ? 'text-zinc-500' : 'text-zinc-50'}`}>
                        {l.label}
                      </span>
                    </span>
                    {busy ? (
                      <Spinner className="h-3.5 w-3.5 text-zinc-400" />
                    ) : locked ? (
                      <span className="inline-flex items-center gap-1 text-[12px] text-zinc-500">
                        <Lock className="h-3 w-3" /> {next?.name ?? 'Upgrade'}
                      </span>
                    ) : null}
                  </span>
                  <span className={`mt-2 block pl-[26px] text-[13px] leading-[19px] ${locked ? 'text-zinc-600' : 'text-zinc-400'}`}>
                    {l.blurb}
                  </span>
                </button>
              )
            })}
          </div>

          <div className={`flex items-start gap-2.5 border-t ${RULE} bg-white/[0.015] px-5 py-3 sm:px-6`}>
            <ShieldCheck className="mt-[2px] h-4 w-4 flex-shrink-0 text-zinc-500" strokeWidth={1.75} />
            <p className="text-[12.5px] leading-[18px] text-zinc-500">
              Auth, destructive and irreversible changes always require your approval. No mode can apply them on its
              own.
              {data.cap !== 'AGGRESSIVE' && CLOUD_CONTROL_PLANE && (
                <>
                  {' '}
                  <Link href={upgradeHref} className="font-medium text-zinc-300 underline-offset-2 hover:underline">
                    Compare plans
                  </Link>{' '}
                  to unlock higher modes.
                </>
              )}
            </p>
          </div>
        </section>

        {/* ── Trust scoreboard: one strip, three counters ─────────── */}
        <section aria-labelledby="autonomy-score">
          <div className="mb-3 flex items-baseline justify-between gap-3">
            <h2 id="autonomy-score" className="text-[15px] font-semibold tracking-[-0.012em] text-zinc-50">
              Track record
            </h2>
            <span className="text-[12.5px] tabular-nums text-zinc-500">Last {data.scoreboard.windowDays} days</span>
          </div>
          <StatStrip className="!grid-cols-3 lg:!grid-cols-none">
            <Stat label="Fixed on its own" value={data.scoreboard.autonomousFixes.toLocaleString()} />
            <Stat label="Rolled back" value={data.scoreboard.rollbacks.toLocaleString()} />
            <Stat
              label="Verified after the fix"
              value={verified === null ? '—' : `${Math.round(verified * 100)}%`}
              tone={verified === null ? 'neutral' : verified >= 0.95 ? 'good' : verified >= 0.8 ? 'warn' : 'bad'}
            />
          </StatStrip>
        </section>

        {/* ── Changes Backenly made, each with its way back ─────────── */}
        <AppliedChangesPanel projectId={projectId} changes={data.appliedChanges ?? []} onReverted={fetchReport} />

        {/* ── Recent guardrail actions: an audit log, read as a table ── */}
        <KitCard className="overflow-hidden">
          <KitCardHeader
            title={
              <span className="flex items-center gap-2">
                <Activity className="h-4 w-4 text-zinc-500" strokeWidth={1.75} />
                Recent guardrail actions
                {data.recentActivity.length > 0 && (
                  <span className="text-[12px] font-normal tabular-nums text-zinc-500">{data.recentActivity.length}</span>
                )}
              </span>
            }
            actions={<span className="text-[12px] tabular-nums text-zinc-500">Last {data.scoreboard.windowDays} days</span>}
          />
          {data.recentActivity.length === 0 ? (
            <p className="px-4 py-8 text-center text-[13px] text-zinc-500">Nothing yet. Backenly has not needed to act.</p>
          ) : (
            <div className="max-h-[380px] overflow-y-auto">
              <table className="w-full border-separate border-spacing-0">
                <thead className="sticky top-0 z-10">
                  <tr className={KIT.gridHead}>
                    <th scope="col" className={`w-24 border-b ${RULE} px-4 py-2 text-left text-[12px] font-normal text-zinc-500`}>
                      When
                    </th>
                    <th scope="col" className={`w-36 border-b ${RULE} px-3 py-2 text-left text-[12px] font-normal text-zinc-500`}>
                      Kind
                    </th>
                    <th scope="col" className={`border-b ${RULE} px-3 py-2 text-left text-[12px] font-normal text-zinc-500`}>
                      Action
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.recentActivity.map((a, i) => (
                    <tr key={i} className={`transition-colors ${KIT.rowHoverOn}`}>
                      <td className="whitespace-nowrap border-b border-white/[0.04] px-4 py-2.5 align-top text-[12px] tabular-nums text-zinc-500">
                        {timeAgo(a.at)}
                      </td>
                      <td className="border-b border-white/[0.04] px-3 py-2.5 align-top">
                        <span className="font-mono text-[12px] text-zinc-400">{a.kind || a.action || '—'}</span>
                      </td>
                      <td className="border-b border-white/[0.04] px-3 py-2.5 text-[13px] leading-[19px] text-zinc-300">
                        {a.summary}
                        {/* An unresolved finding is re-escalated every tick, so
                            one decision you haven't made writes one row a
                            minute. Folded server-side; the count keeps the
                            fold honest rather than a truncation. */}
                        {(a.repeat ?? 1) > 1 && <span className="ml-2 text-[12px] tabular-nums text-zinc-500">×{a.repeat}</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </KitCard>

        {/* ── Restore points ──────────────────────────────────────── */}
        <KitCard className="overflow-hidden">
          <KitCardHeader
            title={
              <span className="flex items-center gap-2">
                <Undo2 className="h-4 w-4 text-zinc-500" strokeWidth={1.75} />
                Restore points
              </span>
            }
            description="Roll the backend back to a saved version: tables, columns, APIs, storage buckets and base auth. Resources added since are kept. OAuth providers and functions need to be reconnected by hand."
          />
          <VersionHistory projectId={projectId} />
        </KitCard>

        {/* Says what the engine can actually back up: a fix whose pre-fix
            snapshot capture failed is not reversible, and the Changes panel
            names each of those instead of the footer implying they cannot exist. */}
        <p className="flex items-start gap-2 text-[12.5px] leading-[18px] text-zinc-500">
          <Lock className="mt-[2px] h-3.5 w-3.5 flex-shrink-0 text-zinc-600" />
          Every autonomous action is written to the audit log and snapshotted before it runs. Changes that captured a
          snapshot can be undone above.
        </p>
      </div>
    </Shell>
  )
}
