'use client'

/**
 * Console Kit: the primitives every dashboard surface composes from.
 *
 * Rebuilt 2026-09-30 with the console redesign. The language is set out in
 * components/console/tokens.ts; this file turns it into components. Every
 * export that existed before the rebuild keeps its name and props, so a
 * section that composed from the old kit picks up the new language without
 * being touched.
 *
 * The short version of the language:
 *   – Panels are a hairline and one tonal step, never a drop shadow. Only
 *     floating layers (menus, dialogs) carry elevation.
 *   – Headings are sentence case. There are no uppercase tracked eyebrows.
 *   – Status is a coloured dot beside neutral text.
 *   – Mono is machine text only (code, ids, keys). Numbers are tabular Geist.
 *   – White is the primary action. Violet is focus, links and the canvas edge.
 *   – Sizes are px. The root font-size is 13px (see console/tokens.ts).
 */

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  forwardRef,
  type ReactNode,
  type ComponentType,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import { Check, ChevronRight, Copy, Info, MoreHorizontal, X, type LucideIcon } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  CANVAS,
  EDGE,
  FLOAT,
  FOCUS,
  FOCUS_INSET,
  GRID_HEAD,
  PAGE_GUTTER,
  PAGE_WIDTH,
  PLATE,
  RAIL,
  RAISE,
  ROW_HOVER,
  RULE,
  R_CONTROL,
  R_PANEL,
  R_TAG,
  T_LEDE,
  T_META,
  T_PAGE,
  T_SECTION,
  WELL,
} from '@/components/console/tokens'

type IconLike = LucideIcon | ComponentType<{ className?: string; strokeWidth?: number }>

// ─── Tokens ──────────────────────────────────────────────────────────────────
// Class recipes for sections that style their own markup. Reach for these
// before writing a new hex value.

export const KIT = {
  bg:          CANVAS,               // the canvas every page renders on
  surface:     PLATE,                // a grouped panel inside the canvas
  surfaceAlt:  'bg-white/[0.035]',
  surfaceSoft: 'bg-white/[0.02]',

  // Dense-surface rungs for full-height instruments, dark → light:
  //   well #08090a · rail #0a0b0d · canvas #0c0d0f · gridHead #0e0f11
  //   · surface #0f1012 · rowHover #121316 · popover #141518
  well:        WELL,
  rail:        RAIL,
  gridHead:    GRID_HEAD,
  rowHover:    ROW_HOVER,

  // Tailwind only compiles class names it can read literally, so the hover
  // variants are spelled out. `rowHoverGroup` repaints a sticky (opaque) cell
  // in step with its `group/row`.
  rowHoverOn:    'hover:bg-[#121316]',
  rowHoverGroup: 'group-hover/row:bg-[#121316]',

  border:      EDGE,
  borderHover: 'hover:border-white/[0.14]',
  borderStrong:'border-white/[0.12]',
  hairline:    RULE,
  divide:      'divide-white/[0.06]',

  // Panels no longer carry a drop shadow; the hairline and the tonal step do
  // the work. Kept as a key so older call sites still compile.
  inset:       '',
  // The ONLY elevation, for floating layers.
  pop:         FLOAT,

  text:        'text-zinc-50',
  textMute:    'text-zinc-300',
  textDim:     'text-zinc-400',
  textFaint:   'text-zinc-500',

  radius:      R_PANEL,
  radiusSm:    R_CONTROL,
  radiusXs:    R_TAG,

  accent:      '#a78bfa',
  accentSolid: 'bg-violet-400',
  accentBg:    'bg-white/[0.06]',
  accentBorder:'border-white/[0.14]',
  accentText:  'text-violet-300',
} as const

// ─── Card ────────────────────────────────────────────────────────────────────

interface KitCardProps {
  children: ReactNode
  className?: string
  /** When true, applies hover state (use for interactive cards) */
  interactive?: boolean
}

export function KitCard({ children, className = '', interactive = false }: KitCardProps) {
  return (
    <div
      className={`relative ${PLATE} border ${EDGE} ${R_PANEL} ${
        interactive ? 'transition-colors duration-150 hover:border-white/[0.14]' : ''
      } ${className}`}
    >
      {children}
    </div>
  )
}

export function KitCardHeader({
  title,
  description,
  actions,
  className = '',
}: {
  title: ReactNode
  description?: ReactNode
  actions?: ReactNode
  className?: string
}) {
  return (
    <div className={`flex items-center justify-between gap-3 border-b ${RULE} px-4 py-3 ${className}`}>
      <div className="min-w-0">
        <h3 className="text-[13px] font-medium leading-[20px] tracking-[-0.006em] text-zinc-100">{title}</h3>
        {description && <p className="mt-0.5 text-[12px] leading-[17px] text-zinc-500">{description}</p>}
      </div>
      {actions && <div className="flex flex-shrink-0 items-center gap-2">{actions}</div>}
    </div>
  )
}

export function KitCardBody({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`p-4 ${className}`}>{children}</div>
}

// ─── Section labels & titles ─────────────────────────────────────────────────

/**
 * A quiet group label: 12px, sentence case. It used to be an uppercase
 * tracked micro-label; those are gone from the console by rule.
 */
