'use client'

import type { ReactNode } from 'react'
import { Pause, Play } from 'lucide-react'

/* ─────────────────────────────────────────────────────────────
   The parts the landing's live cards share: the two product films
   (./FeatureFilm) and regions (./RegionsV7). One pause control, one press
   and hover behaviour, one set of curves, so the cards read as one product.

   Kept apart from ./shared on purpose: the bento cell and figure tokens
   there are also the subpages' (agents, comparisons, alternatives, MCP),
   which stay exactly as they are.

   The values follow the installed design skills: a press scales to 0.96
   over 150ms ease-out (better-ui); hover styles apply only on a pointer
   that can hover, so a tap never leaves a control looking selected; an icon
   swap cross-fades scale 0.25 → 1, opacity and a 4px blur over 300ms
   (better-ui); entrances ease out, never in (emil-design-eng). A caption is
   words in the text face, not a tracked uppercase tag or a mono label
   (no-ai-design-slop).
───────────────────────────────────────────────────────────── */

/** Curves shared by every card control (CSS); the globe uses inline equivalents. */
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

/**
 * Pause and play for a scene's autoplay (WCAG 2.2.2: motion longer than five
 * seconds beside other content can be stopped). Both icons stay in the DOM
 * and cross-fade, so the swap never jumps; the play triangle sits 1px right
 * of centre, where it looks centred.
 */
export function PlayPause({
  paused,
  onToggle,
  what = 'animation',
  className = '',
}: {
  paused: boolean
  onToggle: () => void
  /** What plays, for the accessible name: "Pause the film". */
  what?: string
  className?: string
}) {
  const icon = 'absolute h-[13px] w-[13px] transition-[transform,opacity,filter] duration-300'
  return (
    <button
      type="button"
      aria-label={paused ? `Play the ${what}` : `Pause the ${what}`}
      title={paused ? 'Play' : 'Pause'}
      onClick={onToggle}
      className={`${CONTROL} relative inline-flex h-[30px] w-[30px] shrink-0 items-center justify-center ${className}`}
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

/** The caption under a card that says what it shows (an example store, an illustration), in words rather than a mono label. */
export function IllustrativeNote({ children, className = '' }: { children: ReactNode; className?: string }) {
  // zinc-400 at 12.5px: the honesty note must read at 4.5:1 on the card.
  return <span className={`text-[12.5px] leading-none tracking-[-0.003em] text-zinc-400 ${className}`}>{children}</span>
}
