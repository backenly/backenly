'use client'

/**
 * The dashboard drawn in DOM for the hero — the real shell around real section
 * pages, miniaturized from screenshots of a live project ("CofounderConnect",
 * 2026-07-30) and the components that render it.
 *
 * Subject changed 2026-07-30. It was "Ecommerce platform" (screenshots
 * 2026-07-23), which has since been deleted — so that version of this console
 * depicted a project that no longer exists and could never be re-verified.
 * Anything still carrying its numbers is stale by definition; see
 * SECTION_PANELS for what is outstanding.
 *
 * Drawn, not screenshotted, for the same reason AutonomyFilm is drawn and not
 * filmed: a screenshot of our own dashboard shipped on this page once and had
 * to be pulled because the product had moved underneath it. Drawn DOM makes
 * drift a one-file diff instead of a reshoot.
 *
 * Fidelity contract — every surface here exists, with its real copy:
 *
 *   - Top bar: org + plan chip, project breadcrumb, Production chip, inbox
 *     with pending count, Assistant, Connect agent, avatar — the real shell's
 *     top bar (project context lives HERE, not in the sidebar).
 *   - Sidebar: components/shell/ProjectSidebar.tsx verbatim — Build / Operate
 *     / Connect groups with chevrons, Functions count badge, MCP tag, the
 *     neutral active treatment with its violet inset rail, frontend pill at
 *     the foot.
 *   - Canvas: components/workspace/WorkspaceHome.tsx — agent panel ("All clear.
 *     Self-healing on watch", Autopilot + LIVE, the always-approval promise),
 *     the self-healing loop (RUNNING chip, five phases with their real unit
 *     copy, RIGHT NOW / LAST 30 DAYS windows, the return-arc caption "Verify
 *     feeds the next Observe — no human at the top of the loop"), the agent's
 *     receipts in its own voice, the runtime strip, the Resources cards.
 *   - Sections: the Database, Auth & Users and Storage inspector pages.
 *
 * One consistent story, and every number in it is this project's: nothing is
 * held, so Detect and Propose read 0, the agent says "All clear", Observe is
 * the lit node and there is no Review button at all. 15 fixes in 30 days, 100%
 * verified. 6 functions in the sidebar badge and the Resources card. 19 users
 * in Resources and 19 identities in Auth. 7 tables in Resources, in the
 * Database rail and in its "7 tables" footer. 0 buckets in Resources and the
 * empty Storage state. No traffic, so the runtime strip shows em dashes rather
 * than an invented uptime, and no frontend is paired, so the sidebar pill is
 * the unpaired one.
 *
 * Palette tracks the product's neutral-first system (2026-07-23): buttons
 * and surfaces are monochrome; violet appears only where the product keeps
 * it as an accent — status dots, the LIVE tag, the active
 * loop node, the sidebar's inset rail.
 *
 * INTERACTIVE as of 2026-07-30, on an explicit decision that supersedes both
 * "hero mocks stay static" and the older no-animated-hero tombstone. Two
 * behaviours were asked for by name:
 *
 *   1. The sidebar is a real tour. Sections with a panel are buttons; visitors
 *      click through to see inside. Only sections whose contents were verified
 *      against a live screenshot get a panel — the rest stay inert rather than
 *      shipping a guess, which is what got two earlier mocks pulled.
 *   2. The self-healing loop runs continuously, walking Observe → Verify and
 *      back. This is a truthful depiction: the real loop reconciles on a
 *      cadence for every plan, Free included.
 *
 * What deliberately does NOT animate: the readings themselves. 14 guarantees,
 * 3 held, 4 fixed, 100% verified are one live project's real numbers, so the
 * traversal moves and the values stay put. Animating them would be inventing
 * data on the one surface whose whole job is to be an honest projection.
 *
 * Hydration: the first client render is byte-identical to the server's — the
 * cycle starts inside an effect and the motion preference is read there too,
 * never during render. Reading it during render is what makes the rest of this
 * page throw #418/#425 for reduced-motion visitors; this component must not
 * add to that.
 */