export function SectionLabel({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <p className={`text-[12px] font-medium leading-[16px] text-zinc-500 ${className}`}>{children}</p>
}

export function SectionTitle({
  title,
  description,
  actions,
  className = '',
}: {
  title: ReactNode
  description?: ReactNode
  actions?: ReactNode
  className?: string
}) {
  return (
    <div className={`mb-4 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between ${className}`}>
      <div className="min-w-0">
        <h2 className={T_SECTION}>{title}</h2>
        {description && (
          <p className="mt-1 max-w-[68ch] text-[13px] leading-[20px] text-zinc-400 [text-wrap:pretty]">{description}</p>
        )}
      </div>
      {actions && <div className="flex flex-shrink-0 items-center gap-2">{actions}</div>}
    </div>
  )
}

// ─── Status ──────────────────────────────────────────────────────────────────

export type StatusTone = 'operational' | 'managed' | 'paused' | 'attention' | 'failed' | 'beta' | 'neutral'

const DOT: Record<StatusTone, string> = {
  operational: 'bg-emerald-400',
  managed:     'bg-zinc-500',
  paused:      'bg-zinc-600',
  attention:   'bg-amber-400',
  failed:      'bg-rose-400',
  beta:        'bg-violet-300',
  neutral:     'bg-zinc-600',
}

// Neutral text for calm states; a tinted label only where the state asks for
// action, so the eye lands on what needs it.
const DOT_TEXT: Record<StatusTone, string> = {
  operational: 'text-zinc-300',
  managed:     'text-zinc-400',
  paused:      'text-zinc-500',
  attention:   'text-amber-200',
  failed:      'text-rose-300',
  beta:        'text-violet-200',
  neutral:     'text-zinc-400',
}

/** A status: coloured dot, plain label. `pulse` only for a genuinely live stream. */
export function StatusDot({
  tone = 'neutral',
  label,
  pulse = false,
  className = '',
}: {
  tone?: StatusTone
  label?: ReactNode
  pulse?: boolean
  className?: string
}) {
  return (
    <span className={`inline-flex items-center gap-1.5 text-[12px] leading-[16px] ${DOT_TEXT[tone]} ${className}`}>
      <span className="relative flex h-[7px] w-[7px] flex-shrink-0 items-center justify-center" aria-hidden>
        {pulse && (
          <span className={`absolute inline-flex h-full w-full rounded-full opacity-60 motion-safe:animate-ping ${DOT[tone]}`} />
        )}
        <span className={`relative inline-flex h-[6px] w-[6px] rounded-full ${DOT[tone]}`} />
      </span>
      {label}
    </span>
  )
}

/**
 * Kept for older call sites (RuntimeStatusBar is no longer used by a page).
 * An agent status band: heading, sentence, trailing status and actions.
 */
interface RuntimeStatusBarProps {
  icon: IconLike
  title: string
  description: string
  status?: { label: string; tone?: 'operational' | 'managed' | 'paused' | 'attention' | 'failed' | 'beta' }
  actions?: ReactNode
}

export function RuntimeStatusBar({ title, description, status, actions }: RuntimeStatusBarProps) {
  return (
    <KitCard className="mb-4">
      <div className="flex items-center justify-between gap-6 px-5 py-4">
        <div className="min-w-0">
          {status && <StatusDot tone={status.tone ?? 'operational'} label={status.label} />}
          <h2 className={`mt-2 ${T_SECTION}`}>{title}</h2>
          <p className="mt-1 max-w-xl text-[13px] leading-[20px] text-zinc-400">{description}</p>
        </div>
        {actions && <div className="flex flex-shrink-0 items-center gap-2">{actions}</div>}
      </div>
    </KitCard>
  )
}

// ─── Stat tile / grid ────────────────────────────────────────────────────────

interface StatTileProps {
  icon?: IconLike
  label: string
  value: ReactNode
  /** Optional small delta line (e.g. "+12% · 24h") */
  delta?: { value: number; suffix?: string }
  /** Semantic tone for the numeral; defaults to neutral white */
  tone?: 'violet' | 'emerald' | 'sky' | 'amber' | 'neutral'
  loading?: boolean
}

const TONE_TEXT = {
  violet:  'text-violet-200',
  emerald: 'text-emerald-300',
  sky:     'text-zinc-100',
  amber:   'text-amber-200',
  neutral: 'text-zinc-50',
} as const

const TONE_ICON = {
  violet:  'text-violet-300/80',
  emerald: 'text-emerald-300/80',
  sky:     'text-zinc-400',
  amber:   'text-amber-300/80',
  neutral: 'text-zinc-500',
} as const

export function StatTile({ label, value, delta, tone = 'neutral', loading }: StatTileProps) {
  return (
    <div className={`${PLATE} border ${EDGE} ${R_PANEL} px-4 py-3.5`}>
      <p className="text-[12px] leading-[16px] text-zinc-500">{label}</p>
      <div className="mt-2 flex items-baseline gap-2">
        {loading ? (
          <Skeleton className="h-[22px] w-16" />
        ) : (
          <p className={`text-[22px] font-semibold leading-[26px] tracking-[-0.02em] tabular-nums ${TONE_TEXT[tone]}`}>
            {value}
          </p>
        )}
        {typeof delta?.value === 'number' && !loading && <Delta value={delta.value} suffix={delta.suffix} />}
      </div>
    </div>
  )
}

function Delta({ value, suffix }: { value: number; suffix?: string }) {
  if (!value) return <span className="text-[12px] tabular-nums text-zinc-600">±0%</span>
  const up = value > 0
  return (
    <span className={`text-[12px] font-medium tabular-nums ${up ? 'text-emerald-300' : 'text-rose-300'}`}>
      {up ? '+' : ''}
      {value}%{suffix ? ` ${suffix}` : ''}
    </span>
  )
}

export function StatGrid({ children, cols = 4 }: { children: ReactNode; cols?: 2 | 3 | 4 }) {
  const colsClass =
    cols === 4 ? 'grid-cols-2 lg:grid-cols-4' : cols === 3 ? 'grid-cols-1 sm:grid-cols-3' : 'grid-cols-1 sm:grid-cols-2'
  return <div className={`mb-4 grid ${colsClass} gap-3`}>{children}</div>
}

/**
 * Stats as one strip: a single object split by hairlines rather than four
 * floating boxes. Pass <Stat> children.
 */
export function StatStrip({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={`grid grid-cols-2 overflow-hidden border ${EDGE} ${R_PANEL} bg-white/[0.06] gap-px lg:auto-cols-fr lg:grid-flow-col lg:grid-cols-none ${className}`}
    >
      {children}
    </div>
  )
}

export function Stat({
  label,
  value,
  hint,
  tone = 'neutral',
  loading,
}: {
  label: ReactNode
  value: ReactNode
  hint?: ReactNode
  tone?: 'neutral' | 'good' | 'warn' | 'bad'
  loading?: boolean
}) {
  const valueTone =
    tone === 'good' ? 'text-emerald-300' : tone === 'warn' ? 'text-amber-200' : tone === 'bad' ? 'text-rose-300' : 'text-zinc-50'
  return (
    <div className={`${PLATE} min-w-0 px-4 py-3.5`}>
      <p className="truncate text-[12px] leading-[16px] text-zinc-500">{label}</p>
      {loading ? (
        <Skeleton className="mt-2 h-[22px] w-14" />
      ) : (
        <p className={`mt-1.5 truncate text-[20px] font-semibold leading-[26px] tracking-[-0.02em] tabular-nums ${valueTone}`}>
          {value}
        </p>
      )}
      {hint && <p className="mt-0.5 truncate text-[12px] leading-[16px] text-zinc-500">{hint}</p>}
    </div>
  )
}

// ─── Empty state ─────────────────────────────────────────────────────────────

interface EmptyStateProps {
  icon: IconLike
  title: string
  description: string
  action?: ReactNode
  className?: string
}

/**
 * An empty state is a next step, not a void: what this place holds, and how
 * it gets its first thing. Pair with <AgentPrompt> when the next step is
 * something to ask the coding agent for.
 */
export function EmptyState({ icon: Icon, title, description, action, className = '' }: EmptyStateProps) {
  return (
    <div className={`flex flex-col items-center justify-center px-6 py-14 text-center ${className}`}>
      <span
        className={`mb-4 flex h-[40px] w-[40px] items-center justify-center ${R_PANEL} border ${EDGE} bg-white/[0.03] shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]`}
        aria-hidden
      >
        <Icon className="h-[18px] w-[18px] text-zinc-400" strokeWidth={1.75} />
      </span>
      <h3 className="text-[14px] font-semibold leading-[20px] tracking-[-0.01em] text-zinc-100">{title}</h3>
      <p className="mt-1.5 max-w-[46ch] text-[13px] leading-[20px] text-zinc-400 [text-wrap:pretty]">{description}</p>
      {action && <div className="mt-5 flex flex-wrap items-center justify-center gap-2">{action}</div>}
    </div>
  )
}

// ─── Badges & chips ──────────────────────────────────────────────────────────

interface KitBadgeProps {
  children: ReactNode
  tone?: 'operational' | 'managed' | 'paused' | 'attention' | 'failed' | 'beta' | 'neutral'
  icon?: IconLike
  className?: string
}

/** Status text: a dot (or icon) and a plain label. */
export function KitBadge({ children, tone = 'neutral', icon: Icon, className = '' }: KitBadgeProps) {
  if (!Icon) return <StatusDot tone={tone} label={children} className={className} />
  return (
    <span className={`inline-flex items-center gap-1.5 text-[12px] leading-[16px] ${DOT_TEXT[tone]} ${className}`}>
      <Icon className="h-3 w-3" strokeWidth={2} />
      {children}
    </span>
  )
}

/** A small bordered tag for a category or a technical attribute. */
export function Tag({
  children,
  tone = 'neutral',
  mono = false,
  className = '',
}: {
  children: ReactNode
  tone?: 'neutral' | 'violet' | 'good' | 'warn' | 'bad'
  mono?: boolean
  className?: string
}) {
  const tones = {
    neutral: 'border-white/[0.09] bg-white/[0.03] text-zinc-400',
    violet:  'border-violet-300/20 bg-violet-400/[0.08] text-violet-200',
    good:    'border-emerald-400/20 bg-emerald-400/[0.07] text-emerald-200',
    warn:    'border-amber-400/20 bg-amber-400/[0.07] text-amber-200',
    bad:     'border-rose-400/25 bg-rose-400/[0.07] text-rose-200',
  }
  return (
    <span
      className={`inline-flex h-[20px] flex-shrink-0 items-center gap-1 whitespace-nowrap ${R_TAG} border px-1.5 ${
        mono ? 'font-mono text-[11px]' : 'text-[11.5px] font-medium'
      } ${tones[tone]} ${className}`}
    >
      {children}
    </span>
  )
}

// ─── Buttons ─────────────────────────────────────────────────────────────────

interface KitButtonProps {
  children: ReactNode
  onClick?: () => void
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
  size?: 'sm' | 'md'
  icon?: IconLike
  iconRight?: IconLike
  disabled?: boolean
  /** Shows a spinner in place of the icon and keeps the label. */
  loading?: boolean
  type?: 'button' | 'submit'
  className?: string
  title?: string
  'aria-label'?: string
}

export const BUTTON_BASE = `inline-flex items-center justify-center gap-1.5 whitespace-nowrap font-medium ${R_CONTROL} transition-[background-color,border-color,color,transform] duration-150 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-40 ${FOCUS}`

export const BUTTON_SIZES = {
  sm: 'h-[28px] px-2.5 text-[12px]',
  md: 'h-[32px] px-3 text-[13px]',
} as const

export const BUTTON_VARIANTS = {
  // White on dark: the landing page's primary recipe, scaled for a tool.
  primary:   'bg-white font-semibold text-zinc-950 shadow-[0_1px_0_rgba(255,255,255,0.25)_inset,0_1px_2px_rgba(0,0,0,0.4)] hover:bg-zinc-200',
  secondary: 'border border-white/[0.10] bg-white/[0.04] text-zinc-100 hover:border-white/[0.16] hover:bg-white/[0.07]',
  ghost:     'text-zinc-400 hover:bg-white/[0.05] hover:text-zinc-100',
  danger:    'border border-rose-400/25 bg-rose-500/[0.08] text-rose-200 hover:border-rose-400/40 hover:bg-rose-500/[0.14]',
} as const

export function KitButton({
  children,
  onClick,
  variant = 'secondary',
  size = 'md',
  icon: Icon,
  iconRight: IconRight,
  disabled,
  loading = false,
  type = 'button',
  className = '',
  title,
  'aria-label': ariaLabel,
}: KitButtonProps) {
  const iconSize = size === 'sm' ? 'h-3.5 w-3.5' : 'h-[15px] w-[15px]'
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled || loading}
      title={title}
      aria-label={ariaLabel}
      aria-busy={loading || undefined}
      className={`${BUTTON_BASE} ${BUTTON_SIZES[size]} ${BUTTON_VARIANTS[variant]} ${className}`}
    >
      {loading ? <Spinner className={iconSize} /> : Icon && <Icon className={iconSize} strokeWidth={2} />}
      {children}
      {IconRight && <IconRight className={iconSize} strokeWidth={2} />}
    </button>
  )
}

