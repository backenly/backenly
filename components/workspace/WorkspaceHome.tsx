'use client'

/**
 * WORKSPACE HOME  ────────────────────────────────────────────────────────────
 * Project dashboard for an autonomous backend platform. The organizing idea:
 * the AGENT is the protagonist, the resources are its inventory.
 *
 * Composition (top → bottom):
 *
 *   • Command bar    Name — nothing else. The top bar owns all global actions
 *                    (Assistant, review inbox, Connect agent), so the page
 *                    header carries zero duplicate buttons (§6.2).
 *   • Agent panel    What the agent has to say right now, in its own voice,
 *                    with the single next action. Right: the mode dial, what
 *                    that mode permits in plain English, and the promise no
 *                    mode overrides.
 *   • Loop panel     THE hero surface (promoted out of the agent panel's
 *                    footer, 2026-07-21). The closed circuit — Observe →
 *                    Detect → Propose → Apply → Verify, and a drawn RETURN
 *                    PATH back to Observe — with the current phase lit, every
 *                    node carrying its real reading, a clock axis saying which
 *                    readings are "now" vs "last 30 days", and the agent's
 *                    last three receipts beneath it.
 *   • Runtime strip  24h of real traffic. Window stated by the section label.
 *   • Resource cards The four things a backend HAS — users / database /
 *                    storage / functions. One card each: icon + label, big
 *                    numeral, size right-aligned. Every card opens its section,
 *                    and this is the page's ENTIRE inventory surface.
 *
 * The lower two blocks carry headings. Four panels at one uniform gap
 * with no headings made everything read equally important, which on a
 * dashboard means nothing does.
 *
 * Two things were removed on 2026-07-21, both for the same reason — the page
 * was saying everything twice:
 *
 *   – The Database panel and the Storage / Realtime / Agent journal row. Each
 *     restated a number the card above it already carried, and on a one-table
 *     project they spent ~600px saying "1 table, empty". The lists live in
 *     their own sections, where each panel's "View all" already pointed.
 *   – The Backend health block. It listed findings and offered "Review and fix
 *     in Autonomy" directly beneath the loop, which already prints those counts
 *     on its Detect / Propose nodes and already links to the same queue.
 *
 * So: if a number matters on the overview it belongs ON a card or a loop node,
 * and if it needs a list it belongs in its own section. Do not re-add a panel
 * here.
 *
 * Design rules that keep this from reading "generated" (console redesign,
 * 2026-09-30):
 *   – Sentence-case headings; no uppercase micro-labels. Numbers are tabular
 *     Geist, not mono.
 *   – Violet is reserved for the active loop phase and attention states.
 *     Status is a dot beside neutral text.
 *   – Hairline borders only, no drop shadows. The page's one entrance is the
 *     shell's; nothing here animates in on its own.
 *
 * Data sources:
 *   • /api/projects/[id]/build-status        verdict / blocked / failed
 *   • /api/projects/[id]/health              lastReconciledAt (loop cadence),
 *                                            lastCheckedAt (daily sweep),
 *                                            weekly fixes
 *   • /api/projects/[id]/dashboard-stats     tables, buckets, summary
 *                                            (end-users, db bytes)
 *   • useAutonomyStatus                      level, pending, trust scoreboard
 *
 * Numbers are never fabricated. Missing data → '—' or hidden cell.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import {
  ArrowRight, ArrowUpRight, Braces, ChevronRight, Database, HardDrive, ShieldCheck, User,
  type LucideIcon,
} from 'lucide-react'
import { BUTTON_BASE, BUTTON_VARIANTS, StatusDot } from '@/components/inspector/kit'
import { FOCUS, FOCUS_INSET } from '@/components/console/tokens'
import {
  levelLabel, useAutonomyStatus, type AutonomyLastAction,
} from '@/lib/hooks/useAutonomyStatus'
// Type only — the block itself no longer renders here (see the note in the
// body); /health still returns findings and the loop counts them.
import { type AdvisorFinding } from '@/components/workspace/AdvisorBlock'
import { ObservabilityStrip } from '@/components/workspace/ObservabilityStrip'

// ── Types ──────────────────────────────────────────────────────────────────

type Verdict =
  | 'production_ready' | 'structure_ready' | 'needs_launch_fixes'
  | 'credentials_needed' | 'not_started' | null

interface BuildStatus {
  blocked: Array<{ name: string; type: string; reason?: string }>
  failed:  Array<{ name: string; type: string; error?: string }>
  summary: { statusLabel: string; verdict?: Verdict }
}

interface HealthData {
  /** Last DEEP observer sweep — daily cron. NOT the self-healing cadence. */
  lastCheckedAt: string | null
  /**
   * Last self-healing loop pass — per-minute on every plan. null = the loop has
   * not run for this project inside the lookback window. Never fall back to
   * lastCheckedAt here: showing the daily sweep under the loop's header is the
   * bug this field exists to fix (see lib/autonomy/loop-tick.ts).
   */
  lastReconciledAt: string | null
  autoFixedThisWeek: number
  /** Uncapped count of findings held for approval. */
  needsAttention: number
  criticalCount?: number
  warningCount?: number
  /** Uncapped count of everything still needing attention (open + held). */
  actionableTotal?: number
  /** TRUNCATED preview (see FINDINGS_PREVIEW_LIMIT) — render it, never count it. */
  findings?: AdvisorFinding[]
}

interface DashboardStats {
  tables:  Array<{ name: string; rowCount: number }>
  buckets: Array<{ name: string; totalBytes: number; fileCount: number; isPublic: boolean }>
  /** Headline counters for the resource cards. null members → render '—'. */
  summary?: { endUsers: number | null; dbBytes: number | null }
}

interface TableEntry { name: string }

interface WorkspaceHomeProps {
  projectId: string
  projectName: string | null
  hasBackend: boolean
  /** Server-rendered table list — the count source until /dashboard-stats lands. */
  tables: TableEntry[]
  storageBuckets?: number
  extras?: Array<{ name: string; icon: string; count?: number }>
  blockedCount?: number
}

// ── Design tokens ────────────────────────────────────────────────────────────
// Single source of truth for surfaces so panels can't drift apart. The values
// are the console ladder (components/console/tokens.ts): a plate on the lit
// canvas, a hairline edge, no drop shadow.
const PANEL = 'rounded-[10px] border border-white/[0.08] bg-[#0f1012]'
const HAIRLINE = 'border-white/[0.06]'
/** The panel ground, repeated where a shape must mask the rail behind it. */
const NODE_GROUND = 'bg-[#0f1012]'

// ── Helpers ────────────────────────────────────────────────────────────────

