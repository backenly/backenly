'use client'

import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react'
import { HEADING } from '@/components/site/tokens'

/* ─────────────────────────────────────────────────────────────
   Landing v7, shared pieces: ONE visual system for every section below the
   hero (founders, 2026-10-14: the self-healing and regions sections had
   "completely different text styles, color patterns ... make it unified").

   The system is the live bento's (origin/main app/page.tsx), used verbatim:
     section title   one two-tone headline, left-aligned, no eyebrow
     frame           BentoCell: rounded-2xl, a white/7 hairline, a faint
                     top-down lift, the violet spotlight that follows the
                     cursor
     type            CellTitle 19px semibold, CellBody 15px zinc-400
     figures         mono 11px on solid ink chips, uppercase 9px tags,
                     monochrome; emphasis by brightness. The brand violet is
                     the one accent, and below the hero it marks only what
                     Backenly itself does.

   SIZES ARE px: app/globals.css sets the root font-size to 13px, and it also
   redefines several margin utilities (mt-4, mt-16, mb-12...). Every spacing
   on this page is an arbitrary px value for that reason.
───────────────────────────────────────────────────────────── */

/** The live page's container (100rem is 1300px here), so every edge lines up under the hero. */
export const CONTAINER = 'mx-auto w-full max-w-[100rem] px-5 sm:px-6'

export const SECTION = 'relative pt-[96px] md:pt-[144px]'

/** The section-title type on its own, for a title set in a narrower column (the FAQ). */
export const TITLE_TYPE =
  'text-[30px] font-semibold leading-[1.12] tracking-[-0.03em] text-white sm:text-[36px] md:text-[42px] md:leading-[1.1]'

/** Every section title below the hero: white claim, grey continuation. */
export const SECTION_TITLE = `max-w-[900px] [text-wrap:pretty] ${TITLE_TYPE}`

/** The gap between a section title and its first cell. */
export const SECTION_BODY_GAP = 'mt-[48px] md:mt-[64px]'

/* ── The live page's own tokens (origin/main app/page.tsx), so the hero and
      the closing render identically to backenly.com ── */

/** Display weight and tracking: the hero headline and the closing headline. */
export const DISPLAY = 'font-semibold leading-[1.02] tracking-[-0.045em] md:leading-[0.98]'

export const PRIMARY_CTA =
  'group inline-flex h-[46px] items-center justify-center gap-2 whitespace-nowrap rounded-lg bg-white px-5 text-[15px] font-semibold tracking-[-0.01em] text-black shadow-[0_0_0_1px_rgba(255,255,255,0.1),0_8px_30px_-8px_rgba(255,255,255,0.35)] transition-[background-color,transform,box-shadow] duration-200 hover:bg-zinc-200 hover:shadow-[0_0_0_1px_rgba(255,255,255,0.14),0_10px_40px_-8px_rgba(255,255,255,0.45)] active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-300 focus-visible:ring-offset-2 focus-visible:ring-offset-[#08090a]'

export const SECONDARY_CTA =
  'group inline-flex h-[46px] items-center justify-center gap-2 whitespace-nowrap rounded-lg border border-white/[0.12] bg-white/[0.03] px-5 text-[15px] font-medium tracking-[-0.01em] text-zinc-200 transition-[background-color,border-color,color,transform] duration-200 hover:border-white/25 hover:bg-white/[0.07] hover:text-white active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-300 focus-visible:ring-offset-2 focus-visible:ring-offset-[#08090a]'

/** A text link with a trailing arrow (the bento's "Every feature", the FAQ's links). */
export const TEXT_LINK =
  'group inline-flex items-center gap-1.5 text-[15px] font-medium tracking-[-0.006em] text-zinc-300 transition-colors duration-200 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-300 focus-visible:ring-offset-2 focus-visible:ring-offset-[#08090a]'

/**
 * The figure grammar of components/landing/CapabilityDiagrams, repeated here
 * for the figures that are not SVG (the DOM labels pinned into the WebGL
 * scenes), so a label on a canvas reads exactly like a chip in the bento.
 */
export const FIG = {
  MONO: 'font-mono text-[11px] leading-none tracking-tight [font-variant-ligatures:none]',
  TEXT: 'text-zinc-300',
  MUTED: 'text-zinc-500',
  BRIGHT: 'text-zinc-100',
  CHIP: 'inline-flex h-8 items-center gap-2 whitespace-nowrap rounded-[5px] border border-white/[0.09] bg-[#0b0b0e] px-2.5',
  CHIP_BRIGHT: 'inline-flex h-8 items-center gap-2 whitespace-nowrap rounded-[5px] border border-white/[0.18] bg-[#0b0b0e] px-2.5',
  TAG: 'text-[9px] font-medium uppercase tracking-[0.14em] text-zinc-600',
  /** The tag inside a control, where it names state: raised to about 5:1 on the chip. */
  CONTROL_TAG: 'text-[9px] font-medium uppercase tracking-[0.14em] text-zinc-400/80',
  /** The bento's fact chips, used here as small controls. */
  FACT: 'rounded-md border px-2.5 py-1 text-[12.5px] transition-colors duration-200',
  FACT_ON: 'border-white/[0.2] bg-white/[0.08] text-white',
  FACT_OFF: 'border-white/[0.08] bg-white/[0.03] text-zinc-400 hover:border-white/[0.14] hover:text-zinc-200',
} as const

