'use client'

/**
 * Inspector Kit — the design system every inspector section composes from.
 *
 * Language (shared with WorkspaceHome, the platform's reference surface):
 *   – Panels: rounded-xl, #16171d, hairline white/[0.07] borders, one soft
 *     drop shadow. No decorative gradients, no hover-lift.
 *   – Type scale: 22 / 15 / 13 / 12 / 11 / 10. Tabular numerals everywhere.
 *   – Data is mono: counts, paths, timestamps, statuses render in mono text,
 *     not pill badges. Uppercase micro-labels at 10px / tracking-[0.12em].
 *   – Violet is reserved for the primary action, the active state, and
 *     attention. Emerald = healthy, amber = waiting, rose = failing.
 *   – Row dividers (divide-white/[0.04]) instead of card-per-row chrome.
 */

import { useEffect, forwardRef, type ReactNode, type ComponentType } from 'react'
import { Check, ChevronRight, X, type LucideIcon } from 'lucide-react'

// ─── Tokens ──────────────────────────────────────────────────────────────────
// Use these className recipes (not raw hex) when extending the kit.

export const KIT = {
  bg:          'bg-[#101116]',
  surface:     'bg-[#16171d]',
  surfaceAlt:  'bg-white/[0.04]',
  surfaceSoft: 'bg-white/[0.03]',

  // Dense-surface rungs (2026-07-29). A full-height workbench (a data grid, a
  // flush side rail) needs steps the panel ladder does not have: it stacks
  // opaque regions directly against each other with no gap or shadow between
  // them, so each one has to read as a distinct plane on its own. Extracted
  // from the Tables inspector rather than invented — reach for these instead of
  // eyeballing a new shade.
  //
  // The full ladder, dark → light:
  //   well #0f1015 · bg #101116 · rail #131419 · chrome #141519
  //   · gridHead #15161c · surface #16171d · rowHover #17181e · popover #1c1d23
  well:        'bg-[#0f1015]',   // sunken input wells inside a panel
  rail:        'bg-[#131419]',   // flush full-height side column
  gridHead:    'bg-[#15161c]',   // sticky grid header + pinned gutter head
  rowHover:    'bg-[#17181e]',   // grid row hover, opaque so sticky cells match

  // Tailwind scans source statically, so an arbitrary value only compiles where
  // it appears literally — a variant cannot be derived from `rowHover` at
  // runtime. Hence the explicit pair. `rowHoverGroup` repaints a sticky cell in
  // step with its row: sticky cells must be opaque or the scrolled-under
  // content shows through, which also means they do not inherit the row's
  // hover. It is coupled to the `group/row` name on the <tr>.
  rowHoverOn:    'hover:bg-[#17181e]',
  rowHoverGroup: 'group-hover/row:bg-[#17181e]',

  border:      'border-white/[0.07]',
  borderHover: 'hover:border-white/[0.14]',
  borderStrong:'border-white/[0.12]',
  hairline:    'border-white/[0.06]',
  divide:      'divide-white/[0.04]',

  inset:       'shadow-[0_16px_44px_-28px_rgba(0,0,0,0.9)]',
  // The ONLY elevation for floating layers (modals, dropdown menus). Never
  // shadow-2xl, never backdrop-blur.
  pop:         'shadow-[0_12px_32px_-16px_rgba(0,0,0,0.85)]',

  text:        'text-zinc-50',
  textMute:    'text-zinc-300',
  textDim:     'text-zinc-400',
  textFaint:   'text-zinc-500',

  radius:      'rounded-xl',
  radiusSm:    'rounded-lg',
  radiusXs:    'rounded-md',

  // Neutral-first (2026-07-23): surfaces and buttons are monochrome; violet
  // is an ACCENT ONLY — text, dots, count badges, focus rings, hairlines.
  // accentBg/accentBorder consumers keep their layout but read neutral now;
  // the violet in those spots comes from accentText alone.
  accent:      '#7C3AED',
  accentSolid: 'bg-violet-500',
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
      className={`relative ${KIT.surface} border ${KIT.border} ${KIT.radius} ${KIT.inset}
        ${interactive ? `transition-colors ${KIT.borderHover}` : ''}
        ${className}`}
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
    <div className={`flex items-center justify-between gap-3 px-4 py-3 border-b ${KIT.hairline} ${className}`}>
      <div className="min-w-0 flex items-baseline gap-2 flex-wrap">
        <h3 className="text-[12.5px] font-semibold text-zinc-100 leading-tight">
          {title}
        </h3>
        {description && (
          <p className="text-[11px] text-zinc-500 leading-snug truncate">
            {description}
          </p>
        )}
      </div>
      {actions && <div className="flex items-center gap-2 flex-shrink-0">{actions}</div>}
    </div>
  )
}

