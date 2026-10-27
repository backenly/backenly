'use client'

import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react'
import {
  Activity,
  AlertTriangle,
  Bot,
  Braces,
  Cable,
  Camera,
  ChevronDown,
  ChevronRight,
  ChevronsUpDown,
  ClipboardList,
  Code2,
  Database,
  Eye,
  GitBranch,
  GitPullRequestArrow,
  HardDrive,
  History,
  Inbox,
  KeyRound,
  LayoutDashboard,
  Link2,
  Menu,
  Network,
  Plus,
  Puzzle,
  Radio,
  RefreshCw,
  Rocket,
  ScanSearch,
  Search,
  Settings,
  Shield,
  ShieldCheck,
  Sparkles,
  Table2,
  Terminal,
  Undo2,
  Webhook,
  Wrench,
  X,
  Zap,
  type LucideIcon,
} from 'lucide-react'

/* ─────────────────────────────────────────────────────────────
   The hero's live console (founders' mentor, 2026-10-22: look at how
   instacloud.com makes the idea understandable). InstaCloud's hero is ONE
   product mock that plays the whole thesis in a loop: the agent deploys,
   the database turns "Warning", the agent proposes a fix, a person
   approves it, everything goes green. This is Backenly's version of that
   loop, in Backenly's own console:

     Build      Claude Code builds UrbanCart over MCP; the tables land on
                the Database page and the store's traffic starts arriving
     Self-heal  the loop on Overview walks Observe → Verify: two broken
                guarantees, one fixed on its own, one waiting on you
     Approve    the waiting one on Autonomy, next to the fix Backenly made
                with its Undo; Approve & fix is pressed
     Watch      Overview, all clear, both receipts listed

   Every surface is a DOM copy of a real one, at the 1280 x 750 the launch
   film's studio renders it (public/media/v7/win-*-r3/r4.webp), and every
   string is the product's own:
     chrome      components/shell/ProjectSidebar.tsx (icons and labels),
                 the Cloud top bar from the round-16 renders
     Overview    components/workspace/WorkspaceHome.tsx (agent panel, shown
                 only while a change waits on you, as in the product since
                 #528; loop readings and units: '—' until a fix exists,
                 Propose accented while something waits)
     Autonomy    the Waiting-on-you and Changes cards of the r4 render
     terminal    the r3 Claude Code session; set_rls, auth, integrations
                 and realtime are advertised tools (lib/mcp/catalog.ts)
   No invented surface, no pointer, no numbers the product would not show.
───────────────────────────────────────────────────────────── */

export const W = 1280
export const H = 750
export const TERM_W = 800
export const TERM_H = 700

type Page = 'database' | 'overview' | 'autonomy'
type Receipt = 'index' | 'fk'

export type View = {
  page: Page
  /** Terminal: -1 hidden, 0 the empty window, 1 the prompt, 2..7 the six tool calls, 8 done. */
  term: number
  /** Tables on the Database page, in creation order. */
  tables: number
  /** Orders the store has taken so far. */
  rows: number
  /** The loop's lit node, 0 Observe .. 4 Verify. */
  phase: number
  detect: number
  propose: number
  apply: number
  verify: string
  receipts: Receipt[]
  pressed: boolean
}

type Frame = { chapter: number; hold: number; view: View }

const START: View = {
  page: 'database',
  term: 0,
  tables: 0,
  rows: 0,
  phase: 0,
  detect: 0,
  propose: 0,
  apply: 0,
  verify: '—',
  receipts: [],
  pressed: false,
}

/** The story, beat by beat. Each frame inherits the one before it. */
const BEATS: Array<{ chapter: number; hold: number; set: Partial<View> }> = [
  // ── Build: the session in front, the console filling behind it ──
  { chapter: 0, hold: 400, set: {} },
  { chapter: 0, hold: 700, set: { term: 1 } },
  { chapter: 0, hold: 500, set: { term: 2 } },
  { chapter: 0, hold: 700, set: { term: 3, tables: 3 } },
  { chapter: 0, hold: 500, set: { term: 4, tables: 4 } },
  { chapter: 0, hold: 400, set: { term: 5 } },
  { chapter: 0, hold: 400, set: { term: 6 } },
  { chapter: 0, hold: 400, set: { term: 7 } },
  { chapter: 0, hold: 900, set: { term: 8 } },
  // the session steps aside: the tables it made, and the store's first orders
  { chapter: 0, hold: 700, set: { term: -1, rows: 2 } },
  { chapter: 0, hold: 600, set: { rows: 4 } },
  { chapter: 0, hold: 1000, set: { rows: 6 } },
  // ── Self-heal: one pass of the loop. Detect counts open + waiting, so the
  //    held foreign key is in it from the start and the panel says so ──
  { chapter: 1, hold: 900, set: { page: 'overview', phase: 0 } },
  { chapter: 1, hold: 1100, set: { phase: 1, detect: 2, propose: 1 } },
  { chapter: 1, hold: 800, set: { phase: 2 } },
  { chapter: 1, hold: 1000, set: { phase: 3, apply: 1, detect: 1 } },
  { chapter: 1, hold: 1700, set: { phase: 4, verify: '100%', receipts: ['index'] } },
  // ── Approve: once it is pressed nothing waits, so the Overview's panel
  //    closes here, behind this page, not under the cut back to it ──
  { chapter: 2, hold: 2300, set: { page: 'autonomy' } },
  { chapter: 2, hold: 1100, set: { pressed: true, propose: 0 } },
  // ── Watch ──
  {
    chapter: 3,
    hold: 1500,
    set: { page: 'overview', pressed: false, phase: 0, detect: 0, propose: 0, receipts: ['fk', 'index'] },
  },
  { chapter: 3, hold: 700, set: { phase: 1 } },
  { chapter: 3, hold: 700, set: { phase: 2 } },
  { chapter: 3, hold: 700, set: { phase: 3 } },
  { chapter: 3, hold: 900, set: { phase: 4 } },
]