/** An icon-only button. `label` is required: it is the accessible name and the tooltip. */
export function IconButton({
  icon: Icon,
  label,
  onClick,
  disabled,
  active = false,
  className = '',
}: {
  icon: IconLike
  label: string
  onClick?: () => void
  disabled?: boolean
  active?: boolean
  className?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className={`inline-flex h-[28px] w-[28px] flex-shrink-0 items-center justify-center ${R_CONTROL} transition-colors duration-150 disabled:pointer-events-none disabled:opacity-40 ${FOCUS} ${
        active ? 'bg-white/[0.08] text-zinc-100' : 'text-zinc-500 hover:bg-white/[0.05] hover:text-zinc-100'
      } ${className}`}
    >
      <Icon className="h-[15px] w-[15px]" strokeWidth={1.75} />
    </button>
  )
}

export function Spinner({ className = 'h-3.5 w-3.5' }: { className?: string }) {
  return (
    <svg className={`${className} animate-spin`} viewBox="0 0 16 16" fill="none" aria-hidden>
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
      <path d="M14 8a6 6 0 0 0-6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}

// ─── Tabs ────────────────────────────────────────────────────────────────────

export function KitTabs({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div
      role="tablist"
      className={`scrollbar-hide flex items-center gap-1 overflow-x-auto border-b ${RULE} ${className}`}
    >
      {children}
    </div>
  )
}

export function KitTab({
  active,
  onClick,
  children,
  count,
}: {
  active: boolean
  onClick: () => void
  children: ReactNode
  count?: number
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`group relative -mb-px flex h-[40px] flex-shrink-0 items-center whitespace-nowrap px-2.5 text-[13px] font-medium transition-colors duration-150 ${FOCUS_INSET} ${
        active ? 'text-zinc-50' : 'text-zinc-500 hover:text-zinc-200'
      }`}
    >
      <span className="flex items-center gap-1.5 [&_svg]:h-[15px] [&_svg]:w-[15px]">
        {children}
        {typeof count === 'number' && (
          <span className={`text-[12px] font-normal tabular-nums ${active ? 'text-zinc-400' : 'text-zinc-600'}`}>
            {count}
          </span>
        )}
      </span>
      <span
        aria-hidden
        className={`absolute inset-x-2.5 bottom-0 h-[1.5px] rounded-full transition-opacity duration-150 ${
          active ? 'bg-zinc-100 opacity-100' : 'bg-zinc-600 opacity-0 group-hover:opacity-40'
        }`}
      />
    </button>
  )
}

/**
 * A segmented control for switching a view in place (time ranges, list vs
 * detail). Tabs are for sections of a page; this is for one control's value.
 */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  size = 'md',
  label,
  className = '',
}: {
  value: T
  onChange: (value: T) => void
  options: Array<{ value: T; label: ReactNode; icon?: IconLike; title?: string }>
  size?: 'sm' | 'md'
  /** Accessible name for the group. */
  label: string
  className?: string
}) {
  const h = size === 'sm' ? 'h-[24px] px-2 text-[12px]' : 'h-[28px] px-2.5 text-[12.5px]'
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={`inline-flex flex-shrink-0 items-center gap-0.5 ${R_CONTROL} border ${EDGE} bg-white/[0.025] p-0.5 ${className}`}
    >
      {options.map((opt) => {
        const on = opt.value === value
        const OptIcon = opt.icon
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={on}
            title={opt.title}
            onClick={() => onChange(opt.value)}
            className={`inline-flex items-center gap-1.5 rounded-[5px] font-medium transition-[background-color,color] duration-150 ${h} ${FOCUS_INSET} ${
              on
                ? 'bg-white/[0.09] text-zinc-50 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]'
                : 'text-zinc-500 hover:text-zinc-200'
            }`}
          >
            {OptIcon && <OptIcon className="h-3.5 w-3.5" strokeWidth={1.75} />}
            {opt.label}
          </button>
        )
      })}
    </div>
  )
}