function formatRelative(iso: string | null | undefined): string {
  if (!iso) return ''
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 60_000) return 'just now'
  const m = Math.round(ms / 60_000)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}

function formatBytes(n: number): string {
  if (n === 0) return '0 B'
  const k = 1024
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(Math.floor(Math.log(n) / Math.log(k)), units.length - 1)
  return `${(n / Math.pow(k, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}K`
  return String(n)
}

// ── Component ──────────────────────────────────────────────────────────────

export function WorkspaceHome({
  projectId, projectName, hasBackend,
  tables, storageBuckets = 0, extras = [],
  blockedCount = 0,
}: WorkspaceHomeProps) {
  const router = useRouter()
  const [build, setBuild]       = useState<BuildStatus | null>(null)
  const [health, setHealth]     = useState<HealthData | null>(null)
  const [stats, setStats]       = useState<DashboardStats | null>(null)
  const { status: autonomy, refresh: refreshAutonomy } = useAutonomyStatus(hasBackend ? projectId : null)

  // Heal choreography signal: bumped when a previously-open finding closes on
  // its own, so the loop instrument can animate the fix flowing through. It is
  // a real state transition made legible — never a timer-driven fiction.
  const [healSignal, setHealSignal] = useState(0)
  const prevOpenIdsRef = useRef<Set<string> | null>(null)

  // no-store: this dashboard live-polls while a finding is open, so a cached
  // /health would hide the very self-heal the loop is meant to show.
  const noStore: RequestInit = { credentials: 'include', cache: 'no-store' }

  const loadAll = useCallback(async () => {
    if (!projectId || !hasBackend) return
    // Progressive: paint each surface as its fetch resolves rather than
    // blocking on the slowest. /build-status runs a deep scan (~8-13s);
    // awaiting all of them used to hold the whole dashboard — including the
    // fast /health finding row and loop counters — hostage to it.
    //
    // /realtime-status left this set with the Realtime panel (2026-07-21): its
    // online-user and channel counts had exactly one reader, and polling an
    // endpoint whose numbers nothing renders is just load.
    const get = (route: string) =>
      fetch(`/api/projects/${projectId}/${route}`, noStore).then(r => r.ok ? r.json() : null).catch(() => null)
    get('build-status').then(v => { if (v) setBuild(v) })
    get('health').then(v => { if (v?.data) setHealth(v.data) })
    get('dashboard-stats').then(v => { if (v?.data) setStats(v.data) })
  }, [projectId, hasBackend]) // eslint-disable-line react-hooks/exhaustive-deps

  // Cheap health-only refresh for the live-watch poll — /build-status runs a
  // deep scan (~8-13s) and would delay the moment we notice a self-heal. The
  // loop's Detect count + the finding row both key off /health, so this alone
  // makes the repair land on screen within a poll.
  const refreshHealth = useCallback(async () => {
    if (!projectId || !hasBackend) return
    try {
      const res = await fetch(`/api/projects/${projectId}/health`, noStore)
      if (res.ok) { const j = await res.json(); if (j?.data) setHealth(j.data) }
    } catch { /* soft-fail — next poll retries */ }
  }, [projectId, hasBackend]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { loadAll() }, [loadAll])

  // Refresh when the user returns to the tab — no polling while hidden.
  useEffect(() => {
    if (!projectId || !hasBackend) return
    const onVisible = () => { if (!document.hidden) loadAll() }
    const onFocus = () => loadAll()
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onFocus)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onFocus)
    }
  }, [projectId, hasBackend, loadAll])

  // While a finding is open the loop is about to act — watch closely so the
  // self-repair is caught the moment it lands, then stop when idle. This is the
  // only window that justifies polling; it ends the instant the finding closes.
  const hasOpenFinding = (health?.findings ?? []).some(f => f.status === 'open')
  useEffect(() => {
    if (!projectId || !hasBackend || !hasOpenFinding) return
    const iv = setInterval(() => { refreshHealth(); refreshAutonomy() }, 2500)
    return () => clearInterval(iv)
  }, [projectId, hasBackend, hasOpenFinding, refreshHealth, refreshAutonomy])

  // Detect a self-heal: a finding that was open is no longer open. Fire the
  // loop signal, pull a fresh scoreboard so Apply/Verify tick in step, and do
  // one full refresh so the verdict-driven headline settles to "all clear".
  useEffect(() => {
    const openIds = new Set(
      (health?.findings ?? []).filter(f => f.status === 'open').map(f => f.id),
    )
    const prev = prevOpenIdsRef.current
    prevOpenIdsRef.current = openIds
    if (prev == null) return // first load — establish baseline, never fire
    let closed = false
    for (const id of prev) if (!openIds.has(id)) { closed = true; break }
    if (closed && autonomy?.level !== 'OFF') {
      setHealSignal(n => n + 1)
      refreshAutonomy()
      loadAll() // verdict/headline/stats catch up to the healed reality
    }
  }, [health, autonomy?.level, refreshAutonomy, loadAll])

  if (!hasBackend) return null

  // ── Deep-scan verdict (drives the agent panel + loop phase below) ────────
  const verdict: Verdict = (build?.summary?.verdict as Verdict) ?? null
  const liveBlocked = build?.blocked?.length ?? blockedCount
  const liveFailed  = build?.failed?.length ?? 0

  // Open findings the loop has seen but not yet acted on (from the fast /health
  // poll). Computed up here so the headline + loop phase can flip the instant a
  // self-heal closes the last finding, rather than waiting on the slow deep
  // scan's verdict to catch up — and so we never say "a few things to clear"
  // when nothing is actually open.
  const openFindings = health?.findings
    ? health.findings.filter(f => f.status === 'open').length
    : null

  // What the DETECT node reports. Deliberately NOT `openFindings`.
  //
  // The loop read "DETECT 7 open" directly above a health list showing "All 10",
  // and a reviewer reasonably called that fake. Both numbers were correct —
  // DETECT counted status='open' and the list counts open + pending_approval, so
  // 7 open + 3 held = the 10 below. They were a decomposition, not a
  // disagreement. But nothing on screen said so, and two different counts of
  // what looks like one quantity reads as a system that cannot count.
  //
  // So DETECT now reports everything still needing attention — the same set the
  // list beneath it renders — and PROPOSE reports how many OF THOSE are held for
  // a human. "12 detected, 6 waiting on you" is a sentence; "2 open, 6 held,
  // 8 listed" is a puzzle.
  //
  // Kept separate from `openFindings` on purpose: that one drives the heal
  // choreography, which must fire when a finding actually CLOSES, not when one
  // moves from open to pending_approval.
  // Counted from the payload's uncapped total, NOT from the findings array —
  // that array is a truncated preview, so measuring it capped Detect at the
  // preview limit while Propose read an uncapped list. That mismatch is exactly
  // what made the rail read "10 need attention · 14 of those, held for you".
  const actionableFindings = health
    ? health.actionableTotal ?? (health.findings ?? []).filter(
        f => f.status === 'open' || f.status === 'pending_approval',
      ).length
    : null

  // What PROPOSE reports: the subset of DETECT that is held for a human.
  //
  // This MUST be counted from the same payload DETECT is counted from. It used
  // to read /autonomy's pendingApprovals while DETECT read /health — two
  // endpoints over the same table on independent refresh schedules — so the
  // rail rendered "10 need attention · 14 of those, held for you". A subset
  // larger than its superset is not a rounding error the user forgives; it is
  // the whole surface admitting it cannot count. One fetch, one instant, one
  // table. /autonomy remains the fallback only for when the health fetch has
  // not landed, and in that case DETECT renders '—' beside it anyway.
  const heldFindings = health
    ? health.needsAttention ?? (health.findings ?? []).filter(
        f => f.status === 'pending_approval',
      ).length
    : null

  const hasOpenWork = (openFindings ?? 0) > 0 || liveFailed > 0 || liveBlocked > 0

  // ── Agent panel state — one headline, one action, in the agent's voice ───
  const autonomyPending = heldFindings ?? autonomy?.pendingCount ?? 0
  const agent: {
    headline: string
    body: string
    cta?: { label: string; onClick: () => void }
    quiet?: { label: string; onClick: () => void }
  } =
    autonomyPending > 0 ? {
      headline: 'Waiting on your review',
      body: `Backenly prepared ${autonomyPending} change${autonomyPending === 1 ? '' : 's'} and is holding ${autonomyPending === 1 ? 'it' : 'them'}. Destructive and auth-related changes never ship without your OK.`,
      cta: { label: `Review ${autonomyPending === 1 ? 'the change' : `${autonomyPending} changes`}`, onClick: () => router.push(`/app/projects/${projectId}/autonomy`) },
    }
    : (verdict === 'credentials_needed' || liveBlocked > 0) ? {
      headline: 'Paused: a key is missing',
      body: 'Part of the build is waiting on a credential. Add it in Integrations and Backenly picks up exactly where it stopped.',
      cta: { label: "See what's blocked", onClick: () => router.push(`/app/projects/${projectId}/autonomy`) },
    }
    : hasOpenWork ? {
      headline: 'A few things to clear before launch',
      body: 'Backenly flagged some issues while checking the runtime. Auto-fix them here, or hand them to your coding agent.',
      cta: { label: 'Review in Autonomy', onClick: () => router.push(`/app/projects/${projectId}/autonomy`) },
    }
    : verdict === 'structure_ready' ? {
      headline: 'Built and standing by',
      body: 'Your backend is ready. Point your coding agent at it and Backenly starts watching every change live: schema, APIs, auth, storage.',
      cta: { label: 'Connect your agent', onClick: () => router.push(`/app/projects/${projectId}/connect`) },
    }
    : {
      headline: 'All clear. Self-healing on watch',
      body: 'Schema, APIs, auth and storage are healthy. Backenly re-checks continuously and repairs safe issues on its own. Only auth or destructive changes ever wait for you.',
    }

  // ── Loop phase (derived from real state, never animated fiction) ─────────
  const autonomyOff = autonomy?.level === 'OFF'
  const lastActionIso = autonomy?.lastAction?.at ?? null
  const lastActionFresh = lastActionIso != null && Date.now() - new Date(lastActionIso).getTime() < 15 * 60_000
  const loopPhase: LoopPhase =
    autonomyPending > 0 ? 'propose'
    : (hasOpenWork || verdict === 'credentials_needed') ? 'detect'
    : lastActionFresh ? 'verify'
    : 'observe'

  // The loop's OWN clock — the per-minute reconciler pass, not the daily
  // observer sweep. These were the same field until the loop header ended up
  // advertising "checked 11h ago" on a backend the loop had reconciled a minute
  // earlier, because lastCheckedAt is stamped by the 00:10 UTC observer and the
  // reconciler stamps nothing. null = no pass inside the lookback; show "first
  // check running", never a fake time and never the observer's timestamp.
  const lastReconciledIso = health?.lastReconciledAt ?? null

  // ── Resource counters ─────────────────────────────────────────────────────
  const functionsCount = extras.find(x => /function/i.test(x.name))?.count ?? 0

  // Table count: the live stats when they've landed, else the server-rendered
  // list, so the card shows a real number on first paint instead of a dash
  // that resolves a second later.
  const tableCount   = stats?.tables ? stats.tables.length : tables.length
  const bucketCount  = stats?.buckets ? stats.buckets.length : storageBuckets
  const storageBytes = stats?.buckets
    ? stats.buckets.reduce((acc, b) => acc + b.totalBytes, 0)
    : null
  const endUsers = stats?.summary ? stats.summary.endUsers : null
  const dbBytes  = stats?.summary ? stats.summary.dbBytes  : null

  // Four resource cards. Secondary metrics are omitted (not zeroed) while their
  // fetch is in flight or when the project has no such resource — a size that
  // has not loaded must never render as a confident "0 B".
  const resources: ResourceCard[] = [
    {
      key: 'users', label: 'Users', icon: User,
      value: endUsers == null ? '—' : formatCount(endUsers),
      muted: !endUsers,
      // The standalone /users route folded into Auth & Users (§6.5); the tab
      // query param is the page's own documented deep link.
      onClick: () => router.push(`/app/projects/${projectId}/auth?tab=users`),
    },
    {
      key: 'database', label: 'Database', icon: Database,
      value: formatCount(tableCount),
      unit: tableCount === 1 ? 'Table' : 'Tables',
      meta: dbBytes == null ? undefined : formatBytes(dbBytes),
      muted: tableCount === 0,
      onClick: () => router.push(`/app/projects/${projectId}/database`),
    },
    {
      key: 'storage', label: 'Storage', icon: HardDrive,
      value: formatCount(bucketCount),
      unit: bucketCount === 1 ? 'Bucket' : 'Buckets',
      meta: storageBytes == null ? undefined : formatBytes(storageBytes),
      muted: bucketCount === 0,
      onClick: () => router.push(`/app/projects/${projectId}/storage`),
    },
    {
      key: 'functions', label: 'Functions', icon: Braces,
      value: formatCount(functionsCount),
      unit: functionsCount === 1 ? 'Function' : 'Functions',
      muted: functionsCount === 0,
      onClick: () => router.push(`/app/projects/${projectId}/functions`),
    },
  ]

  return (
    <div className="relative space-y-10">
      {/* ── The agent and its loop — one block, tight internal rhythm ─────
          The header carries the name only. Status lives in the agent panel
          below; a header chip duplicated it. Global actions (Assistant, inbox,
          Connect agent) live in the top bar. ──────────────────────────── */}
      <div className="space-y-3">
        <header className="min-w-0 pb-3">
          <h1 className="truncate text-[26px] font-semibold leading-[32px] tracking-[-0.028em] text-zinc-50">
            {projectName ?? 'Untitled project'}
          </h1>
        </header>

        <AgentPanel
          agent={agent}
          autonomy={autonomy}
          autonomyOff={!!autonomyOff}
          onOpenAutonomy={() => router.push(`/app/projects/${projectId}/autonomy`)}
        />

        {/* The loop is the page's centrepiece: a closed circuit whose readings
            are the same numbers the Autonomy page computes, and whose return
            path is why the phases never end. */}
        <LoopPanel
          autonomy={autonomy}
          autonomyOff={!!autonomyOff}
          pending={autonomyPending}
          openFindings={openFindings}
          actionableFindings={actionableFindings}
          loopPhase={loopPhase}
          healSignal={healSignal}
          lastReconciledIso={lastReconciledIso}
          onReview={() => router.push(`/app/projects/${projectId}/autonomy`)}
        />
      </div>

      {/* The Backend health list sat here until 2026-07-21. It rendered the
          finding groups AND a "Review and fix in Autonomy" button — the same
          destination the loop's Propose node above already offers, above the
          same counts the loop already prints. Autonomy owns the one queue; the
          loop is this page's summary of it. Findings do not get a second
          surface here. ──────────────────────────────────────────────────── */}

      {/* ── Honest observability — 24h runtime traffic only (§6.2). The window
             is stated once in the heading, so the readings do not repeat it. */}
      <section aria-labelledby="runtime-heading" className="space-y-3">
        <BlockHeading id="runtime-heading" hint="Requests your frontend and agents made against this backend">
          Last 24 hours
        </BlockHeading>
        <ObservabilityStrip projectId={projectId} />
      </section>

      {/* ── Resource cards — the four things a backend HAS. This is the whole
          inventory surface. The Database / Storage / Realtime / Agent journal
          panels that used to sit below were removed (2026-07-21): each
          restated a number a card already carries. The lists live one click
          away in their own sections. ─────────────────────────────────────── */}
      <section aria-labelledby="resources-heading" className="space-y-3">
        <BlockHeading id="resources-heading">Resources</BlockHeading>
        <ResourceCards items={resources} />
      </section>
    </div>
  )
}

