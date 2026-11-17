'use client'

/**
 * The first page of a section the coding agent builds into, before it has
 * built anything there: Database, Auth & Users, Storage, Functions, Realtime.
 *
 * The founder's call (2026-11-17): on these five, the plain top-left
 * EmptyPanel read as "too plain", and the centred empty state they had before
 * the console rebuild was better. This is that state, drawn in today's
 * console language: the outline of the page it becomes, what it holds, the
 * request to send the agent, then Connect agent and the docs. Every other
 * empty panel keeps EmptyPanel (states.tsx).
 *
 *            ┌────────┬──────────────────────────────┐
 *            │ ▬▬▬    │ ▬▬▬▬▬   ▬▬▬▬▬▬   ▬▬▬▬▬        │   the page it becomes, in outline,
 *            │ ▬▬▬▬▬  │ ▬▬▬▬▬▬  ▬▬▬▬     ▬▬▬▬▬▬▬      │   faded at the foot
 *            └────────┴──────────────────────────────┘
 *                          No tables yet                       16px medium, white
 *         Your agent creates the tables your app needs, ...      14px zinc-400, two lines at most
 *            ┌ Ask your agent ─────────────── Copy ┐           "Ask Claude Code" once it is connected
 *            │ Add a products table with a name, …   │
 *            └───────────────────────────────────────┘
 *                [Connect agent]   Database docs ↗              Connect agent until an agent connects
 *
 * The outline is a miniature of the section's own page (its rail, its column
 * heads, its rows), so the picture says what the page turns into. Shapes
 * only, never words or numbers, so nothing in it can be read as the
 * project's data; it is decorative and hidden from assistive tech. It builds
 * in once, top to bottom, as the page opens (globals.css .first-run-in), then
 * holds still. With reduced motion it is simply there.
 */

import type { ComponentType, CSSProperties, ReactNode } from 'react'
import { ArrowUpRight, Cable } from 'lucide-react'
import type { DocSlug } from '@/app/docs/content'
import { KitButtonLink } from '@/components/inspector/kit'
import { EDGE, GRID_HEAD, PLATE, RAIL, RULE, R_PANEL, WELL } from './tokens'
import { AskYourAgent, docsHref, type AgentState } from './states'

export type FirstRunPicture = 'tables' | 'users' | 'files' | 'functions' | 'events'

export interface FirstRunProps {
  /** Which page to draw in outline. */
  picture: FirstRunPicture
  /** "No tables yet". */
  title: string
  /** What the section holds, in at most two lines. */
  sentence: string
  /** The request to send the agent: one, as the five pages each give (1-3 fit). */
  requests: readonly string[]
  /** For Connect agent's link. */
  projectId: string
  /** useAgentConnection's answer; null or loading while unknown, so nothing flashes the wrong offer. */
  agent?: AgentState | null
  /** An owner or admin, who can connect an agent. Others are told who can. */
  canConnect?: boolean
  docs: { label: string; slug: DocSlug }
  /** The title's level in the page outline: h2 under the page's bar. */
  headingLevel?: 2 | 3
  className?: string
}

export function FirstRun({
  picture,
  title,
  sentence,
  requests,
  projectId,
  agent,
  canConnect = true,
  docs,
  headingLevel = 2,
  className = '',
}: FirstRunProps) {
  const Heading = `h${headingLevel}` as 'h2' | 'h3'
  const disconnected = agent?.status === 'disconnected'
  const client = agent?.status === 'connected' ? agent.client?.trim() || null : null
  const Picture = PICTURES[picture]
  return (
    <div className={`flex min-h-full flex-col items-center justify-center px-[20px] py-[32px] text-center sm:py-[48px] ${className}`}>
      <Picture />
      <Heading className="mt-[20px] text-[16px] font-medium leading-[24px] tracking-[-0.012em] text-white [text-wrap:balance]">{title}</Heading>
      <p className="mt-[6px] max-w-[480px] text-[14px] leading-[22px] tracking-[-0.006em] text-zinc-400 [text-wrap:balance]">{sentence}</p>
      {/* The requests are prose to copy, so they read left to right inside the centred column. */}
      <div className="mt-[24px] w-full max-w-[480px] text-left">
        <AskYourAgent requests={requests} label={client ? `Ask ${client}` : 'Ask your agent'} />
      </div>
      {disconnected && !canConnect && (
        <p className="mt-[16px] max-w-[480px] text-[13px] leading-[20px] text-faint">Only an owner or admin can connect an agent to this project.</p>
      )}
      <div className="mt-[20px] flex flex-wrap items-center justify-center gap-[8px]">
        {disconnected && canConnect && (
          <KitButtonLink href={`/app/projects/${projectId}/connect`} variant="primary" icon={Cable}>
            Connect agent
          </KitButtonLink>
        )}
        {/* In a new tab, so the console keeps its place. */}
        <KitButtonLink href={docsHref(docs.slug)} variant="ghost" external>
          {docs.label}
          <ArrowUpRight aria-hidden className="h-[14px] w-[14px]" strokeWidth={2} />
        </KitButtonLink>
      </div>
    </div>
  )
}

