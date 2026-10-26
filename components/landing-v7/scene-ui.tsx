'use client'

import type { ReactNode } from 'react'
import { Pause, Play } from 'lucide-react'
import { FIG } from './shared'

/* ─────────────────────────────────────────────────────────────
   The parts the landing's three live scenes share: self-healing
   (./OperatedScene), restructuring (./EvolutionScene) and regions
   (./RegionsV7). One chip, one pause control, one press and hover
   behaviour, one set of curves, so the three cards read as one product.

   Kept apart from ./shared on purpose: the bento cell and figure tokens
   there are also the subpages' (agents, comparisons, alternatives, MCP),
   which stay exactly as they are.

   The values follow the installed design skills: a press scales to 0.96
   over 150ms ease-out (better-ui); hover styles apply only on a pointer
   that can hover, so a tap never leaves a control looking selected; an icon
   swap cross-fades scale 0.25 → 1, opacity and a 4px blur over 300ms
   (better-ui); entrances ease out, never in (emil-design-eng). A chip's
   note is sentence case in the text face, not a tracked uppercase tag: the
   value (a table, a statement, a count) is the machine text and keeps the
   mono face, the note is words (no-ai-design-slop).
───────────────────────────────────────────────────────────── */

/** Curves shared by every scene control (CSS); the three.js scenes use the GSAP or inline equivalents. */
export const EASE = {
  /** Strong ease-out: entrances, presses, thumbs that follow a choice. */
  out: 'cubic-bezier(0.23, 1, 0.32, 1)',
  /** better-ui's curve for an icon cross-fade. */
  swap: 'cubic-bezier(0.2, 0, 0, 1)',
} as const

/**
 * A scene control at rest: the bento's fact chip, with a press, and a hover
 * only where a pointer can hover (Tailwind 3's `hover:` also fires on a tap
 * and sticks). Class names are written out whole so Tailwind can find them.
 */
export const CONTROL =
  'rounded-[7px] border border-white/[0.08] bg-white/[0.03] text-zinc-400 transition-[transform,background-color,border-color,color] duration-150 ease-out active:scale-[0.96] [@media(hover:hover)_and_(pointer:fine)]:hover:border-white/[0.14] [@media(hover:hover)_and_(pointer:fine)]:hover:text-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-300 [-webkit-tap-highlight-color:transparent]'

/** Which way a chip runs from its leader: centred over it, or as a flag running right or left. */
const ALIGN = {
  center: { box: 'items-center -translate-x-1/2', stem: '', dot: '' },
  start: { box: 'items-start -translate-x-[15px]', stem: 'ml-[14.5px]', dot: 'ml-[12px]' },
  end: { box: 'items-end translate-x-[calc(-100%+15px)]', stem: 'mr-[14.5px]', dot: 'mr-[12px]' },
} as const

/** A chip's value: machine text (a table, a statement, a count), in the mono face. */
export function ChipValue({ children, bright = false, className = '' }: { children: ReactNode; bright?: boolean; className?: string }) {
  return <span className={`${FIG.MONO} ${bright ? 'text-zinc-50' : 'text-zinc-200'} ${className}`}>{children}</span>
}

/** A chip's note: words, in the text face, sentence case. */
export function ChipNote({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <span className={`text-[11.5px] leading-none tracking-[-0.003em] text-zinc-400 ${className}`}>{children}</span>
}

/**
 * A label pinned to a point in a scene: a chip on a leader with an anchor
 * dot, the dot's centre on the point. `accent` marks what Backenly itself
 * does, in the brand violet; everything else is neutral. `below` hangs the
 * chip under its point, for a point at a table's front edge, where a chip
 * above would cover what it names. Its engine finds it by `data-chip` and
 * moves it with a transform; it is never read by a screen reader, which
 * gets the scene's own description instead.
 */
export function Callout({
  name,
  accent = false,
  align = 'center',
  below = false,
  children,
}: {
  name: string
  accent?: boolean
  align?: keyof typeof ALIGN
  below?: boolean
  children: ReactNode
}) {
  const a = ALIGN[align]
  return (
    <div data-chip={name} aria-hidden className="pointer-events-none absolute left-0 top-0 opacity-0 will-change-transform">
      <div className={`flex ${below ? '-translate-y-[3px] flex-col-reverse' : '-translate-y-[calc(100%-3px)] flex-col'} ${a.box}`}>
        {/* Elevation from layered shadow, structure from a hairline ring; the transparent border keeps an edge in forced colours. */}
        <span
          className={`inline-flex h-[28px] items-center gap-2 whitespace-nowrap rounded-[6px] border border-transparent bg-[#0e0f12] px-2.5 ${
            accent
              ? 'shadow-[0_0_0_1px_rgba(196,181,253,0.30),0_1px_2px_rgba(0,0,0,0.5),0_10px_24px_-8px_rgba(0,0,0,0.75)]'
              : 'shadow-[0_0_0_1px_rgba(255,255,255,0.10),0_1px_2px_rgba(0,0,0,0.5),0_10px_24px_-8px_rgba(0,0,0,0.75)]'
          }`}
        >
          {children}
        </span>
        <span className={`h-[18px] w-px ${accent ? 'bg-violet-200/40' : 'bg-white/[0.22]'} ${a.stem}`} />
        <span className={`h-[6px] w-[6px] rounded-full ring-2 ring-[#0b0b0e] ${accent ? 'bg-violet-300' : 'bg-zinc-300'} ${a.dot}`} />
      </div>
    </div>
  )
}

/**
 * Pause and play for a scene's autoplay (WCAG 2.2.2: motion longer than five
 * seconds beside other content can be stopped). Both icons stay in the DOM
 * and cross-fade, so the swap never jumps; the play triangle sits 1px right
 * of centre, where it looks centred.
 */
export function PlayPause({ paused, onToggle }: { paused: boolean; onToggle: () => void }) {
  const icon = 'absolute h-[13px] w-[13px] transition-[transform,opacity,filter] duration-300'
  return (
    <button
      type="button"
      aria-label={paused ? 'Play the animation' : 'Pause the animation'}
      title={paused ? 'Play' : 'Pause'}
      onClick={onToggle}
      className={`${CONTROL} relative inline-flex h-[30px] w-[30px] shrink-0 items-center justify-center`}
    >
      <Pause
        aria-hidden
        strokeWidth={2}
        className={icon}
        style={{
          transitionTimingFunction: EASE.swap,
          transform: paused ? 'scale(0.25)' : 'scale(1)',
          opacity: paused ? 0 : 1,
          filter: paused ? 'blur(4px)' : 'blur(0px)',
        }}
      />
      <Play
        aria-hidden
        strokeWidth={2}
        className={icon}
        style={{
          transitionTimingFunction: EASE.swap,
          transform: paused ? 'translateX(1px) scale(1)' : 'translateX(1px) scale(0.25)',
          opacity: paused ? 1 : 0,
          filter: paused ? 'blur(0px)' : 'blur(4px)',
        }}
      />
    </button>
  )
}

/** The caption under a scene that says it is an illustration, in words rather than a mono label. */
export function IllustrativeNote({ children, className = '' }: { children: ReactNode; className?: string }) {
  // zinc-400 at 12.5px: the honesty note must read at 4.5:1 on the card.
  return <span className={`text-[12.5px] leading-none tracking-[-0.003em] text-zinc-400 ${className}`}>{children}</span>
}