// ── Shared primitives ───────────────────────────────────────────────────────

function Panel({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <section className={`relative overflow-hidden ${PANEL} ${className}`}>{children}</section>
}

/**
 * A block heading for the page's lower half, in sentence case. The page used
 * to be four panels at one uniform gap with no hierarchy; these name the two
 * inventory blocks and carry their shared time window.
 */
function BlockHeading({ children, id, hint }: { children: React.ReactNode; id: string; hint?: string }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
      <h2 id={id} className="text-[15px] font-semibold leading-[22px] tracking-[-0.012em] text-zinc-100">
        {children}
      </h2>
      {hint && <p className="text-[13px] leading-[20px] text-zinc-500">{hint}</p>}
    </div>
  )
}

// ── Agent panel ─────────────────────────────────────────────────────────────
// What the agent has to say right now, in its own voice, with the single next
// action — and beside it the one control that governs it (the mode dial) plus
// the promise that survives every mode.

type LoopPhase = 'observe' | 'detect' | 'propose' | 'apply' | 'verify'

const LOOP_STAGES: Array<{ key: LoopPhase; label: string }> = [
  { key: 'observe', label: 'Observe' },
  { key: 'detect',  label: 'Detect'  },
  { key: 'propose', label: 'Propose' },
  { key: 'apply',   label: 'Apply'   },
  { key: 'verify',  label: 'Verify'  },
]