export const FRAMES: Frame[] = BEATS.reduce<Frame[]>((out, beat) => {
  const prev = out.length ? out[out.length - 1].view : START
  out.push({ chapter: beat.chapter, hold: beat.hold, view: { ...prev, ...beat.set } })
  return out
}, [])

export const CHAPTERS = [
  { id: 'build', label: 'Build', caption: 'Your agent builds tables, auth, policies and realtime over MCP.' },
  { id: 'heal', label: 'Self-heal', caption: 'Backenly fixes a slow query on its own, then re-checks it.' },
  { id: 'approve', label: 'Approve', caption: 'A fix that could reject writes waits for your approval.' },
  { id: 'watch', label: 'Watch', caption: 'Checks run every minute, and each fix keeps its Undo.' },
] as const

/**
 * First and last frame and total length of each chapter, and the frame shown
 * still under reduced motion: the chapter's end, except Build, whose end has
 * the agent session gone; it holds on the session's "Done." instead.
 */
export const CHAPTER_SPAN = CHAPTERS.map((_, c) => {
  const first = FRAMES.findIndex((f) => f.chapter === c)
  const ms = FRAMES.filter((f) => f.chapter === c).reduce((sum, f) => sum + f.hold, 0)
  const last = first + FRAMES.filter((f) => f.chapter === c).length - 1
  const done = FRAMES.findIndex((f) => f.chapter === c && f.view.term === 8)
  return { first, last, ms, still: c === 0 && done >= 0 ? done : last }
})

const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect

/**
 * Draws a fixed-size design at the width of its box, like an image: one
 * transform, recomputed only when the box resizes.
 */
export function Fit({ w, h, children, className = '' }: { w: number; h: number; children: ReactNode; className?: string }) {
  const outer = useRef<HTMLDivElement>(null)
  const inner = useRef<HTMLDivElement>(null)
  useIsoLayoutEffect(() => {
    const o = outer.current
    const i = inner.current
    if (!o || !i) return
    const fit = () => {
      i.style.transform = `scale(${o.clientWidth / w})`
    }
    fit()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(fit)
    ro.observe(o)
    return () => ro.disconnect()
  }, [w])
  return (
    <div ref={outer} className={`relative overflow-hidden ${className}`} style={{ aspectRatio: `${w} / ${h}` }}>
      <div ref={inner} className="absolute left-0 top-0 origin-top-left" style={{ width: w, height: h }}>
        {children}
      </div>
    </div>
  )
}

/* ── Shared bits ─────────────────────────────────────────────── */

const EASE = 'cubic-bezier(0.16,1,0.3,1)'

/** A layer that fades and settles in when `on`, and keeps its place in the stack. */
function Layer({ on, quiet, children }: { on: boolean; quiet: boolean; children: ReactNode }) {
  return (
    <div
      aria-hidden={!on}
      className="absolute inset-0"
      style={{
        opacity: on ? 1 : 0,
        transform: on || quiet ? 'none' : 'translateY(6px)',
        transition: quiet ? 'none' : `opacity 380ms ${EASE}, transform 520ms ${EASE}`,
        pointerEvents: 'none',
      }}
    >
      {children}
    </div>
  )
}

/** Comes in once `on`; used for rows, list items and terminal lines. */
function Enter({ on, quiet, delay = 0, from = 6, children, className = '' }: { on: boolean; quiet: boolean; delay?: number; from?: number; children: ReactNode; className?: string }) {
  return (
    <div
      className={className}
      style={{
        opacity: on ? 1 : 0,
        transform: on || quiet ? 'none' : `translateY(${from}px)`,
        transition: quiet ? 'none' : `opacity 340ms ${EASE} ${delay}ms, transform 460ms ${EASE} ${delay}ms`,
      }}
    >
      {children}
    </div>
  )
}

const Dot = ({ className = 'bg-emerald-400' }: { className?: string }) => (
  <span aria-hidden className={`inline-block h-[6px] w-[6px] shrink-0 rounded-full ${className}`} />
)

const Kbd = ({ children }: { children: ReactNode }) => (
  <span className="inline-flex h-[16px] min-w-[16px] items-center justify-center rounded-[4px] border border-white/[0.1] bg-white/[0.04] px-[3px] text-[10px] leading-none text-zinc-400">
    {children}
  </span>
)

const Code = ({ children }: { children: ReactNode }) => (
  <span className="rounded-[4px] border border-white/[0.08] bg-white/[0.06] px-[5px] py-[1px] font-mono text-[12px] text-zinc-200">
    {children}
  </span>
)

/* ── Chrome: the Cloud top bar and ProjectSidebar ─────────────── */