export function KitCardBody({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`p-4 ${className}`}>{children}</div>
}

// ─── Section labels & titles ─────────────────────────────────────────────────

export function SectionLabel({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <p className={`text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-600 ${className}`}>
      {children}
    </p>
  )
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
    <div className={`flex items-start justify-between gap-4 mb-4 ${className}`}>
      <div className="min-w-0">
        <h2 className="text-[15px] font-semibold text-zinc-50 leading-tight tracking-[-0.01em]">
          {title}
        </h2>
        {description && (
          <p className="text-[12.5px] text-zinc-500 mt-1 leading-snug max-w-2xl">
            {description}
          </p>
        )}
      </div>
      {actions && <div className="flex items-center gap-2 flex-shrink-0">{actions}</div>}
    </div>
  )
}

// ─── Runtime status bar ──────────────────────────────────────────────────────
// Every section's hero — the agent reporting on this slice of the backend, in
// the same voice as the workspace home Agent panel: micro-label, headline,
// body, trailing status in mono. One violet hairline along the top edge.

interface RuntimeStatusBarProps {
  icon: LucideIcon | ComponentType<{ className?: string }>
  title: string
  description: string
  /** Optional right-side status pill */
  status?: { label: string; tone?: 'operational' | 'managed' | 'paused' | 'attention' | 'failed' | 'beta' }
  /** Optional right-side action button or content */
  actions?: ReactNode
}

const STATUS_TONES = {
  operational: { dot: 'bg-emerald-400', text: 'text-emerald-300/90' },
  managed:     { dot: 'bg-zinc-500',    text: 'text-zinc-400'       },
  paused:      { dot: 'bg-zinc-600',    text: 'text-zinc-500'       },
  attention:   { dot: 'bg-amber-400',   text: 'text-amber-500'      },
  failed:      { dot: 'bg-rose-400',    text: 'text-rose-300'       },
  beta:        { dot: 'bg-violet-300',  text: 'text-violet-300'     },
} as const

export function RuntimeStatusBar({
  icon: Icon,
  title,
  description,
  status,
  actions,
}: RuntimeStatusBarProps) {
  const tone = STATUS_TONES[status?.tone ?? 'operational']
  return (
    <KitCard className="mb-4 overflow-hidden">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-violet-300/40 to-transparent" />
      <div className="flex items-center justify-between gap-6 px-5 py-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-500">
            <Icon className="h-3 w-3 text-zinc-500" />
            Backend agent
            {status && (
              <span className={`inline-flex items-center gap-1.5 normal-case tracking-normal font-mono text-[10.5px] font-medium ${tone.text}`}>
                <span className={`h-[5px] w-[5px] rounded-full ${tone.dot}`} />
                {status.label}
              </span>
            )}
          </div>
          <h2 className="mt-2 text-[15px] font-semibold leading-snug tracking-[-0.01em] text-white">{title}</h2>
          <p className="mt-1 max-w-xl text-[12.5px] leading-5 text-zinc-500">{description}</p>
        </div>
        {actions && <div className="flex items-center gap-2 flex-shrink-0">{actions}</div>}
      </div>
    </KitCard>
  )
}

