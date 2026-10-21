'use client'

import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import Link from 'next/link'
import { motion, type Variants } from 'framer-motion'
import { ArrowRight } from 'lucide-react'
import { Icon } from '@iconify/react'
import { AGENT_MARKS, AgentGlyph } from '@/components/landing/AgentMarks'
import { ROUTES } from '@/components/site/SiteShell'
import { LEDE } from '@/components/site/tokens'
import { useSettledReducedMotion } from '@/lib/hooks/useSettledReducedMotion'
import { useUserSession } from '@/lib/hooks/useUserSession'
import {
  AgentSession,
  CHAPTERS,
  CHAPTER_SPAN,
  CONSOLE_KEYFRAMES,
  ConsoleScreen,
  FRAMES,
  Fit,
  H,
  TERM_H,
  TERM_W,
  W,
} from './LiveConsole'
import { CONTAINER, DISPLAY, PRIMARY_CTA, SECONDARY_CTA, useOnScreen } from './shared'

/* ─────────────────────────────────────────────────────────────
   Hero, round 4 (2026-10-22). The founders' mentor pointed at
   instacloud.com: its hero is one product mock that plays the whole idea
   as a story, so a visitor understands the product before reading a
   word. The four crossfading stills are replaced by that: the console,
   live, playing Build → Self-heal → Approve → Watch (./LiveConsole). The
   step rail under it (round 17) now names those chapters and fills while
   each one plays; a click plays that chapter once and holds on it.

   The copy block is still the live hero's: same headline, buttons, light
   and entrance. The subline now says the two halves of the product, in
   the founders' own paragraph (public/llms.txt): the agent builds it over
   MCP; Backenly then maintains it, within what it can verify and undo.

   The stills hero is backed up at F:/landing-v7/alt-hero/HeroV7.stills-round17.tsx,
   the centred round-2 hero at F:/landing-v7/alt-hero/HeroV7.centered-round2.tsx.
───────────────────────────────────────────────────────────── */

/** What each chapter shows, for screen readers: the console itself is drawn, not read. */
const CHAPTER_ALT = [
  'Claude Code builds the UrbanCart store backend through Backenly MCP tools while the Backenly Database page fills with the products, orders, order_items and users tables and the first orders arrive.',
  'The self-healing loop on the Backenly Overview page detects two broken guarantees, fixes one on its own by adding an index on orders.customer_id, proves it fixed, and holds the other for you.',
  'The Backenly Autonomy page: a missing foreign key on order_items waits for your approval with Approve and fix, next to the index Backenly added on its own, which keeps an Undo button.',
  'Backenly Overview, all clear: no issues detected, self-healing on watch, with both changes listed as receipts.',
]

/** Corner radii measured off the renders (export-windows.py), as shares of each side. */
const CONSOLE_RADIUS = '1.168% / 1.993%'
const TERMINAL_RADIUS = '1.75% / 2%'

/**
 * NO FRAME, as the live HeroFilm: the violet field fades out at its edges,
 * shorter at the sides and top, longer at the bottom, so it reads as light on
 * the page. Same mask and widths as components/landing/HeroFilm.tsx.
 */
const MASK =
  'linear-gradient(to right, transparent, #000 var(--fx), #000 calc(100% - var(--fx)), transparent), ' +
  'linear-gradient(to bottom, transparent, #000 var(--fx), #000 calc(100% - var(--fb)), transparent)'
const FEATHER = {
  maskImage: MASK,
  WebkitMaskImage: MASK,
  maskComposite: 'intersect',
  WebkitMaskComposite: 'source-in',
} as const
const FEATHER_SIZE = '[--fx:7%] [--fb:16%] md:[--fx:9%] md:[--fb:26%]'

const EASE_OUT = [0.16, 1, 0.3, 1] as const

const heroItem: Variants = {
  hidden: { opacity: 0, y: 14, filter: 'blur(8px)' },
  visible: { opacity: 1, y: 0, filter: 'blur(0px)' },
}

/** The showcase rises without blur: a filter left on an ancestor costs every frame. */
const heroFilm: Variants = {
  hidden: { opacity: 0, y: 28 },
  visible: { opacity: 1, y: 0 },
}