function TopBar() {
  return (
    <div className="absolute inset-x-0 top-0 flex h-[40px] items-center pl-[14px] pr-[10px] text-[13px] text-zinc-300">
      <span className="flex h-[20px] w-[20px] items-center justify-center rounded-[5px] bg-violet-500/25 text-violet-200">
        <Menu className="h-[12px] w-[12px]" strokeWidth={2.2} />
      </span>
      <span className="mx-[11px] text-zinc-600">/</span>
      <span className="font-semibold tracking-[-0.01em] text-zinc-100">Adarsh&rsquo;s Team</span>
      <span className="ml-[8px] rounded-[4px] border border-white/[0.1] px-[5px] py-[1px] text-[11px] text-zinc-400">Free</span>
      <ChevronsUpDown className="ml-[8px] h-[13px] w-[13px] text-zinc-500" />
      <span className="mx-[11px] text-zinc-600">/</span>
      <Dot />
      <span className="ml-[7px] font-semibold tracking-[-0.01em] text-zinc-100">UrbanCart</span>
      <ChevronsUpDown className="ml-[8px] h-[13px] w-[13px] text-zinc-500" />
      <span className="ml-[12px] inline-flex items-center gap-[6px] rounded-[5px] border border-white/[0.09] px-[7px] py-[2px] text-[11.5px] text-zinc-300">
        <Dot /> Production
      </span>

      <span className="ml-auto inline-flex h-[26px] w-[158px] items-center gap-[7px] rounded-[6px] border border-white/[0.09] bg-white/[0.02] px-[8px] text-[12.5px] text-zinc-500">
        <Search className="h-[13px] w-[13px]" />
        Search
        <span className="ml-auto flex gap-[3px]">
          <Kbd>⌘</Kbd>
          <Kbd>K</Kbd>
        </span>
      </span>
      <span className="ml-[7px] flex h-[26px] w-[26px] items-center justify-center rounded-[6px] border border-white/[0.09] text-zinc-400">
        <Inbox className="h-[13px] w-[13px]" />
      </span>
      <span className="ml-[14px] inline-flex items-center gap-[6px] text-[12.5px] text-zinc-200">
        <Sparkles className="h-[13px] w-[13px]" /> Ask <Kbd>⌘J</Kbd>
      </span>
      <span className="ml-[16px] inline-flex h-[26px] items-center gap-[7px] rounded-[6px] border border-white/[0.09] px-[9px] text-[12.5px] text-zinc-200">
        <Dot /> Agent connected
      </span>
      <span className="ml-[8px] flex h-[26px] w-[26px] items-center justify-center rounded-full bg-zinc-800 text-[11px] font-semibold text-zinc-200">
        A
      </span>
    </div>
  )
}

type NavItem = { id: string; title: string; icon: LucideIcon; tag?: string }

const NAV: Array<{ label?: string; items: NavItem[] }> = [
  { items: [{ id: 'overview', title: 'Overview', icon: LayoutDashboard }] },
  {
    label: 'Build',
    items: [
      { id: 'database', title: 'Database', icon: Database },
      { id: 'auth', title: 'Auth & Users', icon: Shield },
      { id: 'storage', title: 'Storage', icon: HardDrive },
      { id: 'functions', title: 'Functions', icon: Code2 },
      { id: 'realtime', title: 'Realtime', icon: Radio },
      { id: 'integrations', title: 'Integrations', icon: Zap },
    ],
  },
  {
    label: 'Operate',
    items: [
      { id: 'autonomy', title: 'Autonomy', icon: Bot },
      { id: 'monitoring', title: 'Monitoring', icon: Activity },
      { id: 'branches', title: 'Branches', icon: GitBranch },
      { id: 'deploy', title: 'Deploy', icon: Rocket },
    ],
  },
  {
    label: 'Connect',
    items: [
      { id: 'connect', title: 'Connect', icon: Cable, tag: 'MCP' },
      { id: 'webhooks', title: 'Webhooks', icon: Webhook },
    ],
  },
  { items: [{ id: 'settings', title: 'Settings', icon: Settings }] },
]

function Sidebar({ active, quiet }: { active: Page; quiet: boolean }) {
  return (
    <div className="absolute bottom-0 left-0 top-[40px] w-[200px] px-[10px] pt-[7px] text-[13px]">
      {NAV.map((group, g) => (
        <div key={g} className={g === 0 ? '' : 'mt-[12px]'}>
          {group.label && <div className="mb-[4px] px-[8px] pt-[4px] text-[11.5px] text-zinc-500">{group.label}</div>}
          {group.items.map((item) => {
            const on = item.id === active
            const ItemIcon = item.icon
            return (
              <div
                key={item.id}
                className={`flex h-[26px] items-center gap-[10px] rounded-[6px] px-[8px] ${on ? 'bg-white/[0.07] text-zinc-50' : 'text-zinc-400'}`}
                style={{ transition: quiet ? 'none' : 'background-color 300ms, color 300ms' }}
              >
                <ItemIcon className="h-[15px] w-[15px] shrink-0" strokeWidth={1.8} />
                <span className="truncate">{item.title}</span>
                {item.tag && (
                  <span className="ml-auto rounded-[4px] border border-white/[0.1] px-[5px] text-[10px] text-zinc-400">{item.tag}</span>
                )}
              </div>
            )
          })}
        </div>
      ))}
      <div className="absolute inset-x-[10px] bottom-[14px] flex items-center rounded-[8px] border border-white/[0.07] bg-white/[0.02] px-[10px] py-[6px]">
        <div className="leading-tight">
          <div className="text-[10px] text-zinc-500">Frontend</div>
          <div className="text-[12px] text-zinc-200">Frontend connected</div>
        </div>
        <Dot className="ml-auto bg-emerald-400" />
      </div>
    </div>
  )
}

/* ── Database ─────────────────────────────────────────────────── */

const TABLES = [
  { name: 'products', perOrder: 0, base: 7 },
  { name: 'orders', perOrder: 1, base: 0 },
  { name: 'order_items', perOrder: 2, base: 0 },
  { name: 'users', perOrder: 0.67, base: 0 },
]

