import Link from 'next/link'
import { ArrowRight, ArrowUpRight, Check, Minus } from 'lucide-react'
import type { HTMLAttributes, ReactNode } from 'react'
import {
  BODY,
  CONTAINER,
  DISPLAY,
  GROUND,
  HEADING,
  LEDE,
  MEASURE,
  PANEL,
  PRIMARY_CTA,
  SECONDARY_CTA,
  SECTION_TOP,
  TEXT_LINK,
  TITLE,
} from '@/components/site/tokens'

/* ─────────────────────────────────────────────────────────────
   The marketing kit, rebuilt 2026-09-30 on the landing page's system.

   Every subpage is assembled from these pieces, so a visitor moving from `/`
   to `/pricing` to a legal page never feels the ground, the type or the edges
   change under them. What carried over from the landing page, deliberately:

   - One ground (#08090a), one container (1300px, the navbar's own), one set of
     gutters. The old kit ran subpages in a 1040px column inboard of the nav,
     because `max-w-7xl` is 80rem and the root font-size here is 13px.
   - Sizes in px. The root font-size is 13px, so every rem-based utility
     renders at 81% (`text-sm` is 11.4px). See components/site/tokens.ts.
   - No uppercase, wide-tracked eyebrow over a headline. A subpage hero says
     where you are with a breadcrumb trail instead, in sentence case.
   - Violet is the only colour, and it is used as light: the key light and the
     horizon under every hero, the arc at the close, the focus ring.
   - One radius per job: 16px panels, 8px controls, 6px chips.

   The signature, repeated on purpose: every page opens under the landing's
   top-left key light, its hero ends on a lit horizon the page's content sits
   on, and every page closes on the landing's rising arc.
───────────────────────────────────────────────────────────── */

/* ── Frame ───────────────────────────────────────────────────────────────── */

/** The page's <main>: the ground, the grain, and the skip-link target. */
export function Page({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <main id="main-content" className={`relative overflow-x-clip ${GROUND} ${className}`}>
      <Grain />
      {children}
    </main>
  )
}

/**
 * Film grain over the whole page, identical to the landing's. Fixed and
 * pointer-events-none, so it costs one composited layer instead of repainting
 * with the scroll. It breaks the banding in the large gradients.
 */
export function Grain() {
  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-0 z-30 opacity-[0.035] mix-blend-overlay"
      style={{
        backgroundImage:
          "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='160' height='160'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/></filter><rect width='100%' height='100%' filter='url(%23n)'/></svg>\")",
      }}
    />
  )
}

export function Container({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`${CONTAINER} ${className}`}>{children}</div>
}

/** Structured data, emitted as a script tag. The caller escapes via safeJsonLd. */
export function JsonLd({ json }: { json: string }) {
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: json }} />
}

/* ── Hero ────────────────────────────────────────────────────────────────── */

export type Crumb = { label: string; href?: string }

/**
 * Where you are, in place of an eyebrow. The last crumb is the current page and
 * is not a link; on a top-level page the trail is a single quiet label.
 */
export function Trail({ items, className = '' }: { items: Crumb[]; className?: string }) {
  return (
    <nav aria-label="Breadcrumb" className={className}>
      <ol className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[14px] tracking-[-0.006em] text-zinc-500">
        {items.map((item, index) => {
          const last = index === items.length - 1
          return (
            <li key={`${item.label}-${index}`} className="flex min-w-0 items-center gap-2">
              {item.href && !last ? (
                <Link
                  href={item.href}
                  className="rounded-sm transition-colors duration-200 hover:text-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-300"
                >
                  {item.label}
                </Link>
              ) : (
                <span aria-current={last ? 'page' : undefined} className={last ? 'truncate text-zinc-300' : ''}>
                  {item.label}
                </span>
              )}
              {!last && (
                <span aria-hidden className="text-zinc-700">
                  /
                </span>
              )}
            </li>
          )
        })}
      </ol>
    </nav>
  )
}

