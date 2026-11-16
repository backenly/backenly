'use client'

/**
 * The bars of an instrument page (Database, Auth & Users, Storage, Functions,
 * Realtime, Monitoring): one shape on all six (project decision 2).
 *
 *   InstrumentBar   48px  Database  8 tables   Tables SQL Schema …     Updated 12 s ago  [1h|24h]  ⟳  ⋯  [New table]
 *   PaneToolbar     44px  movies  1,284 rows  ⋯                  [Search rows] [Filter] [Data|Structure] [Insert row] ⟳
 *   ChipStrip       only when a filter is applied: rating = 5 ×   Sorted by created_at ×
 *   GridFooter      36px  1–50 of 1,284                                  Previous   1 of 26   Next
 *
 * The bar's right side is always in this order: freshness, range, refresh,
 * ⋯, the one create button. Refresh sits in the bar that owns the data it
 * reloads, so a page whose panes load separately puts it in the pane
 * toolbar instead. Object actions live in the pane toolbar, never in the bar.
 * Rails have no header or footer.
 */

import { useId, useRef, type ComponentType, type KeyboardEvent, type ReactNode } from 'react'
import { Plus, RefreshCw, Search, X, type LucideIcon } from 'lucide-react'
import {
  IconButton,
  INPUT_BASE,
  KitButton,
  KitButtonLink,
  OverflowMenu,
  Segmented,
  Skeleton,
  StatusGlyph,
  type GlyphState,
} from '@/components/inspector/kit'
import { FOCUS, FOCUS_INSET, RULE } from './tokens'
import { Time } from './Time'
import type { Moment } from './format'

type IconLike = LucideIcon | ComponentType<{ className?: string; strokeWidth?: number }>
/** The ⋯ menu's items, as OverflowMenu takes them. */
export type MenuItems = Parameters<typeof OverflowMenu>[0]['items']

const nf = new Intl.NumberFormat('en-US')
/** "1,284": full numbers with separators, the console's way. */
export const count = (n: number) => nf.format(n)

// ─── Instrument bar ──────────────────────────────────────────────────────────

/** One fact after the title. A state glyph leads the first one when there is a state. */
export interface BarFact {
  glyph?: GlyphState
  /** The glyph in words, for screen readers (and the only words when there is no `text`). */
  label?: string
  /** "8 tables", "Published", "1 failed". */
  text?: ReactNode
  /** White for "waits on you" and for failed; faint otherwise. Always with a glyph or a word. */
  tone?: 'neutral' | 'attention' | 'danger'
}

export interface BarTab {
  id: string
  label: string
  /** Shown after the label, only where a count helps choose. */
  count?: number
}

export interface InstrumentBarProps<R extends string = string> {
  title: ReactNode
  /** At most two (decision 2); a state glyph first. Falsy entries are skipped. */
  facts?: ReadonlyArray<BarFact | null | false | undefined>
  /** The facts are not known yet: placeholders instead, the title stays. */
  loading?: boolean
  /** Text tabs for the page's views. Inline from 1024px, their own row below it. */
  tabs?: readonly BarTab[]
  activeTab?: string
  onTab?: (id: string) => void
  /** The tab list's name; defaults to "{title} views" when the title is text. */
  tabsLabel?: string
  /** The id of the element the tabs switch (give it role="tabpanel"). */
  panelId?: string
  /** When the page's data was last read: "Updated 12 s ago". */
  freshness?: Moment | null
  /** The time range (Monitoring). */
  range?: { value: R; options: ReadonlyArray<{ value: NoInfer<R>; label: string }>; onChange: (value: NoInfer<R>) => void; label?: string }
  /** A page-level control of the page's own, after the range (Realtime's Clear). Use sparingly. */
  controls?: ReactNode
  onRefresh?: () => void
  refreshing?: boolean
  /** Page actions behind ⋯. */
  menu?: MenuItems
  menuLabel?: string
  /**
   * The one create button. `primary` once the first object exists; secondary
   * until then, so an empty project keeps one white button on the screen.
   */
  create?: { label: string; onClick?: () => void; href?: string; primary?: boolean; icon?: IconLike | null; disabled?: boolean }
  /** The title's heading level: 1, the page's own title, unless the page already has one. */
  headingLevel?: 1 | 2 | 3
  className?: string
}