import { useEffect, useRef, useState } from 'react'
import {
  Activity,
  AlertTriangle,
  ArrowUpRight,
  Bot,
  Braces,
  Cable,
  Check,
  ChevronDown,
  ChevronRight,
  Code2,
  Columns,
  Database,
  FileText,
  Folder,
  Gauge,
  GitBranch,
  Github,
  HardDrive,
  Inbox,
  LayoutDashboard,
  Mail,
  Menu,
  Plus,
  Radio,
  RefreshCw,
  Rocket,
  Search,
  Settings,
  Shield,
  ShieldCheck,
  Sparkles,
  Table,
  Timer,
  Upload,
  User,
  Zap,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

/**
 * The four sections the tour covers. A section becomes clickable only once its
 * panel exists in SECTION_PANELS, so adding one is a single entry and a nav
 * `section` key — and a section whose insides have not been verified against a
 * live screenshot simply stays inert instead of shipping invented contents.
 */
type SectionId = 'overview' | 'database' | 'auth' | 'storage'

/* Mirrors components/shell/ProjectSidebar.tsx — keep in sync by hand. */
const NAV: {
  label?: string
  items: {
    title: string
    icon: LucideIcon
    tag?: string
    count?: number
    section?: SectionId
  }[]
}[] = [
  { items: [{ title: 'Overview', icon: LayoutDashboard, section: 'overview' }] },
  {
    label: 'Build',
    items: [
      { title: 'Database', icon: Database, section: 'database' },
      { title: 'Auth & Users', icon: Shield, section: 'auth' },
      { title: 'Storage', icon: HardDrive, section: 'storage' },
      { title: 'Functions', icon: Code2, count: 6 },
      { title: 'Realtime', icon: Radio },
      { title: 'Integrations', icon: Zap },
    ],
  },
  {
    label: 'Operate',
    items: [
      { title: 'Autonomy', icon: Bot },
      { title: 'Monitoring', icon: Activity },
      { title: 'Branches', icon: GitBranch },
      { title: 'Deploy', icon: Rocket },
    ],
  },
  {
    label: 'Connect',
    items: [{ title: 'Connect', icon: Cable, tag: 'MCP' }],
  },
  { items: [{ title: 'Settings', icon: Settings }] },
]

/* Mirrors the SelfHealingLoop readings. */
const LOOP = [
  { label: 'Observe', value: '14', unit: 'guarantees' },
  { label: 'Detect', value: '0', unit: 'need attention' },
  { label: 'Propose', value: '0', unit: 'of those, held for you' },
  { label: 'Apply', value: '15', unit: 'fixed · 30d' },
  { label: 'Verify', value: '100%', unit: 'verified · 30d' },
] as const

/** One phase per 1.5s: slow enough to read the label, quick enough that a
    visitor sees the loop close before they scroll past. */
const PHASE_MS = 1500

/**
 * Observe is the resting phase — it is the node lit on the live surface, which
 * follows from nothing being held: Detect and Propose are both 0, so the loop
 * is watching rather than waiting on anyone. Both the server render and
 * reduced-motion visitors stop here, so the still frame is the frame the live
 * project is actually in.
 */
const RESTING_PHASE = 0

/**
 * Walks the loop while it is on screen.
 *
 * The motion preference is read inside the effect rather than during render:
 * a render-time read would make the first client paint disagree with the
 * server's and throw the same hydration errors the rest of this page already
 * has. Same reason the initial state is a constant.
 *
 * The IntersectionObserver is not a nicety — this is the hero of the busiest
 * page on the site, and a timer that keeps firing after the visitor has
 * scrolled to the footer is pure waste.
 */
function useLoopWalk() {
  const [phase, setPhase] = useState(RESTING_PHASE)
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const node = panelRef.current
    if (!node) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return

    let timer: ReturnType<typeof setInterval> | undefined
    const stop = () => {
      if (timer) clearInterval(timer)
      timer = undefined
    }
    const start = () => {
      if (timer) return
      timer = setInterval(() => setPhase((p) => (p + 1) % LOOP.length), PHASE_MS)
    }

    const observer = new IntersectionObserver(
      ([entry]) => (entry.isIntersecting ? start() : stop()),
      { threshold: 0.2 },
    )
    observer.observe(node)

    return () => {
      stop()
      observer.disconnect()
    }
  }, [])

  return { phase, panelRef }
}

/**
 * The agent's receipts, in its own voice — copy verbatim from the product. The
 * top one is the emphasised row on the live surface; the rest sit dimmer.
 */
const RECEIPTS = [
  { text: 'Applied your approved fix: contract surface broken — verified & snapshotted', bright: true },
  { text: 'data plane heal verified', bright: false },
  { text: 'You approved a fix — applying it now', bright: false },
]

/**
 * Mirrors ObservabilityStrip.tsx tiles. This project has taken no traffic, so
 * reliability and latency have nothing to average and the surface says so with
 * an em dash rather than a fabricated 100%.
 */
const RUNTIME: { label: string; icon: LucideIcon; value: string; hint?: string }[] = [
  { label: 'Requests', icon: Activity, value: '0' },
  { label: 'Reliability', icon: Gauge, value: '—', hint: 'No traffic yet' },
  { label: 'Avg response', icon: Timer, value: '—' },
  { label: 'Failed', icon: AlertTriangle, value: '0' },
]

/* Mirrors the Resources cards. Functions = 6, same as the sidebar badge; Users
   = 19, the same identities Auth & Users counts. */
const RESOURCES: { label: string; icon: LucideIcon; value: string; unit: string; meta?: string }[] = [
  { label: 'Users', icon: User, value: '19', unit: 'Users' },
  { label: 'Database', icon: Database, value: '7', unit: 'Tables', meta: '792.0 KB' },
  { label: 'Storage', icon: HardDrive, value: '0', unit: 'Buckets', meta: '0 B' },
  { label: 'Functions', icon: Braces, value: '6', unit: 'Functions' },
]

const PANEL = 'rounded-xl border border-white/[0.08] bg-[#16171d]'
const LABEL = 'text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-600'

function TopBar() {
  return (
    <div className="flex items-center justify-between border-b border-white/[0.07] bg-[#141519] px-3.5 py-2">
      <div className="flex min-w-0 items-center gap-2.5">
        <Menu className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
        <span className="hidden items-center gap-1.5 sm:flex">
          <span className="text-[12px] font-medium text-zinc-200">Adarsh</span>
          <span className="rounded bg-white/[0.06] px-1 py-0.5 text-[9px] leading-none text-zinc-400">
            Free
          </span>
        </span>
        <span className="hidden text-zinc-700 sm:inline">/</span>
        <span className="flex items-center gap-1.5 text-[12px] font-medium text-zinc-200">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
          CofounderConnect
          <ChevronDown className="h-3 w-3 text-zinc-600" />
        </span>
        <span className="text-zinc-700">/</span>
        <span className="inline-flex items-center gap-1.5 rounded-md border border-white/[0.09] px-2 py-0.5 font-mono text-[10px] text-zinc-400">
          <span className="h-1 w-1 rounded-full bg-emerald-400" />
          Production
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {/* No count badge, mirroring the real TopBar (no-badges rule). */}
        <span className="relative rounded-md border border-white/[0.14] bg-white/[0.06] p-1.5">
          <Inbox className="h-3.5 w-3.5 text-zinc-300" />
        </span>
        <span className="hidden items-center gap-1.5 rounded-md border border-white/[0.09] px-2 py-1 text-[11px] font-medium text-zinc-300 sm:inline-flex">
          <Sparkles className="h-3 w-3" />
          Assistant
        </span>
        <span className="inline-flex items-center gap-1.5 rounded-md bg-white px-2 py-1 text-[11px] font-semibold text-black">
          <Cable className="h-3 w-3" />
          Connect agent
        </span>
        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-white/[0.08] text-[9px] font-semibold text-zinc-300">
          AC
        </span>
      </div>
    </div>
  )
}