/**
 * What each phase MEANS, in one plain sentence.
 *
 * No other backend ships this loop, so its five stage names are vocabulary
 * nobody arrives already knowing. The readings say how MUCH and never WHAT —
 * "0 waiting on you" only reads as good news once you know the loop stops
 * there deliberately, and a first-time visitor reads it as a dead column.
 *
 * Deliberately number-free. The numerals sit directly above these lines and
 * change every minute; restating them here would only give them a second place
 * to drift out of sync.
 */
const LOOP_EXPLAIN: Record<LoopPhase, string> = {
  observe:
    'The rules your backend must always hold to. Backenly re-checks every one of them, every minute, on every plan.',
  detect:
    'How many of those rules it is failing right now. Backenly probes the live database instead of waiting for a bug report.',
  propose:
    'Backenly writes the exact repair before touching anything. Safe ones ship themselves; risky ones wait for your approval.',
  apply:
    'Repairs Backenly made on its own in the last 30 days, each behind a restore point taken before the change.',
  verify:
    'Of those repairs, the share whose original probe ran again and came back clean. Not “nobody undid it”.',
}

/** Live per-phase readings for the loop instrument. null → render '—'. */
interface LoopStats {
  invariants: number | null
  openFindings: number | null
  actionableFindings: number | null
  pending: number | null
  fixes30d: number | null
  verifiedRate: number | null
}

/** One-line plain-English description of what the current mode permits. */
const MODE_MEANING: Record<string, string> = {
  Autopilot:    'Safe fixes ship on their own. Everything risky waits for you.',
  'Review-only': 'Every change is prepared and held until you approve it.',
  Off:          'The loop watches and records, but changes nothing.',
}