export function InstrumentBar<R extends string = string>({
  title,
  facts = [],
  loading = false,
  tabs,
  activeTab,
  onTab,
  tabsLabel,
  panelId,
  freshness,
  range,
  controls,
  onRefresh,
  refreshing = false,
  menu,
  menuLabel,
  create,
  headingLevel = 1,
  className = '',
}: InstrumentBarProps<R>) {
  const Heading = `h${headingLevel}` as 'h1' | 'h2' | 'h3'
  const given = facts.filter((f): f is BarFact => !!f)
  if (process.env.NODE_ENV !== 'production' && given.length > 2) {
    console.warn(`InstrumentBar: ${given.length} facts given; the bar shows two (decision 2).`)
  }
  const shown = given.slice(0, 2)
  const titleText = typeof title === 'string' ? title : null
  const CreateIcon = create?.icon === null ? undefined : create?.icon ?? Plus
  return (
    <div
      className={`flex min-h-[48px] flex-shrink-0 flex-wrap items-center gap-x-[20px] border-b ${RULE} px-[16px] sm:px-[20px] ${className}`}
    >
      <div className="flex min-h-[48px] min-w-0 flex-[1_1_auto] items-center gap-x-[14px] lg:flex-initial">
        <Heading className="min-w-0 truncate text-[15px] font-medium leading-[22px] tracking-[-0.012em] text-white">{title}</Heading>
        {loading ? (
          <span aria-hidden className="flex items-center gap-[12px]">
            <Skeleton className="h-[11px] w-[64px]" />
          </span>
        ) : (
          shown.length > 0 && (
            <div className="flex min-w-0 flex-shrink-0 items-center gap-x-[14px] text-[12.5px] leading-[18px] tabular-nums text-faint">
              {shown.map((f, i) => (
                <FactItem key={i} fact={f} />
              ))}
            </div>
          )
        )}
      </div>

      {tabs && tabs.length > 0 && (
        <BarTabs
          tabs={tabs}
          active={activeTab}
          onTab={onTab}
          label={tabsLabel ?? (titleText ? `${titleText} views` : 'Views')}
          panelId={panelId}
        />
      )}

      <div className="ml-auto flex min-h-[48px] flex-shrink-0 items-center gap-[8px]">
        {freshness && (
          <span className="hidden whitespace-nowrap text-[12px] leading-[16px] text-faint sm:inline">
            <Time iso={freshness} prefix="Updated" />
          </span>
        )}
        {range && <Segmented value={range.value} onChange={range.onChange} options={[...range.options]} label={range.label ?? 'Time range'} />}
        {controls}
        {onRefresh && <RefreshButton onRefresh={onRefresh} refreshing={refreshing} />}
        {menu && menu.length > 0 && (
          <OverflowMenu label={menuLabel ?? (titleText ? `More actions for ${titleText}` : 'More actions')} items={menu} width="w-[240px]" />
        )}
        {create &&
          (create.href ? (
            <KitButtonLink href={create.href} variant={create.primary ? 'primary' : 'secondary'} icon={CreateIcon}>
              {create.label}
            </KitButtonLink>
          ) : (
            <KitButton onClick={create.onClick} variant={create.primary ? 'primary' : 'secondary'} icon={CreateIcon} disabled={create.disabled}>
              {create.label}
            </KitButton>
          ))}
      </div>
    </div>
  )
}

function FactItem({ fact }: { fact: BarFact }) {
  // Monochrome: white asks for the person. A plain label is also set medium;
  // a composed fact (the storage quota) weights its own words.
  const asks = fact.tone === 'danger' || fact.tone === 'attention'
  const tone = asks ? `text-zinc-50${typeof fact.text === 'string' ? ' font-medium' : ''}` : ''
  return (
    <span className={`inline-flex items-center gap-[6px] whitespace-nowrap ${tone}`}>
      {fact.glyph && <StatusGlyph state={fact.glyph} label={fact.text ? fact.label ?? '' : fact.label ?? fact.glyph} />}
      {fact.text}
    </span>
  )
}