function AgentPanelMini() {
  return (
    <div className={`${PANEL} grid grid-cols-1 overflow-hidden sm:grid-cols-[minmax(0,1fr)_230px]`}>
      <div className="px-5 py-4">
        <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-500">
          <span className="h-[6px] w-[6px] rounded-full bg-violet-300" />
          Backend agent
        </div>
        {/* The all-clear state carries NO call to action — there is nothing to
            review when Detect and Propose are both 0. The Review button belongs
            to the held-changes state and would be a fabricated affordance
            here. */}
        <p className="mt-2.5 text-[17px] font-semibold leading-snug tracking-[-0.01em] text-white">
          All clear. Self-healing on watch
        </p>
        <p className="mt-1 max-w-md text-[12px] leading-5 text-zinc-400">
          Schema, APIs, auth and storage are healthy. Backenly re-checks continuously and repairs
          safe issues on its own. Only auth or destructive changes ever wait for you.
        </p>
      </div>
      <div className="flex flex-col border-t border-white/[0.07] sm:border-l sm:border-t-0">
        <div className="flex-1 px-4 py-3.5">
          <div className="flex items-center justify-between">
            <span className={LABEL}>Mode</span>
            <ChevronRight className="h-3 w-3 text-zinc-700" />
          </div>
          <p className="mt-1 flex items-baseline gap-2">
            <span className="text-[14px] font-semibold text-white">Autopilot</span>
            <span className="font-mono text-[9px] uppercase tracking-[0.12em] text-violet-300/80">
              live
            </span>
          </p>
          <p className="mt-1 text-[10.5px] leading-4 text-zinc-500">
            Safe fixes ship on their own. Everything risky waits for you.
          </p>
        </div>
        <div className="flex items-start gap-2 border-t border-white/[0.07] px-4 py-2.5">
          <ShieldCheck className="mt-px h-3 w-3 shrink-0 text-zinc-600" />
          <p className="text-[10px] leading-4 text-zinc-500">
            Auth, destructive and irreversible changes always need your approval, in every mode.
          </p>
        </div>
      </div>
    </div>
  )
}

function LoopPanelMini() {
  const { phase, panelRef } = useLoopWalk()

  return (
    <div ref={panelRef} className={`${PANEL} overflow-hidden`}>
      <div className="flex items-center justify-between border-b border-white/[0.06] px-5 py-3">
        <div className="flex items-center gap-2.5">
          <span className="text-[13px] font-semibold text-white">Self-healing loop</span>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-white/[0.09] px-2 py-0.5 text-[8.5px] font-semibold uppercase tracking-[0.14em] text-zinc-300">
            <span className="h-1 w-1 rounded-full bg-violet-300" />
            Running
          </span>
        </div>
        {/* The real panel reads the reconciler's own clock, which ticks every
            minute on every plan (lib/autonomy/loop-tick.ts). "23h" was left here
            from when this label was wired to the daily observer sweep, so the
            page selling self-healing every minute showed a day-old timestamp
            beside a RUNNING badge. The mock mirrors the real surface. */}
        <span className="font-mono text-[10px] text-zinc-600">checked 1m ago</span>
      </div>

      <div className="px-4 pb-3 pt-4 sm:px-6">
        <div className="relative">
          <div className="absolute left-[10%] right-[10%] top-[10px] h-px bg-white/[0.08]" />
          <div className="relative grid grid-cols-5">
            {LOOP.map((stage, i) => {
              // Exactly one node is lit, as in the product. The walk is the
              // highlight moving; no extra "done" state is invented for the
              // phases behind it, because the real panel does not have one.
              const active = i === phase
              return (
                <div key={stage.label} className="flex flex-col items-center text-center">
                  <span
                    className={`flex h-[20px] w-[20px] items-center justify-center rounded-full border bg-[#16171d] transition-colors duration-500 ${
                      active ? 'border-violet-400/45' : 'border-white/[0.09]'
                    }`}
                  >
                    <span
                      className={`h-[5px] w-[5px] rounded-full transition-colors duration-500 ${
                        active ? 'bg-violet-300' : 'bg-zinc-600'
                      }`}
                    />
                  </span>
                  <span
                    className={`mt-2 text-[8px] font-semibold uppercase tracking-[0.13em] transition-colors duration-500 sm:text-[9px] ${
                      active ? 'text-violet-200' : 'text-zinc-500'
                    }`}
                  >
                    {stage.label}
                  </span>
                  <span
                    className={`mt-1.5 font-mono text-[16px] font-medium tabular-nums leading-none tracking-[-0.01em] transition-colors duration-500 ${
                      active ? 'text-violet-300' : 'text-zinc-300'
                    }`}
                  >
                    {stage.value}
                  </span>
                  <span className="mt-1 hidden px-1 text-[9px] leading-tight text-zinc-600 sm:block">
                    {stage.unit}
                  </span>
                </div>
              )
            })}
          </div>
        </div>

        {/* The two windows, then the return path — the loop's whole argument. */}
        <div className="mt-3 hidden grid-cols-5 sm:grid">
          <div className="col-span-3 flex items-center gap-2 px-4">
            <span className="h-px flex-1 bg-white/[0.05]" />
            <span className="text-[8.5px] font-semibold uppercase tracking-[0.16em] text-zinc-700">
              Right now
            </span>
            <span className="h-px flex-1 bg-white/[0.05]" />
          </div>
          <div className="col-span-2 flex items-center gap-2 px-4">
            <span className="h-px flex-1 bg-white/[0.05]" />
            <span className="text-[8.5px] font-semibold uppercase tracking-[0.16em] text-zinc-700">
              Last 30 days
            </span>
            <span className="h-px flex-1 bg-white/[0.05]" />
          </div>
        </div>
        <div className="relative mx-[10%] mt-2 hidden h-4 rounded-b-lg border-b border-l border-r border-white/[0.06] sm:block">
          <span className="absolute left-1/2 top-2 -translate-x-1/2 whitespace-nowrap bg-[#16171d] px-2 text-[9px] text-zinc-600">
            Verify feeds the next Observe. No human at the top of the loop
          </span>
        </div>
      </div>

      <div className="divide-y divide-white/[0.05] border-t border-white/[0.06]">
        {RECEIPTS.map((receipt) => (
          <div key={receipt.text} className="flex items-center gap-2.5 px-5 py-2">
            <span
              className={`h-1 w-1 shrink-0 rounded-full ${
                receipt.bright ? 'bg-violet-400' : 'bg-zinc-700'
              }`}
            />
            <span
              className={`min-w-0 flex-1 truncate text-[11px] leading-5 ${
                receipt.bright ? 'text-zinc-300' : 'text-zinc-500'
              }`}
            >
              {receipt.text}
            </span>
            <span className="shrink-0 font-mono text-[9.5px] text-zinc-600">9h ago</span>
          </div>
        ))}
        <div className="flex items-center justify-between px-5 py-2">
          <span className="text-[11px] text-zinc-500">
            Full guardrail log, restore points and approvals
          </span>
          <ChevronRight className="h-3 w-3 text-zinc-600" />
        </div>
      </div>
    </div>
  )
}