// ─── Stat tile / grid ────────────────────────────────────────────────────────
// Dense counters in the inventory-rail voice: micro-label on top, mono
// numeral below. Icon chips are gone — the number is the interface.

interface StatTileProps {
  icon?: LucideIcon | ComponentType<{ className?: string }>
  label: string
  value: ReactNode
  /** Optional small delta line (e.g. "+12% · 24h") */
  delta?: { value: number; suffix?: string }
  /** Semantic tone for the numeral; defaults to neutral white */
  tone?: 'violet' | 'emerald' | 'sky' | 'amber' | 'neutral'
  loading?: boolean
}

const TONE_TEXT = {
  violet:  'text-violet-300',
  emerald: 'text-emerald-300',
  sky:     'text-sky-300',
  amber:   'text-amber-500',
  neutral: 'text-white',
} as const

// Kept for row icons (ListRow) — muted mono icon tints, no chip boxes.
const TONE_ICON = {
  violet:  'text-violet-300/80',
  emerald: 'text-emerald-300/80',
  sky:     'text-sky-300/80',
  amber:   'text-amber-500/80',
  neutral: 'text-zinc-500',
} as const

export function StatTile({
  icon: Icon,
  label,
  value,
  delta,
  tone = 'neutral',
  loading,
}: StatTileProps) {
  return (
    <div className={`relative ${KIT.surface} border ${KIT.border} ${KIT.radius} ${KIT.inset} px-4 py-3.5`}>
      <div className="flex items-center justify-between gap-2">
        <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-600 leading-none">{label}</p>
        {Icon && <Icon className="h-3 w-3 text-zinc-700" />}
      </div>
      <div className="mt-2.5 flex items-baseline gap-2">
        <p className={`font-mono text-[20px] font-medium tabular-nums leading-none ${loading ? 'text-zinc-700' : TONE_TEXT[tone]}`}>
          {loading ? '—' : value}
        </p>
        {typeof delta?.value === 'number' && !loading && <Delta value={delta.value} suffix={delta.suffix} />}
      </div>
    </div>
  )
}

function Delta({ value, suffix }: { value: number; suffix?: string }) {
  if (!value) return <span className="font-mono text-[10.5px] text-zinc-600 tabular-nums">—</span>
  const up = value > 0
  return (
    <span className={`font-mono text-[10.5px] font-medium tabular-nums ${up ? 'text-emerald-300/90' : 'text-rose-300'}`}>
      {up ? '+' : ''}{value}%{suffix ? ` · ${suffix}` : ''}
    </span>
  )
}

export function StatGrid({ children, cols = 4 }: { children: ReactNode; cols?: 2 | 3 | 4 }) {
  const colsClass = cols === 4 ? 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-4'
    : cols === 3 ? 'grid-cols-1 sm:grid-cols-3'
    : 'grid-cols-1 sm:grid-cols-2'
  return <div className={`grid ${colsClass} gap-3 mb-4`}>{children}</div>
}

// ─── Empty state ─────────────────────────────────────────────────────────────

interface EmptyStateProps {
  icon: LucideIcon | ComponentType<{ className?: string }>
  title: string
  description: string
  action?: ReactNode
  className?: string
}