/**
 * A subpage hero: trail, headline, one lede, actions. At most four text
 * elements, left-aligned on the site's own edge, under the landing's key light.
 *
 * `aside` takes the right column from lg up, for the one page-specific object a
 * hero sometimes needs. `children` renders under the actions, full width, for
 * anything that belongs to the hero but is not text (a toggle, a meta line).
 *
 * The entrance is CSS (`.hero-enter` in app/globals.css): one staggered rise
 * that the reduced-motion media query turns off, with no hydration branch.
 */
export function PageHero({
  trail,
  title,
  lede,
  actions,
  aside,
  children,
  size = 'default',
}: {
  trail?: Crumb[]
  title: ReactNode
  lede?: ReactNode
  actions?: ReactNode
  aside?: ReactNode
  children?: ReactNode
  /** `compact` for documents (legal, guides), where the title is a label. */
  size?: 'default' | 'compact'
}) {
  // A headline is two lines at most. Beside an aside the column is narrower,
  // so the same words step down a size rather than wrapping to a third line.
  const headline =
    size === 'compact'
      ? 'max-w-[22ch] text-[36px] sm:text-[44px] md:text-[52px]'
      : aside
        ? 'max-w-[18ch] text-[40px] sm:text-[48px] md:text-[54px] xl:text-[60px]'
        : 'max-w-[20ch] text-[40px] sm:text-[52px] md:text-[60px] xl:text-[68px]'

  return (
    <section className="relative isolate">
      {/* Key light, top left, behind the headline: the landing's own. */}
      <div
        aria-hidden
        className="pointer-events-none absolute -top-[260px] left-[-12%] -z-10 h-[820px] w-[1100px] max-w-none bg-[radial-gradient(closest-side,rgba(255,255,255,0.07),transparent)]"
      />
      <div
        className={`${CONTAINER} pb-[64px] pt-[40px] md:pb-[88px] md:pt-[64px] ${
          aside ? 'grid gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,440px)] lg:items-end lg:gap-16' : ''
        }`}
      >
        <div className="min-w-0">
          {trail && <Trail items={trail} className="hero-enter" />}
          <h1
            // One vertical falloff across the whole headline, white to a cool
            // grey, the way a lit object reads. Never a second colour on one
            // phrase: that is the most common tell of a generated hero.
            className={`hero-enter hero-enter-1 ${trail ? 'mt-7' : ''} bg-gradient-to-b from-white from-40% to-zinc-400 bg-clip-text pb-2 text-transparent [text-wrap:balance] ${headline} ${DISPLAY}`}
          >
            {title}
          </h1>
          {lede && (
            <p
              className={`hero-enter hero-enter-2 mt-6 max-w-[58ch] text-[17px] text-zinc-400 [text-wrap:pretty] md:text-[19px] ${LEDE}`}
            >
              {lede}
            </p>
          )}
          {actions && (
            <div className="hero-enter hero-enter-3 mt-9 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
              {actions}
            </div>
          )}
          {children && <div className="hero-enter hero-enter-3">{children}</div>}
        </div>
        {aside && <div className="hero-enter hero-enter-4 min-w-0">{aside}</div>}
      </div>
      <Horizon />
    </section>
  )
}

/**
 * The lit edge the page's content sits on. A hairline that brightens toward
 * the middle, with the light it casts falling onto whatever comes next. The
 * same line the landing's hero film sits on.
 */
export function Horizon() {
  return (
    <div aria-hidden className={`pointer-events-none relative ${CONTAINER}`}>
      <div className="h-px bg-[linear-gradient(to_right,transparent,rgba(196,181,253,0.35)_22%,rgba(255,255,255,0.65)_50%,rgba(196,181,253,0.35)_78%,transparent)]" />
      <div className="absolute left-1/2 top-0 -z-10 h-[160px] w-[76%] -translate-x-1/2 bg-[radial-gradient(50%_100%_at_50%_0%,rgba(139,92,246,0.13),transparent)]" />
    </div>
  )
}