/* Canvas — the Overview page, top to bottom. Overview is the one section with
   page padding; the inspector sections are full-bleed, so the padding lives
   here rather than on the shared canvas wrapper. */
function OverviewCanvas() {
  return (
    <div className="space-y-4 px-4 py-5 sm:px-6">
      <h3 className="text-[17px] font-semibold leading-tight tracking-[-0.01em] text-white">
        CofounderConnect
      </h3>

      <AgentPanelMini />
      <LoopPanelMini />

          <div className="space-y-2">
            <p className={LABEL}>Runtime · last 24 hours</p>
            <div className={`${PANEL} grid grid-cols-2 divide-white/[0.06] sm:grid-cols-4 sm:divide-x`}>
              {RUNTIME.map((tile) => {
                const Icon = tile.icon
                return (
                  <div key={tile.label} className="px-4 py-3">
                    <div className="flex items-center gap-1.5">
                      <Icon className="h-3 w-3 text-zinc-600" />
                      <span className={LABEL}>{tile.label}</span>
                    </div>
                    <p className="mt-2 font-mono text-[17px] font-medium tabular-nums leading-none text-zinc-200">
                      {tile.value}
                    </p>
                    {tile.hint && (
                      <p className="mt-1.5 text-[10px] leading-none text-zinc-600">{tile.hint}</p>
                    )}
                  </div>
                )
              })}
            </div>
          </div>

          <div className="space-y-2">
            <p className={LABEL}>Resources</p>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              {RESOURCES.map((card) => {
                const Icon = card.icon
                return (
                  <div key={card.label} className={`${PANEL} relative px-4 py-3`}>
                    <ArrowUpRight className="absolute right-3 top-3 h-3 w-3 text-zinc-700" />
                    <div className="flex items-center gap-2">
                      <Icon className="h-3.5 w-3.5 text-zinc-500" />
                      <span className={LABEL}>{card.label}</span>
                    </div>
                    <p className="mt-2.5 flex items-baseline gap-1.5">
                      <span className="font-mono text-[18px] font-medium tabular-nums leading-none text-zinc-100">
                        {card.value}
                      </span>
                      <span className="text-[11px] text-zinc-500">{card.unit}</span>
                      {card.meta && (
                        <span className="ml-auto font-mono text-[10px] text-zinc-600">
                          {card.meta}
                        </span>
                      )}
                    </p>
                  </div>
                )
              })}
            </div>
          </div>
    </div>
  )
}

/* ── Inspector chrome, shared by the three section pages ─────────────────── */

/**
 * The `INSPECTOR | <Section> ● <status>` bar every section page carries. Unlike
 * Overview, these pages are full-bleed: the rails and their padding are part of
 * the layout, so the canvas wrapper adds none.
 */
function InspectorHeader({
  icon: Icon,
  section,
  status,
  count,
  children,
}: {
  icon: LucideIcon
  section: string
  status: string
  count?: string
  children?: React.ReactNode
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-white/[0.07] px-4 py-2.5">
      <div className="flex min-w-0 items-center gap-2">
        <Icon className="h-3 w-3 shrink-0 text-zinc-600" />
        <span className="hidden text-[9.5px] font-semibold uppercase tracking-[0.14em] text-zinc-600 sm:inline">
          Inspector
        </span>
        <span className="hidden text-zinc-700 sm:inline">|</span>
        <span className="truncate text-[13px] font-semibold text-white">{section}</span>
        <span className="flex shrink-0 items-center gap-1.5 text-[10.5px] text-zinc-500">
          <span className="h-1 w-1 rounded-full bg-violet-300" />
          {status}
        </span>
        {count && <span className="shrink-0 font-mono text-[10.5px] text-zinc-500">{count}</span>}
      </div>
      {children && <div className="flex shrink-0 items-center gap-2">{children}</div>}
    </div>
  )
}

