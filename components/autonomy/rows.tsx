'use client'

/**
 * One row anatomy for everything the Autonomy page lists: what waits on you,
 * what Backenly found, what it changed, the architecture changes and the
 * activity behind them.
 *
 *   [tile]  A title in plain words                  [secondary] [primary] [⋯]
 *           A sentence on why, when there is one
 *           Facts, each its own item: who asked, how much, how old
 *           Show the statements (on demand)
 *
 * The section heading sits above its panel, the way the console's settings
 * pages do it, instead of inside it with an icon, a coloured count, a refresh
 * button and an explainer paragraph. Machine words (finding types, ids) are not
 * in a row's default view; the title says what is wrong in words.
 */

import type { ComponentType, ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import { ChevronDown } from 'lucide-react'
import { EDGE, FOCUS, R_PANEL, T_SECTION, WELL } from '@/components/console/tokens'
import { KIT, Skeleton, StatusGlyph, type GlyphState } from '@/components/inspector/kit'
import { ActorMark, type Actor } from '@/components/console/ActorMark'
import { IconWell } from '@/components/console/IconWell'

type IconLike = LucideIcon | ComponentType<{ className?: string; strokeWidth?: number }>

/** A page section: its heading, an optional count and controls, then the panel. */
export function Section({
  id,
  title,
  count,
  aside,
  description,
  children,
}: {
  id: string
  title: ReactNode
  /** Shown only when there is something to count. */
  count?: number | null
  aside?: ReactNode
  /** One line under the heading, when the section needs a word of context. */
  description?: ReactNode
  children: ReactNode
}) {
  return (
    <section aria-labelledby={id}>
      <div className="mb-2.5 flex min-h-[28px] flex-wrap items-center gap-x-2 gap-y-1">
        <h2 id={id} className={T_SECTION}>
          {title}
        </h2>
        {typeof count === 'number' && count > 0 && (
          <span className="text-[13px] tabular-nums text-faint">{count}</span>
        )}
        {aside && <div className="ml-auto flex items-center gap-3">{aside}</div>}
      </div>
      {description && <p className="-mt-1 mb-3 max-w-[760px] text-[13px] leading-[20px] text-faint">{description}</p>}
      {children}
    </section>
  )
}

/** The panel a section's rows sit in: one hairline outline, rows divided inside. */
export const PANEL = `overflow-hidden border ${EDGE} ${R_PANEL} ${KIT.surface}`

/**
 * The same panel without the clip, for one that holds a popover drawn in place
 * (not in a portal). Its first and last children round their own corners.
 * OverflowMenu and KitSelect never need it: the menu opens in a portal and the
 * select is native.
 */
export const PANEL_OPEN = `border ${EDGE} ${R_PANEL} ${KIT.surface} [&>*:first-child]:rounded-t-[9px] [&>*:last-child]:rounded-b-[9px]`

export function Panel({ children, className = '', clip = true }: { children: ReactNode; className?: string; clip?: boolean }) {
  return <div className={`${clip ? PANEL : PANEL_OPEN} ${className}`}>{children}</div>
}

export function RowList({ children }: { children: ReactNode }) {
  return <ul className="divide-y divide-white/[0.06]">{children}</ul>
}

type Tone = 'neutral' | 'attention' | 'danger' | 'done' | 'accent'

// Monochrome: a row's icon says what kind of thing it is, never its state in a colour.
const TILE_ICON: Record<Tone, string> = {
  neutral: 'text-zinc-300',
  attention: 'text-zinc-50',
  danger: 'text-zinc-300',
  done: 'text-zinc-500',
  accent: 'text-violet-300',
}

/** The square at the start of a row: what kind of thing this is, at a glance. */
export function RowTile({ icon: Icon, tone = 'neutral', busy = false }: { icon: IconLike; tone?: Tone; busy?: boolean }) {
  return (
    <span
      aria-hidden
      className={`flex h-[32px] w-[32px] flex-shrink-0 items-center justify-center rounded-[8px] border border-white/[0.08] bg-white/[0.035] ${
        busy ? 'animate-pulse' : ''
      }`}
    >
      <Icon className={`h-[15px] w-[15px] ${TILE_ICON[tone]}`} strokeWidth={1.75} />
    </span>
  )
}

/**
 * What leads a row (project decision 7): whatever varies down that list.
 *   'glyph'  a state (StatusGlyph): functions, endpoints, snapshots
 *   'actor'  who did it (24px ActorMark): changes, tool calls
 *   'well'   the kind of thing in a 28px IconWell: what waits on you, what
 *            Backenly found and fixed, branches (the founder's call, 2026-11-16:
 *            the spanner and the bin say more than a dot)
 *   'icon'   a bare 16px kind icon: file types
 *   'none'   nothing varies, so nothing leads
 * Leaving `lead` unset keeps the retired 32px tile for the rows that still use it.
 */
export type RowLead = 'glyph' | 'actor' | 'well' | 'icon' | 'none'

const LEAD_ICON: Record<Tone, string> = {
  neutral: 'text-zinc-400',
  attention: 'text-zinc-50',
  danger: 'text-zinc-400',
  done: 'text-zinc-500',
  accent: 'text-violet-300',
}

/**
 * One row. The title and everything under it share a column; the actions sit
 * at the top right and wrap under the text on a narrow screen.
 *
 *   <Row lead="glyph" glyph="failed" glyphLabel="Failed" title={…} />
 *   <Row lead="actor" actor={{ type: 'agent', label: 'Claude Code' }} title={…} />
 *   <Row lead="well" icon={Wrench} title={…} />
 *   <Row lead="icon" icon={FileImage} title={…} />
 *   <Row lead="none" title={…} />
 */
export function Row({
  icon,
  tone = 'neutral',
  busy,
  title,
  actions,
  children,
  className = '',
  lead,
  glyph = 'idle',
  glyphLabel,
  actor,
  id,
}: {
  /**
   * The row's anchor, for links from other pages (Overview's "Waiting on
   * you" opens /autonomy#approval-<id>). The row a link points at is lit
   * while `data-target` is set on it (useHashTarget).
   */
  id?: string
  /** The kind icon (lead 'icon') or the old tile's icon (no lead). */
  icon?: IconLike
  tone?: Tone
  busy?: boolean
  title: ReactNode
  actions?: ReactNode
  children?: ReactNode
  className?: string
  lead?: RowLead
  /** lead 'glyph': the state. */
  glyph?: GlyphState
  /** lead 'glyph': the state in words, read by screen readers. */
  glyphLabel?: string
  /** lead 'actor': who did it. */
  actor?: Pick<Actor, 'type' | 'label'>
}) {
  if (lead === undefined) {
    return (
      <li id={id} className={`px-5 py-4 ${ANCHORED} ${className}`}>
        <div className="flex items-start gap-3.5">
          {icon && <RowTile icon={icon} tone={tone} busy={busy} />}
          <div className="flex min-w-0 flex-1 flex-wrap items-start gap-x-6 gap-y-3 sm:flex-nowrap">
            <div className="min-w-0 flex-[1_1_260px] pt-[5px]">
              {title}
              {children}
            </div>
            {actions && <div className="flex flex-shrink-0 items-center gap-2">{actions}</div>}
          </div>
        </div>
      </li>
    )
  }
  // Each lead is centred on the title's first line (21px).
  const Icon = icon
  const leadNode =
    lead === 'glyph' ? (
      <StatusGlyph state={glyph} label={glyphLabel ?? glyph} className={`mt-[4.5px] ${busy ? 'motion-safe:animate-pulse' : ''}`} />
    ) : lead === 'actor' && actor ? (
      <ActorMark actor={actor} size={24} className="-mt-[1.5px]" />
    ) : lead === 'well' && Icon ? (
      <IconWell icon={Icon} quiet={tone === 'done'} className={`-mt-[3.5px] ${busy ? 'motion-safe:animate-pulse' : ''}`} />
    ) : lead === 'icon' && Icon ? (
      <Icon className={`mt-[2.5px] h-4 w-4 flex-shrink-0 ${LEAD_ICON[tone]}`} strokeWidth={1.75} />
    ) : null
  return (
    <li id={id} className={`px-[20px] py-[14px] ${ANCHORED} ${className}`}>
      <div className="flex items-start gap-[12px]">
        {leadNode && <span className="flex flex-shrink-0">{leadNode}</span>}
        <div className="flex min-w-0 flex-1 flex-wrap items-start gap-x-6 gap-y-3 sm:flex-nowrap">
          <div className="min-w-0 flex-[1_1_260px]">
            {title}
            {children}
          </div>
          {actions && <div className="flex flex-shrink-0 items-center gap-2">{actions}</div>}
        </div>
      </div>
    </li>
  )
}

/** A row a link can land on: clear of the top bar, and lit while it is the target. */
const ANCHORED = 'scroll-mt-[96px] transition-colors duration-500 data-[target]:bg-white/[0.04]'

/** Row-shaped placeholders in the new row anatomy, so a panel loads in one pass. */
export function RowSkeleton({ rows = 3, lead = 'glyph' }: { rows?: number; lead?: RowLead }) {
  const mark =
    lead === 'glyph'
      ? 'mt-[4.5px] h-[12px] w-[12px] !rounded-full'
      : lead === 'actor'
        ? 'h-[24px] w-[24px] !rounded-full'
        : lead === 'well'
          ? '-mt-[3.5px] h-[28px] w-[28px] !rounded-[7px]'
          : 'mt-[2.5px] h-[16px] w-[16px]'
  return (
    <ul aria-hidden className="divide-y divide-white/[0.06]">
      {Array.from({ length: rows }, (_, i) => (
        <li key={i} className="flex items-start gap-[12px] px-[20px] py-[14px]">
          {lead !== 'none' && <Skeleton className={`flex-shrink-0 ${mark}`} />}
          <div className="min-w-0 flex-1 space-y-[8px] pt-[3px]">
            <Skeleton className={`h-[13px] ${i % 2 ? 'w-[46%]' : 'w-[58%]'}`} />
            <Skeleton className={`h-[10px] ${i % 2 ? 'w-[30%]' : 'w-[38%]'}`} />
          </div>
        </li>
      ))}
    </ul>
  )
}

/** A row's title. */
export const ROW_TITLE = 'text-[13.5px] font-medium leading-[21px] tracking-[-0.006em] text-zinc-50 [overflow-wrap:anywhere]'
/** The sentence under a row's title. */
export const ROW_TEXT = 'mt-1 text-[13px] leading-[20px] text-zinc-400 [overflow-wrap:anywhere]'

/** The facts under a row's title, each its own item, spaced apart rather than strung with dots. */
export function Facts({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] leading-[16px] text-faint ${className}`}>
      {children}
    </div>
  )
}

export function Fact({ icon: Icon, children, strong = false }: { icon?: IconLike; children: ReactNode; strong?: boolean }) {
  return (
    <span className={`inline-flex min-w-0 items-center gap-1.5 ${strong ? 'text-zinc-300' : ''}`}>
      {Icon && <Icon className="h-3.5 w-3.5 flex-shrink-0 text-zinc-500" strokeWidth={1.75} />}
      {children}
    </span>
  )
}

/** "Show …" with a chevron: opens what a row keeps out of its default view. */
export function Disclosure({ open, onToggle, children }: { open: boolean; onToggle: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      className={`mt-2.5 inline-flex items-center gap-1 rounded-[5px] text-[12.5px] font-medium text-zinc-400 transition-colors hover:text-zinc-100 ${FOCUS}`}
    >
      {children}
      <ChevronDown className={`h-3.5 w-3.5 transition-transform duration-150 ${open ? 'rotate-180' : ''}`} strokeWidth={1.75} />
    </button>
  )
}

/** Machine text a person may want to read exactly: statements, a request's own words. */
export function CodeBlock({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <pre
      className={`mt-2.5 max-h-[260px] overflow-auto whitespace-pre-wrap break-words rounded-[7px] border ${EDGE} ${WELL} px-3.5 py-2.5 font-mono text-[12px] leading-[19px] text-zinc-300 ${className}`}
    >
      {children}
    </pre>
  )
}

/** A short state line inside a row: done, failed, or a question being asked. */
export function RowNote({
  tone = 'neutral',
  icon: Icon,
  children,
  role,
}: {
  tone?: 'neutral' | 'done' | 'danger' | 'attention'
  icon?: IconLike
  children: ReactNode
  role?: 'status' | 'alert'
}) {
  // Monochrome, except a failure's own words, which keep the console's one danger colour.
  const text = {
    neutral: 'text-zinc-400',
    done: 'text-zinc-300',
    danger: 'text-rose-300',
    attention: 'text-zinc-50',
  }[tone]
  return (
    <p role={role} className={`mt-2.5 flex items-start gap-2 text-[12.5px] leading-[18px] ${text}`}>
      {Icon && <Icon className="mt-px h-3.5 w-3.5 flex-shrink-0" strokeWidth={1.75} />}
      <span className="min-w-0 [overflow-wrap:anywhere]">{children}</span>
    </p>
  )
}

/**
 * A panel's one line when it has nothing in it. New uses pass no icon (the
 * tile is retired); the icon is kept for the rows that still have one.
 */
export function EmptyLine({ icon: Icon, children }: { icon?: IconLike; children: ReactNode }) {
  if (!Icon) {
    return <p className="px-[20px] py-[14px] text-[13px] leading-[20px] text-zinc-400">{children}</p>
  }
  return (
    <div className="flex items-center gap-3.5 px-5 py-4">
      <RowTile icon={Icon} tone="neutral" />
      <p className="text-[13px] leading-[20px] text-zinc-400">{children}</p>
    </div>
  )
}

/** "1,500,000 rows", "1 row". */
export function rows(n: number): string {
  return `${n.toLocaleString()} row${n === 1 ? '' : 's'}`
}
