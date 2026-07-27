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
 * The lower two blocks carry SectionLabels. Four panels at one uniform gap
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
 * Design rules that keep this from reading "generated":
 *   – One type scale: 22 / 15 / 13 / 12 / 11 / 10. Tabular numerals everywhere.
 *   – Violet is reserved for: the primary action, the active loop phase, and
 *     attention states. Never decorative.
 *   – Hairline borders only. One entrance animation. No hover-lift on cards.
 *
 * Data sources:
 *   • /api/projects/[id]/build-status        verdict / blocked / failed
 *   • /api/projects/[id]/health              lastCheckedAt, weekly fixes
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
  ArrowUpRight, Braces, ChevronRight, Database, HardDrive, ShieldCheck, User,
} from 'lucide-react'
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
  lastCheckedAt: string | null
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
// Single source of truth for surfaces so panels can't drift apart.
const PANEL = 'rounded-xl border border-white/[0.07] bg-[#16171d]'
const PANEL_SHADOW = 'shadow-[0_16px_44px_-28px_rgba(0,0,0,0.9)]'
const HAIRLINE = 'border-white/[0.06]'

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
      cta: { label: 'Open inspector', onClick: () => router.push(`/app/projects/${projectId}/autonomy`) },
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

  // null = no completed scan yet (the health route kicks one off in the
  // background when it sees this) — show "first check running", not a fake time
  const lastCheckedIso = health?.lastCheckedAt ?? null

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
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.32, ease: [0.25, 0.46, 0.45, 0.94] }}
      className="relative space-y-7"
    >
      {/* ── The agent and its loop — one block, tight internal rhythm ─────
          Header carries the name only. Status lives in the agent panel below;
          the header chip duplicated it. Global actions (Assistant, inbox,
          Connect agent) live in the top bar. ──────────────────────────── */}
      <div className="space-y-3.5">
        <header className="min-w-0 px-1 pt-1">
          <h1 className="truncate text-[22px] font-semibold leading-tight tracking-[-0.01em] text-white">
            {projectName ?? 'Untitled project'}
          </h1>
        </header>

        <AgentPanel
          agent={agent}
          autonomy={autonomy}
          autonomyOff={!!autonomyOff}
          onOpenAutonomy={() => router.push(`/app/projects/${projectId}/autonomy`)}
        />

        {/* The loop used to be a 3px rail crammed into the agent panel's
            footer: the one thing that makes this platform different was the
            least legible element on the page. It is now the page's centerpiece
            — a closed circuit whose readings are the same numbers the Autonomy
            page computes, and whose return path is why the phases never end. */}
        <LoopPanel
          autonomy={autonomy}
          autonomyOff={!!autonomyOff}
          pending={autonomyPending}
          openFindings={openFindings}
          actionableFindings={actionableFindings}
          loopPhase={loopPhase}
          healSignal={healSignal}
          lastCheckedIso={lastCheckedIso}
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
             is stated once here, so the tiles no longer each repeat "· 24h". */}
      <section className="space-y-3">
        <SectionLabel>Runtime · last 24 hours</SectionLabel>
        <ObservabilityStrip projectId={projectId} />
      </section>

      {/* ── Resource cards — the four things a backend HAS. This is the whole
          inventory surface now. The Database / Storage / Realtime / Agent
          journal panels that used to sit below were removed (2026-07-21): each
          restated a number the card above it already carries, and on a project
          with one table they rendered ~600px of void to say "1 table, empty".
          The lists they held are one click away in their own sections, which is
          where "View all" was already sending everyone. ─────────────────── */}
      <section className="space-y-3">
        <SectionLabel>Resources</SectionLabel>
        <ResourceCards items={resources} />
      </section>
    </motion.div>
  )
}

// ── Shared primitives ───────────────────────────────────────────────────────

function Panel({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <section className={`relative overflow-hidden ${PANEL} ${PANEL_SHADOW} ${className}`}>
      {children}
    </section>
  )
}

/**
 * Section heading for the page's lower half. The page used to be four panels
 * at one uniform gap with no hierarchy — everything looked equally important,
 * which on a dashboard means nothing does. These name the two inventory
 * blocks and carry their shared time window so the tiles inside don't each
 * have to repeat it.
 */
function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 px-1">
      <h2 className="text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-500">
        {children}
      </h2>
      <span className="h-px flex-1 bg-gradient-to-r from-white/[0.07] to-transparent" />
    </div>
  )
}