/** The store's first orders, newest first (sample rows from the r3 render). */
const ORDERS = [
  ['e6b7902d-513e-464d-853c-87e3b8ff2da7', '63812d12-daf9-4929-8be5-76ff06283535', '178.00', 'cs_live_460'],
  ['afa8fceb-b890-4574-b314-742d8c5a4d06', '18e873a2-7158-4447-8b0e-9f074941535f', '140.00', 'cs_live_d68'],
  ['ac7d3f50-84c3-4135-a96e-2a6fd6a418fb', '3701aa65-72ae-4272-97f8-7f3d0e703a02', '281.00', 'cs_live_5ca'],
  ['51a21ab1-ee41-4fb3-aadf-f6fbf4e6cca5', 'eb39f923-492d-4e16-b04e-86e2eb838542', '32.00', 'cs_live_108'],
  ['2a5ad5cf-2157-42bc-a249-0d34e7eecdff', 'e3e92575-73a5-4b0f-938a-ba541e6bfe1c', '32.00', 'cs_live_fa3'],
  ['5ecb30dc-b006-4860-9a76-1b4060890336', 'eb0b6d15-d1fa-4b6c-ac01-e01d16c5d57c', '249.00', 'cs_live_285'],
]

const DB_TABS: Array<{ title: string; icon: LucideIcon }> = [
  { title: 'Tables', icon: Table2 },
  { title: 'Schema', icon: Network },
  { title: 'SQL', icon: Terminal },
  { title: 'History', icon: History },
  { title: 'Types', icon: Braces },
  { title: 'Extensions', icon: Puzzle },
  { title: 'Snapshots', icon: Camera },
]

const GRID = 'grid grid-cols-[38px_276px_262px_104px_90px_1fr] items-center'

function DatabasePage({ view, quiet }: { view: View; quiet: boolean }) {
  const count = (t: (typeof TABLES)[number]) => (view.rows ? Math.round(t.base + t.perOrder * view.rows) : 0)
  const shown = ORDERS.slice(ORDERS.length - view.rows)
  return (
    <div className="absolute inset-0 text-[13px]">
      <div className="flex h-[48px] items-center justify-between px-[17px] pt-[6px]">
        <div className="flex items-baseline gap-[9px]">
          <span className="text-[15px] font-semibold tracking-[-0.01em] text-zinc-100">Database</span>
          <span className="text-[11.5px] text-zinc-500">
            {view.tables} {view.tables === 1 ? 'table' : 'tables'}
          </span>
        </div>
        <span className="inline-flex h-[28px] items-center gap-[6px] rounded-[6px] bg-white px-[11px] text-[12.5px] font-medium text-black">
          <Plus className="h-[13px] w-[13px]" /> New table
        </span>
      </div>
      <div className="flex h-[30px] items-end gap-[22px] border-b border-white/[0.07] px-[21px] text-[12.5px]">
        {DB_TABS.map((tab, i) => {
          const TabIcon = tab.icon
          return (
            <span
              key={tab.title}
              className={`flex h-[28px] items-center gap-[6px] border-b ${i === 0 ? 'border-zinc-100 text-zinc-100' : 'border-transparent text-zinc-400'}`}
            >
              <TabIcon className="h-[13px] w-[13px]" strokeWidth={1.8} /> {tab.title}
            </span>
          )
        })}
      </div>

      <div className="absolute bottom-0 left-0 top-[78px] flex w-full">
        {/* Tables list */}
        <div className="w-[206px] shrink-0 border-r border-white/[0.07] px-[7px] pt-[12px]">
          <div className="flex items-center justify-between px-[6px] text-[12.5px] text-zinc-200">
            Tables
            <span className="flex gap-[10px] text-zinc-500">
              <RefreshCw className="h-[12px] w-[12px]" />
              <Plus className="h-[13px] w-[13px]" />
            </span>
          </div>
          <div className="mt-[13px] flex h-[24px] items-center gap-[7px] rounded-[6px] border border-white/[0.08] px-[8px] text-[12px] text-zinc-500">
            <Search className="h-[12px] w-[12px]" /> Search tables...
          </div>
          <div className="mt-[14px] space-y-[2px]">
            {TABLES.map((t, i) => (
              <Enter key={t.name} on={i < view.tables} quiet={quiet} delay={(i % 3) * 110} from={4}>
                <div
                  className={`flex h-[26px] items-center gap-[9px] rounded-[6px] px-[8px] font-mono text-[12px] ${
                    t.name === 'orders' ? 'bg-white/[0.06] text-zinc-100' : 'text-zinc-300'
                  }`}
                >
                  <Table2 className="h-[12px] w-[12px] text-zinc-500" strokeWidth={1.8} />
                  {t.name}
                  <span className="ml-auto text-[11px] tabular-nums text-zinc-500">{count(t)}</span>
                </div>
              </Enter>
            ))}
          </div>
        </div>

        {/* The orders table */}
        <div className="relative min-w-0 flex-1">
          <Enter on={view.tables >= 3} quiet={quiet} delay={240} from={0}>
            <div className="flex items-center gap-[8px] px-[16px] pt-[11px]">
              <span className="font-mono text-[12.5px] font-semibold text-zinc-100">orders</span>
              <span className="text-[11.5px] text-zinc-500">
                {view.rows} {view.rows === 1 ? 'row' : 'rows'} · 6 columns
              </span>
              <span className="ml-auto flex h-[26px] items-center rounded-[6px] border border-white/[0.08] text-[11.5px]">
                <span className="flex h-full items-center gap-[5px] rounded-[5px] bg-white/[0.08] px-[8px] text-zinc-100">Data</span>
                <span className="flex items-center gap-[5px] px-[8px] text-zinc-400">Structure</span>
              </span>
              <span className="flex h-[26px] items-center gap-[5px] rounded-[6px] border border-white/[0.09] px-[9px] text-[11.5px] text-zinc-200">
                <Plus className="h-[12px] w-[12px]" /> Insert row
              </span>
              <RefreshCw className="ml-[4px] h-[12px] w-[12px] text-zinc-500" />
            </div>
            <div className="mx-[16px] mt-[11px] flex h-[24px] w-[232px] items-center gap-[7px] rounded-[6px] border border-white/[0.08] px-[8px] text-[12px] text-zinc-500">
              <Search className="h-[12px] w-[12px]" /> Search rows...
            </div>
            <div className={`${GRID} mt-[12px] h-[40px] border-y border-white/[0.07] pl-[2px] text-[11.5px]`}>
              <span className="text-center text-zinc-500">#</span>
              <ColHead icon={KeyRound} name="id" type="uuid" />
              <ColHead icon={Link2} name="customer_id" type="uuid" />
              <span className="pr-[14px] text-right">
                <span className="block font-semibold text-zinc-200">total</span>
                <span className="block text-[10px] text-zinc-500">numeric</span>
              </span>
              <ColHead name="status" type="text" />
              <ColHead name="stripe_session" type="text" />
            </div>
            <div className="relative">
              {shown.map((row, i) => (
                <OrderRow key={row[0]} row={row} index={i + 1} fresh={i < 2 && view.page === 'database'} quiet={quiet} />
              ))}
            </div>
          </Enter>
        </div>
      </div>
    </div>
  )
}