// ─── The outlines ────────────────────────────────────────────────────────────

/** The frame every outline sits in: a panel like the page's own, faded at the foot. */
const FRAME = `relative flex h-[164px] w-[408px] max-w-full overflow-hidden ${R_PANEL} border ${EDGE} ${PLATE} text-left shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] [mask-image:linear-gradient(to_bottom,#000_48%,transparent)]`

/** Four brightnesses: a column head, a name, a value, a meta line. */
const TONE = {
  head: 'bg-white/[0.14]',
  strong: 'bg-white/[0.10]',
  base: 'bg-white/[0.065]',
  faint: 'bg-white/[0.04]',
} as const
type Tone = keyof typeof TONE

/** One line of text, as a rounded bar. A number is pixels; a string is a share of the space it sits in. */
function Bar({ w, tone = 'base', h = 6 }: { w: number | string; tone?: Tone; h?: number }) {
  return <span className={`block flex-shrink-0 rounded-full ${TONE[tone]}`} style={{ width: w, height: h }} />
}

/** A small outlined tag: an operation, a method, a sign-in provider. */
function Chip({ w }: { w: number }) {
  return <span className="block h-[14px] flex-shrink-0 rounded-[4px] border border-white/[0.09] bg-white/[0.025]" style={{ width: w }} />
}

/** A table's or a bucket's mark in a rail, and a row's checkbox. */
function Square({ tone = 'border-white/[0.14]' }: { tone?: string }) {
  return <span className={`block h-[8px] w-[8px] flex-shrink-0 rounded-[2px] border ${tone}`} />
}

/** One step of the build-in. `d` is its delay in milliseconds. */
function In({ d, className = '', children }: { d: number; className?: string; children: ReactNode }) {
  return (
    <div className={`first-run-in ${className}`} style={{ '--d': `${d}ms` } as CSSProperties}>
      {children}
    </div>
  )
}

/** The page's rail: a short list with one item chosen, as the real rail has. */
function Rail({ items, chosen, width = 100 }: { items: Array<{ lead: ReactNode; w: number }>; chosen?: number; width?: number }) {
  return (
    <In d={60} className={`h-full flex-shrink-0 border-r ${RULE} ${RAIL} p-[6px]`}>
      <div style={{ width: width - 13 }} className="space-y-[2px]">
        {items.map((item, i) => (
          <div key={i} className={`flex h-[24px] items-center gap-[7px] rounded-[5px] px-[7px] ${i === chosen ? 'bg-white/[0.06]' : ''}`}>
            {item.lead}
            <Bar w={item.w} tone={i === chosen ? 'strong' : 'base'} h={5} />
          </div>
        ))}
      </div>
    </In>
  )
}