// ── Agent panel ─────────────────────────────────────────────────────────────
// What the agent has to say right now, in its own voice, with the single next
// action — and beside it the one control that governs it (the mode dial) plus
// the promise that survives every mode.
//
// The loop moved OUT of this panel on 2026-07-21. Bolted to the footer here it
// rendered as five 6px dots on a hairline: the product's signature reduced to
// the least legible element on the page. It now owns LoopPanel below, and this
// panel is a short, dense report instead of a tall one with a void under the
// CTA.

type LoopPhase = 'observe' | 'detect' | 'propose' | 'apply' | 'verify'

const LOOP_STAGES: Array<{ key: LoopPhase; label: string }> = [
  { key: 'observe', label: 'Observe' },
  { key: 'detect',  label: 'Detect'  },
  { key: 'propose', label: 'Propose' },
  { key: 'apply',   label: 'Apply'   },
  { key: 'verify',  label: 'Verify'  },
]

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
      {/* single restrained accent: hairline glow along the top edge */}
      <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-violet-300/40 to-transparent" />

      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_300px]">
        {/* ── Left: the agent's report ──────────────────────────────────── */}
        <div className="flex flex-col justify-center px-5 py-5 sm:px-6">
          <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-500">
            <span className="relative flex h-[6px] w-[6px]">
              {!autonomyOff && (
                <motion.span
                  animate={{ opacity: [0.25, 0.8, 0.25] }}
                  transition={{ duration: 3, repeat: Infinity, ease: 'easeInOut' }}
                  className="absolute inset-[-3px] rounded-full bg-violet-400/30"
                />
              )}
              <span className={`relative h-[6px] w-[6px] rounded-full ${autonomyOff ? 'bg-zinc-600' : 'bg-violet-300'}`} />
            </span>
            Backend agent
          </div>

          <div className="mt-3 min-h-[26px]">
            <AnimatePresence mode="wait" initial={false}>
              <motion.h2
                key={agent.headline}
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.3, ease: [0.25, 0.46, 0.45, 0.94] }}
                className="text-[19px] font-semibold leading-snug tracking-[-0.01em] text-white"
              >
                {agent.headline}
              </motion.h2>
            </AnimatePresence>
          </div>
          <p className="mt-1.5 max-w-xl text-[13px] leading-6 text-zinc-400">
            {agent.body}
          </p>

          {(agent.cta || agent.quiet) && (
            <div className="mt-4 flex items-center gap-3">
              {agent.cta && (
                <button
                  onClick={agent.cta.onClick}
                  className="group inline-flex h-8 items-center gap-1.5 rounded-lg bg-white px-3.5 text-[12px] font-semibold text-black transition-colors hover:bg-zinc-200 focus:outline-none focus:ring-2 focus:ring-violet-400/50"
                >
                  {agent.cta.label}
                  <ArrowUpRight className="h-3 w-3 opacity-90 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
                </button>
              )}
              {agent.quiet && (
                <button
                  onClick={agent.quiet.onClick}
                  className="group inline-flex items-center gap-0.5 text-[12px] font-medium text-zinc-500 transition-colors hover:text-zinc-200 focus:outline-none"
                >
                  {agent.quiet.label}
                  <ChevronRight className="h-3 w-3 transition-transform group-hover:translate-x-0.5" />
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
        <div className={`border-t lg:border-l lg:border-t-0 ${HAIRLINE} flex flex-col`}>
          <button
            type="button"
            onClick={onOpenAutonomy}
            className="group/mode flex-1 px-5 py-4 text-left transition-colors hover:bg-white/[0.02] focus:outline-none focus:ring-2 focus:ring-inset focus:ring-violet-400/30"
          >
            <span className="flex items-center justify-between">
              <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-600">Mode</span>
              <ChevronRight className="h-3.5 w-3.5 text-zinc-700 transition-all group-hover/mode:translate-x-0.5 group-hover/mode:text-zinc-400" />
            </span>
            <span className="mt-1.5 flex items-baseline gap-2">
              <span className={`text-[15px] font-semibold tracking-[-0.01em] ${autonomyOff ? 'text-zinc-400' : 'text-white'}`}>
                {mode ?? '—'}
              </span>
              {!autonomyOff && mode && (
                <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-violet-300/80">live</span>
              )}
            </span>
            {mode && MODE_MEANING[mode] && (
              <span className="mt-1.5 block text-[11.5px] leading-[1.45] text-zinc-500">
                {MODE_MEANING[mode]}
              </span>
            )}
          </button>
          <div className={`border-t ${HAIRLINE} flex items-start gap-2 px-5 py-3`}>
            <ShieldCheck className="mt-px h-3.5 w-3.5 flex-shrink-0 text-zinc-600" />
            <p className="text-[11px] leading-4 text-zinc-500">
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
  loopPhase, healSignal, lastCheckedIso, onReview,
}: {
  autonomy: ReturnType<typeof useAutonomyStatus>['status']
  autonomyOff: boolean
  pending: number
  openFindings: number | null
  actionableFindings: number | null
  loopPhase: LoopPhase
  healSignal: number
  lastCheckedIso: string | null
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
      <div className={`flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-b ${HAIRLINE} px-5 py-3.5 sm:px-6`}>
        <div className="flex items-center gap-2.5">
          <h2 className="text-[13px] font-semibold tracking-tight text-zinc-100">Self-healing loop</h2>
          <LiveBadge off={autonomyOff} />
        </div>
        <span className="font-mono text-[10.5px] text-zinc-600 tabular-nums">
          {autonomyOff
            ? 'records & suggests only'
            : lastCheckedIso ? `checked ${formatRelative(lastCheckedIso)}` : 'first check running…'}
        </span>
      </div>

      {/* ── The circuit ────────────────────────────────────────────────── */}
      <div className="px-5 pb-5 pt-6 sm:px-8">
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
          the guardrail action log, already folded by repeat server-side. The
          trust ledger used to show exactly one of these rows, clamped to two
          lines in a 300px column. Three rows with their own tone marker say
          far more and cost less height. ────────────────────────────────── */}
      {receipts.length > 0 && (
        <div className={`border-t ${HAIRLINE}`}>
          <ul className="divide-y divide-white/[0.04]">
            {receipts.map((a, i) => (
              <ReceiptRow key={`${a.at}-${i}`} item={a} />
            ))}
          </ul>
          <button
            type="button"
            onClick={onReview}
            className={`group/all flex w-full items-center justify-between border-t ${HAIRLINE} px-5 py-2.5 text-left transition-colors hover:bg-white/[0.02] focus:outline-none sm:px-6`}
          >
            <span className="text-[11.5px] font-medium text-zinc-500 transition-colors group-hover/all:text-zinc-300">
              Full guardrail log, restore points and approvals
            </span>
            <ChevronRight className="h-3.5 w-3.5 text-zinc-700 transition-all group-hover/all:translate-x-0.5 group-hover/all:text-zinc-400" />
          </button>
        </div>
      )}
    </Panel>
  )
}

/** Live / paused state of the loop, as a single quiet chip. */
function LiveBadge({ off }: { off: boolean }) {
  const reduced = useReducedMotion()
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-[3px] text-[9.5px] font-semibold uppercase tracking-[0.12em] ${
        off
          ? 'border-white/[0.06] text-zinc-600'
          : 'border-violet-400/20 bg-violet-400/[0.07] text-violet-200/90'
      }`}
    >
      <span className="relative flex h-[5px] w-[5px]">
        {!off && !reduced && (
          <motion.span
            animate={{ opacity: [0.2, 0.85, 0.2], scale: [1, 1.9, 1] }}
            transition={{ duration: 2.4, repeat: Infinity, ease: 'easeInOut' }}
            className="absolute inset-0 rounded-full bg-violet-300/50"
          />
        )}
        <span className={`relative h-[5px] w-[5px] rounded-full ${off ? 'bg-zinc-600' : 'bg-violet-300'}`} />
      </span>
      {off ? 'Paused' : 'Running'}
    </span>
  )
}

// Receipt tone: the row's marker colour states what KIND of act it was, so a
// rollback or a failed apply can never read as routine. Amber/rose match the
// status vocabulary the observability strip already uses.
const RECEIPT_TONE: Record<string, string> = {
  auto_fix:   'bg-violet-400/70',
  applied:    'bg-violet-400/70',
  escalation: 'bg-amber-400/70',
  rollback:   'bg-amber-400/70',
  failed:     'bg-rose-400/70',
  breaker:    'bg-rose-400/70',
  shadow:     'bg-zinc-600',
  other:      'bg-zinc-600',
}

function ReceiptRow({ item }: { item: AutonomyLastAction }) {
  return (
    <li className="flex items-start gap-3 px-5 py-2.5 sm:px-6">
      <span className={`mt-[6px] h-1.5 w-1.5 flex-shrink-0 rounded-full ${RECEIPT_TONE[item.kind] ?? RECEIPT_TONE.other}`} />
      <span className="min-w-0 flex-1 text-[12px] leading-[1.5] text-zinc-400">
        <span className="line-clamp-2">{item.summary}</span>
        {(item.repeat ?? 1) > 1 && (
          <span className="ml-1.5 font-mono text-[10.5px] tabular-nums text-zinc-600">×{item.repeat}</span>
        )}
      </span>
      <span className="flex-shrink-0 pt-px font-mono text-[10.5px] text-zinc-600 tabular-nums">
        {formatRelative(item.at)}
      </span>
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
 * Every node carries its REAL reading (invariants watched, findings needing
 * attention, held for review, fixes 30d, verified rate) and the axis beneath
 * says which clock each reading is on — Observe/Detect/Propose are an instant
 * snapshot, Apply/Verify a 30-day track record. Without that split "15 need
 * attention" beside "100% verified" reads as the loop contradicting itself.
 *
 * Motion is telemetry, never theater: the lit node is the real derived phase,
 * the heal sweep fires only when a finding genuinely closed, OFF freezes the
 * whole circuit, and prefers-reduced-motion renders it static. Numbers come
 * from the same trust report the Autonomy page renders, so the two surfaces
 * cannot disagree.
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
      unit: 'guarantees',
    },
    detect: {
      // open + pending_approval. Autonomy renders exactly this set across its
      // two cards — Detected (open) + Waiting on you (held) — so this number is
      // the sum of what that page shows, never larger than it. The Backend
      // health list this used to point at was deleted on 2026-07-21.
      value: stats.actionableFindings == null ? '—' : String(stats.actionableFindings),
      unit: 'need attention',
    },
    propose: {
      value: stats.pending == null ? '—' : String(stats.pending),
      // A SUBSET of `detect`, not a separate population. The units say so.
      unit: 'of those, held for you',
      accent: (stats.pending ?? 0) > 0,
    },
    apply: {
      value: stats.fixes30d == null ? '—' : String(stats.fixes30d),
      unit: 'fixed · 30d',
    },
    verify: {
      value: stats.verifiedRate == null ? '—' : `${Math.round(stats.verifiedRate * 100)}%`,
      // Matches Apply's '· 30d' on purpose: this is the hold-up rate of THOSE
      // 30-day fixes, not a live score against what Detect shows right now.
      // Without the matching window label, "15 need attention" next to "100%
      // verified" reads as a straight contradiction instead of two different
      // clocks — the single biggest source of "this makes no sense" reports.
      unit: 'verified · 30d',
    },
  }

  return (
    <div
      className="relative"
      aria-label={off ? 'Autonomy loop off' : `Autonomy loop phase: ${phase}`}
    >
      {/* ── Rail + phase nodes ───────────────────────────────────────────
          A five-column grid, not justify-between: the node centers then sit at
          exactly 10/30/50/70/90% of the width, which is what lets the rail and
          the return arc below anchor to them at any viewport size. ──────── */}
      <div className="relative">
        {/* Rail — one hairline through the node centers (top = NODE/2). */}
        <div className={`absolute left-[10%] right-[10%] top-[13px] h-px ${off ? 'bg-white/[0.05]' : 'bg-white/[0.08]'}`} />

        {/* The signal: two comets travelling the rail, clipped to a 3px strip
            so they enter and leave cleanly at the first and last node. */}
        {live && (
          <div className="pointer-events-none absolute left-[10%] right-[10%] top-[12px] h-[3px] overflow-hidden">
            <motion.span
              className="absolute top-[1px] h-px w-28 bg-[linear-gradient(to_right,transparent,rgba(196,181,253,0.85),transparent)]"
              animate={{ left: ['-18%', '104%'] }}
              transition={{ duration: 5.6, repeat: Infinity, ease: 'linear' }}
            />
            <motion.span
              className="absolute top-[1px] h-px w-16 bg-[linear-gradient(to_right,transparent,rgba(196,181,253,0.4),transparent)]"
              animate={{ left: ['-18%', '104%'] }}
              transition={{ duration: 5.6, repeat: Infinity, ease: 'linear', delay: 2.8 }}
            />
          </div>
        )}

        {/* The heal signal: one bright pulse driving the fix down the rail from
            Detect to Verify. Fires once per real self-heal, keyed so re-heals
            replay it cleanly. */}
        {heal && !reduced && (
          <div className="pointer-events-none absolute left-[10%] right-[10%] top-[12px] h-[3px] overflow-hidden">
            <motion.span
              key={heal.id}
              className="absolute top-[1px] h-[1.5px] w-24 rounded-full bg-[linear-gradient(to_right,transparent,rgba(196,181,253,1),transparent)]"
              initial={{ left: '4%', opacity: 0 }}
              animate={{ left: '96%', opacity: [0, 1, 1, 0.6] }}
              transition={{ duration: 2.0, ease: 'easeInOut' }}
            />
          </div>
        )}

        {/* Phase nodes — circles mask the rail with the panel background. Each
            node shows its live reading; Propose navigates to the queue when
            something is actually waiting. */}
        <div className="relative grid grid-cols-5">
          {LOOP_STAGES.map((s, idx) => {
            const healingHere = healingIndex === idx
            const active = !off && (healingIndex != null ? healingHere : s.key === phase)
            const r = readings[s.key]
            const clickable = s.key === 'propose' && (stats.pending ?? 0) > 0
            const valueClass = `font-mono text-[21px] font-medium tabular-nums leading-none tracking-[-0.01em] ${
              r.accent ? 'text-violet-300' : off ? 'text-zinc-600' : active ? 'text-white' : 'text-zinc-300'
            }`
            const node = (
              <>
                <span
                  className={`relative flex h-[26px] w-[26px] items-center justify-center rounded-full border bg-[#16171d] transition-colors ${
                    active ? 'border-violet-400/45' : off ? 'border-white/[0.05]' : 'border-white/[0.09]'
                  }`}
                >
                  {active && !reduced && !healingHere && (
                    <motion.span
                      animate={{ opacity: [0.15, 0.5, 0.15], scale: [1, 1.5, 1] }}
                      transition={{ duration: 2.2, repeat: Infinity, ease: 'easeInOut' }}
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
                    className={`relative h-[6px] w-[6px] rounded-full transition-colors ${
                      active ? 'bg-violet-300' : off ? 'bg-zinc-700' : 'bg-zinc-600'
                    }`}
                  />
                </span>

                <span
                  className={`mt-2.5 text-[9.5px] font-semibold uppercase tracking-[0.14em] transition-colors ${
                    active ? 'text-violet-200' : 'text-zinc-500'
                  }`}
                >
                  {s.label}
                </span>

                {/* The reading, stacked under its phase: numeral then unit, so
                    the numbers form one scannable row across the instrument
                    instead of five inline value+unit clumps of varying width. */}
                <span className="mt-2 flex h-[21px] items-center">
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

                <span className="mt-1.5 max-w-[132px] px-1 text-center text-[10px] leading-[1.35] text-zinc-600">
                  {r.unit}
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
                  className="group/loop flex flex-col items-center rounded-lg focus:outline-none focus:ring-2 focus:ring-violet-400/30"
                >
                  {node}
                </button>
              )
            }
            return (
              <div key={s.key} className="flex flex-col items-center">
                {node}
              </div>
            )
          })}
        </div>
      </div>

      {/* ── Clock axis ───────────────────────────────────────────────────
          Observe/Detect/Propose read the backend right now; Apply/Verify are a
          30-day track record, not the next two steps those same items take.
          Without this split, "15 need attention" beside "100% verified" reads
          as the loop contradicting itself instead of two different clocks —
          one instant snapshot, one rolling window. It used to be two 9px words
          in zinc-700 that nobody saw; it is now a ruled axis under the
          readings it governs. ─────────────────────────────────────────── */}
      <div className="mt-5 grid grid-cols-5">
        <AxisSpan className="col-span-3 pr-3" label="right now" />
        <AxisSpan className="col-span-2 pl-3" label="last 30 days" />
      </div>

      {/* ── Return path — the reason it is a loop and not a pipeline ───── */}
      <ReturnCircuit
        off={off}
        live={live}
        label={
          off ? (
            <>
              Loop paused
              <span className="hidden lg:inline"> — findings are still recorded</span>
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
  )
}

/** One labelled span of the clock axis: hairline — label — hairline. */
function AxisSpan({ label, className = '' }: { label: string; className?: string }) {
  return (
    <div className={`flex items-center gap-2.5 ${className}`}>
      <span className="h-px flex-1 bg-gradient-to-r from-white/[0.02] to-white/[0.08]" />
      <span className="whitespace-nowrap text-[9px] font-semibold uppercase tracking-[0.16em] text-zinc-600">
        {label}
      </span>
      <span className="h-px flex-1 bg-gradient-to-l from-white/[0.02] to-white/[0.08]" />
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
 * Coordinates are snapped to the half-pixel grid. A 1px stroke at a fractional
 * x (and x = width * 0.1 is fractional at almost every viewport) antialiases
 * across two pixel columns at half opacity each, which at these stroke alphas
 * made the path disappear entirely — leaving only the travelling signal
 * visible, so the circuit read as two disconnected brackets.
 *
 * That signal is a dash pattern on the path itself (pathLength=100 normalises
 * the dash units, so no length maths), which is why it follows the corners
 * exactly — an absolutely-positioned dot animating left/top would cut across
 * them.
 */
const CIRCUIT_H = 42
const CIRCUIT_R = 10

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
    <div ref={ref} className="relative mt-3.5" style={{ height: h }}>
      {w > 0 && (
        <svg
          width={w}
          height={h}
          viewBox={`0 0 ${w} ${h}`}
          fill="none"
          className="absolute inset-0"
          aria-hidden="true"
        >
          <path
            d={d}
            stroke={off ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.13)'}
            strokeWidth={1}
          />
          {/* Arrowhead at the Observe end — the loop has a direction. */}
          <path
            d={`M ${x1 - 3.5} 7 L ${x1} 1.5 L ${x1 + 3.5} 7`}
            stroke={off ? 'rgba(255,255,255,0.09)' : 'rgba(196,181,253,0.55)'}
            strokeWidth={1.25}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          {live && (
            <motion.path
              d={d}
              pathLength={100}
              strokeDasharray="16 84"
              stroke="rgba(196,181,253,0.8)"
              strokeWidth={1.25}
              strokeLinecap="round"
              animate={{ strokeDashoffset: [0, -100] }}
              transition={{ duration: 5.6, repeat: Infinity, ease: 'linear' }}
            />
          )}
        </svg>
      )}

      {/* Why the arc exists, said once — set ON the return run like a callout
          on a circuit diagram. Floating it in the middle of the enclosed space
          read as a caption stranded in a large empty box. */}
      <span className="pointer-events-none absolute bottom-0 left-1/2 -translate-x-1/2 translate-y-1/2 whitespace-nowrap bg-[#16171d] px-3 text-[10px] leading-none text-zinc-600">
        {label}
      </span>
    </div>
  )
}

// ── Resource cards ──────────────────────────────────────────────────────────
// The four things a backend HAS: identities, data, files, code. One card each,
// each an open-in link to that section. Icon + label on the top line, the
// reading on the bottom line — big numeral, its unit beside it, the size
// measurement right-aligned. Still the flat kit: hairline borders, mono
// numerals, no gradient chrome, violet only on focus.

interface ResourceCard {
  key: string
  label: string
  icon: React.ComponentType<{ className?: string }>
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
          className={`group ${PANEL} ${PANEL_SHADOW} flex flex-col justify-between gap-6 px-4 py-3.5 text-left transition-colors hover:border-white/[0.12] hover:bg-white/[0.02] focus:outline-none focus:ring-2 focus:ring-inset focus:ring-violet-400/30`}
        >
          <span className="flex items-center gap-2">
            <m.icon className="h-3.5 w-3.5 flex-shrink-0 text-zinc-500" />
            <span className="truncate text-[12.5px] font-medium text-zinc-300">{m.label}</span>
            <ArrowUpRight className="ml-auto h-3.5 w-3.5 flex-shrink-0 text-zinc-700 transition-colors group-hover:text-zinc-400" />
          </span>

          <span className="flex items-baseline gap-1.5">
            <span className={`font-mono text-[22px] font-medium leading-none tabular-nums ${m.muted ? 'text-zinc-500' : 'text-white'}`}>
              {m.value}
            </span>
            {m.unit && <span className="text-[11.5px] leading-none text-zinc-500">{m.unit}</span>}
            {m.meta && (
              <span className="ml-auto whitespace-nowrap font-mono text-[11.5px] leading-none text-zinc-500 tabular-nums">
                {m.meta}
              </span>
            )}
          </span>
        </button>
      ))}
    </div>
  )
}