function ColHead({ name, type, icon: HeadIcon }: { name: string; type: string; icon?: LucideIcon }) {
  return (
    <span className="min-w-0">
      <span className="flex items-center gap-[5px] font-semibold text-zinc-200">
        {HeadIcon && <HeadIcon className="h-[11px] w-[11px] text-amber-300/80" />}
        {name}
      </span>
      <span className={`block text-[10px] text-zinc-500 ${HeadIcon ? 'pl-[16px]' : ''}`}>{type}</span>
    </span>
  )
}

function OrderRow({ row, index, fresh, quiet }: { row: string[]; index: number; fresh: boolean; quiet: boolean }) {
  return (
    <div
      className={`${GRID} h-[31px] border-b border-white/[0.05] pl-[2px] font-mono text-[11.5px] text-zinc-300`}
      style={{
        backgroundColor: fresh ? 'rgba(139,92,246,0.10)' : 'transparent',
        transition: quiet ? 'none' : 'background-color 900ms ease-out',
        animation: quiet ? undefined : `v7-row-in 420ms ${EASE} both`,
      }}
    >
      <span className="text-center text-zinc-500">{index}</span>
      <span className="truncate pr-[10px]">{row[0]}</span>
      <span className="truncate pr-[10px]">{row[1]}</span>
      <span className="pr-[14px] text-right text-zinc-200">{row[2]}</span>
      <span className="text-zinc-300">paid</span>
      <span className="truncate text-zinc-400">{row[3]}</span>
    </div>
  )
}

/* ── Overview ─────────────────────────────────────────────────── */

const LOOP: Array<{ label: string; icon: LucideIcon; unit: string }> = [
  { label: 'Observe', icon: Eye, unit: 'guarantees, every minute' },
  { label: 'Detect', icon: ScanSearch, unit: 'broken guarantees' },
  { label: 'Propose', icon: GitPullRequestArrow, unit: 'waiting on you' },
  { label: 'Apply', icon: Wrench, unit: 'fixed on its own' },
  { label: 'Verify', icon: ShieldCheck, unit: 'proven fixed' },
]

const RECEIPT_TEXT: Record<Receipt, string> = {
  fk: 'Backenly added a foreign-key constraint to "order_items.order_id"',
  index: 'Backenly added an index on "orders.customer_id"',
}

/**
 * The agent panel's one state the story passes through (WorkspaceHome.tsx): the
 * held change. With nothing waiting the product renders no panel, so neither
 * does this copy of it.
 */
function AgentPanelCopy() {
  return (
    <div className="flex-1 px-[23px] pt-[34px]">
      <div className="text-[17px] font-semibold tracking-[-0.015em] text-zinc-50">Waiting on your review</div>
      <p className="mt-[10px] max-w-[470px] text-[13px] leading-[1.45] text-zinc-400">
        Backenly prepared 1 change and is holding it. Destructive and auth-related changes never ship without your OK.
      </p>
      <span className="mt-[14px] inline-flex h-[28px] items-center rounded-[6px] bg-white px-[12px] text-[12.5px] font-semibold text-black">
        Review the change
      </span>
    </div>
  )
}