/** Database: the tables rail, then a grid with its column heads. */
function TablesPicture() {
  const cols = `grid grid-cols-[8px_1.2fr_0.8fr_1fr] items-center gap-x-[14px] px-[12px]`
  const rows = [
    ['76%', '52%', '70%'],
    ['58%', '68%', '46%'],
    ['70%', '40%', '62%'],
    ['52%', '60%', '74%'],
    ['64%', '46%', '56%'],
  ]
  return (
    <div aria-hidden className={FRAME}>
      <Rail
        chosen={1}
        items={[
          { lead: <Square />, w: 40 },
          { lead: <Square />, w: 54 },
          { lead: <Square />, w: 32 },
          { lead: <Square />, w: 46 },
        ]}
      />
      <div className="min-w-0 flex-1">
        <In d={140} className={`${cols} h-[30px] border-b ${RULE} ${GRID_HEAD}`}>
          <Square tone="border-white/[0.12]" />
          <Bar w="54%" tone="head" />
          <Bar w="64%" tone="head" />
          <Bar w="48%" tone="head" />
        </In>
        {rows.map((row, i) => (
          <In key={i} d={200 + i * 60} className={`${cols} h-[30px] border-b ${RULE}`}>
            <Square tone="border-white/[0.08]" />
            {row.map((w, j) => (
              <Bar key={j} w={w} tone={j === 0 ? 'strong' : 'base'} />
            ))}
          </In>
        ))}
      </div>
    </div>
  )
}

/** Auth & Users: the search bar, then people, each with how they signed in and when. */
function UsersPicture() {
  const rows: Array<[string, number, number]> = [
    ['56%', 30, 24],
    ['42%', 26, 30],
    ['64%', 30, 20],
    ['48%', 26, 28],
  ]
  return (
    <div aria-hidden className={`${FRAME} flex-col`}>
      <In d={60} className={`flex h-[38px] flex-shrink-0 items-center justify-between gap-[12px] border-b ${RULE} px-[12px]`}>
        <span className={`flex h-[22px] w-[46%] items-center gap-[7px] rounded-[6px] border ${EDGE} ${WELL} px-[8px]`}>
          <span className="block h-[7px] w-[7px] flex-shrink-0 rounded-full border border-white/[0.20]" />
          <Bar w="46%" tone="faint" h={5} />
        </span>
        <Bar w={42} tone="faint" />
      </In>
      {rows.map(([w, chip, at], i) => (
        <In key={i} d={140 + i * 60} className={`flex h-[36px] flex-shrink-0 items-center gap-[10px] border-b ${RULE} px-[12px]`}>
          <span className="block h-[18px] w-[18px] flex-shrink-0 rounded-full border border-white/[0.10] bg-white/[0.04]" />
          <span className="flex min-w-0 flex-1">
            <Bar w={w} tone="strong" />
          </span>
          <Chip w={chip} />
          <span className="flex w-[40px] flex-shrink-0 justify-end">
            <Bar w={at} tone="faint" />
          </span>
        </In>
      ))}
    </div>
  )
}

/** A picture's mark inside a file tile. */
function ImageMark() {
  return (
    <svg viewBox="0 0 16 12" className="h-[12px] w-[16px]" fill="none" stroke="rgba(255,255,255,0.18)" strokeWidth="1" strokeLinejoin="round">
      <rect x="0.5" y="0.5" width="15" height="11" rx="2" />
      <circle cx="5" cy="4.2" r="1.3" />
      <path d="M1 10.5 L6 6.5 L9 9 L11.5 7 L15 10" />
    </svg>
  )
}

/** Storage: the buckets rail, then files as tiles. */
function FilesPicture() {
  const names = ['72%', '54%', '66%', '80%', '60%', '76%', '48%', '68%']
  return (
    <div aria-hidden className={FRAME}>
      <Rail
        chosen={0}
        items={[
          { lead: <Square />, w: 44 },
          { lead: <Square />, w: 34 },
          { lead: <Square />, w: 50 },
        ]}
      />
      <div className="grid min-w-0 flex-1 grid-cols-4 content-start gap-[8px] p-[10px]">
        {names.map((w, i) => (
          <In key={i} d={140 + i * 45} className={`rounded-[7px] border ${RULE} bg-white/[0.015] p-[4px]`}>
            <div className="flex aspect-[4/3] items-center justify-center rounded-[5px] bg-white/[0.035]">
              <ImageMark />
            </div>
            <span className="mx-[2px] mb-[2px] mt-[6px] block">
              <Bar w={w} h={5} />
            </span>
          </In>
        ))}
      </div>
    </div>
  )
}

