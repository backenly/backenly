'use client'

/**
 * AutonomyGuardrailsSettings — Control Hub → Autonomy & Guardrails.
 *
 * THE one autonomy surface (2026-07-18): what's waiting on you right now
 * (ReviewQueuePanel, folded in from the deleted /review-queue page), the risk
 * ladder, a plain-English reflection of what's always gated and what autonomy
 * is already allowed to do on its own, a trust scoreboard, and the
 * recent-activity feed. The standalone Review Queue page duplicated this
 * page's data source and now redirects here — one inbox, shown once.
 *
 * Visual language: strictly the shared inspector kit (components/inspector/kit.tsx)
 * — #16171d panels, hairline white/[0.07] borders, one soft drop shadow, mono
 * numerals, violet reserved for the primary action/active state. No decorative
 * gradients or glow (the inspector flat-look is locked), so it reads as one
 * product with Monitoring / Connect / the rest of the inspector rather than the
 * gradient-and-glow variant it was originally written as.
 */

import { useEffect, useState, useCallback } from 'react'
import Link from 'next/link'
import {
  Bot, Gauge, ShieldCheck, Undo2, CheckCircle2, Loader2, Lock, Activity,
  AlertTriangle, RefreshCw, Sparkles, ArrowUpRight, Zap, Wrench,
} from 'lucide-react'
import { InspectorPageHeader } from '@/components/inspector/InspectorPageHeader'
import { KIT, StatTile } from '@/components/inspector/kit'
import { VersionHistory } from '@/components/workspace/VersionHistory'
import { ReviewQueuePanel } from '@/components/ReviewQueuePanel'
import { DetectedFindingsPanel } from '@/components/DetectedFindingsPanel'

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
}

// TWO modes, not three (founder, 2026-07-18: "the off also not needed — just
// review only and auto pilot"). The dial is one decision: does Backenly apply
// safe fixes itself, or hold everything for you? "Off" earned nothing as a
// user choice — the runtime's incident-freeze + circuit breaker are the real
// kill switch, and Review-only already holds every visible change. Persisted
// values (OFF/CONSERVATIVE/BALANCED/AGGRESSIVE) stay valid across the DB,
// billing caps, and breaker logic in lib/autonomy/autonomy-level.ts — legacy
// BALANCED rows render as Autopilot; a legacy OFF row lights neither card and
// shows "Off" in the header badge until the owner picks a mode.
const LEVELS: { id: Level; label: string; blurb: string }[] = [
  { id: 'CONSERVATIVE', label: 'Review-only',  blurb: 'Every change waits for your one-click approval' },
  { id: 'AGGRESSIVE',   label: 'Autopilot',    blurb: 'Backenly heals everything safe on its own; auth and destructive changes still wait for you' },
]

const LEVEL_RANK: Record<Level, number> = { OFF: 0, CONSERVATIVE: 1, BALANCED: 2, AGGRESSIVE: 3 }

/** Legacy BALANCED renders as (and clicks through to) Autopilot. */
function displayLevel(level: Level): Level {
  return level === 'BALANCED' ? 'AGGRESSIVE' : level
}

function labelFor(level: Level): string {
  const norm = displayLevel(level)
  if (norm === 'OFF') return 'Off' // legacy rows only — no longer offered on the dial
  return LEVELS.find(l => l.id === norm)?.label ?? level
}

// The upgrade target for a locked mode. Since 2026-07-18 every plan seeds the
// full dial (prisma/seed-billing.ts: all plans → AGGRESSIVE) — self-healing is
// the product, so no mode is plan-locked anymore. Kept as defence in depth:
// if a future plan re-caps the dial, the lock UI degrades gracefully to a
// Pro upsell instead of a dead button.
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