/**
 * A bento cell with a cursor-following spotlight on its border and surface.
 * The pointer position is written straight to CSS custom properties on the
 * element, never to React state, so moving the mouse re-renders nothing.
 * `bare` drops the padding, for cells whose figure runs to the edges.
 */
/*
 * The hover border changes in one step, not over a 300ms transition: a
 * border-colour transition repaints the whole cell, diagrams and all, on every
 * frame, and while a page scrolls under a resting cursor every cell it crosses
 * starts one. The spotlight still fades, as an opacity the compositor runs.
 */
export function BentoCell({ children, className = '', bare = false }: { children: ReactNode; className?: string; bare?: boolean }) {
  const ref = useRef<HTMLElement>(null)

  function onMove(event: PointerEvent<HTMLElement>) {
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    el.style.setProperty('--x', `${event.clientX - rect.left}px`)
    el.style.setProperty('--y', `${event.clientY - rect.top}px`)
  }

  return (
    <article
      ref={ref}
      onPointerMove={onMove}
      className={`group relative flex min-w-0 flex-col overflow-hidden rounded-2xl border border-white/[0.07] bg-[linear-gradient(180deg,rgba(255,255,255,0.028),rgba(255,255,255,0.008))] hover:border-white/[0.13] ${
        bare ? '' : 'p-6 md:p-8'
      } ${className}`}
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-300 group-hover:opacity-100"
        style={{
          background:
            'radial-gradient(420px circle at var(--x, 50%) var(--y, 0%), rgba(167,139,250,0.08), transparent 60%)',
        }}
      />
      <div className="relative flex h-full flex-col">{children}</div>
    </article>
  )
}

export function CellTitle({ children }: { children: ReactNode }) {
  return <h3 className={`text-[19px] text-white ${HEADING}`}>{children}</h3>
}

export function CellBody({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <p className={`mt-3 max-w-[46ch] text-[15px] leading-[1.7] tracking-[-0.004em] text-zinc-400 ${className}`}>
      {children}
    </p>
  )
}

/** True while the element is on screen. Loops pause when it is not. */
export function useOnScreen<T extends Element>(margin = '0px') {
  const ref = useRef<T | null>(null)
  const [on, setOn] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver(([e]) => setOn(e.isIntersecting), { rootMargin: margin })
    io.observe(el)
    return () => io.disconnect()
  }, [margin])
  return [ref, on] as const
}

/* ── Scroll performance (founders, 2026-10-14: "make the scrolling fast and
      professional"). Measured with a wheel-scroll frame-timing benchmark: the
      page-wide blended grain, live blurs, a scroll-linked parallax, framer's
      per-frame JavaScript entrances and three.js booting mid-scroll each cost
      frames. Nothing on this page may run JavaScript per scroll frame.

      No section entrances either (Impeccable polish, 2026-10-14): one
      identical fade-up on every section is a generated-page tell, and the
      page reads faster with content simply there. The hero's entrance is the
      one authored moment; the bento figures still assemble, because their
      order is the explanation. ── */

/**
 * Run `fn` once the browser is idle after the page has loaded (or after
 * `timeout` ms at the latest), so heavy setup such as loading three.js and
 * compiling shaders happens while the visitor reads the hero, not in the middle
 * of a scroll. Returns a cancel function.
 */
export function whenIdle(fn: () => void, timeout = 2500): () => void {
  let idle = 0
  let timer = 0
  const go = () => {
    if (typeof window.requestIdleCallback === 'function') idle = window.requestIdleCallback(fn, { timeout })
    else timer = window.setTimeout(fn, 400)
  }
  if (document.readyState === 'complete') go()
  else window.addEventListener('load', go, { once: true })
  return () => {
    window.removeEventListener('load', go)
    if (idle) window.cancelIdleCallback?.(idle)
    if (timer) window.clearTimeout(timer)
  }
}

/**
 * Frame gate for the WebGL loops. On displays above 90 Hz it lets every other
 * frame through: the scenes are ambient, 72 fps is smooth for them, and half
 * the work leaves the frame budget to scrolling. Below 90 Hz every frame passes.
 */
export function frameGate() {
  let last = 0
  let fast = 0
  let odd = false
  return (now: number) => {
    const dt = now - last
    last = now
    if (dt > 0 && dt < 11) fast = Math.min(fast + 1, 10)
    else if (dt > 13) fast = Math.max(fast - 1, 0)
    if (fast < 5) return true
    odd = !odd
    return odd
  }
}