// ─── List row ────────────────────────────────────────────────────────────────

interface ListRowProps {
  icon?: IconLike
  iconTone?: 'violet' | 'emerald' | 'sky' | 'amber' | 'neutral'
  title: ReactNode
  subtitle?: ReactNode
  right?: ReactNode
  onClick?: () => void
  className?: string
}

export function ListRow({ icon: Icon, iconTone = 'neutral', title, subtitle, right, onClick, className = '' }: ListRowProps) {
  const interactive = !!onClick
  const Wrapper: any = interactive ? 'button' : 'div'
  return (
    <Wrapper
      {...(interactive ? { type: 'button' } : {})}
      onClick={onClick}
      className={`flex w-full items-center gap-3 px-4 py-[11px] text-left transition-colors duration-150 ${
        interactive ? `hover:bg-white/[0.025] ${FOCUS_INSET}` : ''
      } ${className}`}
    >
      {Icon && <Icon className={`h-4 w-4 flex-shrink-0 ${TONE_ICON[iconTone]}`} strokeWidth={1.75} />}
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-medium text-zinc-200">{title}</div>
        {subtitle && <div className="mt-0.5 truncate text-[12px] text-zinc-500">{subtitle}</div>}
      </div>
      {right && <div className="flex flex-shrink-0 items-center gap-2">{right}</div>}
    </Wrapper>
  )
}

// ─── Page chrome ─────────────────────────────────────────────────────────────