/** ⟳, spinning while the read is in flight. */
export function RefreshButton({ onRefresh, refreshing = false, label = 'Refresh' }: { onRefresh: () => void; refreshing?: boolean; label?: string }) {
  return (
    <button
      type="button"
      onClick={onRefresh}
      disabled={refreshing}
      aria-label={label}
      title={label}
      aria-busy={refreshing || undefined}
      className={`inline-flex h-[28px] w-[28px] flex-shrink-0 items-center justify-center rounded-[7px] text-zinc-400 transition-colors duration-150 hover:bg-white/[0.05] hover:text-zinc-100 disabled:pointer-events-none ${FOCUS}`}
    >
      <RefreshCw className={`h-[14px] w-[14px] ${refreshing ? 'motion-safe:animate-spin' : ''}`} strokeWidth={1.75} />
    </button>
  )
}

/**
 * The page's views as text tabs. Arrow keys, Home and End move between them;
 * Enter or Space opens one, so arrowing past a heavy view does not load it.
 * The open tab is the one Tab reaches.
 */
function BarTabs({
  tabs,
  active,
  onTab,
  label,
  panelId,
}: {
  tabs: readonly BarTab[]
  active?: string
  onTab?: (id: string) => void
  label: string
  panelId?: string
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([])
  const base = useId()
  const current = tabs.some((t) => t.id === active) ? active : tabs[0]?.id
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const at = refs.current.findIndex((el) => el === document.activeElement)
    if (at < 0) return
    const last = tabs.length - 1
    const next =
      e.key === 'ArrowRight' ? (at === last ? 0 : at + 1)
      : e.key === 'ArrowLeft' ? (at === 0 ? last : at - 1)
      : e.key === 'Home' ? 0
      : e.key === 'End' ? last
      : -1
    if (next < 0) return
    e.preventDefault()
    refs.current[next]?.focus()
  }
  return (
    <div
      role="tablist"
      aria-label={label}
      onKeyDown={onKey}
      className="order-last -mx-[6px] flex w-[calc(100%+12px)] flex-wrap items-stretch lg:order-none lg:mx-0 lg:w-auto lg:-ml-[6px]"
    >
      {tabs.map((t, i) => {
        const on = t.id === current
        return (
          <button
            key={t.id}
            ref={(el) => {
              refs.current[i] = el
            }}
            type="button"
            role="tab"
            id={`${base}-${t.id}`}
            aria-selected={on}
            aria-controls={panelId}
            tabIndex={on ? 0 : -1}
            onClick={() => onTab?.(t.id)}
            className={`group relative flex h-[40px] items-center gap-[6px] whitespace-nowrap rounded-[6px] px-[6px] text-[13px] font-medium transition-colors duration-150 lg:h-[48px] lg:px-[8px] ${FOCUS_INSET} ${
              on ? 'text-white' : 'text-faint hover:text-zinc-200'
            }`}
          >
            {t.label}
            {typeof t.count === 'number' && (
              <span className={`text-[12px] font-normal tabular-nums ${on ? 'text-zinc-400' : 'text-faint'}`}>{count(t.count)}</span>
            )}
            <span
              aria-hidden
              className={`absolute inset-x-[6px] bottom-[-1px] h-[1.5px] rounded-full transition-opacity duration-150 lg:inset-x-[8px] ${
                on ? 'bg-zinc-100 opacity-100' : 'bg-zinc-500 opacity-0 group-hover:opacity-40'
              }`}
            />
          </button>
        )
      })}
    </div>
  )
}

// ─── Pane toolbar ────────────────────────────────────────────────────────────

export interface PaneToolbarProps<V extends string = string> {
  /** The object the pane shows: a table, a bucket, a function. */
  title: ReactNode
  /** The title is machine text (a table's name): set in mono. */
  mono?: boolean
  /** "1,284 rows". */
  count?: ReactNode
  /** The object's own actions behind ⋯ (Copy name, Delete table…). */
  menu?: MenuItems
  menuLabel?: string
  search?: { value: string; onChange: (value: string) => void; placeholder: string; label?: string }
  /** The filter control (a button that opens the filter popover). */
  filter?: ReactNode
  /** The view switch: Data | Structure, Runs | Code. */
  view?: { value: V; options: ReadonlyArray<{ value: NoInfer<V>; label: string }>; onChange: (value: NoInfer<V>) => void; label: string }
  /** The object's add or test action: Insert row, Upload, Test run. */
  action?: ReactNode
  /** Only when this pane loads separately from the page. */
  onRefresh?: () => void
  refreshing?: boolean
  /** The object's heading level: 2 under the bar's h1. */
  headingLevel?: 2 | 3 | 4
  className?: string
}