/** The small icon-only affordances on the rail heads (refresh, add). */
function RailIcon({ icon: Icon }: { icon: LucideIcon }) {
  return <Icon className="h-3 w-3 text-zinc-600" />
}

function MiniSearch({ placeholder }: { placeholder: string }) {
  return (
    <div className="flex items-center gap-1.5 rounded-md border border-white/[0.08] bg-white/[0.02] px-2 py-1.5">
      <Search className="h-3 w-3 shrink-0 text-zinc-600" />
      <span className="truncate text-[10.5px] text-zinc-600">{placeholder}</span>
    </div>
  )
}

/* ── Database ────────────────────────────────────────────────────────────── */

/* The workspace schema's tables, with their live row counts. */
const TABLES = [
  { name: 'connections', rows: 2, open: true },
  { name: 'conversations', rows: 1 },
  { name: 'messages', rows: 1 },
  { name: 'profile_views', rows: 3 },
  { name: 'profiles', rows: 18 },
  { name: 'reports', rows: 0 },
  { name: 'users', rows: 19 },
]

/**
 * The open table's grid. Column types are rendered under the names exactly as
 * the inspector does, and timestamp cells keep the inspector's amber — the
 * grid colours cells by Postgres type, so dropping that would make the mock
 * read like a generic table instead of this one.
 */
const CONNECTION_ROWS = [
  { id: '11977268-a7a6-4799-b955-faa57932803d', created: '2026-07-26T23:04:05.071Z', updated: '2026-07-26T23:04:05.071Z' },
  { id: '7adf2f80-62e9-40a8-be93-6201a42fad10', created: '2026-07-26T23:05:00.388Z', updated: '2026-07-26T23:06:44.727Z' },
]

const GRID_COLS = [
  { name: 'id', tag: 'PK', type: 'uuid' },
  { name: 'createdAt', type: 'timestamp with time zone' },
  { name: 'updatedAt', type: 'timestamp with time zone' },
  { name: 'deleted_at', type: 'timestamp with time zone' },
]