function OverviewPage({ view, quiet }: { view: View; quiet: boolean }) {
  const values = [String(26), String(view.detect), String(view.propose), String(view.apply), view.verify]
  const receiptAge = (r: Receipt) => (r === 'fk' || view.receipts.length === 1 ? 'just now' : '1m ago')
  const holding = view.propose > 0
  return (
    <div className="absolute inset-x-0 top-0 text-[13px]">
      <div className="px-[37px] pb-[16px] pt-[26px] text-[22px] font-semibold tracking-[-0.02em] text-zinc-50">UrbanCart</div>

      {/* Agent panel, only while a change waits on you. It opens and closes
          the way a receipt does below (176 = its 164 plus the 12 below it). */}
      <div
        className="overflow-hidden"
        style={{
          maxHeight: holding ? 176 : 0,
          opacity: holding ? 1 : 0,
          transition: quiet ? 'none' : `max-height 500ms ${EASE}, opacity 400ms ${EASE}`,
        }}
      >
        <div className="mx-[37px] mb-[12px] flex h-[164px] rounded-[10px] border border-white/[0.08] bg-white/[0.015]">
          <AgentPanelCopy />
          <div className="flex w-[267px] flex-col border-l border-white/[0.07]">
            <div className="flex-1 px-[20px] pt-[20px]">
              <div className="flex items-center justify-between text-[11px] text-zinc-500">
                Autonomy mode <ChevronRight className="h-[12px] w-[12px]" />
              </div>
              <div className="mt-[10px] flex items-center gap-[8px]">
                <span className="text-[14px] font-semibold text-zinc-50">Autopilot</span>
                <span className="inline-flex items-center gap-[5px] text-[11px] text-zinc-300">
                  <Dot /> Live
                </span>
              </div>
              <p className="mt-[8px] text-[12px] leading-[1.45] text-zinc-400">Safe fixes ship on their own. Everything risky waits for you.</p>
            </div>
            <div className="flex gap-[8px] border-t border-white/[0.07] px-[20px] py-[10px] text-[11px] leading-[1.45] text-zinc-500">
              <Shield className="mt-[2px] h-[12px] w-[12px] shrink-0" />
              Auth, destructive and irreversible changes always need your approval, in every mode.
            </div>
          </div>
        </div>
      </div>

      {/* Self-healing loop: WorkspaceHome.tsx readings */}
      <div className="mx-[37px] rounded-[10px] border border-white/[0.08] bg-white/[0.015]">
        <div className="flex h-[37px] items-center border-b border-white/[0.07] px-[19px]">
          <span className="text-[13px] font-semibold text-zinc-100">Self-healing loop</span>
          <span className="ml-[10px] inline-flex items-center gap-[6px] text-[11px] text-zinc-300">
            <Dot /> Running
          </span>
          <span className="ml-auto text-[11px] text-zinc-500">Checked 9s ago</span>
        </div>
        <div className="relative grid grid-cols-5 px-[27px] pt-[19px]">
          {/* the connector, behind the tiles */}
          <span aria-hidden className="absolute left-[121px] right-[121px] top-[37px] h-px bg-white/[0.09]" />
          <span
            aria-hidden
            className="absolute left-[121px] top-[37px] h-px origin-left bg-violet-300/70"
            style={{
              width: 'calc(100% - 242px)',
              transform: `scaleX(${view.phase / 4})`,
              transition: quiet ? 'none' : `transform 700ms ${EASE}`,
            }}
          />
          {LOOP.map((node, i) => {
            const lit = i === view.phase
            const NodeIcon = node.icon
            const accent = i === 2 && holding
            return (
              <div key={node.label} className="relative flex flex-col items-center text-center">
                <span
                  className={`relative flex h-[36px] w-[36px] items-center justify-center rounded-[8px] border bg-[#101014] ${
                    lit ? 'border-violet-300/60 text-violet-100' : 'border-white/[0.12] text-zinc-400'
                  }`}
                  style={{
                    boxShadow: lit ? '0 0 0 4px rgba(139,92,246,0.14), 0 0 22px rgba(139,92,246,0.35)' : 'none',
                    transition: quiet ? 'none' : 'box-shadow 400ms, border-color 400ms, color 400ms',
                  }}
                >
                  <NodeIcon className="h-[15px] w-[15px]" strokeWidth={1.8} />
                  <span className="absolute -right-[7px] -top-[7px] flex h-[14px] w-[14px] items-center justify-center rounded-[3px] border border-white/[0.15] bg-[#16161b] text-[9px] text-zinc-300">
                    {i + 1}
                  </span>
                </span>
                <span className={`mt-[14px] text-[13px] ${lit ? 'text-zinc-50' : 'text-zinc-300'}`}>{node.label}</span>
                <span
                  key={values[i]}
                  className={`mt-[6px] text-[22px] font-semibold tabular-nums tracking-[-0.02em] ${accent ? 'text-amber-300' : 'text-zinc-50'}`}
                  style={{ animation: quiet ? undefined : `v7-num-in 420ms ${EASE} both` }}
                >
                  {values[i]}
                </span>
                <span className="mt-[2px] max-w-[110px] text-[11px] leading-[1.35] text-zinc-500">{node.unit}</span>
              </div>
            )
          })}
        </div>
        <div className="mt-[22px] grid grid-cols-5 px-[27px] text-[11px] text-zinc-500">
          <Axis className="col-span-3 pr-[12px]" label="Right now" />
          <Axis className="col-span-2 pl-[12px]" label="Last 30 days" />
        </div>
        <div className="relative mx-[121px] mt-[14px] h-[36px] rounded-b-[10px] border-x border-b border-white/[0.1]">
          <span className="absolute -top-[7px] left-[-4px] h-0 w-0 border-x-[4px] border-b-[6px] border-x-transparent border-b-white/[0.25]" />
          <span className="absolute -bottom-[7px] left-1/2 -translate-x-1/2 bg-[#0d0d11] px-[10px] text-[11px] text-zinc-500">
            Verify feeds the next Observe. No human at the top of the loop
          </span>
        </div>
        <div className="mt-[22px]">
          {(['fk', 'index'] as Receipt[]).map((r) => {
            const on = view.receipts.includes(r)
            return (
              <div
                key={r}
                className="overflow-hidden"
                style={{
                  maxHeight: on ? 37 : 0,
                  opacity: on ? 1 : 0,
                  transition: quiet ? 'none' : `max-height 500ms ${EASE}, opacity 400ms ${EASE}`,
                }}
              >
                <div className="flex h-[37px] items-center gap-[12px] border-t border-white/[0.07] px-[21px] text-[13px] text-zinc-200">
                  <Dot />
                  {RECEIPT_TEXT[r]}
                  <span className="ml-auto text-[11px] text-zinc-500">{receiptAge(r)}</span>
                </div>
              </div>
            )
          })}
          <div className="flex h-[37px] items-center justify-between border-t border-white/[0.07] px-[19px] text-[12.5px] text-zinc-400">
            Full guardrail log, repairs and approvals
            <ChevronRight className="h-[13px] w-[13px]" />
          </div>
        </div>
      </div>
    </div>
  )
}