/** Functions: the functions rail, each with its trigger, then one function's code. */
function FunctionsPicture() {
  // [indent, segments]: a keyword-bright piece, then the rest of the line.
  const lines: Array<[number, Array<[string, Tone]>]> = [
    [0, [['20%', 'strong'], ['34%', 'base']]],
    [1, [['14%', 'faint'], ['42%', 'base']]],
    [2, [['24%', 'base'], ['16%', 'strong']]],
    [2, [['38%', 'base']]],
    [1, [['12%', 'strong'], ['26%', 'base']]],
    [0, [['6%', 'faint']]],
  ]
  return (
    <div aria-hidden className={FRAME}>
      <Rail
        width={112}
        chosen={0}
        items={[
          { lead: <Chip w={22} />, w: 42 },
          { lead: <Chip w={22} />, w: 34 },
          { lead: <Chip w={22} />, w: 46 },
        ]}
      />
      <div className="min-w-0 flex-1">
        <In d={140} className={`flex h-[32px] items-center gap-[8px] border-b ${RULE} ${GRID_HEAD} px-[12px]`}>
          <Chip w={34} />
          <Bar w="40%" tone="head" />
        </In>
        <div className="py-[8px]">
          {lines.map(([indent, segments], i) => (
            <In key={i} d={200 + i * 55} className="flex h-[19px] items-center gap-[10px] px-[12px]">
              <Bar w={6} tone="faint" h={4} />
              <span className="flex min-w-0 flex-1 items-center gap-[6px]" style={{ paddingLeft: indent * 14 }}>
                {segments.map(([w, tone], j) => (
                  <Bar key={j} w={w} tone={tone} />
                ))}
              </span>
            </In>
          ))}
        </div>
      </div>
    </div>
  )
}

/** Realtime: the tables rail (● streaming, ○ not), then changes as they arrive. */
function EventsPicture() {
  const rows: Array<[number, number, string]> = [
    [30, 50, '72%'],
    [26, 42, '56%'],
    [30, 56, '64%'],
    [26, 46, '50%'],
    [30, 50, '60%'],
  ]
  const live = <span className="block h-[6px] w-[6px] flex-shrink-0 rounded-full bg-white/[0.32]" />
  const idle = <span className="block h-[6px] w-[6px] flex-shrink-0 rounded-full border border-white/[0.20]" />
  return (
    <div aria-hidden className={FRAME}>
      <Rail
        items={[
          { lead: live, w: 40 },
          { lead: live, w: 52 },
          { lead: idle, w: 34 },
        ]}
      />
      <div className="min-w-0 flex-1">
        <In d={140} className={`flex h-[30px] items-center gap-[12px] border-b ${RULE} ${GRID_HEAD} px-[12px]`}>
          <span className="w-[32px] flex-shrink-0">
            <Bar w={24} tone="head" />
          </span>
          <span className="w-[42px] flex-shrink-0">
            <Bar w={28} tone="head" />
          </span>
          <span className="w-[58px] flex-shrink-0">
            <Bar w={30} tone="head" />
          </span>
          <Bar w={26} tone="head" />
        </In>
        {rows.map(([at, table, row], i) => (
          <In key={i} d={200 + i * 60} className={`flex h-[30px] items-center gap-[12px] border-b ${RULE} px-[12px]`}>
            <span className="w-[32px] flex-shrink-0">
              <Bar w={at} tone="faint" />
            </span>
            <span className="w-[42px] flex-shrink-0">
              <Chip w={40} />
            </span>
            <span className="w-[58px] flex-shrink-0">
              <Bar w={table} tone="strong" />
            </span>
            <span className="flex min-w-0 flex-1">
              <Bar w={row} />
            </span>
          </In>
        ))}
      </div>
    </div>
  )
}

const PICTURES: Record<FirstRunPicture, ComponentType> = {
  tables: TablesPicture,
  users: UsersPicture,
  files: FilesPicture,
  functions: FunctionsPicture,
  events: EventsPicture,
}