function Shell({ level, children }: { level?: Level; children: React.ReactNode }) {
  return (
    <div className="h-full overflow-y-auto bg-[#101116] text-zinc-100">
      <InspectorPageHeader
        icon={Bot}
        title="Autonomy"
        description="Your backend keeps working when nobody is asking. Control what Backenly can change on its own and what always needs your approval. The safety floor below never moves, at any mode."
        badge={level ? { label: labelFor(level), variant: level === 'OFF' ? 'governed' : 'beta' } : undefined}
      />
      <div className="px-8 pb-24 pt-6">{children}</div>
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

  useEffect(() => { fetchReport() }, [fetchReport])

  const setLevel = async (level: Level) => {
    if (!data || level === data.level || saving) return
    if (LEVEL_RANK[level] > LEVEL_RANK[data.cap]) {
      const next = nextPlanFor(level)
      setBanner({
        tone: 'gate',
        text: next
          ? `${labelFor(level)} is included in ${next.name} (${next.cadence}). Upgrade to enable it.`
          : `Your plan's ceiling is ${labelFor(data.cap)}. Upgrade to enable ${labelFor(level)}.`,
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
        <div className="space-y-6 animate-pulse">
          <div className="h-44 rounded-lg border border-white/[0.07] bg-white/[0.02]" />
          <div className="grid grid-cols-3 gap-4">
            <div className="h-24 rounded-lg border border-white/[0.07] bg-white/[0.02]" />
            <div className="h-24 rounded-lg border border-white/[0.07] bg-white/[0.02]" />
            <div className="h-24 rounded-lg border border-white/[0.07] bg-white/[0.02]" />
          </div>
          <div className="h-56 rounded-lg border border-white/[0.07] bg-white/[0.02]" />
        </div>
      </Shell>
    )
  }

  if (error || !data) {
    return (
      <Shell>
        <div className={`${KIT.radius} border ${KIT.border} ${KIT.surface} px-6 py-14 text-center ${KIT.inset}`}>
          <div className="mx-auto mb-4 flex size-11 items-center justify-center rounded-lg border border-amber-500/25 bg-amber-500/[0.10]">
            <AlertTriangle className="size-5 text-amber-500" />
          </div>
          <h3 className="text-[14.5px] font-semibold text-zinc-50 tracking-tight">Autonomy settings are unavailable</h3>
          <p className="mx-auto mt-1.5 max-w-sm text-[13px] leading-snug text-zinc-400">
            We couldn&apos;t reach the autonomy service. Nothing has changed; your guardrails are still enforced.
          </p>
          <button
            onClick={() => { setLoading(true); fetchReport() }}
            className="mt-5 inline-flex items-center gap-1.5 rounded-md border border-white/[0.10] bg-white/[0.03] px-3.5 py-2 text-[13px] font-medium text-zinc-200 transition-colors hover:border-white/[0.18] hover:bg-white/[0.06]"
          >
            <RefreshCw className="size-3.5" /> Retry
          </button>
        </div>
      </Shell>
    )
  }

  const verified = data.scoreboard.verifiedRate
  const capLabel = labelFor(data.cap)

  return (
    <Shell level={data.level}>
      <div className="space-y-8">
        {banner && (
          <div
            role="status"
            aria-live="polite"
            className={`flex items-center gap-3 rounded-lg border px-4 py-2.5 text-[13px] shadow-[0_16px_44px_-30px_rgba(0,0,0,0.9)] ${
              banner.tone === 'ok' ? 'border-white/[0.08] bg-[#16171d]' : 'border-violet-500/25 bg-[#16171d]'
            }`}
          >
            <span
              className={`flex size-6 shrink-0 items-center justify-center rounded-md ${
                banner.tone === 'ok'
                  ? 'bg-emerald-500/[0.12] text-emerald-400'
                  : 'bg-violet-500/[0.14] text-violet-300'
              }`}
            >
              {banner.tone === 'ok'
                ? <CheckCircle2 className="size-3.5" />
                : <Sparkles className="size-3.5" />}
            </span>
            <span className="flex-1 font-medium text-zinc-200">{banner.text}</span>
            {banner.tone === 'gate' && (
              <Link
                href="/app/settings?tab=billing"
                className="inline-flex items-center gap-1 rounded-md bg-white/[0.10] px-2.5 py-1 text-[12px] font-semibold text-white transition-colors hover:bg-white/[0.16]"
              >
                Upgrade <ArrowUpRight className="size-3" />
              </Link>
            )}
          </div>
        )}

        {/* ── 0. The one queue, in two halves ─────────────────────────────
               Waiting on you = findings HELD for a human (pending_approval).
               Detected      = findings the loop owns and has not cleared yet
                               (open). Both are self-headed cards, so no
                               section label above either.

               The second card is not a duplicate surface, it is the missing
               one. Overview's loop counts `open + pending_approval` on its
               Detect node and its hero fires on open findings alone — but
               from 2026-07-21 until this panel existed, Autonomy rendered only
               the approval half, so "DETECT 2 need attention → Open inspector"
               landed on "Nothing waiting on you". Detect's number is now the
               sum of these two cards, which is the only arrangement in which
               the dashboard and the page it links to can both be true. ── */}
        <ReviewQueuePanel projectId={projectId} />
        <DetectedFindingsPanel projectId={projectId} level={data.level} />

        {/* ── 1. Autonomy ladder ─────────────────────────────────────────── */}
        <section className={`overflow-hidden ${KIT.radius} border ${KIT.border} ${KIT.surface} ${KIT.inset}`}>
          <div className="flex flex-wrap items-center justify-between gap-3 px-6 pt-6">
            <div className="flex items-center gap-2.5">
              <Gauge className="size-4 text-violet-300" />
              <h3 className="text-[14.5px] font-semibold tracking-tight text-zinc-50">Autonomy mode</h3>
            </div>
            <div className="inline-flex items-center gap-2 rounded-md border border-white/[0.08] bg-white/[0.02] px-2.5 py-1 text-[11.5px] text-zinc-400">
              <span>Plan</span>
              <span className="font-semibold text-zinc-200">{data.plan}</span>
              <span className="text-zinc-600">·</span>
              <span>ceiling</span>
              <span className="font-semibold text-zinc-200">{capLabel}</span>
            </div>
          </div>

          <div className="mt-5 grid grid-cols-1 gap-3 px-6 sm:grid-cols-2">
            {LEVELS.map((l) => {
              const active = displayLevel(data.level) === l.id
              const busy = saving === l.id
              const locked = LEVEL_RANK[l.id] > LEVEL_RANK[data.cap]
              const next = locked ? nextPlanFor(l.id) : null
              return (
                <button
                  key={l.id}
                  disabled={saving !== null || locked}
                  onClick={() => setLevel(l.id)}
                  title={locked && next ? `${l.label} is included in ${next.name} (${next.cadence}). Upgrade to enable.` : undefined}
                  className={`group relative overflow-hidden rounded-lg border p-4 text-left transition-colors disabled:cursor-not-allowed ${
                    active
                      ? 'border-white/[0.18] bg-white/[0.05]'
                      : locked
                        ? 'border-white/[0.06] bg-white/[0.015] opacity-60'
                        : 'border-white/[0.08] bg-white/[0.02] hover:border-white/[0.16] hover:bg-white/[0.035]'
                  }`}
                >
                  <div className="mb-3 flex items-center justify-between">
                    <Meter rank={LEVEL_RANK[l.id]} active={active} locked={locked} />
                    {busy ? (
                      <Loader2 className="size-3.5 animate-spin text-violet-300" />
                    ) : active ? (
                      <span className="rounded bg-violet-500/20 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-violet-200">
                        Active
                      </span>
                    ) : locked ? (
                      <span className="inline-flex items-center gap-1 rounded bg-white/[0.05] px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-zinc-500">
                        <Lock className="size-2.5" /> {next?.name ?? 'Upgrade'}
                      </span>
                    ) : null}
                  </div>
                  <div className={`text-[13.5px] font-semibold tracking-tight ${
                    active ? 'text-violet-200' : locked ? 'text-zinc-500' : 'text-zinc-100'
                  }`}>
                    {l.label}
                  </div>
                  <p className={`mt-1 text-[11.5px] leading-snug ${locked ? 'text-zinc-600' : 'text-zinc-500'}`}>
                    {l.blurb}
                  </p>
                  {!active && !locked && (
                    <span className="mt-2 inline-flex items-center gap-0.5 text-[11px] font-medium text-zinc-500 opacity-0 transition-opacity group-hover:opacity-100">
                      Switch to this <ArrowUpRight className="size-3" />
                    </span>
                  )}
                </button>
              )
            })}
          </div>

          <div className="mt-5 flex items-start gap-2 border-t border-white/[0.06] px-6 py-4">
            <ShieldCheck className="mt-px size-3.5 shrink-0 text-zinc-500" />
            <p className="text-[12px] leading-relaxed text-zinc-500">
              Auth, destructive, and irreversible changes always require your approval. No mode can auto-apply them.
              {data.cap !== 'AGGRESSIVE' && (
                <>
                  {' '}
                  <Link href="/app/settings?tab=billing" className="font-medium text-violet-300 underline-offset-2 hover:text-violet-200 hover:underline">
                    Upgrade
                  </Link>{' '}
                  to unlock higher modes.
                </>
              )}
            </p>
          </div>
        </section>

        {/* ── 2. Trust scoreboard ────────────────────────────────────────── */}
        <section>
          <SectionLabel icon={Sparkles}>Trust scoreboard · last {data.scoreboard.windowDays} days</SectionLabel>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <StatTile
              icon={Wrench}
              tone="violet"
              value={data.scoreboard.autonomousFixes.toLocaleString()}
              label="Autonomous fixes"
            />
            <StatTile
              icon={Undo2}
              tone="neutral"
              value={data.scoreboard.rollbacks.toLocaleString()}
              label="Rollbacks"
            />
            <StatTile
              icon={Zap}
              tone="emerald"
              value={verified === null ? '—' : `${Math.round(verified * 100)}%`}
              label="Verified rate"
            />
          </div>
        </section>

        {/* ── 3. Recent guardrail actions ───────────────────────────────── */}
        <section className={`overflow-hidden ${KIT.radius} border ${KIT.border} ${KIT.surface} ${KIT.inset}`}>
          <div className="flex items-center justify-between border-b border-white/[0.06] px-5 py-3.5">
            <div className="flex items-center gap-2">
              <Activity className="size-3.5 text-zinc-400" />
              <h3 className="text-[13px] font-semibold tracking-tight text-zinc-100">Recent guardrail actions</h3>
            </div>
            <span className="text-[11px] tabular-nums text-zinc-500">last {data.scoreboard.windowDays} days</span>
          </div>
          {data.recentActivity.length === 0 ? (
            <div className="px-5 py-10 text-center">
              <p className="text-[13px] text-zinc-500">Nothing yet. Backenly hasn&apos;t needed to act.</p>
            </div>
          ) : (
            <ul className="divide-y divide-white/[0.04]">
              {data.recentActivity.slice(0, 12).map((a, i) => (
                <li key={i} className="flex items-start gap-3 px-5 py-3 transition-colors hover:bg-white/[0.015]">
                  <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-violet-400/60" />
                  <span className="flex-1 text-[13px] leading-snug text-zinc-300">
                    {a.summary}
                    {/* An unresolved finding is re-escalated every tick, so one
                        decision you haven't made writes one row every 30
                        minutes. Folded server-side; the count is what makes the
                        fold honest rather than a truncation. */}
                    {(a.repeat ?? 1) > 1 && (
                      <span className="ml-2 font-mono text-[11px] tabular-nums text-zinc-600">
                        ×{a.repeat}
                      </span>
                    )}
                  </span>
                  <span className="shrink-0 pt-px text-[11px] tabular-nums text-zinc-600">{timeAgo(a.at)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* ── 4. Restore points ─────────────────────────────────────────── */}
        <section className={`overflow-hidden ${KIT.radius} border ${KIT.border} ${KIT.surface} ${KIT.inset}`}>
          <div className="border-b border-white/[0.06] px-5 py-3.5">
            <div className="flex items-center gap-2">
              <Undo2 className="size-3.5 text-zinc-400" />
              <h3 className="text-[13px] font-semibold tracking-tight text-zinc-100">Restore points</h3>
            </div>
            <p className="mt-1 text-[11.5px] leading-relaxed text-zinc-500">
              Roll the backend back to any saved version. Restores tables, columns, APIs, storage buckets, and base
              auth from that version. Resources added since are not deleted; OAuth providers and functions need to be
              reconnected manually.
            </p>
          </div>
          <VersionHistory projectId={projectId} />
        </section>

        <div className="flex items-center gap-1.5 pt-1">
          <Lock className="size-3 text-zinc-600" />
          <span className="text-[11.5px] text-zinc-500">Every autonomous action is snapshotted, reversible, and written to the audit log.</span>
        </div>
      </div>
    </Shell>
  )
}

// ── Sub-components ────────────────────────────────────────────────────────────

/** Signal-bar meter showing how much autonomy a mode grants (0–3). */
function Meter({ rank, active, locked }: { rank: number; active: boolean; locked: boolean }) {
  return (
    <div className="flex items-end gap-0.5" aria-hidden>
      {[0, 1, 2].map((i) => {
        const filled = i < rank
        const h = ['h-2', 'h-3', 'h-4'][i]
        const color = !filled
          ? 'bg-white/[0.10]'
          : active
            ? 'bg-violet-400'
            : locked
              ? 'bg-zinc-600'
              : 'bg-zinc-400'
        return <span key={i} className={`w-1 rounded-sm ${h} ${color}`} />
      })}
    </div>
  )
}

function SectionLabel({ icon: Icon, children }: { icon: React.ComponentType<{ className?: string }>; children: React.ReactNode }) {
  return (
    <div className="mb-4 flex items-center gap-2">
      <Icon className="size-3.5 text-zinc-500" />
      <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-500">{children}</span>
    </div>
  )
}