/** Standard outer wrapper for a document surface's content area. */
export function KitPage({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`${PAGE_WIDTH} ${PAGE_GUTTER} py-6 sm:py-8 ${className}`}>{children}</div>
}

/**
 * The header of a DOCUMENT surface: title, one sentence, actions. Tabs, when a
 * page has them, sit flush under it (pass `tabs`).
 *
 * `meta` is for one real fact about the page's state (a status, a count), not
 * a label that restates the product ("Governed", "Managed").
 */
export function PageHeader({
  title,
  description,
  actions,
  meta,
  tabs,
  className = '',
}: {
  title: ReactNode
  description?: ReactNode
  actions?: ReactNode
  meta?: ReactNode
  tabs?: ReactNode
  className?: string
}) {
  return (
    <header className={`${PAGE_WIDTH} ${PAGE_GUTTER} pt-7 sm:pt-9 ${className}`}>
      <div className={`flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between ${tabs ? 'pb-5' : 'pb-6'}`}>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <h1 className={`${T_PAGE} [text-wrap:balance]`}>{title}</h1>
            {meta}
          </div>
          {description && <p className={`mt-1.5 max-w-[72ch] ${T_LEDE} [text-wrap:pretty]`}>{description}</p>}
        </div>
        {actions && <div className="flex flex-shrink-0 flex-wrap items-center gap-2 sm:pt-0.5">{actions}</div>}
      </div>
      {tabs}
    </header>
  )
}

/**
 * The header row of an INSTRUMENT surface (a page that owns the viewport and
 * scrolls internally: Database, Storage, Functions, Realtime, Monitoring,
 * Auth). One 52px row: the section, its context, then controls.
 */
export function CommandBar({
  title,
  context,
  children,
  className = '',
}: {
  title: ReactNode
  /** Small facts after the title: a status, a count, the selected object. */
  context?: ReactNode
  /** Right-aligned controls. */
  children?: ReactNode
  className?: string
}) {
  return (
    <div
      className={`flex min-h-[52px] flex-shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b ${RULE} px-4 py-2.5 sm:px-5 ${className}`}
    >
      <div className="flex min-w-0 items-center gap-3">
        <h1 className="truncate text-[15px] font-semibold leading-[22px] tracking-[-0.014em] text-zinc-50">{title}</h1>
        {context && <div className="flex min-w-0 items-center gap-3 text-[12px] text-zinc-500">{context}</div>}
      </div>
      {children && <div className="flex flex-shrink-0 flex-wrap items-center gap-2">{children}</div>}
    </div>
  )
}

/** A thin vertical rule between items in a command bar or toolbar. */
export function BarDivider() {
  return <span aria-hidden className="h-4 w-px flex-shrink-0 bg-white/[0.08]" />
}

/** A section inside a document surface: heading, sentence, content. */
export function PageSection({
  title,
  description,
  actions,
  children,
  className = '',
  id,
}: {
  title?: ReactNode
  description?: ReactNode
  actions?: ReactNode
  children: ReactNode
  className?: string
  id?: string
}) {
  return (
    <section id={id} className={`scroll-mt-20 ${className}`}>
      {(title || actions) && <SectionTitle title={title} description={description} actions={actions} />}
      {children}
    </section>
  )
}

/** Two-column layout used by Auth, Storage, Realtime, etc. */
export function KitColumns({ main, side, sideWidth = 'lg:w-80' }: { main: ReactNode; side: ReactNode; sideWidth?: string }) {
  const width = sideWidth.startsWith('lg:') ? sideWidth : `lg:${sideWidth}`
  return (
    <div className="flex flex-col items-start gap-4 lg:flex-row">
      <div className="flex w-full min-w-0 flex-1 flex-col gap-4">{main}</div>
      <div className={`flex w-full flex-shrink-0 flex-col gap-4 ${width}`}>{side}</div>
    </div>
  )
}

// ─── Settings card ───────────────────────────────────────────────────────────

/**
 * One setting, or one small group of them: title, a sentence, the control,
 * and a footer that carries the hint on the left and the action on the right.
 * `danger` tints the edge for irreversible actions.
 *
 * Pass `onSubmit` and the card becomes a form, so Enter in any field submits.
 */
export function SettingsCard({
  title,
  description,
  children,
  footer,
  actions,
  danger = false,
  onSubmit,
  className = '',
}: {
  title: ReactNode
  description?: ReactNode
  children?: ReactNode
  /** Footer text, left side. */
  footer?: ReactNode
  /** Footer controls, right side. */
  actions?: ReactNode
  danger?: boolean
  onSubmit?: () => void
  className?: string
}) {
  const edge = danger ? 'border-rose-400/25' : EDGE
  const inner = (
    <>
      <div className="px-5 pb-5 pt-5 sm:px-6">
        <h3 className="text-[15px] font-semibold leading-[22px] tracking-[-0.012em] text-zinc-50">{title}</h3>
        {description && (
          <div className="mt-1 max-w-[68ch] text-[13px] leading-[20px] text-zinc-400 [text-wrap:pretty]">{description}</div>
        )}
        {children && <div className="mt-4">{children}</div>}
      </div>
      {(footer || actions) && (
        <div
          className={`flex flex-col gap-3 border-t px-5 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-6 ${
            danger ? 'border-rose-400/20 bg-rose-500/[0.04]' : `${RULE} bg-white/[0.015]`
          }`}
        >
          <div className="min-w-0 text-[12.5px] leading-[18px] text-zinc-500">{footer}</div>
          {actions && <div className="flex flex-shrink-0 items-center gap-2">{actions}</div>}
        </div>
      )}
    </>
  )
  const cls = `overflow-hidden ${PLATE} border ${edge} ${R_PANEL} ${className}`
  if (onSubmit) {
    return (
      <form
        className={cls}
        onSubmit={(e) => {
          e.preventDefault()
          onSubmit()
        }}
      >
        {inner}
      </form>
    )
  }
  return <section className={cls}>{inner}</section>
}