export function EmptyState({ icon: Icon, title, description, action, className = '' }: EmptyStateProps) {
  return (
    <div className={`flex flex-col items-center justify-center text-center py-12 px-6 ${className}`}>
      <Icon className="w-4 h-4 text-zinc-600 mb-3" />
      <h3 className="text-[13px] font-semibold text-zinc-200">{title}</h3>
      <p className="text-[12px] text-zinc-500 mt-1.5 max-w-sm leading-relaxed">{description}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}

// ─── Badges & chips ──────────────────────────────────────────────────────────
// Quiet status text: dot + mono label. Reads as telemetry, not sticker.

interface KitBadgeProps {
  children: ReactNode
  tone?: 'operational' | 'managed' | 'paused' | 'attention' | 'failed' | 'beta' | 'neutral'
  icon?: LucideIcon | ComponentType<{ className?: string }>
  className?: string
}

const BADGE_TONES = {
  operational: { dot: 'bg-emerald-400',  text: 'text-emerald-300/90' },
  managed:     { dot: 'bg-zinc-500',     text: 'text-zinc-400'       },
  paused:      { dot: 'bg-zinc-600',     text: 'text-zinc-500'       },
  attention:   { dot: 'bg-amber-400',    text: 'text-amber-500'      },
  failed:      { dot: 'bg-rose-400',     text: 'text-rose-300'       },
  beta:        { dot: 'bg-violet-300',   text: 'text-violet-300'     },
  neutral:     { dot: 'bg-zinc-600',     text: 'text-zinc-500'       },
} as const

export function KitBadge({ children, tone = 'neutral', icon: Icon, className = '' }: KitBadgeProps) {
  const t = BADGE_TONES[tone]
  return (
    <span className={`inline-flex items-center gap-1.5 font-mono text-[10.5px] font-medium ${t.text} ${className}`}>
      {Icon ? <Icon className="w-3 h-3" /> : <span className={`h-[5px] w-[5px] rounded-full ${t.dot}`} />}
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
  icon?: LucideIcon | ComponentType<{ className?: string }>
  iconRight?: LucideIcon | ComponentType<{ className?: string }>
  disabled?: boolean
  type?: 'button' | 'submit'
  className?: string
}

export function KitButton({
  children,
  onClick,
  variant = 'secondary',
  size = 'md',
  icon: Icon,
  iconRight: IconRight,
  disabled,
  type = 'button',
  className = '',
}: KitButtonProps) {
  const base = `inline-flex items-center justify-center gap-1.5 font-medium transition-colors ${KIT.radiusSm}
    focus:outline-none focus:ring-2 focus:ring-violet-400/35
    disabled:opacity-40 disabled:cursor-not-allowed`
  const sizing = size === 'sm'
    ? 'h-7 px-2.5 text-[11.5px]'
    : 'h-8 px-3 text-[12px]'
  const variants = {
    // Neutral-first: the primary action is white on dark, like every serious
    // dev tool's dark theme. Violet stays in the focus ring — accent only.
    primary:   'bg-white text-black font-semibold hover:bg-zinc-200',
    secondary: 'border border-white/10 bg-white/[0.04] text-zinc-200 hover:border-white/20 hover:bg-white/[0.08]',
    ghost:     'border border-transparent text-zinc-400 hover:text-zinc-100 hover:bg-white/[0.04]',
    danger:    'border border-rose-500/25 bg-rose-500/[0.08] text-rose-300 hover:bg-rose-500/[0.14] hover:border-rose-500/35',
  }
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`${base} ${sizing} ${variants[variant]} ${className}`}
    >
      {Icon && <Icon className="w-3.5 h-3.5" />}
      {children}
      {IconRight && <IconRight className="w-3.5 h-3.5" />}
    </button>
  )
}

// ─── Tabs ────────────────────────────────────────────────────────────────────

export function KitTabs({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`flex items-center gap-0.5 border-b ${KIT.hairline} ${className}`}>
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
      onClick={onClick}
      className={`relative px-3 py-2.5 text-[12.5px] font-medium transition-colors -mb-px border-b-2 focus:outline-none
        ${active
          ? 'text-zinc-50 border-violet-400'
          : 'text-zinc-500 border-transparent hover:text-zinc-200'
        }`}
    >
      <span className="flex items-center gap-1.5">
        {children}
        {typeof count === 'number' && (
          <span className={`font-mono text-[10.5px] font-medium tabular-nums ${
            active ? 'text-violet-300' : 'text-zinc-600'
          }`}>
            {count}
          </span>
        )}
      </span>
    </button>
  )
}