/* ── Sections ────────────────────────────────────────────────────────────── */

/**
 * A section with the landing's top-only rhythm, inside the site container.
 * Pass `flush` for the first section under a hero, whose horizon already made
 * the boundary.
 */
export function Section({
  children,
  className = '',
  containerClassName = '',
  flush = false,
  ...rest
}: {
  children: ReactNode
  className?: string
  containerClassName?: string
  flush?: boolean
} & HTMLAttributes<HTMLElement>) {
  return (
    <section className={`${flush ? 'relative pt-[56px] md:pt-[80px]' : SECTION_TOP} ${className}`} {...rest}>
      <div className={`${CONTAINER} ${containerClassName}`}>{children}</div>
    </section>
  )
}

/**
 * Left-aligned, stacked, no eyebrow. The headline names the section itself.
 * `size="sm"` is for sections that sit inside a longer document.
 */
export function SectionHead({
  id,
  title,
  lede,
  align = 'start',
  size = 'default',
  className = '',
  children,
}: {
  id?: string
  title: ReactNode
  lede?: ReactNode
  align?: 'start' | 'center'
  size?: 'default' | 'sm'
  className?: string
  /** Actions or links under the lede. */
  children?: ReactNode
}) {
  const centered = align === 'center'
  const heading =
    size === 'sm'
      ? 'max-w-[26ch] text-[26px] md:text-[34px]'
      : 'max-w-[22ch] text-[32px] md:text-[46px]'

  return (
    <div className={`${centered ? 'mx-auto flex flex-col items-center text-center' : ''} ${className}`}>
      <h2 id={id} className={`scroll-mt-28 text-white [text-wrap:balance] ${heading} ${TITLE}`}>
        {title}
      </h2>
      {lede && (
        <p className={`mt-5 ${MEASURE} text-[17px] text-zinc-400 [text-wrap:pretty] md:text-[18px] ${LEDE}`}>{lede}</p>
      )}
      {children && <div className={`mt-7 flex flex-wrap gap-x-6 gap-y-3 ${centered ? 'justify-center' : ''}`}>{children}</div>}
    </div>
  )
}

/* ── Actions ─────────────────────────────────────────────────────────────── */

/** True for anything the App Router does not own: off-site, mail, raw files. */
function isPlainHref(href: string) {
  return /^(https?:|mailto:)/.test(href) || /\.(md|txt|xml)$/.test(href)
}

function SmartLink({
  href,
  className,
  children,
  ariaLabel,
}: {
  href: string
  className: string
  children: ReactNode
  ariaLabel?: string
}) {
  if (isPlainHref(href)) {
    const newTab = href.startsWith('http')
    return (
      <a
        href={href}
        className={className}
        aria-label={ariaLabel}
        target={newTab ? '_blank' : undefined}
        rel={newTab ? 'noopener noreferrer' : undefined}
      >
        {children}
      </a>
    )
  }
  return (
    <Link href={href} className={className} aria-label={ariaLabel}>
      {children}
    </Link>
  )
}

/** The landing's two buttons. Icons are the caller's children. */
export function ButtonLink({
  href,
  variant = 'primary',
  children,
  className = '',
}: {
  href: string
  variant?: 'primary' | 'secondary'
  children: ReactNode
  className?: string
}) {
  return (
    <SmartLink href={href} className={`${variant === 'primary' ? PRIMARY_CTA : SECONDARY_CTA} ${className}`}>
      {children}
    </SmartLink>
  )
}

/** A quiet text action with the arrow that moves on hover. */
export function ArrowLink({ href, children, className = '' }: { href: string; children: ReactNode; className?: string }) {
  const external = href.startsWith('http')
  const Icon = external ? ArrowUpRight : ArrowRight
  return (
    <SmartLink href={href} className={`${TEXT_LINK} ${className}`}>
      {children}
      <Icon
        aria-hidden
        className="h-4 w-4 transition-transform duration-200 group-hover:translate-x-0.5"
      />
    </SmartLink>
  )
}