/** A label/value list for read-only facts (ids, URLs, regions). */
export function DetailList({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <dl className={`divide-y divide-white/[0.06] ${className}`}>{children}</dl>
}

export function DetailRow({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-1.5 py-3 first:pt-0 last:pb-0 sm:grid-cols-[180px_minmax(0,1fr)] sm:items-center sm:gap-4">
      <dt className="text-[13px] text-zinc-400">{label}</dt>
      <dd className="min-w-0 text-[13px] text-zinc-200">{children}</dd>
    </div>
  )
}

// ─── Inline note / banner ────────────────────────────────────────────────────

interface KitNoteProps {
  icon?: IconLike
  tone?: 'info' | 'warn' | 'success' | 'danger'
  title?: ReactNode
  children: ReactNode
  actions?: ReactNode
}

export function KitNote({ icon: Icon = Check, tone = 'info', title, children, actions }: KitNoteProps) {
  const tones = {
    info:    { box: 'border-white/[0.08] bg-white/[0.025]', icon: 'text-zinc-400' },
    warn:    { box: 'border-amber-400/20 bg-amber-400/[0.05]', icon: 'text-amber-300' },
    success: { box: 'border-emerald-400/20 bg-emerald-400/[0.05]', icon: 'text-emerald-300' },
    danger:  { box: 'border-rose-400/25 bg-rose-500/[0.06]', icon: 'text-rose-300' },
  }
  const t = tones[tone]
  return (
    <div
      role={tone === 'danger' || tone === 'warn' ? 'alert' : undefined}
      className={`flex items-start gap-3 ${R_CONTROL} border px-3.5 py-3 ${t.box}`}
    >
      <Icon className={`mt-[2px] h-4 w-4 flex-shrink-0 ${t.icon}`} strokeWidth={1.75} />
      <div className="min-w-0 flex-1 text-[13px] leading-[20px]">
        {title && <p className="mb-0.5 font-medium text-zinc-100">{title}</p>}
        <div className="text-zinc-400 [&_code]:font-mono [&_code]:text-[12px] [&_code]:text-zinc-300">{children}</div>
      </div>
      {actions && <div className="flex flex-shrink-0 items-center gap-2">{actions}</div>}
    </div>
  )
}

/**
 * A one-line notice that runs flush under an instrument surface's command bar:
 * the fact, then the action it calls for. For page-level state (a stale
 * session, an offline stream, work waiting), never for decoration.
 */
export function NoticeStrip({
  icon: Icon = Info,
  tone = 'neutral',
  children,
  action,
}: {
  icon?: IconLike
  tone?: 'neutral' | 'attention' | 'danger'
  children: ReactNode
  action?: ReactNode
}) {
  const iconTone = { neutral: 'text-zinc-500', attention: 'text-amber-300', danger: 'text-rose-300' }[tone]
  const wash = { neutral: '', attention: 'bg-amber-400/[0.03]', danger: 'bg-rose-500/[0.04]' }[tone]
  return (
    <div
      role={tone === 'neutral' ? undefined : 'alert'}
      className={`flex min-h-[44px] flex-shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b ${RULE} px-4 py-2 sm:px-5 ${wash}`}
    >
      <Icon className={`h-4 w-4 flex-shrink-0 ${iconTone}`} strokeWidth={1.75} />
      <div className="min-w-0 flex-1 text-[13px] leading-[20px] text-zinc-400 [&_strong]:font-medium [&_strong]:text-zinc-100">
        {children}
      </div>
      {action && <div className="flex flex-shrink-0 items-center gap-2">{action}</div>}
    </div>
  )
}

// ─── Checklist ───────────────────────────────────────────────────────────────

export function KitChecklist({ items }: { items: string[] }) {
  return (
    <ul className="space-y-2.5">
      {items.map((line) => (
        <li key={line} className="flex items-start gap-2.5">
          <Check className="mt-[3px] h-3.5 w-3.5 flex-shrink-0 text-emerald-400/80" strokeWidth={2} />
          <p className="text-[13px] leading-[20px] text-zinc-400">{line}</p>
        </li>
      ))}
    </ul>
  )
}

// ─── Fields ──────────────────────────────────────────────────────────────────

export function KitField({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    <div>
      <label className="mb-1.5 block text-[12.5px] font-medium leading-[18px] text-zinc-300">{label}</label>
      {children}
      {hint && <p className="mt-1.5 text-[12px] leading-[17px] text-zinc-500">{hint}</p>}
    </div>
  )
}

export const INPUT_BASE = `w-full ${WELL} border ${EDGE} ${R_CONTROL} text-[16px] text-zinc-100 placeholder:text-zinc-600 shadow-[inset_0_1px_2px_rgba(0,0,0,0.35)] transition-[border-color,box-shadow] duration-150 hover:border-white/[0.12] focus:border-violet-300/50 focus:outline-none focus:ring-[3px] focus:ring-violet-400/15 disabled:opacity-50 sm:text-[13px]`

export const KitInput = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(function KitInput(
  props,
  ref,
) {
  const { className = '', ...rest } = props
  return <input {...rest} ref={ref} className={`${INPUT_BASE} h-[36px] px-3 sm:h-[32px] ${className}`} />
})

export function KitTextarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const { className = '', ...rest } = props
  return <textarea {...rest} className={`${INPUT_BASE} resize-none px-3 py-2 leading-[20px] ${className}`} />
}

// ─── "More" trailing link (used in card headers) ─────────────────────────────

export function KitMoreLink({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`group inline-flex items-center gap-0.5 ${R_TAG} text-[12.5px] font-medium text-zinc-400 transition-colors duration-150 hover:text-zinc-100 ${FOCUS}`}
    >
      {children}
      <ChevronRight className="h-3.5 w-3.5 transition-transform duration-150 group-hover:translate-x-0.5" />
    </button>
  )
}

// ─── Small parts ─────────────────────────────────────────────────────────────

