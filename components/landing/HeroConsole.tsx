'use client'

/**
 * The dashboard drawn in DOM for the hero — the real shell around the real
 * Overview page, miniaturized from screenshots of a live project
 * (2026-07-23, "Ecommerce platform") and the components that render it.
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
 *   - Canvas: components/workspace/WorkspaceHome.tsx — agent panel ("Waiting
 *     on your review", Autopilot + LIVE, the always-approval promise), the
 *     self-healing loop (RUNNING chip, five phases with their real unit copy,
 *     RIGHT NOW / LAST 30 DAYS windows, the return-arc caption "Verify feeds
 *     the next Observe — no human at the top of the loop"), the agent's
 *     receipts in its own voice, the runtime strip, the Resources cards.
 *
 * One consistent story: 3 findings held for review (inbox badge, agent
 * headline, Propose reading and Review button all say 3), 12 functions
 * (sidebar badge = Resources card), receipts 11h ago on the same tables.
 *
 * Palette tracks the product's neutral-first system (2026-07-23): buttons
 * and surfaces are monochrome; violet appears only where the product keeps
 * it as an accent — status dots, the LIVE tag, the active
 * loop node, the sidebar's inset rail.
 *
 * Static. No looping motion in the hero, per the standing decision — the
 * product renders this instrument static under prefers-reduced-motion, so a
 * still render is a truthful one.
 */