function DatabaseCanvas() {
  return (
    <div className="flex h-full flex-col">
      <InspectorHeader icon={Database} section="Tables" status="Managed" count="7">
        <span className="inline-flex items-center gap-1.5 rounded-md border border-white/[0.14] bg-white/[0.06] px-2 py-1 text-[10.5px] font-medium text-zinc-200">
          <Table className="h-3 w-3" />
          Tables
        </span>
        <span className="hidden items-center gap-1.5 px-2 py-1 text-[10.5px] font-medium text-zinc-500 sm:inline-flex">
          <Columns className="h-3 w-3" />
          Schema
        </span>
      </InspectorHeader>

      <div className="flex min-h-0 flex-1">
        {/* Left rail: the schema and its tables. */}
        <div className="hidden w-[184px] shrink-0 flex-col border-r border-white/[0.07] lg:flex">
          <div className="flex items-center justify-between px-3 py-2.5">
            <span className="flex items-center gap-1.5 text-[11px] text-zinc-300">
              <span className="h-1 w-1 rounded-full bg-violet-300" />
              workspace
            </span>
            <span className="flex items-center gap-1.5">
              <RailIcon icon={RefreshCw} />
              <RailIcon icon={Plus} />
            </span>
          </div>
          <div className="px-2.5 pb-2">
            <MiniSearch placeholder="Search tables…" />
          </div>
          <ul className="flex-1 space-y-px px-2 pt-1">
            {TABLES.map((table) => (
              <li
                key={table.name}
                className={`flex items-center gap-2 rounded-md px-2 py-[5px] font-mono text-[11px] ${
                  table.open ? 'bg-white/[0.06] text-zinc-100' : 'text-zinc-400'
                }`}
              >
                <span
                  className={`h-1 w-1 shrink-0 rounded-full ${
                    table.open ? 'bg-violet-300' : 'bg-zinc-700'
                  }`}
                />
                <span className="flex-1 truncate">{table.name}</span>
                <span className="shrink-0 text-[10px] tabular-nums text-zinc-600">{table.rows}</span>
              </li>
            ))}
          </ul>
          <div className="border-t border-white/[0.07] px-3 py-2 font-mono text-[10px] text-zinc-600">
            7 tables
          </div>
        </div>

        {/* Right pane: the open table. */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center justify-between gap-3 px-4 py-2.5">
            <span className="flex min-w-0 items-baseline gap-2">
              <span className="truncate font-mono text-[13px] font-semibold text-white">
                connections
              </span>
              <span className="shrink-0 font-mono text-[10.5px] text-zinc-500">2 rows</span>
            </span>
            <span className="flex shrink-0 items-center gap-2">
              <span className="rounded-md border border-white/[0.14] bg-white/[0.06] px-2 py-1 text-[10.5px] font-medium text-zinc-200">
                Data
              </span>
              <span className="hidden px-1 text-[10.5px] font-medium text-zinc-500 sm:inline">
                Structure
              </span>
              <span className="inline-flex items-center gap-1 rounded-md bg-white px-2 py-1 text-[10.5px] font-semibold text-black">
                <Plus className="h-2.5 w-2.5" />
                Insert row
              </span>
            </span>
          </div>
          <div className="px-4 pb-2.5">
            <MiniSearch placeholder="Search rows…" />
          </div>

          {/* Runs off the right edge like the real grid, which scrolls. */}
          <div className="min-w-0 flex-1 overflow-hidden border-t border-white/[0.06]">
            <div className="w-[720px]">
              <div className="flex items-start gap-4 border-b border-white/[0.06] px-4 py-2">
                <span className="w-4 shrink-0 font-mono text-[9.5px] text-zinc-700">#</span>
                {GRID_COLS.map((col, i) => (
                  <span key={col.name} className={i === 0 ? 'w-[210px] shrink-0' : 'w-[150px] shrink-0'}>
                    <span className="flex items-center gap-1 text-[9.5px] font-semibold uppercase tracking-[0.1em] text-zinc-400">
                      {col.name}
                      {col.tag && <span className="text-violet-300/90">{col.tag}</span>}
                    </span>
                    <span className="mt-0.5 block truncate font-mono text-[9px] text-zinc-600">
                      {col.type}
                    </span>
                  </span>
                ))}
                <span className="w-[80px] shrink-0">
                  <span className="block text-[9.5px] font-semibold uppercase tracking-[0.1em] text-zinc-400">
                    requ
                  </span>
                  <span className="mt-0.5 block font-mono text-[9px] text-zinc-600">uuid</span>
                </span>
              </div>
              {CONNECTION_ROWS.map((row, i) => (
                <div
                  key={row.id}
                  className="flex items-center gap-4 border-b border-white/[0.04] px-4 py-2 font-mono text-[10px]"
                >
                  <span className="w-4 shrink-0 text-zinc-700">{i + 1}</span>
                  <span className="w-[210px] shrink-0 truncate text-zinc-200">{row.id}</span>
                  <span className="w-[150px] shrink-0 truncate text-amber-400/85">{row.created}</span>
                  <span className="w-[150px] shrink-0 truncate text-amber-400/85">{row.updated}</span>
                  <span className="w-[150px] shrink-0 italic text-zinc-600">NULL</span>
                  <span className="w-[80px] shrink-0 truncate text-zinc-500">729c</span>
                </div>
              ))}
            </div>
          </div>
          <div className="border-t border-white/[0.06] px-4 py-2 font-mono text-[10px] text-zinc-600">
            1-2 of 2
          </div>
        </div>
      </div>
    </div>
  )
}

/* ── Auth & Users ────────────────────────────────────────────────────────── */

/* Marks and taglines copied from components/auth/AuthConfiguration.tsx so the
   mock cannot drift from the surface it portrays. */
function GoogleMark({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden>
      <path fill="#4285F4" d="M23.49 12.27c0-.79-.07-1.54-.19-2.27H12v4.51h6.47a5.57 5.57 0 0 1-2.4 3.58v3h3.86c2.26-2.09 3.56-5.17 3.56-8.82Z" />
      <path fill="#34A853" d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.86-3c-1.08.72-2.45 1.16-4.07 1.16-3.13 0-5.78-2.11-6.73-4.96H1.29v3.09A11.99 11.99 0 0 0 12 24Z" />
      <path fill="#FBBC05" d="M5.27 14.29a7.16 7.16 0 0 1 0-4.58V6.62H1.29a12.04 12.04 0 0 0 0 10.76l3.98-3.09Z" />
      <path fill="#EA4335" d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0A11.99 11.99 0 0 0 1.29 6.62l3.98 3.09C6.22 6.86 8.87 4.75 12 4.75Z" />
    </svg>
  )
}

const POSTURE = [
  "Tokens signed with this project's isolated secret",
  'Passwords hashed with bcrypt, never reversible',
  'Identities isolated in a per-project schema',
  'Sessions revocable server-side on logout',
]

/**
 * The founder's own address is the first row on the live surface. It is
 * replaced here with an example.com identity: this page is public, and
 * publishing a personal mailbox to a marketing site invites scraping. The
 * surface, counts and shape are untouched.
 */
const IDENTITIES = [
  { email: 'adarsh.jose@example.com', initial: 'A' },
  { email: 'yujin.shin@example.com', initial: 'Y' },
  { email: 'doyoon.kang@example.com', initial: 'D' },
]

const AUTH_STATS = [
  { value: '19', unit: 'identities' },
  { value: '0', unit: 'active · 30d' },
  { value: '0', unit: 'verified' },
  { value: '0', unit: 'new · 24h' },
]

function AuthCanvas() {
  return (
    <div className="flex h-full flex-col">
      <InspectorHeader icon={Shield} section="Auth & Users" status="Governed" count="19">
        <span className="font-mono text-[10.5px] text-zinc-500">19 identities</span>
      </InspectorHeader>

      <div className="flex items-center gap-4 border-b border-white/[0.07] px-4">
        <span className="flex items-center gap-1.5 border-b border-violet-400 py-2 text-[11.5px] font-medium text-zinc-50">
          <Settings className="h-3 w-3" />
          Configuration
        </span>
        <span className="flex items-center gap-1.5 border-b border-transparent py-2 text-[11.5px] font-medium text-zinc-500">
          <User className="h-3 w-3" />
          Users
          <span className="font-mono text-[10px] text-zinc-600">19</span>
        </span>
      </div>

      <div className="grid grid-cols-2 divide-x divide-white/[0.06] border-b border-white/[0.07] sm:grid-cols-4">
        {AUTH_STATS.map((stat) => (
          <div key={stat.unit} className="flex items-baseline gap-1.5 px-4 py-3">
            <span className="font-mono text-[16px] font-medium tabular-nums leading-none text-zinc-100">
              {stat.value}
            </span>
            <span className="text-[10.5px] text-zinc-500">{stat.unit}</span>
          </div>
        ))}
      </div>

      <div className="grid flex-1 gap-3 p-4 lg:grid-cols-[minmax(0,1fr)_210px]">
        <div className={`${PANEL} h-fit overflow-hidden`}>
          <div className="flex flex-wrap items-baseline gap-x-2 border-b border-white/[0.06] px-4 py-3">
            <span className="text-[12.5px] font-semibold text-white">Sign-in methods</span>
            <span className="text-[10.5px] text-zinc-500">
              Choose how end-users authenticate with this backend.
            </span>
          </div>
          <div className="px-4 py-3">
            <div className="flex items-center gap-2.5 rounded-lg border border-white/[0.07] px-3 py-2.5">
              <Mail className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
              <span className="min-w-0 flex-1">
                <span className="block text-[11.5px] font-semibold text-zinc-100">
                  Email &amp; password
                </span>
                <span className="block truncate text-[10px] text-zinc-500">
                  Secure registration and login with JWT sessions.
                </span>
              </span>
              <span className="flex shrink-0 items-center gap-1 text-[10px] text-emerald-400">
                <span className="h-1 w-1 rounded-full bg-emerald-400" />
                active
              </span>
            </div>

            <div className="mt-3.5 flex items-center justify-between gap-2">
              <span className={LABEL}>Social sign-in</span>
              <span className="hidden truncate text-[9.5px] text-zinc-600 sm:inline">
                Your own OAuth credentials, stored encrypted per project
              </span>
            </div>

            <div className="mt-2 space-y-2">
              {[
                { name: 'Google', tagline: 'One-tap OAuth 2.0 sign-in', mark: <GoogleMark className="h-3.5 w-3.5" /> },
                { name: 'GitHub', tagline: 'OAuth sign-in built for developer apps', mark: <Github className="h-3.5 w-3.5 text-zinc-200" /> },
              ].map((provider) => (
                <div
                  key={provider.name}
                  className="flex items-center gap-2.5 rounded-lg border border-white/[0.07] px-3 py-2.5"
                >
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-white/[0.05]">
                    {provider.mark}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[11.5px] font-semibold text-zinc-100">
                      {provider.name}
                    </span>
                    <span className="block truncate text-[10px] text-zinc-500">
                      {provider.tagline}
                    </span>
                  </span>
                  <span className="shrink-0 text-[10px] text-zinc-500">Set up →</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="hidden space-y-3 lg:block">
          <div className={`${PANEL} px-3.5 py-3`}>
            <div className="flex items-center gap-1.5">
              <ShieldCheck className="h-3 w-3 text-zinc-600" />
              <span className={LABEL}>Security posture</span>
            </div>
            <ul className="mt-2.5 space-y-2">
              {POSTURE.map((line) => (
                <li key={line} className="flex gap-1.5">
                  <Check className="mt-px h-2.5 w-2.5 shrink-0 text-emerald-400/80" />
                  <span className="text-[10px] leading-4 text-zinc-400">{line}</span>
                </li>
              ))}
            </ul>
          </div>

          <div className={`${PANEL} overflow-hidden`}>
            <div className="flex items-center justify-between px-3.5 py-2.5">
              <span className={LABEL}>Recent identities</span>
              <span className="flex items-center gap-0.5 text-[9.5px] text-zinc-600">
                All
                <ChevronRight className="h-2.5 w-2.5" />
              </span>
            </div>
            <div className="divide-y divide-white/[0.05] border-t border-white/[0.06]">
              {IDENTITIES.map((identity) => (
                <div key={identity.email} className="flex items-center gap-2 px-3.5 py-2">
                  <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-white/[0.07] text-[8px] font-semibold text-zinc-300">
                    {identity.initial}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[10px] text-zinc-300">
                      {identity.email}
                    </span>
                    <span className="block font-mono text-[9px] text-zinc-600">email · 2d ago</span>
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

/* ── Storage ─────────────────────────────────────────────────────────────── */

/**
 * Storage is genuinely empty on this project, so the panel is the real empty
 * state — including its copy, which sells the agent path rather than an upload
 * button. Dressing it with invented buckets is exactly the move the
 * no-fake-scaffolding rule forbids.
 */
function StorageCanvas() {
  return (
    <div className="flex h-full flex-col">
      <InspectorHeader icon={HardDrive} section="Storage" status="Governed">
        <span className="hidden items-center gap-2 sm:flex">
          <span className="font-mono text-[10px] text-zinc-500">0 B / 1.0 GB</span>
          <span className="h-1 w-16 rounded-full bg-white/[0.08]" />
          <span className="font-mono text-[10px] text-zinc-600">0.0%</span>
        </span>
        <span className="inline-flex items-center gap-1 rounded-md border border-white/[0.14] bg-white/[0.06] px-2 py-1 text-[10.5px] font-medium text-zinc-200">
          <Upload className="h-2.5 w-2.5" />
          Upload
        </span>
      </InspectorHeader>

      <div className="flex min-h-0 flex-1">
        <div className="hidden w-[184px] shrink-0 flex-col border-r border-white/[0.07] lg:flex">
          <div className="flex items-center justify-between px-3 py-2.5">
            <span className={LABEL}>Buckets</span>
            <span className="flex items-center gap-1.5">
              <RailIcon icon={RefreshCw} />
              <RailIcon icon={Plus} />
            </span>
          </div>
          <div className="flex flex-1 flex-col items-center px-3 pt-6 text-center">
            <Folder className="h-4 w-4 text-zinc-700" />
            <p className="mt-2 text-[11px] font-semibold text-zinc-200">No buckets yet</p>
            <p className="mt-1.5 text-[9.5px] leading-4 text-zinc-500">
              Ask your coding agent for file uploads and Backenly creates one with governed access.
            </p>
            <span className="mt-3 flex w-full items-center justify-center gap-1 rounded-md border border-white/[0.09] bg-white/[0.03] py-1.5 text-[10.5px] font-medium text-zinc-300">
              <Plus className="h-2.5 w-2.5" />
              New bucket
            </span>
          </div>
        </div>

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center justify-between gap-3 px-4 py-2.5">
            <span className="flex min-w-0 items-baseline gap-2">
              <span className="font-mono text-[13px] font-semibold text-white">All buckets</span>
              <span className="shrink-0 font-mono text-[10.5px] text-zinc-500">0 objects</span>
            </span>
            <span className="hidden w-40 shrink-0 sm:block">
              <MiniSearch placeholder="Search objects…" />
            </span>
          </div>

          <div className="flex flex-1 flex-col items-center justify-center border-t border-white/[0.06] px-6 py-10 text-center">
            <FileText className="h-4 w-4 text-zinc-700" />
            <p className="mt-2.5 text-[12.5px] font-semibold text-zinc-100">No storage yet</p>
            <p className="mt-1.5 max-w-[280px] text-[10.5px] leading-4 text-zinc-500">
              Ask your coding agent for file uploads and Backenly sets up a bucket with governed
              access.
            </p>
            <span className="mt-3.5 inline-flex items-center gap-1.5 rounded-md bg-white px-2.5 py-1.5 text-[10.5px] font-semibold text-black">
              <Sparkles className="h-2.5 w-2.5" />
              Connect your agent
            </span>
          </div>

          <div className="border-t border-white/[0.06] px-4 py-2 font-mono text-[10px] text-zinc-600">
            0 objects
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * A section is clickable only if it appears here.
 *
 * All four panels are verified against live screenshots of **CofounderConnect**
 * taken 2026-07-30: Overview, Database, Auth & Users, Storage. Ecommerce
 * platform was the subject until that project was deleted, which is why no
 * number here traces back to it any more.
 */
const SECTION_PANELS: Partial<Record<SectionId, () => JSX.Element>> = {
  overview: OverviewCanvas,
  database: DatabaseCanvas,
  auth: AuthCanvas,
  storage: StorageCanvas,
}

/** The canvas heading the real shell shows for each section. */
const SECTION_LABEL: Record<SectionId, string> = {
  overview: 'Overview',
  database: 'Database',
  auth: 'Auth & Users',
  storage: 'Storage',
}

export function HeroConsole() {
  const [section, setSection] = useState<SectionId>('overview')
  const Panel = SECTION_PANELS[section] ?? OverviewCanvas

  return (
    // No aria-hidden any more: this holds real focusable controls, and hiding
    // focusable controls from assistive tech is worse than exposing a mock.
    <div
      className="select-none overflow-hidden rounded-xl border border-white/[0.10] bg-[#101116]"
      role="group"
      aria-label="Backenly dashboard tour"
    >
      <TopBar />

      <div className="flex items-stretch">
        {/* Sidebar — the real shell's nav, verbatim, nav-first like the real one. */}
        <aside className="hidden w-52 shrink-0 flex-col justify-between border-r border-white/[0.07] bg-[#141519] px-2.5 py-3 md:flex">
          <nav className="space-y-3.5">
            {NAV.map((group, gi) => (
              <div key={group.label ?? gi}>
                {group.label && (
                  <p className="flex items-center justify-between px-2.5 pb-1 text-[9.5px] font-semibold uppercase tracking-[0.12em] text-zinc-600">
                    {group.label}
                    <ChevronDown className="h-3 w-3" />
                  </p>
                )}
                <ul className="space-y-0.5">
                  {group.items.map((item) => {
                    const Icon = item.icon
                    const active = item.section === section
                    const tourable = !!item.section && !!SECTION_PANELS[item.section]
                    const row = (
                      <>
                        <Icon className="h-3.5 w-3.5 shrink-0" />
                        <span className="flex-1 text-left">{item.title}</span>
                        {item.tag && (
                          <span className="rounded-full bg-white/[0.05] px-1.5 py-0.5 text-[9px] leading-none text-zinc-500">
                            {item.tag}
                          </span>
                        )}
                        {item.count && (
                          <span className="rounded-full bg-white/[0.07] px-1.5 py-0.5 font-mono text-[9.5px] font-semibold leading-none text-zinc-300">
                            {item.count}
                          </span>
                        )}
                      </>
                    )
                    const shape = `flex w-full items-center gap-2.5 rounded-md border px-2.5 py-[5px] text-[12px] font-medium ${
                      active
                        ? 'border-white/[0.12] bg-white/[0.06] text-zinc-50 shadow-[inset_3px_0_0_rgba(196,181,253,0.78)]'
                        : 'border-transparent text-zinc-400'
                    }`

                    return (
                      <li key={item.title}>
                        {tourable ? (
                          <button
                            type="button"
                            onClick={() => setSection(item.section as SectionId)}
                            aria-current={active ? 'true' : undefined}
                            className={`${shape} transition-colors duration-200 hover:border-white/[0.10] hover:bg-white/[0.04] hover:text-zinc-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-violet-300/60`}
                          >
                            {row}
                          </button>
                        ) : (
                          <span className={shape}>{row}</span>
                        )}
                      </li>
                    )
                  })}
                </ul>
              </div>
            ))}
          </nav>
          {/* This project has no frontend paired, so the pill is the unpaired
              state, not the connected one. */}
          <div className="mt-3 flex items-center gap-2 border-t border-white/[0.07] px-2.5 pt-3">
            <span className="h-1.5 w-1.5 rounded-full bg-zinc-600" />
            <span className="text-[11px] text-zinc-500">No frontend yet</span>
          </div>
        </aside>

        {/* A floor tuned to Overview, the tallest panel, so clicking a section
            does not shift the rest of the page. Measured at lg: without it the
            three inspector panels come in 104px shorter and everything below
            the hero jumps. The slack it leaves inside Storage is what the real
            Storage page looks like when a project has no buckets. */}
        <div
          className="min-h-[520px] min-w-0 flex-1 md:min-h-[600px] lg:min-h-[798px]"
          aria-label={SECTION_LABEL[section]}
        >
          <Panel />
        </div>
      </div>
    </div>
  )
}