export function HeroV7() {
  const quiet = useSettledReducedMotion()
  const { isLoggedIn } = useUserSession()

  return (
    <motion.section
      aria-labelledby="hero-heading"
      className="relative isolate pt-[56px] sm:pt-[72px] md:pt-[96px]"
      initial="hidden"
      animate="visible"
      variants={{
        hidden: {},
        visible: { transition: { staggerChildren: quiet ? 0 : 0.1, delayChildren: quiet ? 0 : 0.05 } },
      }}
    >
      <style>{'@keyframes v7-fill{from{transform:scaleX(0)}to{transform:scaleX(1)}}' + CONSOLE_KEYFRAMES}</style>

      {/* Key light, top left, behind the headline (as on the live page). */}
      <div
        aria-hidden
        className="pointer-events-none absolute -top-[240px] left-[-10%] -z-10 h-[820px] w-[1100px] max-w-none bg-[radial-gradient(closest-side,rgba(255,255,255,0.075),transparent)]"
      />
      {/* Violet fill, low and wide behind the demo (as on the live page). The
          hero is the one place the page keeps the brand's purple shade. */}
      <div
        aria-hidden
        className="pointer-events-none absolute left-1/2 top-[420px] -z-10 h-[900px] w-[1500px] max-w-none -translate-x-1/2 bg-[radial-gradient(closest-side,rgba(139,92,246,0.16),rgba(139,92,246,0.04)_55%,transparent)]"
      />

      <div className={CONTAINER}>
        <motion.h1
          id="hero-heading"
          variants={heroItem}
          transition={{ duration: quiet ? 0 : 0.95, ease: EASE_OUT }}
          // One vertical falloff across the whole headline, white to a cool grey (live page).
          className={`bg-gradient-to-b from-white from-40% to-zinc-400 bg-clip-text pb-2 text-[38px] text-transparent [text-wrap:balance] sm:text-[60px] md:text-[76px] xl:text-[80px] ${DISPLAY}`}
        >
          The autonomous backend
          <span className="block">built for coding agents</span>
        </motion.h1>

        <motion.p
          variants={heroItem}
          transition={{ duration: quiet ? 0 : 0.95, ease: EASE_OUT }}
          className={`relative z-10 mt-7 max-w-[56ch] text-[17px] font-light text-zinc-400 [text-wrap:pretty] md:mt-8 md:text-[20px] ${LEDE}`}
        >
          Your coding agent builds the backend over MCP. Backenly maintains it on its own, fixing what it can verify and undo,
          and holding anything risky for you.
        </motion.p>

        <motion.div
          variants={heroItem}
          transition={{ duration: quiet ? 0 : 0.95, ease: EASE_OUT }}
          className="relative z-10 mt-9 flex flex-col gap-3 sm:flex-row sm:items-center"
        >
          <Link href={isLoggedIn ? ROUTES.app : ROUTES.signup} className={PRIMARY_CTA}>
            {isLoggedIn ? 'Go to console' : 'Start free'}
            <ArrowRight aria-hidden className="h-4 w-4 transition-transform duration-200 group-hover:translate-x-0.5" />
          </Link>
          <a href={ROUTES.github} target="_blank" rel="noopener noreferrer" className={SECONDARY_CTA}>
            <Icon icon="ri:github-fill" width={18} aria-hidden />
            Star on GitHub
          </a>
        </motion.div>

        <motion.div
          variants={heroFilm}
          transition={{ duration: quiet ? 0 : 1.2, ease: EASE_OUT }}
          className="relative mt-[56px] md:mt-[80px]"
        >
          <Showcase />
        </motion.div>
      </div>

      <AgentBand />
    </motion.section>
  )
}