/* ── Surfaces ────────────────────────────────────────────────────────────── */

/** The landing bento's raised surface, without the pointer light. */
export function Panel({
  children,
  className = '',
  as: Component = 'div',
}: {
  children: ReactNode
  className?: string
  as?: 'div' | 'article' | 'aside' | 'li' | 'section'
}) {
  return <Component className={`${PANEL} ${className}`}>{children}</Component>
}

/**
 * A row of facts under hairlines: the landing's Plan / Review / Apply row.
 * For three to five parallel ideas that each need a title and a sentence,
 * where boxing each one would only add noise.
 */
export function Facts({
  items,
  className = '',
}: {
  items: { title: ReactNode; body: ReactNode; icon?: ReactNode }[]
  className?: string
}) {
  const cols =
    items.length >= 5
      ? 'sm:grid-cols-2 lg:grid-cols-5'
      : items.length === 4
        ? 'sm:grid-cols-2 lg:grid-cols-4'
        : items.length === 3
          ? 'md:grid-cols-3'
          : 'sm:grid-cols-2'

  return (
    <div className={`grid gap-x-8 gap-y-10 ${cols} ${className}`}>
      {items.map((item, index) => (
        <div key={index} className="min-w-0 border-t border-white/[0.10] pt-6">
          {item.icon && <div className="mb-5 text-violet-300">{item.icon}</div>}
          <h3 className={`text-[17px] text-white ${HEADING}`}>{item.title}</h3>
          <p className="mt-3 text-[15px] leading-[1.65] tracking-[-0.004em] text-zinc-400 [text-wrap:pretty]">
            {item.body}
          </p>
        </div>
      ))}
    </div>
  )
}

/**
 * A plain list with a glyph that means something: a check for what is done or
 * included, a dash for what stays yours or is out of scope. Never a decorative
 * dot.
 */
export function GlyphList({
  items,
  glyph = 'check',
  className = '',
}: {
  items: ReactNode[]
  glyph?: 'check' | 'dash'
  className?: string
}) {
  const Icon = glyph === 'check' ? Check : Minus
  return (
    <ul className={`flex flex-col gap-3.5 ${className}`}>
      {items.map((item, index) => (
        <li key={index} className="flex gap-3 text-[15px] leading-[1.65] text-zinc-300">
          <Icon
            aria-hidden
            className={`mt-[4px] h-4 w-4 shrink-0 ${glyph === 'check' ? 'text-violet-300' : 'text-zinc-500'}`}
            strokeWidth={2}
          />
          <span className="min-w-0 [text-wrap:pretty]">{item}</span>
        </li>
      ))}
    </ul>
  )
}

/**
 * Where to go next: a row of linked panels, each with a title, an optional
 * line, and an arrow that moves on hover.
 */
export function NextLinks({
  items,
  className = '',
}: {
  items: { href: string; title: ReactNode; body?: ReactNode; meta?: ReactNode }[]
  className?: string
}) {
  const cols =
    items.length >= 4 ? 'sm:grid-cols-2 lg:grid-cols-4' : items.length === 3 ? 'md:grid-cols-3' : 'sm:grid-cols-2'

  return (
    <ul className={`grid gap-3 ${cols} ${className}`}>
      {items.map((item) => {
        const external = item.href.startsWith('http')
        const Icon = external ? ArrowUpRight : ArrowRight
        return (
          <li key={item.href} className="min-w-0">
            <SmartLink
              href={item.href}
              className={`group flex h-full flex-col justify-between gap-6 p-6 transition-[border-color,background-color] duration-200 hover:border-white/[0.16] hover:bg-white/[0.035] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-300 ${PANEL}`}
            >
              <span className="min-w-0">
                {item.meta && <span className="mb-3 block text-[13px] text-zinc-500">{item.meta}</span>}
                <span className={`block text-[17px] text-white ${HEADING}`}>{item.title}</span>
                {item.body && (
                  <span className="mt-2 block text-[14px] leading-[1.6] text-zinc-400 [text-wrap:pretty]">
                    {item.body}
                  </span>
                )}
              </span>
              <Icon
                aria-hidden
                className="h-4 w-4 text-zinc-500 transition-[color,transform] duration-200 group-hover:translate-x-0.5 group-hover:text-white"
              />
            </SmartLink>
          </li>
        )
      })}
    </ul>
  )
}