function AgentPanel({
  agent, autonomy, autonomyOff, onOpenAutonomy,
}: {
  agent: { headline: string; body: string; cta?: { label: string; onClick: () => void }; quiet?: { label: string; onClick: () => void } }
  autonomy: ReturnType<typeof useAutonomyStatus>['status']
  autonomyOff: boolean
  onOpenAutonomy: () => void
}) {
  const mode = autonomy ? levelLabel(autonomy.level) : null
  return (
    <Panel>
      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_320px]">
        {/* ── Left: the agent's report ──────────────────────────────────── */}
        <div className="flex flex-col justify-center px-5 py-6 sm:px-7 sm:py-7">
          <div className="min-h-[30px]">
            <AnimatePresence mode="wait" initial={false}>
              <motion.h2
                key={agent.headline}
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
                className="text-[21px] font-semibold leading-[30px] tracking-[-0.022em] text-zinc-50 [text-wrap:balance]"
              >
                {agent.headline}
              </motion.h2>
            </AnimatePresence>
          </div>
          <p className="mt-2 max-w-[60ch] text-[14px] leading-[22px] text-zinc-400 [text-wrap:pretty]">{agent.body}</p>

          {(agent.cta || agent.quiet) && (
            <div className="mt-5 flex flex-wrap items-center gap-3">
              {agent.cta && (
                <button
                  type="button"
                  onClick={agent.cta.onClick}
                  className={`group ${BUTTON_BASE} ${BUTTON_VARIANTS.primary} h-[34px] px-3.5 text-[13px]`}
                >
                  {agent.cta.label}
                  <ArrowRight className="h-3.5 w-3.5 transition-transform duration-150 group-hover:translate-x-0.5" strokeWidth={2} />
                </button>
              )}
              {agent.quiet && (
                <button
                  type="button"
                  onClick={agent.quiet.onClick}
                  className={`group inline-flex items-center gap-0.5 rounded-[5px] text-[13px] font-medium text-zinc-400 transition-colors hover:text-zinc-100 ${FOCUS}`}
                >
                  {agent.quiet.label}
                  <ChevronRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
                </button>
              )}
            </div>
          )}
        </div>

        {/* ── Right: the one control that governs the agent ─────────────
               Pending / fixes / verified / last action all live on the loop
               below — this column deliberately holds no number the instrument
               already prints. What it holds instead is the dial, what the dial
               currently permits in plain English, and the promise that no dial
               setting can override. ─────────────────────────────────────── */}
        <div className={`flex flex-col border-t lg:border-l lg:border-t-0 ${HAIRLINE} bg-white/[0.012]`}>
          <button
            type="button"
            onClick={onOpenAutonomy}
            className={`group/mode flex-1 px-5 py-5 text-left transition-colors hover:bg-white/[0.02] sm:px-6 ${FOCUS_INSET}`}
          >
            <span className="flex items-center justify-between">
              <span className="text-[12px] font-medium text-zinc-500">Autonomy mode</span>
              <ChevronRight className="h-4 w-4 text-zinc-600 transition-all group-hover/mode:translate-x-0.5 group-hover/mode:text-zinc-300" />
            </span>
            <span className="mt-2 flex items-center gap-2.5">
              <span className={`text-[16px] font-semibold tracking-[-0.014em] ${autonomyOff ? 'text-zinc-400' : 'text-zinc-50'}`}>
                {mode ?? '—'}
              </span>
              {!autonomyOff && mode && <StatusDot tone="operational" label="Live" />}
            </span>
            {mode && MODE_MEANING[mode] && (
              <span className="mt-1.5 block text-[13px] leading-[20px] text-zinc-400">{MODE_MEANING[mode]}</span>
            )}
          </button>
          <div className={`flex items-start gap-2.5 border-t ${HAIRLINE} px-5 py-3.5 sm:px-6`}>
            <ShieldCheck className="mt-[2px] h-4 w-4 flex-shrink-0 text-zinc-500" strokeWidth={1.75} />
            <p className="text-[12.5px] leading-[19px] text-zinc-500">
              Auth, destructive and irreversible changes always need your approval, in every mode.
            </p>
          </div>
        </div>
      </div>
    </Panel>
  )
}

// ── Loop panel ──────────────────────────────────────────────────────────────
// The self-healing loop as its own instrument, at full width: header (state +
// check cadence), the five-phase circuit, and the agent's receipts.
//
// Every reading is the same number the Autonomy page computes from the same
// trust report, so the two surfaces cannot disagree. Nothing here is a
// decorative animation over static data: the lit node is the derived phase, the
// heal sweep fires on a real finding closing, and OFF freezes the whole circuit.

function LoopPanel({
  autonomy, autonomyOff, pending, openFindings, actionableFindings,
  loopPhase, healSignal, lastReconciledIso, onReview,
}: {
  autonomy: ReturnType<typeof useAutonomyStatus>['status']
  autonomyOff: boolean
  pending: number
  openFindings: number | null
  actionableFindings: number | null
  loopPhase: LoopPhase
  healSignal: number
  /** Last reconciler pass — the loop's cadence, not the daily observer's. */
  lastReconciledIso: string | null
  onReview: () => void
}) {
  const loopStats: LoopStats = {
    invariants: autonomy?.invariantCount ?? null,
    openFindings,
    actionableFindings,
    // Gated on the SAME payload as `actionableFindings` (the caller derives
    // both from one health fetch). Gating this on `autonomy` instead let the
    // rail print a held-count from one endpoint beside a detected-count from
    // another — see the note on `heldFindings` in the parent.
    pending: actionableFindings == null ? null : pending,
    fixes30d: autonomy ? autonomy.autonomousFixes : null,
    verifiedRate: autonomy?.verifiedRate ?? null,
  }
  const receipts = (autonomy?.recentActivity ?? []).slice(0, 3)

  return (
    <Panel>
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div className={`flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-b ${HAIRLINE} px-5 py-3.5 sm:px-7`}>
        <div className="flex items-center gap-3">
          <h2 className="text-[14px] font-semibold tracking-[-0.01em] text-zinc-100">Self-healing loop</h2>
          <StatusDot
            tone={autonomyOff ? 'paused' : 'operational'}
            label={autonomyOff ? 'Paused' : 'Running'}
            pulse={!autonomyOff}
          />
        </div>
        <span className="text-[12px] tabular-nums text-zinc-500">
          {autonomyOff
            ? 'Records and suggests only'
            : lastReconciledIso ? `Checked ${formatRelative(lastReconciledIso)}` : 'First check running…'}
        </span>
      </div>

      {/* ── The circuit ────────────────────────────────────────────────── */}
      <div className="px-5 pb-8 pt-7 sm:px-8">
        <SelfHealingLoop
          phase={loopPhase}
          off={autonomyOff}
          stats={loopStats}
          healSignal={healSignal}
          onReview={onReview}
        />
      </div>

      {/* ── Receipts — proof the circuit above actually ran ─────────────
          Not a second findings queue (Autonomy owns the one queue): this is
          the guardrail action log, already folded by repeat server-side. */}
      {receipts.length > 0 && (
        <div className={`border-t ${HAIRLINE}`}>
          <ul className="divide-y divide-white/[0.05]">
            {receipts.map((a, i) => (
              <ReceiptRow key={`${a.at}-${i}`} item={a} />
            ))}
          </ul>
          <button
            type="button"
            onClick={onReview}
            className={`group/all flex w-full items-center justify-between border-t ${HAIRLINE} px-5 py-3 text-left transition-colors hover:bg-white/[0.02] sm:px-7 ${FOCUS_INSET}`}
          >
            <span className="text-[12.5px] font-medium text-zinc-400 transition-colors group-hover/all:text-zinc-100">
              Full guardrail log, restore points and approvals
            </span>
            <ChevronRight className="h-4 w-4 text-zinc-600 transition-all group-hover/all:translate-x-0.5 group-hover/all:text-zinc-300" />
          </button>
        </div>
      )}
    </Panel>
  )
}

