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
import { KIT } from '@/components/inspector/kit'

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

export function Panel({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`${PANEL} ${className}`}>{children}</div>
}

export function RowList({ children }: { children: ReactNode }) {
  return <ul className="divide-y divide-white/[0.06]">{children}</ul>
}

type Tone = 'neutral' | 'attention' | 'danger' | 'done' | 'accent'

const TILE_ICON: Record<Tone, string> = {
  neutral: 'text-zinc-300',
  attention: 'text-amber-300',
  danger: 'text-rose-300',
  done: 'text-emerald-300',
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
 * One row. The title and everything under it share a column; the actions sit
 * at the top right and wrap under the text on a narrow screen.
 */
export function Row({
  icon,
  tone = 'neutral',
  busy,
  title,
  actions,
  children,
  className = '',
}: {
  icon: IconLike
  tone?: Tone
  busy?: boolean
  title: ReactNode
  actions?: ReactNode
  children?: ReactNode
  className?: string
}) {
  return (
    <li className={`px-5 py-4 ${className}`}>
      <div className="flex items-start gap-3.5">
        <RowTile icon={icon} tone={tone} busy={busy} />
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
  const text = {
    neutral: 'text-zinc-400',
    done: 'text-emerald-300',
    danger: 'text-rose-300',
    attention: 'text-amber-200',
  }[tone]
  return (
    <p role={role} className={`mt-2.5 flex items-start gap-2 text-[12.5px] leading-[18px] ${text}`}>
      {Icon && <Icon className="mt-px h-3.5 w-3.5 flex-shrink-0" strokeWidth={1.75} />}
      <span className="min-w-0 [overflow-wrap:anywhere]">{children}</span>
    </p>
  )
}

/** A panel's one line when it has nothing in it. */
export function EmptyLine({ icon: Icon, children }: { icon: IconLike; children: ReactNode }) {
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