import {
  Activity,
  AlertTriangle,
  ArrowUpRight,
  Bot,
  Braces,
  Cable,
  ChevronDown,
  ChevronRight,
  Code2,
  Database,
  Gauge,
  GitBranch,
  HardDrive,
  Inbox,
  LayoutDashboard,
  Menu,
  Radio,
  Rocket,
  Settings,
  Shield,
  ShieldCheck,
  Sparkles,
  Timer,
  User,
  Zap,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

/* Mirrors components/shell/ProjectSidebar.tsx — keep in sync by hand. */
const NAV: {
  label?: string
  items: { title: string; icon: LucideIcon; tag?: string; count?: number; active?: boolean }[]
}[] = [
  { items: [{ title: 'Overview', icon: LayoutDashboard, active: true }] },
  {
    label: 'Build',
    items: [
      { title: 'Database', icon: Database },
      { title: 'Auth & Users', icon: Shield },
      { title: 'Storage', icon: HardDrive },
      { title: 'Functions', icon: Code2, count: 12 },
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

/* Mirrors the SelfHealingLoop readings — Propose is the active phase because
   3 changes are held, which is also what the agent panel and inbox say. */
const LOOP = [
  { label: 'Observe', value: '14', unit: 'guarantees' },
  { label: 'Detect', value: '3', unit: 'need attention' },
  { label: 'Propose', value: '3', unit: 'of those, held for you', active: true },
  { label: 'Apply', value: '4', unit: 'fixed · 30d' },
  { label: 'Verify', value: '100%', unit: 'verified · 30d' },
] as const

/* The agent's receipts, in its own voice — copy verbatim from the product. */
const RECEIPTS = [
  'Backenly fixed missing api on "_email_verifications" because it would have caused silent damage from going unnoticed.',
  'Backenly fixed missing api on "order_items" because it would have caused silent damage from going unnoticed.',
  'Backenly fixed missing api on "products" because it would have caused silent damage from going unnoticed.',
]

/* Mirrors ObservabilityStrip.tsx tiles. */
const RUNTIME: { label: string; icon: LucideIcon; value: string; hint?: string }[] = [
  { label: 'Requests', icon: Activity, value: '1,284' },
  { label: 'Reliability', icon: Gauge, value: '100%' },
  { label: 'Avg response', icon: Timer, value: '38ms' },
  { label: 'Failed', icon: AlertTriangle, value: '0' },
]

/* Mirrors the Resources cards. Functions = 12, same as the sidebar badge. */
const RESOURCES: { label: string; icon: LucideIcon; value: string; unit: string; meta?: string }[] = [
  { label: 'Users', icon: User, value: '10', unit: 'Users' },
  { label: 'Database', icon: Database, value: '4', unit: 'Tables', meta: '496.0 KB' },
  { label: 'Storage', icon: HardDrive, value: '2', unit: 'Buckets', meta: '12.4 MB' },
  { label: 'Functions', icon: Braces, value: '12', unit: 'Functions' },
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
          <span className="h-1.5 w-1.5 rounded-full bg-zinc-500" />
          Ecommerce platform
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
        <p className="mt-2.5 text-[17px] font-semibold leading-snug tracking-[-0.01em] text-white">
          Waiting on your review
        </p>
        <p className="mt-1 max-w-md text-[12px] leading-5 text-zinc-400">
          Backenly prepared 3 changes and is holding them. Destructive and auth-related changes
          never ship without your OK.
        </p>
        <span className="mt-3 inline-flex h-7 items-center gap-1.5 rounded-lg bg-white px-3 text-[11.5px] font-semibold text-black">
          Review 3 changes
          <ArrowUpRight className="h-3 w-3 opacity-90" />
        </span>
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
  return (
    <div className={`${PANEL} overflow-hidden`}>
      <div className="flex items-center justify-between border-b border-white/[0.06] px-5 py-3">
        <div className="flex items-center gap-2.5">
          <span className="text-[13px] font-semibold text-white">Self-healing loop</span>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-white/[0.09] px-2 py-0.5 text-[8.5px] font-semibold uppercase tracking-[0.14em] text-zinc-300">
            <span className="h-1 w-1 rounded-full bg-violet-300" />
            Running
          </span>
        </div>
        <span className="font-mono text-[10px] text-zinc-600">checked 12h ago</span>
      </div>

      <div className="px-4 pb-3 pt-4 sm:px-6">
        <div className="relative">
          <div className="absolute left-[10%] right-[10%] top-[10px] h-px bg-white/[0.08]" />
          <div className="relative grid grid-cols-5">
            {LOOP.map((stage) => {
              const active = 'active' in stage && stage.active
              return (
                <div key={stage.label} className="flex flex-col items-center text-center">
                  <span
                    className={`flex h-[20px] w-[20px] items-center justify-center rounded-full border bg-[#16171d] ${
                      active ? 'border-violet-400/45' : 'border-white/[0.09]'
                    }`}
                  >
                    <span
                      className={`h-[5px] w-[5px] rounded-full ${
                        active ? 'bg-violet-300' : 'bg-zinc-600'
                      }`}
                    />
                  </span>
                  <span
                    className={`mt-2 text-[8px] font-semibold uppercase tracking-[0.13em] sm:text-[9px] ${
                      active ? 'text-violet-200' : 'text-zinc-500'
                    }`}
                  >
                    {stage.label}
                  </span>
                  <span
                    className={`mt-1.5 font-mono text-[16px] font-medium tabular-nums leading-none tracking-[-0.01em] ${
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
          <div key={receipt} className="flex items-center gap-2.5 px-5 py-2">
            <span className="h-1 w-1 shrink-0 rounded-full bg-violet-400" />
            <span className="min-w-0 flex-1 truncate text-[11px] leading-5 text-zinc-400">
              {receipt}
            </span>
            <span className="shrink-0 font-mono text-[9.5px] text-zinc-600">11h ago</span>
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

export function HeroConsole() {
  return (
    <div
      aria-hidden
      className="select-none overflow-hidden rounded-xl border border-white/[0.10] bg-[#101116]"
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
                    return (
                      <li
                        key={item.title}
                        className={`flex items-center gap-2.5 rounded-md border px-2.5 py-[5px] text-[12px] font-medium ${
                          item.active
                            ? 'border-white/[0.12] bg-white/[0.06] text-zinc-50 shadow-[inset_3px_0_0_rgba(196,181,253,0.78)]'
                            : 'border-transparent text-zinc-400'
                        }`}
                      >
                        <Icon className="h-3.5 w-3.5 shrink-0" />
                        <span className="flex-1">{item.title}</span>
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
                      </li>
                    )
                  })}
                </ul>
              </div>
            ))}
          </nav>
          <div className="mt-3 flex items-center gap-2 border-t border-white/[0.07] px-2.5 pt-3">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
            <span className="text-[11px] text-zinc-500">Frontend · connected</span>
          </div>
        </aside>

        {/* Canvas — the Overview page, top to bottom. */}
        <div className="min-w-0 flex-1 space-y-4 px-4 py-5 sm:px-6">
          <h3 className="text-[17px] font-semibold leading-tight tracking-[-0.01em] text-white">
            Ecommerce platform
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
      </div>
    </div>
  )
}