// ─── List row ────────────────────────────────────────────────────────────────
// Hairline-divided rows: plain muted icon, 12.5px title, mono metadata right.

interface ListRowProps {
  icon?: LucideIcon | ComponentType<{ className?: string }>
  iconTone?: 'violet' | 'emerald' | 'sky' | 'amber' | 'neutral'
  title: ReactNode
  subtitle?: ReactNode
  right?: ReactNode
  onClick?: () => void
  className?: string
}

export function ListRow({
  icon: Icon,
  iconTone = 'neutral',
  title,
  subtitle,
  right,
  onClick,
  className = '',
}: ListRowProps) {
  const interactive = !!onClick
  const Wrapper: any = interactive ? 'button' : 'div'
  return (
    <Wrapper
      onClick={onClick}
      className={`w-full flex items-center gap-3 px-4 py-[11px] text-left transition-colors
        ${interactive ? 'hover:bg-white/[0.025] focus:outline-none' : ''}
        ${className}`}
    >
      {Icon && (
        <Icon className={`w-3.5 h-3.5 flex-shrink-0 ${TONE_ICON[iconTone]}`} />
      )}
      <div className="flex-1 min-w-0">
        <div className="text-[12.5px] font-medium text-zinc-200 truncate">{title}</div>
        {subtitle && <div className="text-[11.5px] text-zinc-500 mt-0.5 truncate">{subtitle}</div>}
      </div>
      {right && <div className="flex items-center gap-2 flex-shrink-0">{right}</div>}
    </Wrapper>
  )
}

// ─── Page chrome ─────────────────────────────────────────────────────────────

/** Standard outer wrapper for an inspector page's content area. */
export function KitPage({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`px-8 py-6 ${className}`}>{children}</div>
}

/** Two-column layout used by Auth, Storage, Realtime, etc. */
export function KitColumns({
  main,
  side,
  sideWidth = 'w-80',
}: {
  main: ReactNode
  side: ReactNode
  sideWidth?: string
}) {
  return (
    <div className="flex gap-4 items-start">
      <div className="flex-1 min-w-0 flex flex-col gap-4">{main}</div>
      <div className={`${sideWidth} flex-shrink-0 flex flex-col gap-4`}>{side}</div>
    </div>
  )
}

// ─── Inline note / banner ────────────────────────────────────────────────────

interface KitNoteProps {
  icon?: LucideIcon | ComponentType<{ className?: string }>
  tone?: 'info' | 'warn' | 'success' | 'danger'
  title?: ReactNode
  children: ReactNode
  actions?: ReactNode
}

export function KitNote({ icon: Icon = Check, tone = 'info', title, children, actions }: KitNoteProps) {
  const tones = {
    info:    'border-sky-500/15 text-sky-200/90',
    warn:    'border-amber-500/15 text-amber-500/90',
    success: 'border-emerald-500/15 text-emerald-200/90',
    danger:  'border-rose-500/15 text-rose-200/90',
  }
  return (
    <div className={`flex items-start gap-2.5 px-3.5 py-2.5 ${KIT.radiusSm} border bg-white/[0.015] ${tones[tone]}`}>
      <Icon className="w-3.5 h-3.5 mt-0.5 flex-shrink-0 opacity-70" />
      <div className="flex-1 min-w-0 text-[12.5px] leading-5">
        {title && <p className="font-semibold mb-0.5 text-zinc-100">{title}</p>}
        <div className="text-zinc-400">{children}</div>
      </div>
      {actions && <div className="flex items-center gap-2 flex-shrink-0">{actions}</div>}
    </div>
  )
}

// ─── Checklist (reused by Auth security posture, etc.) ───────────────────────