/** A keyboard key. */
export function Kbd({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={`inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-[4px] border border-white/[0.10] bg-white/[0.04] px-1 font-sans text-[11px] font-medium leading-none text-zinc-400 ${className}`}
    >
      {children}
    </kbd>
  )
}

/** A loading placeholder shaped like the content it stands in for. */
export function Skeleton({ className = '' }: { className?: string }) {
  return <span aria-hidden className={`block animate-pulse rounded-[5px] bg-white/[0.06] ${className}`} />
}

/** Copies `value` and says so, in place, for 1.6s. */
export function CopyButton({
  value,
  label = 'Copy',
  className = '',
  showLabel = false,
}: {
  value: string
  label?: string
  className?: string
  showLabel?: boolean
}) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout>>()
  useEffect(() => () => clearTimeout(timer.current), [])
  const onCopy = useCallback(() => {
    navigator.clipboard?.writeText(value).then(
      () => {
        setCopied(true)
        clearTimeout(timer.current)
        timer.current = setTimeout(() => setCopied(false), 1600)
      },
      () => {},
    )
  }, [value])
  return (
    <button
      type="button"
      onClick={onCopy}
      aria-label={copied ? 'Copied' : label}
      title={copied ? 'Copied' : label}
      className={`inline-flex h-[26px] flex-shrink-0 items-center justify-center gap-1.5 ${R_CONTROL} ${
        showLabel ? 'px-2' : 'w-[26px]'
      } text-[12px] font-medium transition-colors duration-150 ${FOCUS} ${
        copied ? 'text-emerald-300' : 'text-zinc-500 hover:bg-white/[0.06] hover:text-zinc-100'
      } ${className}`}
    >
      {copied ? <Check className="h-3.5 w-3.5" strokeWidth={2.25} /> : <Copy className="h-3.5 w-3.5" strokeWidth={1.75} />}
      {showLabel && <span aria-live="polite">{copied ? 'Copied' : label}</span>}
    </button>
  )
}

/** A read-only machine value (an id, a URL, a key prefix) with a copy button. */
export function CopyField({ value, display, className = '' }: { value: string; display?: ReactNode; className?: string }) {
  return (
    <div className={`flex h-[34px] min-w-0 items-center gap-2 ${WELL} border ${EDGE} ${R_CONTROL} pl-3 pr-1 ${className}`}>
      <code className="min-w-0 flex-1 truncate font-mono text-[12px] text-zinc-300">{display ?? value}</code>
      <CopyButton value={value} />
    </div>
  )
}

/**
 * The console's empty-state next step. Building happens through the user's
 * coding agent, so the most useful thing an empty section can offer is the
 * sentence to send it: shown as a prompt, one click to copy.
 */
export function AgentPrompt({ prompt, className = '' }: { prompt: string; className?: string }) {
  return (
    <div
      className={`group flex w-full max-w-[520px] items-start gap-3 ${R_CONTROL} border ${EDGE} ${WELL} py-2.5 pl-3.5 pr-1.5 text-left ${className}`}
    >
      <span aria-hidden className="mt-[1px] select-none font-mono text-[12px] leading-[20px] text-violet-300/80">
        ›
      </span>
      <p className="min-w-0 flex-1 font-mono text-[12px] leading-[20px] text-zinc-300">{prompt}</p>
      <CopyButton value={prompt} label="Copy prompt" />
    </div>
  )
}


// ─── Menus ───────────────────────────────────────────────────────────────────

/** Closes a menu on an outside click or Escape. Attach the ref to the wrapper. */
export function useDismiss(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    document.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open, close])
  return ref
}

export function MenuPanel({
  children,
  align = 'left',
  width = 'w-[260px]',
}: {
  children: ReactNode
  align?: 'left' | 'right'
  width?: string
}) {
  return (
    <motion.div
      role="menu"
      initial={{ opacity: 0, y: -4, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -4, scale: 0.98 }}
      transition={{ duration: 0.14, ease: [0.16, 1, 0.3, 1] }}
      className={`absolute top-full z-40 mt-1.5 ${align === 'right' ? 'right-0 origin-top-right' : 'left-0 origin-top-left'} ${width} overflow-hidden rounded-[10px] ${RAISE} ${FLOAT} p-1`}
    >
      {children}
    </motion.div>
  )
}

export function MenuItem({
  icon: Icon,
  children,
  onClick,
  href,
  danger = false,
  disabled = false,
  trailing,
}: {
  icon?: IconLike
  children: ReactNode
  onClick?: () => void
  href?: string
  danger?: boolean
  disabled?: boolean
  trailing?: ReactNode
}) {
  const cls = `flex w-full items-center gap-2.5 rounded-[6px] px-2.5 py-[7px] text-left text-[13px] transition-colors disabled:pointer-events-none disabled:opacity-40 ${
    danger ? 'text-zinc-300 hover:bg-rose-500/[0.10] hover:text-rose-200' : 'text-zinc-300 hover:bg-white/[0.06] hover:text-zinc-50'
  } focus-visible:bg-white/[0.06] focus-visible:outline-none`
  const inner = (
    <>
      {Icon && <Icon className={`h-[15px] w-[15px] flex-shrink-0 ${danger ? 'text-rose-300/80' : 'text-zinc-500'}`} strokeWidth={1.75} />}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {trailing}
    </>
  )
  if (href) {
    return (
      <a role="menuitem" href={href} onClick={onClick} className={cls}>
        {inner}
      </a>
    )
  }
  return (
    <button role="menuitem" type="button" onClick={onClick} disabled={disabled} className={cls}>
      {inner}
    </button>
  )
}

export function MenuSeparator() {
  return <div role="separator" className="mx-1 my-1 h-px bg-white/[0.07]" />
}

/**
 * A row's secondary actions behind one "…" button, so a list row carries one
 * visible action instead of five. Items close the menu when chosen.
 */