function Showcase() {
  const quiet = useSettledReducedMotion()
  const [frame, setFrame] = useState(0)
  const [hover, setHover] = useState(false)
  const [manual, setManual] = useState(false)
  const [nonce, setNonce] = useState(0)
  const [screenRef, onScreen] = useOnScreen<HTMLDivElement>()
  const tabs = useRef<(HTMLButtonElement | null)[]>([])
  /** Time left on a paused beat, so a pause resumes where it stopped. */
  const left = useRef<{ frame: number; ms: number } | null>(null)

  // Reduced motion: no story, each chapter shown as its finished state.
  const shown = quiet ? CHAPTER_SPAN[FRAMES[frame].chapter].last : frame
  const chapter = FRAMES[shown].chapter
  const span = CHAPTER_SPAN[chapter]
  const view = FRAMES[shown].view
  // A chosen chapter plays once and holds on its last beat.
  const held = manual && frame === span.last
  const running = !quiet && !hover && onScreen && !held

  useEffect(() => {
    if (!running) return
    const hold = left.current?.frame === frame ? left.current.ms : FRAMES[frame].hold
    left.current = null
    const started = performance.now()
    const id = window.setTimeout(() => setFrame((f) => (f + 1) % FRAMES.length), hold)
    return () => {
      window.clearTimeout(id)
      const ms = hold - (performance.now() - started)
      if (ms > 30) left.current = { frame, ms }
    }
  }, [frame, running])

  const choose = (i: number, focus = false) => {
    setManual(true)
    setNonce((n) => n + 1)
    setFrame(quiet ? CHAPTER_SPAN[i].last : CHAPTER_SPAN[i].first)
    if (focus) tabs.current[i]?.focus()
  }

  const onKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    const n = CHAPTERS.length
    if (e.key === 'ArrowRight') choose((chapter + 1) % n, true)
    else if (e.key === 'ArrowLeft') choose((chapter - 1 + n) % n, true)
    else if (e.key === 'Home') choose(0, true)
    else if (e.key === 'End') choose(n - 1, true)
    else return
    e.preventDefault()
  }

  return (
    <div
      ref={screenRef}
      className="relative"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <div role="tabpanel" id="v7-stage-panel" aria-labelledby={`v7-stage-${CHAPTERS[chapter].id}`}>
        <p className="sr-only">{CHAPTER_ALT[chapter]}</p>
        <div aria-hidden className={`relative isolate aspect-[4/3.3] w-full sm:aspect-[16/10.4] md:aspect-[16/9.4] ${FEATHER_SIZE}`}>
          {/* The field's own light on the page, as the live HeroFilm casts it: a
              blurred copy past every edge, so the feathered field fades into
              violet rather than into black. The blur is baked into the image
              (F:/landing-v7/tools/soft-ambient.py): a live CSS blur(72px) was
              re-applied on every scroll frame. */}
          {/* eslint-disable-next-line @next/next/no-img-element -- decorative light */}
          <img
            src="/media/v7/field-ambient-soft.webp"
            alt=""
            decoding="async"
            draggable={false}
            className="pointer-events-none absolute -inset-x-[17.19%] -inset-y-[29.33%] -z-20 h-[158.66%] w-[134.38%] max-w-none scale-[1.04] select-none object-fill opacity-80"
          />
          {/* The launch film's violet field, feathered with the live film's own mask. */}
          {/* eslint-disable-next-line @next/next/no-img-element -- decorative backdrop */}
          <img
            src="/media/v7/field.webp"
            alt=""
            decoding="async"
            draggable={false}
            className="pointer-events-none absolute inset-0 -z-10 h-full w-full select-none object-cover"
            style={FEATHER}
          />

          {/* The console, live. */}
          <div className="absolute inset-x-[4%] top-[8%] sm:inset-x-[8%] sm:top-[7%]">
            <div
              className="overflow-hidden shadow-[0_50px_110px_-30px_rgba(0,0,0,0.95),0_0_0_1px_rgba(255,255,255,0.07)]"
              style={{ borderRadius: CONSOLE_RADIUS }}
            >
              <Fit w={W} h={H}>
                <ConsoleScreen view={view} quiet={quiet} />
              </Fit>
            </div>
          </div>

          {/* The agent's own session, in front while it builds. */}
          <div
            className="absolute left-0 top-[38%] w-[62%] sm:top-[33%] sm:w-[40%]"
            style={{
              opacity: view.term >= 0 ? 1 : 0,
              transform: view.term >= 0 || quiet ? 'none' : 'translateX(-28px)',
              transition: quiet ? 'none' : 'opacity 600ms cubic-bezier(0.16,1,0.3,1), transform 700ms cubic-bezier(0.16,1,0.3,1)',
            }}
          >
            <div
              className="overflow-hidden shadow-[0_60px_120px_-30px_rgba(0,0,0,0.98),0_0_0_1px_rgba(255,255,255,0.10)]"
              style={{ borderRadius: TERMINAL_RADIUS }}
            >
              <Fit w={TERM_W} h={TERM_H}>
                <AgentSession term={view.term} quiet={quiet} />
              </Fit>
            </div>
          </div>
        </div>
      </div>

      {/* The story's four chapters under the stage, on the page's left axis:
          each names itself and says what happens, and the lit one's hairline
          fills while it plays. */}
      <div
        role="tablist"
        aria-label="Backenly, chapter by chapter"
        className="relative z-10 mt-[28px] grid grid-cols-4 gap-x-[14px] md:mt-[20px] md:gap-x-[32px]"
      >
        {CHAPTERS.map((c, i) => {
          const on = i === chapter
          return (
            <button
              key={c.id}
              id={`v7-stage-${c.id}`}
              ref={(el) => {
                tabs.current[i] = el
              }}
              type="button"
              role="tab"
              aria-selected={on}
              aria-controls="v7-stage-panel"
              tabIndex={on ? 0 : -1}
              onClick={() => choose(i)}
              onKeyDown={onKey}
              className="group relative flex min-w-0 flex-col justify-start rounded-[4px] pt-[16px] text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-300 focus-visible:ring-offset-[6px] focus-visible:ring-offset-[#08090a]"
            >
              <span
                aria-hidden
                className={`absolute inset-x-0 top-0 h-px overflow-hidden transition-colors duration-200 ${
                  on ? 'bg-white/[0.16]' : 'bg-white/[0.08] group-hover:bg-white/[0.16]'
                }`}
              >
                {on && (
                  <span
                    key={`${chapter}-${nonce}`}
                    className="block h-full origin-left bg-white/80"
                    style={
                      quiet
                        ? { transform: 'scaleX(1)' }
                        : { animation: `v7-fill ${span.ms}ms linear forwards`, animationPlayState: running || held ? 'running' : 'paused' }
                    }
                  />
                )}
              </span>
              <span
                className={`block truncate text-[14px] font-medium tracking-[-0.01em] transition-colors duration-200 md:text-[15px] ${
                  on ? 'text-zinc-50' : 'text-zinc-400 group-hover:text-zinc-200'
                }`}
              >
                {c.label}
              </span>
              <span
                className={`mt-[6px] hidden text-[13.5px] leading-[1.55] tracking-[-0.004em] transition-colors duration-200 [text-wrap:pretty] lg:block ${
                  on ? 'text-zinc-300' : 'text-zinc-400 group-hover:text-zinc-300'
                }`}
              >
                {c.caption}
              </span>
            </button>
          )
        })}
      </div>

      {/* Below lg the four names fit but four paragraphs do not: the lit chapter's sentence sits under them. */}
      <p aria-live="polite" className="mt-[14px] min-h-[44px] text-[14px] leading-[1.55] tracking-[-0.006em] text-zinc-400 lg:hidden">
        {CHAPTERS[chapter].caption}
      </p>
    </div>
  )
}