export function KitChecklist({ items }: { items: string[] }) {
  return (
    <div className="space-y-2.5">
      {items.map((line) => (
        <div key={line} className="flex items-start gap-2.5">
          <Check className="w-3 h-3 text-emerald-400/70 flex-shrink-0 mt-1" />
          <p className="text-[12px] text-zinc-400 leading-5">{line}</p>
        </div>
      ))}
    </div>
  )
}

// ─── Field (label + input wrapper) ───────────────────────────────────────────

export function KitField({
  label,
  hint,
  children,
}: {
  label: ReactNode
  hint?: ReactNode
  children: ReactNode
}) {
  return (
    <div>
      <label className="block text-[11px] font-medium text-zinc-400 tracking-tight mb-1.5">
        {label}
      </label>
      {children}
      {hint && <p className="text-[11.5px] text-zinc-500 mt-1.5 leading-snug">{hint}</p>}
    </div>
  )
}

export const KitInput = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  function KitInput(props, ref) {
    const { className = '', ...rest } = props
    return (
      <input
        {...rest}
        ref={ref}
        className={`w-full h-8 px-3 bg-[#0f1015] border ${KIT.border} ${KIT.radiusSm}
          text-[12.5px] text-zinc-50 placeholder:text-zinc-600
          focus:outline-none focus:border-violet-400/40 focus:ring-2 focus:ring-violet-400/15
          transition-colors ${className}`}
      />
    )
  }
)

export function KitTextarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const { className = '', ...rest } = props
  return (
    <textarea
      {...rest}
      className={`w-full px-3 py-2 bg-[#0f1015] border ${KIT.border} ${KIT.radiusSm}
        text-[12.5px] text-zinc-50 placeholder:text-zinc-600 resize-none
        focus:outline-none focus:border-violet-400/40 focus:ring-2 focus:ring-violet-400/15
        transition-colors ${className}`}
    />
  )
}

// ─── "More" trailing link (used in card headers) ─────────────────────────────

export function KitMoreLink({
  children,
  onClick,
}: {
  children: ReactNode
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className="group inline-flex items-center gap-0.5 text-[11.5px] font-medium text-zinc-500 transition-colors hover:text-zinc-200 focus:outline-none"
    >
      {children}
      <ChevronRight className="w-3 h-3 transition-transform group-hover:translate-x-0.5" />
    </button>
  )
}

// ─── Modal ───────────────────────────────────────────────────────────────────
// The one sanctioned dialog. Dim scrim (no blur), kit surface, KIT.pop
// elevation, hairline-separated header/footer. Compose KitField/KitInput/
// KitButton inside; pass KitButtons via `footer`.

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

export function KitModal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  width = 'max-w-md',
}: KitModalProps) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/70" onClick={onClose} />
      <div className={`relative w-full ${width} ${KIT.surface} border ${KIT.borderStrong} ${KIT.radius} ${KIT.pop} overflow-hidden`}>
        <div className={`flex items-start justify-between gap-3 px-4 py-3 border-b ${KIT.hairline}`}>
          <div className="min-w-0">
            <h3 className="text-[13px] font-semibold text-zinc-100 leading-tight">{title}</h3>
            {description && (
              <p className="text-[11.5px] text-zinc-500 mt-1 leading-snug">{description}</p>
            )}
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className={`flex-shrink-0 -mr-1 p-1 ${KIT.radiusXs} text-zinc-500 transition-colors hover:text-zinc-200 hover:bg-white/[0.04] focus:outline-none`}
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
        {children && <div className="p-4 max-h-[70vh] overflow-y-auto">{children}</div>}
        {footer && (
          <div className={`flex items-center justify-end gap-2 px-4 py-3 border-t ${KIT.hairline}`}>
            {footer}
          </div>
        )}
      </div>
    </div>
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
          <KitButton variant={danger ? 'danger' : 'primary'} onClick={onConfirm} disabled={busy}>
            {busy ? 'Working…' : confirmLabel}
          </KitButton>
        </>
      }
    >
      {children}
    </KitModal>
  )
}