// Receipt tone: the row's marker colour states what KIND of act it was, so a
// rollback or a failed apply can never read as routine.
const RECEIPT_TONE: Record<string, string> = {
  auto_fix:   'bg-emerald-400',
  applied:    'bg-emerald-400',
  escalation: 'bg-amber-400',
  rollback:   'bg-amber-400',
  failed:     'bg-rose-400',
  breaker:    'bg-rose-400',
  architecture: 'bg-sky-400',
  shadow:     'bg-zinc-600',
  other:      'bg-zinc-600',
}

function ReceiptRow({ item }: { item: AutonomyLastAction }) {
  return (
    <li className="flex items-start gap-3 px-5 py-3 sm:px-7">
      <span className={`mt-[7px] h-[6px] w-[6px] flex-shrink-0 rounded-full ${RECEIPT_TONE[item.kind] ?? RECEIPT_TONE.other}`} aria-hidden />
      <span className="line-clamp-2 min-w-0 flex-1 text-[13px] leading-[20px] text-zinc-300">
        {item.summary}
        {(item.repeat ?? 1) > 1 && (
          <span className="ml-1.5 text-[12px] tabular-nums text-zinc-500">×{item.repeat}</span>
        )}
      </span>
      <span className="flex-shrink-0 pt-px text-[12px] tabular-nums text-zinc-500">{formatRelative(item.at)}</span>
    </li>
  )
}

/**
 * The closed loop as a living instrument.
 *
 * Five phase nodes on one rail, and — this is the point — a RETURN PATH from
 * Verify back to Observe. Drawn as a straight line the diagram dead-ends at
 * Verify, which is precisely the wrong story: it reads as a five-step pipeline
 * that finishes. The arc says the thing that actually differentiates this
 * product: verification feeds the next observation, forever, with no human at
 * the top of the loop.
 *
 * Every node carries its REAL reading (guarantees watched, guarantees broken,
 * held for approval, fixes 30d, proven-fixed rate) and the axis beneath says
 * which clock each reading is on — Observe/Detect/Propose are an instant
 * snapshot, Apply/Verify a 30-day track record. Without that split "15 broken"
 * beside "100% proven fixed" reads as the loop contradicting itself.
 *
 * Each node also carries a one-sentence LOOP_EXPLAIN on hover and focus.
 *
 * Motion is telemetry, never theater: the lit node is the real derived phase,
 * the heal sweep fires only when a finding genuinely closed, OFF freezes the
 * whole circuit, and prefers-reduced-motion renders it static.
 */
// Heal choreography: stage 1..5 maps to the node index the fix is passing
// through (Detect → Propose → Apply → Verify, Observe is home). Driven by a
// real state transition (healSignal), so the motion is telemetry, not theater.
const HEAL_NODE_INDEX: Array<number | null> = [null, 1, 2, 3, 4, 4]