export function OverflowMenu({
  label,
  items,
  disabled,
  width = 'w-[200px]',
}: {
  /** Accessible name, e.g. "Actions for https://…" */
  label: string
  items: Array<
    | { separator: true }
    | { label: string; icon?: IconLike; onClick: () => void; danger?: boolean; disabled?: boolean }
  >
  disabled?: boolean
  width?: string
}) {
  const [open, setOpen] = useState(false)
  const close = useCallback(() => setOpen(false), [])
  const ref = useDismiss(open, close)
  return (
    <div className="relative" ref={ref}>
      <IconButton icon={MoreHorizontal} label={label} onClick={() => setOpen((o) => !o)} disabled={disabled} active={open} />
      <AnimatePresence>
        {open && (
          <MenuPanel align="right" width={width}>
            {items.map((item, i) =>
              'separator' in item ? (
                <MenuSeparator key={`sep-${i}`} />
              ) : (
                <MenuItem
                  key={item.label}
                  icon={item.icon}
                  danger={item.danger}
                  disabled={item.disabled}
                  onClick={() => {
                    setOpen(false)
                    item.onClick()
                  }}
                >
                  {item.label}
                </MenuItem>
              ),
            )}
          </MenuPanel>
        )}
      </AnimatePresence>
    </div>
  )
}

// ─── Modal ───────────────────────────────────────────────────────────────────
// The one sanctioned dialog. A dim scrim, the raised surface, the float
// elevation, hairline-separated header and footer. On phones it is a bottom
// sheet. Focus moves in on open, cycles inside, and returns on close.

interface KitModalProps {
  open: boolean
  onClose: () => void
  title: ReactNode
  description?: ReactNode
  children?: ReactNode
  footer?: ReactNode
  /** Tailwind max-width class for the panel */
  width?: string
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

export function KitModal({ open, onClose, title, description, children, footer, width = 'max-w-md' }: KitModalProps) {
  const titleId = useId()
  const panelRef = useRef<HTMLDivElement>(null)
  const restoreRef = useRef<HTMLElement | null>(null)
  // Callers pass onClose inline. Reading it through a ref keeps the effect
  // below keyed on `open` alone, so a re-render while typing never re-runs the
  // focus handling and pulls the caret out of the field.
  const onCloseRef = useRef(onClose)
  useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])

  useEffect(() => {
    if (!open) return
    restoreRef.current = document.activeElement as HTMLElement | null
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCloseRef.current()
    }
    window.addEventListener('keydown', onKey)
    // Move focus in after the panel mounts: the first field if there is one,
    // else the panel itself so screen readers announce the title.
    const t = setTimeout(() => {
      const panel = panelRef.current
      if (!panel) return
      const field = panel.querySelector<HTMLElement>('input:not([disabled]), textarea:not([disabled]), select:not([disabled])')
      ;(field ?? panel).focus()
    }, 30)
    return () => {
      window.removeEventListener('keydown', onKey)
      clearTimeout(t)
      restoreRef.current?.focus?.()
    }
  }, [open])

  const trapTab = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Tab' || !panelRef.current) return
    const nodes = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE))
    if (nodes.length === 0) return
    const first = nodes[0]
    const last = nodes[nodes.length - 1]
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault()
      first.focus()
    }
  }

  return (
    <AnimatePresence>
      {open && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center p-0 sm:items-center sm:p-6"
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
        >
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
            className="absolute inset-0 bg-black/65"
            onClick={onClose}
          />
          <motion.div
            ref={panelRef}
            tabIndex={-1}
            onKeyDown={trapTab}
            initial={{ opacity: 0, y: 12, scale: 0.985 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.99 }}
            transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
            className={`relative w-full ${width} ${RAISE} ${FLOAT} overflow-hidden overscroll-contain rounded-t-[16px] pb-[env(safe-area-inset-bottom)] focus:outline-none sm:rounded-[14px] sm:pb-0`}
          >
            <div className="flex justify-center pb-1 pt-2.5 sm:hidden" aria-hidden>
              <div className="h-1 w-9 rounded-full bg-white/20" />
            </div>
            <div className="flex items-start justify-between gap-3 px-5 pb-3 pt-4">
              <div className="min-w-0">
                <h2 id={titleId} className="text-[15px] font-semibold leading-[22px] tracking-[-0.012em] text-zinc-50">
                  {title}
                </h2>
                {description && (
                  <div className="mt-1 text-[13px] leading-[20px] text-zinc-400 [text-wrap:pretty]">{description}</div>
                )}
              </div>
              <button
                type="button"
                onClick={onClose}
                aria-label="Close"
                className={`-mr-1.5 -mt-0.5 flex h-[28px] w-[28px] flex-shrink-0 items-center justify-center ${R_CONTROL} text-zinc-500 transition-colors duration-150 hover:bg-white/[0.06] hover:text-zinc-100 ${FOCUS}`}
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            {children && <div className="max-h-[70vh] overflow-y-auto px-5 pb-5 pt-1">{children}</div>}
            {footer && (
              <div className={`flex flex-col-reverse items-stretch justify-end gap-2 border-t ${RULE} bg-white/[0.015] px-5 py-3 sm:flex-row sm:items-center`}>
                {footer}
              </div>
            )}
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  )
}

// ─── Confirm dialog ──────────────────────────────────────────────────────────
// Replaces native alert()/confirm() and hand-rolled per-page ConfirmDialogs.

interface KitConfirmDialogProps {
  open: boolean
  onCancel: () => void
  onConfirm: () => void
  title: ReactNode
  description?: ReactNode
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
  busy?: boolean
  children?: ReactNode
}

export function KitConfirmDialog({
  open,
  onCancel,
  onConfirm,
  title,
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger = false,
  busy = false,
  children,
}: KitConfirmDialogProps) {
  return (
    <KitModal
      open={open}
      onClose={onCancel}
      title={title}
      description={description}
      footer={
        <>
          <KitButton variant="ghost" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </KitButton>
          <KitButton variant={danger ? 'danger' : 'primary'} onClick={onConfirm} loading={busy}>
            {busy ? 'Working…' : confirmLabel}
          </KitButton>
        </>
      }
    >
      {children}
    </KitModal>
  )
}