/**
 * An ordered mechanism: what goes in, what the platform does, what comes out.
 * Numbered because it IS a sequence; a rail joins the numbers so it reads as
 * one path rather than a stack of cards. `label` is the step's verb.
 */
export function Steps({
  steps,
  className = '',
}: {
  steps: { label?: string; title: string; body: string }[]
  className?: string
}) {
  return (
    <ol className={`flex flex-col ${className}`}>
      {steps.map((step, index) => {
        const last = index === steps.length - 1
        return (
          <li key={step.title} className="grid grid-cols-[32px_minmax(0,1fr)] gap-5">
            <div className="flex flex-col items-center" aria-hidden>
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-white/[0.14] bg-[#0a0b0d] text-[13px] font-medium tabular-nums text-zinc-300">
                {index + 1}
              </span>
              {!last && <span className="mt-2 w-px flex-1 bg-[linear-gradient(to_bottom,rgba(255,255,255,0.14),rgba(255,255,255,0.05))]" />}
            </div>
            <div className={`min-w-0 pt-[5px] ${last ? '' : 'pb-10'}`}>
              {step.label && <p className="text-[13px] font-medium text-violet-300">{step.label}</p>}
              <h3 className={`${step.label ? 'mt-1' : ''} text-[17px] text-white ${HEADING}`}>{withCode(step.title)}</h3>
              <p className="mt-2 max-w-[62ch] text-[15px] leading-[1.7] tracking-[-0.004em] text-zinc-400 [text-wrap:pretty]">
                {withCode(step.body)}
              </p>
            </div>
          </li>
        )
      })}
    </ol>
  )
}

/* ── Close ───────────────────────────────────────────────────────────────── */

/**
 * The landing's closing section, shared: centred, and the page's last light, a
 * horizon arc rising behind the ask. It answers the lit horizon under the hero.
 */
export function HorizonClose({
  title,
  lede,
  children,
}: {
  title: ReactNode
  lede?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="relative overflow-hidden pb-[220px] pt-[112px] md:pb-[280px] md:pt-[168px]">
      <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-[420px] overflow-hidden">
        <div className="absolute left-1/2 top-[140px] h-[1400px] w-[2400px] -translate-x-1/2 rounded-[50%] bg-[radial-gradient(closest-side,rgba(139,92,246,0.26),rgba(139,92,246,0.06)_55%,transparent)]" />
        <div className="absolute left-1/2 top-[250px] h-[1400px] w-[1800px] -translate-x-1/2 rounded-[50%] border-t border-violet-200/50 bg-[#08090a] shadow-[0_-40px_140px_-30px_rgba(167,139,250,0.55),inset_0_1px_40px_-10px_rgba(196,181,253,0.25)] md:w-[2200px]" />
      </div>
      <div className={`${CONTAINER} relative text-center`}>
        <h2
          className={`mx-auto max-w-[18ch] text-[36px] text-white [text-wrap:balance] md:text-[60px] ${DISPLAY}`}
        >
          {title}
        </h2>
        {lede && (
          <p
            className={`mx-auto mt-6 max-w-[52ch] text-[17px] text-zinc-400 [text-wrap:pretty] md:text-[18px] ${LEDE}`}
          >
            {lede}
          </p>
        )}
        <div className="mt-10 flex flex-col items-center justify-center gap-3 sm:flex-row">{children}</div>
      </div>
    </section>
  )
}

/* ── Tables ──────────────────────────────────────────────────────────────── */

/**
 * A table that scrolls inside its own focusable region, so the page body never
 * scrolls sideways on a phone and the scroll is reachable by keyboard.
 */
export function DataTable({
  caption,
  columns,
  rows,
  codeFirstColumn = false,
  minWidth = 'min-w-[560px]',
}: {
  caption: string
  columns: string[]
  rows: ReactNode[][]
  /** Set the first column in mono, for tool names and identifiers. */
  codeFirstColumn?: boolean
  minWidth?: string
}) {
  return (
    <div
      role="region"
      aria-label={caption}
      tabIndex={0}
      className={`overflow-x-auto focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-300 ${PANEL}`}
    >
      <table className={`w-full ${minWidth} border-collapse text-left`}>
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="border-b border-white/[0.08]">
            {columns.map((col) => (
              <th key={col} scope="col" className="px-5 py-4 text-[13px] font-medium text-zinc-400">
                {col}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, r) => (
            <tr key={r} className="border-b border-white/[0.06] last:border-0">
              {row.map((cell, i) =>
                i === 0 ? (
                  <th
                    key={i}
                    scope="row"
                    className={`w-[28%] px-5 py-4 align-top font-normal ${
                      codeFirstColumn
                        ? 'font-mono text-[13px] leading-[1.7] text-zinc-200'
                        : 'text-[14px] font-medium leading-[1.6] text-zinc-200'
                    }`}
                  >
                    {cell}
                  </th>
                ) : (
                  <td key={i} className="px-5 py-4 align-top text-[14px] leading-[1.65] text-zinc-400">
                    {cell}
                  </td>
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/**
 * Capability comparison table.
 *
 * Four columns on purpose. A three-column table invites a tick against a cross,
 * which reduces a real difference to a verdict and flatters whoever wrote it;
 * the fourth column has to say what the difference costs or buys, including
 * when the honest answer is "nothing".
 *
 * Two renderings, never both in the accessibility tree at once. Below `md` the
 * rows become a definition list, because four columns of sentence-length prose
 * at 375px is either a horizontal scroll nobody finds or columns too narrow to
 * read. Tailwind's `hidden` is `display: none`, which removes a subtree from the
 * accessibility tree as well as from view.
 *
 * The competitor column comes first and the Backenly column carries the only
 * light, a faint violet wash, so the eye can find it without the table turning
 * into a scorecard.
 */
export function ComparisonTable({
  caption,
  competitor,
  rows,
}: {
  /** Accessible name for the table and its scroll region. Not shown visually. */
  caption: string
  competitor: string
  rows: { aspect: string; competitor: string; backenly: string; practical: string }[]
}) {
  const headings = ['', competitor, 'Backenly', 'In practice']

  return (
    <>
      <div
        role="region"
        aria-label={caption}
        tabIndex={0}
        className={`hidden md:block overflow-x-auto focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-300 ${PANEL}`}
      >
        <table className="w-full min-w-[860px] table-fixed border-collapse text-left">
          <caption className="sr-only">{caption}</caption>
          <colgroup>
            <col className="w-[17%]" />
            <col className="w-[27%]" />
            <col className="w-[28%] bg-[linear-gradient(180deg,rgba(139,92,246,0.07),rgba(139,92,246,0.015))]" />
            <col className="w-[28%]" />
          </colgroup>
          <thead>
            <tr className="border-b border-white/[0.08]">
              {headings.map((h, i) => (
                <th
                  key={i}
                  scope="col"
                  className={`px-5 py-5 text-[14px] font-semibold tracking-[-0.01em] ${
                    i === 2 ? 'text-violet-200' : 'text-zinc-300'
                  }`}
                >
                  {h || <span className="sr-only">Aspect</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.aspect} className="border-b border-white/[0.06] last:border-0">
                <th scope="row" className="px-5 py-5 align-top text-[14px] font-medium leading-[1.55] text-white">
                  {row.aspect}
                </th>
                <td className="px-5 py-5 align-top text-[14px] leading-[1.65] text-zinc-400">{row.competitor}</td>
                <td className="px-5 py-5 align-top text-[14px] leading-[1.65] text-zinc-300">{row.backenly}</td>
                <td className="px-5 py-5 align-top text-[14px] leading-[1.65] text-zinc-400">{row.practical}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <dl className="flex flex-col gap-3 md:hidden">
        {rows.map((row) => (
          <div key={row.aspect} className={`p-5 ${PANEL}`}>
            <dt className={`text-[16px] text-white ${HEADING}`}>{row.aspect}</dt>
            <dd className="mt-4 flex flex-col gap-4">
              <div>
                <p className="text-[13px] font-medium text-zinc-500">{competitor}</p>
                <p className="mt-1 text-[14px] leading-[1.65] text-zinc-400">{row.competitor}</p>
              </div>
              <div>
                <p className="text-[13px] font-medium text-violet-300">Backenly</p>
                <p className="mt-1 text-[14px] leading-[1.65] text-zinc-300">{row.backenly}</p>
              </div>
              <div className="border-t border-white/[0.07] pt-4">
                <p className="text-[13px] font-medium text-zinc-500">In practice</p>
                <p className="mt-1 text-[14px] leading-[1.65] text-zinc-400">{row.practical}</p>
              </div>
            </dd>
          </div>
        ))}
      </dl>
    </>
  )
}

/**
 * The "choose one or the other" pair. The competitor's column is rendered
 * first, on the page as in the DOM: a comparison that puts its own case first
 * reads as a rebuttal rather than an answer. Both columns are the same object;
 * only a violet edge-light says which one is Backenly.
 */
export function SplitDecision({
  heading,
  competitor,
  chooseCompetitor,
  chooseBackenly,
}: {
  /** The block owns a real heading, so it is reachable by heading navigation. */
  heading: string
  competitor: string
  chooseCompetitor: string[]
  chooseBackenly: string[]
}) {
  return (
    <>
      <h2 className={`max-w-[22ch] text-[32px] text-white [text-wrap:balance] md:text-[46px] ${TITLE}`}>{heading}</h2>
      <div className="mt-12 grid gap-3 md:grid-cols-2">
        <div className={`p-6 md:p-8 ${PANEL}`}>
          <h3 className={`text-[19px] text-white ${HEADING}`}>Choose {competitor} when</h3>
          <GlyphList items={chooseCompetitor} glyph="dash" className="mt-6" />
        </div>
        <div className={`relative overflow-hidden p-6 md:p-8 ${PANEL}`}>
          <span
            aria-hidden
            className="pointer-events-none absolute inset-x-0 top-0 h-px bg-[linear-gradient(to_right,transparent,rgba(196,181,253,0.7),transparent)]"
          />
          <span
            aria-hidden
            className="pointer-events-none absolute inset-0 bg-[radial-gradient(70%_60%_at_50%_0%,rgba(139,92,246,0.10),transparent)]"
          />
          <h3 className={`relative text-[19px] text-white ${HEADING}`}>Choose Backenly when</h3>
          <GlyphList items={chooseBackenly} glyph="check" className="relative mt-6" />
        </div>
      </div>
    </>
  )
}

/* ── Prose ───────────────────────────────────────────────────────────────── */

/**
 * Renders `backticked` spans in a content string as inline code. The content
 * files write identifiers the way a developer would in a commit message, and
 * printing the backticks literally read as unrendered markdown.
 */
export function withCode(text: string): ReactNode {
  if (!text.includes('`')) return text
  return text.split(/(`[^`]+`)/g).map((part, index) =>
    part.startsWith('`') && part.endsWith('`') && part.length > 2 ? (
      <code
        key={index}
        className="rounded-[5px] bg-white/[0.06] px-[5px] py-px font-mono text-[0.88em] text-zinc-200"
      >
        {part.slice(1, -1)}
      </code>
    ) : (
      part
    ),
  )
}

/** Body copy at the site's reading size. */
export function Prose({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <p className={`${MEASURE} ${BODY} text-zinc-400 [text-wrap:pretty] ${className}`}>{children}</p>
}