function SelfHealingLoop({
  phase, off, stats, healSignal, onReview,
}: { phase: LoopPhase; off: boolean; stats: LoopStats; healSignal: number; onReview: () => void }) {
  const reduced = useReducedMotion()
  const live = !off && !reduced

  // One-shot sweep when a self-heal lands: walk the fix through the stages.
  const [heal, setHeal] = useState<{ id: number; stage: number } | null>(null)
  useEffect(() => {
    if (!healSignal || off || reduced) return
    const steps = [0, 480, 960, 1440, 1980] // ms → stage 1..5 (detect→verify)
    const timers = steps.map((t, i) =>
      setTimeout(() => setHeal({ id: healSignal, stage: i + 1 }), t),
    )
    timers.push(setTimeout(() => setHeal(null), 3600))
    return () => timers.forEach(clearTimeout)
  }, [healSignal, off, reduced])

  const healingIndex = heal ? HEAL_NODE_INDEX[heal.stage] : null

  // Per-node reading: value + unit. '—' while the trust report is loading.
  const readings: Record<LoopPhase, { value: string; unit: string; accent?: boolean }> = {
    observe: {
      value: stats.invariants == null ? '—' : String(stats.invariants),
      // The cadence belongs ON the reading. It is the whole claim — a linter
      // runs when you invoke it, this runs whether or not anyone is looking —
      // and it holds for every plan including Free.
      unit: 'guarantees, every minute',
    },
    detect: {
      // open + pending_approval: the sum of what the Autonomy page shows
      // across Detected + Waiting on you, never larger than it.
      value: stats.actionableFindings == null ? '—' : String(stats.actionableFindings),
      unit: 'broken guarantees',
    },
    propose: {
      value: stats.pending == null ? '—' : String(stats.pending),
      // A SUBSET of `detect`; the relationship is stated in LOOP_EXPLAIN.
      unit: 'waiting on you',
      accent: (stats.pending ?? 0) > 0,
    },
    apply: {
      value: stats.fixes30d == null ? '—' : String(stats.fixes30d),
      // 'on its own' is the phrase that separates this product from every
      // monitoring tool that also claims 'fixed'.
      unit: 'fixed on its own',
    },
    verify: {
      value: stats.verifiedRate == null ? '—' : `${Math.round(stats.verifiedRate * 100)}%`,
      // 'proven' rather than 'verified': re-probed and confirmed gone, never
      // "nobody rolled it back" (see trust-report's verifiedRate). The 30-day
      // window is stated once, on the axis under Apply and Verify.
      unit: 'proven fixed',
    },
  }

  return (
    <div
      className="scrollbar-hide relative -mx-5 overflow-x-auto px-5 sm:mx-0 sm:overflow-visible sm:px-0"
      aria-label={off ? 'Autonomy loop off' : `Autonomy loop phase: ${phase}`}
    >
      <div className="min-w-[520px] sm:min-w-0">
        {/* ── Rail + phase nodes ───────────────────────────────────────────
          A five-column grid, not justify-between: the node centers then sit at
          exactly 10/30/50/70/90% of the width, which is what lets the rail and
          the return arc below anchor to them at any viewport size. ──────── */}
        <div className="relative">
          {/* Rail — one hairline through the node centers (top = NODE/2). */}
          <div className={`absolute left-[10%] right-[10%] top-[15px] h-px ${off ? 'bg-white/[0.05]' : 'bg-white/[0.10]'}`} />

          {/* The signal: one comet travelling the rail, clipped to a strip so
              it enters and leaves cleanly at the first and last node. */}
          {live && (
            <div className="pointer-events-none absolute left-[10%] right-[10%] top-[14px] h-[3px] overflow-hidden">
              <motion.span
                className="absolute top-[1px] h-px w-32 bg-[linear-gradient(to_right,transparent,rgba(196,181,253,0.9),transparent)]"
                animate={{ left: ['-20%', '104%'] }}
                transition={{ duration: 6.4, repeat: Infinity, ease: 'linear' }}
              />
            </div>
          )}

          {/* The heal signal: one bright pulse driving the fix down the rail
              from Detect to Verify. Fires once per real self-heal. */}
          {heal && !reduced && (
            <div className="pointer-events-none absolute left-[10%] right-[10%] top-[14px] h-[3px] overflow-hidden">
              <motion.span
                key={heal.id}
                className="absolute top-[1px] h-[1.5px] w-24 rounded-full bg-[linear-gradient(to_right,transparent,rgba(196,181,253,1),transparent)]"
                initial={{ left: '4%', opacity: 0 }}
                animate={{ left: '96%', opacity: [0, 1, 1, 0.6] }}
                transition={{ duration: 2.0, ease: 'easeInOut' }}
              />
            </div>
          )}

          {/* Phase nodes — circles mask the rail with the panel ground. Propose
              opens the queue when something is actually waiting. */}
          <div className="relative grid grid-cols-5">
            {LOOP_STAGES.map((s, idx) => {
              const healingHere = healingIndex === idx
              const active = !off && (healingIndex != null ? healingHere : s.key === phase)
              const r = readings[s.key]
              const clickable = s.key === 'propose' && (stats.pending ?? 0) > 0
              const valueClass = `text-[28px] font-semibold leading-none tabular-nums tracking-[-0.03em] ${
                r.accent ? 'text-violet-200' : off ? 'text-zinc-600' : active ? 'text-zinc-50' : 'text-zinc-300'
              }`
              const node = (
                <>
                  <span
                    className={`relative flex h-[30px] w-[30px] items-center justify-center rounded-full border ${NODE_GROUND} transition-colors duration-300 ${
                      active
                        ? 'border-violet-300/50 shadow-[0_0_0_4px_rgba(167,139,250,0.08),0_0_24px_-4px_rgba(167,139,250,0.45)]'
                        : off ? 'border-white/[0.06]' : 'border-white/[0.12]'
                    }`}
                  >
                    {active && !reduced && !healingHere && (
                      <motion.span
                        animate={{ opacity: [0.1, 0.4, 0.1], scale: [1, 1.45, 1] }}
                        transition={{ duration: 2.6, repeat: Infinity, ease: 'easeInOut' }}
                        className="absolute inset-0 rounded-full bg-violet-400/25"
                      />
                    )}
                    {/* One-shot ripple as the heal pulse reaches this node. */}
                    {healingHere && !reduced && (
                      <motion.span
                        key={`ripple-${heal!.id}-${idx}`}
                        initial={{ opacity: 0.65, scale: 1 }}
                        animate={{ opacity: 0, scale: 2.3 }}
                        transition={{ duration: 0.7, ease: 'easeOut' }}
                        className="absolute inset-0 rounded-full bg-violet-400/45"
                      />
                    )}
                    <span
                      className={`relative h-[8px] w-[8px] rounded-full transition-colors duration-300 ${
                        active ? 'bg-violet-200' : off ? 'bg-zinc-700' : 'bg-zinc-500'
                      }`}
                    />
                  </span>

                  <span
                    className={`mt-3 text-[12.5px] font-medium transition-colors ${
                      active ? 'text-zinc-50' : 'text-zinc-400'
                    }`}
                  >
                    {s.label}
                  </span>

                  {/* The reading, stacked under its phase: numeral then unit,
                      so the numbers form one scannable row across the
                      instrument. */}
                  <span className="mt-3 flex h-[28px] items-center">
                    {reduced ? (
                      <span className={valueClass}>{r.value}</span>
                    ) : (
                      <span className="relative inline-flex leading-none">
                        <AnimatePresence initial={false} mode="popLayout">
                          <motion.span
                            key={r.value}
                            initial={{ y: 6, opacity: 0 }}
                            animate={{ y: 0, opacity: 1 }}
                            exit={{ y: -6, opacity: 0, position: 'absolute' }}
                            transition={{ duration: 0.26, ease: 'easeOut' }}
                            className={valueClass}
                          >
                            {r.value}
                          </motion.span>
                        </AnimatePresence>
                      </span>
                    )}
                  </span>

                  <span className="mt-2 max-w-[140px] px-1 text-center text-[12px] leading-[16px] text-zinc-500">
                    {r.unit}
                  </span>

                  {/* What the phase MEANS, on hover and keyboard focus. Edge
                      columns anchor to their own edge instead of centring, so
                      the widest popover stays inside the panel at every
                      viewport. Always in the accessibility tree, so it is never
                      a mouse-only explanation. */}
                  <span className="sr-only">{LOOP_EXPLAIN[s.key]}</span>
                  <span
                    aria-hidden="true"
                    className={`pointer-events-none absolute top-full z-20 mt-2 w-[min(260px,calc(100vw-3rem))] rounded-[10px] bg-[#141518] px-3.5 py-2.5 text-left text-[12.5px] leading-[19px] text-zinc-300 opacity-0 shadow-[0_0_0_1px_rgba(255,255,255,0.08),0_16px_40px_-12px_rgba(0,0,0,0.8)] transition-opacity duration-150 group-hover/node:opacity-100 group-focus-visible/node:opacity-100 ${
                      idx === 0
                        ? 'left-0'
                        : idx === LOOP_STAGES.length - 1
                          ? 'right-0'
                          : 'left-1/2 -translate-x-1/2'
                    }`}
                  >
                    {LOOP_EXPLAIN[s.key]}
                  </span>
                </>
              )
              if (clickable) {
                return (
                  <button
                    key={s.key}
                    type="button"
                    onClick={onReview}
                    title={`${stats.pending} change${stats.pending === 1 ? '' : 's'} waiting on your approval`}
                    className={`group/node relative flex flex-col items-center rounded-[10px] pb-1 ${FOCUS}`}
                  >
                    {node}
                  </button>
                )
              }
              return (
                <div key={s.key} className="group/node relative flex flex-col items-center pb-1">
                  {node}
                </div>
              )
            })}
          </div>
        </div>

        {/* ── Clock axis ───────────────────────────────────────────────────
          Observe/Detect/Propose read the backend right now; Apply/Verify are a
          30-day track record, not the next two steps those same items take.
          Without this split, "15 broken" beside "100% proven fixed" reads
          as the loop contradicting itself instead of two different clocks. */}
        <div className="mt-6 grid grid-cols-5">
          <AxisSpan className="col-span-3 pr-3" label="Right now" />
          <AxisSpan className="col-span-2 pl-3" label="Last 30 days" />
        </div>

        {/* ── Return path — the reason it is a loop and not a pipeline ───── */}
        <ReturnCircuit
          off={off}
          live={live}
          label={
            off ? (
              <>
                Loop paused
                <span className="hidden lg:inline">. Findings are still recorded</span>
              </>
            ) : (
              <>
                Verify feeds the next Observe
                <span className="hidden lg:inline">. No human at the top of the loop</span>
              </>
            )
          }
        />
      </div>
    </div>
  )
}