/**
 * The hosts the MCP server runs in, as a quiet logo strip: one line of label,
 * the marks spread across the same width as the step rail above so the edges
 * line up, one muted tone that lights on hover. One row at every width: below
 * md the marks stand alone (names stay for screen readers), because seven
 * wrapping items always strand one. (Founders, 2026-10-14: the boxed band
 * with a two-line label and a divider read as unfinished.)
 */
function AgentBand() {
  return (
    <div className={`${CONTAINER} mt-[48px] md:mt-[72px]`}>
      <div className="flex flex-col items-center gap-[20px] border-t border-white/[0.07] pt-[28px] lg:flex-row lg:gap-[56px] lg:pt-[32px]">
        <p className="shrink-0 whitespace-nowrap text-[14px] tracking-[-0.006em] text-zinc-400">Works with any MCP host</p>
        <ul aria-label="MCP hosts" className="flex w-full flex-1 items-center justify-between gap-x-[14px] md:gap-x-[18px] lg:w-auto">
          {AGENT_MARKS.map((mark) => (
            <li key={mark.id} className="group flex items-center gap-[8px] text-zinc-400 transition-colors duration-200 hover:text-zinc-100">
              <AgentGlyph mark={mark} className="h-[18px] w-[18px] shrink-0 text-zinc-500 transition-colors duration-200 group-hover:text-zinc-100" />
              <span className="sr-only whitespace-nowrap text-[15px] font-medium tracking-[-0.015em] md:not-sr-only">{mark.name}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