function Axis({ label, className }: { label: string; className: string }) {
  return (
    <div className={`flex items-center gap-[10px] ${className}`}>
      <span className="h-px flex-1 bg-white/[0.08]" />
      {label}
      <span className="h-px flex-1 bg-white/[0.08]" />
    </div>
  )
}

/* ── Autonomy ─────────────────────────────────────────────────── */

function AutonomyPage({ view, quiet }: { view: View; quiet: boolean }) {
  return (
    <div className="absolute inset-0 px-[27px] pt-[13px] text-[13px]">
      <div className="flex rounded-[8px] border border-white/[0.08] bg-white/[0.02] px-[14px] py-[10px]">
        <ClipboardList className="mt-[2px] h-[13px] w-[13px] text-zinc-400" />
        <div className="ml-[10px]">
          <div className="text-[13px] text-zinc-100">
            Backenly handled 1 thing for you and flagged 1 for your review while you were away.
          </div>
          <div className="mt-[3px] text-[12px] text-violet-300">See 2 items →</div>
        </div>
        <X className="ml-auto h-[13px] w-[13px] text-zinc-500" />
      </div>

      <div className="px-[10px] pt-[30px]">
        <div className="flex items-center gap-[10px]">
          <span className="text-[19px] font-semibold tracking-[-0.02em] text-zinc-50">Autonomy</span>
          <span className="inline-flex items-center gap-[6px] text-[11.5px] text-zinc-300">
            <Dot /> Autopilot
          </span>
        </div>
        <p className="mt-[9px] max-w-[720px] text-[13px] leading-[1.5] text-zinc-400">
          Your backend keeps working when nobody is asking. Choose what Backenly may change on its own and what always waits for
          you. The safety floor never moves, in any mode.
        </p>
      </div>

      {/* Waiting on you */}
      <div className="mx-[10px] mt-[26px] rounded-[10px] border border-white/[0.08] bg-white/[0.015]">
        <div className="flex h-[40px] items-center gap-[9px] px-[19px]">
          <AlertTriangle className="h-[14px] w-[14px] text-amber-300" />
          <span className="text-[13px] font-semibold text-zinc-100">Waiting on you</span>
          <span className="text-[12px] text-amber-300">1</span>
          <RefreshCw className="ml-auto h-[12px] w-[12px] text-zinc-500" />
        </div>
        <div className="border-b border-white/[0.07] px-[19px] pb-[11px] text-[12px] text-zinc-500">
          Backenly deliberately did not act on these. They need your call; everything else it handles itself.
        </div>
        <div className="flex gap-[14px] px-[19px] py-[16px]">
          <Dot className="mt-[7px] bg-amber-300" />
          <div className="min-w-0 flex-1">
            <div className="text-[13px] text-zinc-100">
              <Code>order_items</Code> has a relation with no foreign key constraint
            </div>
            <p className="mt-[6px] max-w-[500px] text-[12px] leading-[1.45] text-zinc-500">
              Adding a foreign key changes which writes the database accepts from that moment on, and the delete rule is inferred
              from the column name, so it is stated for you to approve rather than applied.
            </p>
            <div className="mt-[7px] font-mono text-[11px] text-zinc-600">missing_fk · warning · order_items · 1m ago</div>
          </div>
          <div className="flex items-start gap-[10px] pt-[0px]">
            <span
              className="inline-flex h-[28px] items-center rounded-[6px] bg-white px-[16px] text-[12.5px] font-semibold text-black"
              style={{
                transform: view.pressed ? 'scale(0.95)' : 'none',
                backgroundColor: view.pressed ? '#d4d4d8' : '#ffffff',
                boxShadow: view.pressed ? '0 0 0 3px rgba(196,181,253,0.45)' : 'none',
                transition: quiet ? 'none' : 'transform 160ms ease-out, background-color 160ms, box-shadow 220ms',
              }}
            >
              Approve &amp; fix
            </span>
            <span className="inline-flex h-[28px] items-center gap-[6px] rounded-[6px] border border-white/[0.1] px-[10px] text-[12.5px] text-zinc-200">
              <ClipboardList className="h-[12px] w-[12px]" /> Hand to my agent
            </span>
            <span className="inline-flex h-[28px] items-center px-[8px] text-[12.5px] text-zinc-400">Dismiss</span>
          </div>
        </div>
      </div>

      {/* Changes Backenly made */}
      <div className="mx-[10px] mt-[24px] rounded-[10px] border border-white/[0.08] bg-white/[0.015]">
        <div className="flex h-[40px] items-center gap-[9px] px-[19px]">
          <History className="h-[14px] w-[14px] text-zinc-400" />
          <span className="text-[13px] font-semibold text-zinc-100">Changes Backenly made</span>
          <span className="text-[12px] text-zinc-500">1</span>
          <span className="ml-auto text-[11px] text-zinc-500">1 undoable</span>
        </div>
        <div className="border-b border-white/[0.07] px-[19px] pb-[11px] text-[12px] text-zinc-500">
          Applied without waiting for you, because each one was additive and snapshotted first. Undo restores the exact state captured
          before the fix ran.
        </div>
        <div className="flex gap-[14px] px-[19px] py-[15px]">
          <Dot className="mt-[7px] bg-zinc-500" />
          <div className="min-w-0 flex-1">
            <div className="text-[13px] text-zinc-100">Backenly added an index on &quot;orders.customer_id&quot;</div>
            <div className="mt-[6px] font-mono text-[11px] text-zinc-600">
              slow_query_missing_index · orders · 1m ago · <span className="text-emerald-400">re-checked and confirmed</span>
            </div>
            <div className="mt-[10px] inline-flex items-center gap-[5px] text-[12px] text-zinc-400">
              1 statement <ChevronDown className="h-[12px] w-[12px]" />
            </div>
          </div>
          <span className="inline-flex h-[28px] items-center gap-[6px] rounded-[6px] border border-white/[0.12] px-[12px] text-[12.5px] text-zinc-100">
            <Undo2 className="h-[12px] w-[12px]" /> Undo
          </span>
        </div>
      </div>
    </div>
  )
}