export function PaneToolbar<V extends string = string>({
  title,
  mono = false,
  count: total,
  menu,
  menuLabel,
  search,
  filter,
  view,
  action,
  onRefresh,
  refreshing = false,
  headingLevel = 2,
  className = '',
}: PaneToolbarProps<V>) {
  const Heading = `h${headingLevel}` as 'h2' | 'h3' | 'h4'
  const titleText = typeof title === 'string' ? title : null
  const right = search || filter || view || action || onRefresh
  return (
    <div
      className={`flex min-h-[44px] flex-shrink-0 flex-wrap items-center gap-x-[12px] gap-y-[6px] border-b ${RULE} px-[16px] py-[6px] sm:px-[20px] ${className}`}
    >
      {/* A 180px basis: a lone control (⟳) stays on the name's line and a long name truncates,
          while a wider group (view switch, action) wraps under a name rather than squeezing it. */}
      <div className="flex min-w-0 flex-[1_1_180px] items-center gap-[10px]">
        <Heading
          className={`min-w-0 truncate font-medium text-zinc-100 ${mono ? 'font-mono text-[12.5px] leading-[18px]' : 'text-[13px] leading-[20px]'}`}
        >
          {title}
        </Heading>
        {total !== undefined && total !== null && (
          <span className="flex-shrink-0 whitespace-nowrap text-[12.5px] leading-[18px] tabular-nums text-faint">{total}</span>
        )}
        {menu && menu.length > 0 && (
          <span className="-ml-[2px] flex-shrink-0">
            <OverflowMenu label={menuLabel ?? (titleText ? `Actions for ${titleText}` : 'Actions')} items={menu} width="w-[220px]" />
          </span>
        )}
      </div>
      {right && (
        <div className={`ml-auto flex flex-wrap items-center gap-[8px] sm:w-auto sm:flex-nowrap ${search ? 'w-full' : ''}`}>
          {search && (
            <SearchField
              value={search.value}
              onChange={search.onChange}
              placeholder={search.placeholder}
              label={search.label}
              className="w-full sm:w-[220px]"
            />
          )}
          {filter}
          {view && <Segmented size="sm" value={view.value} onChange={view.onChange} options={[...view.options]} label={view.label} />}
          {action}
          {onRefresh && <RefreshButton onRefresh={onRefresh} refreshing={refreshing} />}
        </div>
      )}
    </div>
  )
}

/** A compact search box for a toolbar. Escape clears it. */
export function SearchField({
  value,
  onChange,
  placeholder,
  label,
  className = '',
}: {
  value: string
  onChange: (value: string) => void
  placeholder: string
  /** Defaults to the placeholder. */
  label?: string
  className?: string
}) {
  return (
    <div className={`relative ${className}`}>
      <Search aria-hidden className="pointer-events-none absolute left-[10px] top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-500" strokeWidth={2} />
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && value) {
            e.stopPropagation()
            onChange('')
          }
        }}
        placeholder={placeholder}
        aria-label={label ?? placeholder}
        className={`${INPUT_BASE} h-[36px] pl-[30px] pr-[30px] sm:h-[28px] [&::-webkit-search-cancel-button]:appearance-none`}
      />
      {value && (
        <button
          type="button"
          onClick={() => onChange('')}
          aria-label="Clear search"
          className={`absolute right-[2px] top-1/2 flex h-[24px] w-[24px] -translate-y-1/2 items-center justify-center rounded-[5px] text-zinc-500 hover:text-zinc-200 ${FOCUS}`}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  )
}

// ─── Filter chips ────────────────────────────────────────────────────────────