/** One labelled span of the clock axis: hairline, label, hairline. */
function AxisSpan({ label, className = '' }: { label: string; className?: string }) {
  return (
    <div className={`flex items-center gap-2.5 ${className}`}>
      <span className="h-px flex-1 bg-gradient-to-r from-white/[0.02] to-white/[0.09]" />
      <span className="whitespace-nowrap text-[12px] text-zinc-500">{label}</span>
      <span className="h-px flex-1 bg-gradient-to-l from-white/[0.02] to-white/[0.09]" />
    </div>
  )
}

/**
 * The return path: Verify → Observe, drawn as a U beneath the rail so the five
 * phases visibly close into a circuit.
 *
 * The geometry is measured rather than expressed in percentages because the
 * path is SVG: a percentage viewBox would need preserveAspectRatio="none",
 * which stretches the corner radii into ellipses at wide viewports. Measuring
 * the container and drawing 1:1 keeps the corners circular at every width.
 *
 * Coordinates are snapped to the half-pixel grid, so a 1px stroke lands on one
 * crisp column instead of antialiasing away across two.
 *
 * The travelling signal is a dash pattern on the path itself (pathLength=100
 * normalises the dash units), which is why it follows the corners exactly.
 */
const CIRCUIT_H = 44
const CIRCUIT_R = 12

/** Snap to the half-pixel grid so a 1px stroke lands on one crisp column. */
const crisp = (n: number) => Math.round(n) + 0.5

function ReturnCircuit({ off, live, label }: { off: boolean; live: boolean; label: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const [w, setW] = useState(0)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    setW(el.getBoundingClientRect().width)
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(entries => {
      const next = entries[0]?.contentRect.width ?? 0
      if (next > 0) setW(next)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const x1 = crisp(w * 0.1)
  const x5 = crisp(w * 0.9)
  const h = CIRCUIT_H
  const r = CIRCUIT_R
  const yb = h - 0.5 // bottom run, on the same half-pixel grid
  // Verify (right) → down → left → up → Observe (left).
  const d = w > 0
    ? `M ${x5} 0 V ${yb - r} A ${r} ${r} 0 0 1 ${x5 - r} ${yb} H ${x1 + r} A ${r} ${r} 0 0 1 ${x1} ${yb - r} V 0`
    : ''

  return (
    <div ref={ref} className="relative mt-4" style={{ height: h }}>
      {w > 0 && (
        <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} fill="none" className="absolute inset-0" aria-hidden="true">
          <path d={d} stroke={off ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.14)'} strokeWidth={1} />
          {/* Arrowhead at the Observe end — the loop has a direction. */}
          <path
            d={`M ${x1 - 3.5} 7 L ${x1} 1.5 L ${x1 + 3.5} 7`}
            stroke={off ? 'rgba(255,255,255,0.09)' : 'rgba(196,181,253,0.65)'}
            strokeWidth={1.25}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          {live && (
            <motion.path
              d={d}
              pathLength={100}
              strokeDasharray="14 86"
              stroke="rgba(196,181,253,0.85)"
              strokeWidth={1.25}
              strokeLinecap="round"
              animate={{ strokeDashoffset: [0, -100] }}
              transition={{ duration: 6.4, repeat: Infinity, ease: 'linear' }}
            />
          )}
        </svg>
      )}

      {/* Why the arc exists, said once — set ON the return run like a callout
          on a circuit diagram. */}
      <span className={`pointer-events-none absolute bottom-0 left-1/2 -translate-x-1/2 translate-y-1/2 whitespace-nowrap ${NODE_GROUND} px-3 text-[12px] leading-[16px] text-zinc-500`}>
        {label}
      </span>
    </div>
  )
}

// ── Resource cards ──────────────────────────────────────────────────────────
// The four things a backend HAS: identities, data, files, code. One card each,
// each a link into that section.

interface ResourceCard {
  key: string
  label: string
  icon: LucideIcon
  value: string
  /** Noun beside the numeral ("Tables", "Buckets"). Omitted for a bare count. */
  unit?: string
  /** Right-aligned secondary reading (a size). Omit while unknown — never '0 B'. */
  meta?: string
  /** Dim the numeral when the count is zero, so a real number reads louder. */
  muted?: boolean
  onClick: () => void
}

function ResourceCards({ items }: { items: ResourceCard[] }) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {items.map((m) => (
        <button
          key={m.key}
          type="button"
          onClick={m.onClick}
          className={`group ${PANEL} flex min-h-[124px] flex-col justify-between gap-6 p-4 text-left transition-[border-color,background-color] duration-150 hover:border-white/[0.14] hover:bg-[#111215] ${FOCUS}`}
        >
          <span className="flex items-center gap-2.5">
            <span className="flex h-[28px] w-[28px] flex-shrink-0 items-center justify-center rounded-[7px] border border-white/[0.08] bg-white/[0.03] shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
              <m.icon className="h-[15px] w-[15px] text-zinc-400" strokeWidth={1.75} />
            </span>
            <span className="truncate text-[13px] font-medium text-zinc-200">{m.label}</span>
            <ArrowUpRight className="ml-auto h-4 w-4 flex-shrink-0 text-zinc-600 transition-[color,transform] duration-150 group-hover:-translate-y-px group-hover:translate-x-px group-hover:text-zinc-300" strokeWidth={1.75} />
          </span>

          <span className="flex items-baseline gap-2">
            <span className={`text-[28px] font-semibold leading-none tracking-[-0.03em] tabular-nums ${m.muted ? 'text-zinc-500' : 'text-zinc-50'}`}>
              {m.value}
            </span>
            {m.unit && <span className="text-[13px] leading-none text-zinc-500">{m.unit}</span>}
            {m.meta && (
              <span className="ml-auto whitespace-nowrap text-[12.5px] leading-none text-zinc-500 tabular-nums">{m.meta}</span>
            )}
          </span>
        </button>
      ))}
    </div>
  )
}