/* ── The agent's session (Claude Code, the r3 render) ─────────── */

const CALLS: Array<{ tool: string; args: string; result: ReactNode }> = [
  { tool: 'read_backend_state', args: '(section: "schema")', result: 'UrbanCart: no tables yet. Auth, storage and realtime are off.' },
  {
    tool: 'apply_migration',
    args: '(sql: "CREATE TABLE …")',
    result: (
      <>
        Applied 9 statements: <b className="font-semibold text-zinc-100">products</b>, <b className="font-semibold text-zinc-100">orders</b>,{' '}
        <b className="font-semibold text-zinc-100">order_items</b>
      </>
    ),
  },
  { tool: 'auth', args: '(action: "enable")', result: 'Email/password sign-up and sign-in configured' },
  { tool: 'set_rls', args: '(tableName: "orders")', result: 'Policy applied, read back from PostgreSQL' },
  {
    tool: 'integrations',
    args: '(action: "connect")',
    result: (
      <>
        <b className="font-semibold text-zinc-100">stripe</b> · key verified with the provider, stored encrypted
      </>
    ),
  },
  {
    tool: 'realtime',
    args: '(action: "enable")',
    result: (
      <>
        <b className="font-semibold text-zinc-100">orders</b> · streaming inserts, updates and deletes
      </>
    ),
  },
]

export function AgentSession({ term, quiet }: { term: number; quiet: boolean }) {
  return (
    <div className="absolute inset-0 rounded-[14px] border border-white/[0.11] bg-[#151518] font-mono text-[14.5px] text-zinc-300">
      <div className="relative flex h-[44px] items-center justify-center text-[13px] text-zinc-400">
        <span className="absolute left-[20px] flex gap-[8px]">
          <span className="h-[12px] w-[12px] rounded-full bg-zinc-600" />
          <span className="h-[12px] w-[12px] rounded-full bg-zinc-600" />
          <span className="h-[12px] w-[12px] rounded-full bg-zinc-600" />
        </span>
        <span className="font-sans">~/urbancart — claude</span>
      </div>
      <Enter on={term >= 1} quiet={quiet} from={4}>
        <div className="mx-[12px] bg-white/[0.045] px-[12px] py-[10px] leading-[1.7] text-zinc-100">
          &gt; Build the production backend for UrbanCart, my online store: products, orders, customer accounts, Stripe checkout and
          realtime order updates.
        </div>
      </Enter>
      <div className="mt-[20px] space-y-[12px] px-[22px]">
        {CALLS.map((call, i) => (
          <Enter key={call.tool} on={term >= i + 2} quiet={quiet} from={5}>
            <div className="flex items-baseline gap-[10px] leading-[1.5]">
              <Dot className="relative -top-[2px] bg-emerald-400" />
              <span>
                <b className="font-semibold text-zinc-50">backenly - {call.tool}</b>
                <span className="text-zinc-500"> (MCP)</span>
                <span className="text-zinc-400">{call.args}</span>
              </span>
            </div>
            <div className="pl-[16px] leading-[1.6] text-zinc-300">└ {call.result}</div>
          </Enter>
        ))}
        <Enter on={term >= 8} quiet={quiet} from={5}>
          <div className="flex items-baseline gap-[10px] leading-[1.5] text-zinc-100">
            <Dot className="relative -top-[2px] bg-zinc-100" />
            Done. Every change is verified on the live database, ready to publish.
          </div>
        </Enter>
      </div>
      <div className="absolute inset-x-[16px] bottom-[40px] flex h-[48px] items-center rounded-[8px] border border-white/[0.12] px-[16px] text-zinc-400">
        &gt;
        <span
          aria-hidden
          className="ml-[8px] inline-block h-[18px] w-[9px] bg-zinc-400"
          style={{ animation: quiet || term < 8 ? undefined : 'v7-caret 1.1s steps(1) infinite', opacity: term >= 8 ? 1 : 0 }}
        />
      </div>
      <div className="absolute bottom-[12px] left-[24px] text-[12px] text-zinc-500">? for shortcuts</div>
    </div>
  )
}

/* ── The console ──────────────────────────────────────────────── */

export function ConsoleScreen({ view, quiet }: { view: View; quiet: boolean }) {
  return (
    <div className="absolute inset-0 overflow-hidden bg-[#09090b] font-sans antialiased">
      <TopBar />
      <Sidebar active={view.page} quiet={quiet} />
      <div className="absolute bottom-0 left-[200px] right-0 top-[40px] overflow-hidden rounded-tl-[10px] border-l border-t border-white/[0.08] bg-[#0c0c0f]">
        <Layer on={view.page === 'database'} quiet={quiet}>
          <DatabasePage view={view} quiet={quiet} />
        </Layer>
        <Layer on={view.page === 'overview'} quiet={quiet}>
          <OverviewPage view={view} quiet={quiet} />
        </Layer>
        <Layer on={view.page === 'autonomy'} quiet={quiet}>
          <AutonomyPage view={view} quiet={quiet} />
        </Layer>
      </div>
    </div>
  )
}

/** Keyframes the console and session use, once per page. */
export const CONSOLE_KEYFRAMES =
  '@keyframes v7-row-in{from{opacity:0;transform:translateY(-8px)}to{opacity:1;transform:none}}' +
  '@keyframes v7-num-in{from{opacity:0;transform:translateY(5px)}to{opacity:1;transform:none}}' +
  '@keyframes v7-caret{0%,50%{opacity:1}50.01%,100%{opacity:0}}'