export interface Chip {
  id: string
  /** What the chip shows: "rating = 5". */
  label: ReactNode
  /** The same in plain words, for "Remove …": "rating equals 5". */
  name: string
  onRemove: () => void
}

/** The filters and sort in effect, each removable. Renders nothing when none is applied. */
export function ChipStrip({ chips, onClearAll, className = '' }: { chips: readonly Chip[]; onClearAll?: () => void; className?: string }) {
  if (chips.length === 0) return null
  return (
    <div
      role="group"
      aria-label="Applied filters"
      className={`flex min-h-[38px] flex-wrap items-center gap-[6px] border-b ${RULE} px-[16px] py-[6px] sm:px-[20px] ${className}`}
    >
      {chips.map((c) => (
        <span
          key={c.id}
          className="inline-flex h-[26px] max-w-full items-center gap-[2px] rounded-[6px] border border-white/[0.10] bg-white/[0.03] pl-[9px] pr-[1px] text-[12px] leading-[16px] text-zinc-200"
        >
          <span className="min-w-0 truncate">{c.label}</span>
          <button
            type="button"
            onClick={c.onRemove}
            aria-label={`Remove ${c.name}`}
            title="Remove"
            className={`flex h-[24px] w-[24px] flex-shrink-0 items-center justify-center rounded-[5px] text-zinc-500 transition-colors duration-150 hover:bg-white/[0.06] hover:text-zinc-100 ${FOCUS}`}
          >
            <X className="h-3 w-3" strokeWidth={2} />
          </button>
        </span>
      ))}
      {onClearAll && chips.length > 1 && (
        <button
          type="button"
          onClick={onClearAll}
          className={`h-[26px] rounded-[6px] px-[8px] text-[12px] font-medium text-faint transition-colors duration-150 hover:text-zinc-100 ${FOCUS}`}
        >
          Clear all
        </button>
      )}
    </div>
  )
}

// ─── Grid footer ─────────────────────────────────────────────────────────────

export type GridFooterProps =
  | {
      mode: 'pages'
      /** First and last row shown, 1-based. */
      from: number
      to: number
      total?: number | null
      page: number
      pages: number
      onPrev: () => void
      onNext: () => void
      busy?: boolean
      className?: string
    }
  | {
      mode: 'more'
      shown: number
      total?: number | null
      hasMore: boolean
      onLoadMore: () => void
      loading?: boolean
      /** Says what the list is when there is no total: "Showing the last 50". */
      note?: ReactNode
      className?: string
    }

/** Under a grid: where you are in it, and the way to more. Nothing for an empty grid. */
export function GridFooter(props: GridFooterProps) {
  const bar = `flex min-h-[40px] flex-shrink-0 flex-wrap items-center justify-between gap-x-[12px] gap-y-[4px] border-t ${RULE} px-[16px] py-[4px] text-[12.5px] leading-[18px] tabular-nums text-faint sm:px-[20px] ${props.className ?? ''}`
  if (props.mode === 'pages') {
    const { from, to, total, page, pages, onPrev, onNext, busy } = props
    if (total === 0) return null
    return (
      <nav aria-label="Pages" className={bar}>
        <p>
          {count(from)}–{count(to)}
          {typeof total === 'number' && <> of {count(total)}</>}
        </p>
        <div className="flex items-center gap-[4px]">
          <KitButton size="sm" variant="ghost" onClick={onPrev} disabled={busy || page <= 1}>
            Previous
          </KitButton>
          <span className="px-[6px] text-zinc-300" aria-current="page">
            {count(page)} of {count(pages)}
          </span>
          <KitButton size="sm" variant="ghost" onClick={onNext} disabled={busy || page >= pages}>
            Next
          </KitButton>
        </div>
      </nav>
    )
  }
  const { shown, total, hasMore, onLoadMore, loading, note } = props
  if (shown === 0) return null
  return (
    <div className={bar}>
      <p>{note ?? (typeof total === 'number' ? `${count(shown)} of ${count(total)}` : `Showing ${count(shown)}`)}</p>
      {hasMore && (
        <KitButton size="sm" onClick={onLoadMore} loading={loading}>
          Load more
        </KitButton>
      )}
    </div>
  )
}
