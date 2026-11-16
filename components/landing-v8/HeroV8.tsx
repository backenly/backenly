'use client'

import { useState } from 'react'
import Image from 'next/image'
import Link from 'next/link'
import { AnimatePresence, motion } from 'motion/react'
import { ArrowRight, ArrowUpRight, Pause, Play } from 'lucide-react'
import { AGENT_MARKS, AgentGlyph } from '@/components/landing/AgentMarks'
import { ROUTES } from '@/components/site/SiteShell'
import { useSettledReducedMotion } from '@/lib/hooks/useSettledReducedMotion'
import { useUserSession } from '@/lib/hooks/useUserSession'
import { CommandBlock } from './CommandBlock'
import { DawnField } from './DawnField'
import { BTN_PRIMARY, EASE_OUT, WRAP } from './tokens'

/* ─────────────────────────────────────────────────────────────
   Hero v8, round 3 (2026-11-14). The founders: the hero is the one part of
   the page that is 100% wide and tall; make it "like" Blaxel's (a big centred
   line, an announcement above it, one sentence, the main action beside the
   one command to run, a cinematic light), professional and in our purple, and
   no invented widgets.

     announcement  a real one: #4 Product of the Day on Product Hunt
     headline      what it is and what it does that others don't: it keeps
                   getting better on its own (safe fixes, a better schema as
                   the app grows, one history to undo). The founders chose
                   "evolves" (2026-11-15) over "fixes itself" after seeing
                   rendered options; Backenly's restructuring engine is
                   literally structural evolution. The sentence under it
                   says what it does alone and what waits for a person
     sentence      how: the agent builds it over MCP; Backenly checks it every
                   minute, ships safe fixes, holds risky ones
     action        Start free, beside the real one-command setup any agent
                   connects with (./CommandBlock), naming no agent
     light         ./DawnField: a violet dawn of fibres, written for Backenly
     hosts         the MCP hosts, on the floor of the light

   The entrance is CSS, so the headline paints with the first frame (the v7
   LCP lesson), top to bottom: nothing settles before the line above it, and
   all of it has settled by about 0.9s. The announcement fades with the
   headline's first line; the host row only fades.

   Polish pass (founders, 2026-11-15: "make it more polished aligned more
   professional", the Product Hunt pill "looks not professional"), decided
   from three designers' audits:
     - Product Hunt is a slim citation: Product Hunt's own mark, unaltered
       (their branding rules forbid recolouring it), the one fact, and an
       external arrow; no invented medal tile, divider or glass.
     - The headline caps at 92px so it clears the header's edges, with
       tighter tracking on phones relaxed.
     - "every minute" never splits; the category line has its own line at
       every width.
     - No glow under Start free; no blur on the controls over the light.
     - The host row is a footnote: quieter names, centred on a 3-column
       grid with the pause control in the last column.
───────────────────────────────────────────────────────────── */

const PRODUCT_HUNT =
  'https://www.producthunt.com/products/backenly-2?embed=true&utm_source=badge-top-post-badge&utm_medium=badge&utm_campaign=badge-backenly-2'

const ENTRANCE = `
@keyframes v8Rise{from{opacity:0;transform:translateY(var(--rise,12px));filter:blur(var(--blur,0px))}to{opacity:1;transform:none;filter:none}}
@keyframes v8Fade{from{opacity:0}to{opacity:1}}
@keyframes v8Line{from{transform:translateY(108%)}to{transform:none}}
.v8-rise{animation:v8Rise var(--dur,600ms) cubic-bezier(.16,1,.3,1) var(--d,0ms) both}
.v8-fade{animation:v8Fade var(--dur,500ms) ease-out var(--d,0ms) both}
.v8-ink{background-image:linear-gradient(180deg,#fff 28%,rgba(255,255,255,0.74) 100%);-webkit-background-clip:text;background-clip:text;color:transparent;-webkit-box-decoration-break:clone;box-decoration-break:clone}
.v8-h1{animation:v8Rise 650ms cubic-bezier(.16,1,.3,1) 0ms both;--rise:14px;--blur:0px}
@media (min-width:768px){
  .v8-h1{animation:none}
  .v8-line{display:block;overflow:hidden;padding-bottom:.1em;margin-bottom:-.1em}
  .v8-line>span{display:block;animation:v8Line 800ms cubic-bezier(.16,1,.3,1) var(--d,0ms) both}
}
@media (prefers-reduced-motion: reduce){.v8-rise,.v8-h1{animation:v8Fade 300ms ease-out both;transform:none;filter:none}.v8-fade{animation:v8Fade 300ms ease-out both}.v8-line>span{animation:v8Fade 300ms ease-out both}}
`

const MARK_SCALE: Record<string, number> = { cursor: 0.95, codex: 1.12, cline: 0.88, copilot: 1.06, zed: 0.92 }

export function HeroV8() {
  const { isLoggedIn } = useUserSession()
  const quiet = useSettledReducedMotion()
  const [paused, setPaused] = useState(false)

  return (
    <section aria-labelledby="hero-heading" className="relative isolate -mt-[69px] flex min-h-[max(600px,100svh)] flex-col overflow-hidden">
      <style>{ENTRANCE}</style>
      <DawnField className="-z-10" paused={paused} />
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(125%_90%_at_50%_45%,transparent_55%,rgba(8,9,10,0.6)_100%)]" />
      {/* The floor of the light, behind every word and button: on a short screen
          it reaches up past the buttons, and over them it would grey them out. */}
      <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 -z-10 h-[190px] bg-gradient-to-b from-transparent via-[#08090a]/70 to-[#08090a]" />

      {/* The top padding grows with the window's height (36svh - 150px), so the group's optical centre sits at about 45% of the
          space between the bar and the host row at every laptop and desktop height; phones keep their own. */}
      <div className={`${WRAP} flex flex-1 flex-col items-center pt-[clamp(92px,15svh,150px)] text-center md:pt-[clamp(84px,calc(36svh-150px),230px)] [@media(max-height:700px)]:pt-[clamp(80px,13svh,150px)]`}>
        <a
          href={PRODUCT_HUNT}
          target="_blank"
          rel="noopener noreferrer"
          className="v8-fade [--d:0ms] group inline-flex h-[32px] max-w-full items-center gap-[8px] rounded-[8px] border border-white/[0.10] bg-white/[0.03] pl-[7px] pr-[12px] text-[13.5px] tracking-[-0.006em] transition-[border-color,background-color,transform] duration-150 ease-out active:scale-[0.985] active:duration-75 [@media(hover:hover)_and_(pointer:fine)]:hover:border-white/[0.20] [@media(hover:hover)_and_(pointer:fine)]:hover:bg-white/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:ring-offset-2 focus-visible:ring-offset-[#08090a]"
        >
          {/* Product Hunt's own mark, as their kit ships it (scaled only): their rules forbid recolouring it. */}
          <Image src="/media/v8/ph-mark.png" alt="" width={18} height={18} unoptimized priority className="h-[18px] w-[18px] shrink-0" />
          <span className="truncate">
            <span className="font-medium text-zinc-100">#4 Product of the Day</span>
            <span className="text-zinc-400 max-[359px]:hidden"> on Product Hunt</span>
          </span>
          <ArrowUpRight
            aria-hidden
            className="h-[13px] w-[13px] shrink-0 text-zinc-500 transition-[color,transform] duration-150 ease-out [@media(hover:hover)_and_(pointer:fine)]:group-hover:-translate-y-[2px] [@media(hover:hover)_and_(pointer:fine)]:group-hover:translate-x-[2px] [@media(hover:hover)_and_(pointer:fine)]:group-hover:text-zinc-200"
          />
          <span className="sr-only"> (opens in a new tab)</span>
        </a>

        <h1
          id="hero-heading"
          className="v8-h1 mt-[clamp(20px,3.4svh,32px)] max-w-[1240px] text-[length:clamp(44px,min(7vw,11.5svh),92px)] font-[460] leading-[1.0] tracking-[-0.032em] text-white [text-wrap:balance] md:tracking-[-0.044em]"
        >
          <span className="v8-line">
            <span className="v8-ink [--d:0ms]">Backend infrastructure that</span>
          </span>{' '}
          <span className="v8-line">
            <span className="v8-ink [--d:80ms]">evolves while you sleep.</span>
          </span>
        </h1>

        <p className="v8-rise [--d:200ms] [--rise:10px] mt-[clamp(16px,2.8svh,26px)] max-w-[660px] text-[17px] leading-[1.5] text-zinc-300 [text-wrap:pretty] md:text-[length:clamp(16px,2.6svh,20px)] md:leading-[1.55]">
          <span className="block text-white">The autonomous backend for coding agents.</span>
          Your agent builds it over MCP. Backenly checks it every&nbsp;minute,
          <br className="hidden md:inline" /> ships the safe fixes and holds anything risky for&nbsp;you.
        </p>

        <div className="v8-rise [--d:260ms] [--dur:560ms] [--rise:8px] mt-[clamp(24px,3.6svh,32px)] flex w-full max-w-[860px] flex-col items-stretch gap-[12px] md:flex-row md:items-center md:justify-center">
          <Link
            href={isLoggedIn ? ROUTES.app : ROUTES.signup}
            className={`${BTN_PRIMARY} shrink-0 shadow-[inset_0_-1px_0_rgba(0,0,0,0.12)] md:px-[24px]`}
          >
            {isLoggedIn ? 'Go to console' : 'Start free'}
            <ArrowRight aria-hidden className="h-[16px] w-[16px] transition-transform duration-150 [@media(hover:hover)_and_(pointer:fine)]:group-hover:translate-x-[3px]" />
          </Link>
          <CommandBlock className="w-full md:w-auto" />
        </div>

        {/* The floor of the light: the MCP hosts, and the one control that holds the motion. */}
        <div className="v8-fade [--d:420ms] relative mt-auto w-full pb-[clamp(16px,3svh,28px)] pt-[clamp(28px,6svh,64px)] [@media(max-height:700px)]:pt-[clamp(24px,4.5svh,64px)]">
          <p className="text-[13px] tracking-[-0.003em] text-zinc-300">Works with any agent that supports MCP</p>
          <div className="mt-[16px] grid grid-cols-[28px_minmax(0,1fr)_28px] items-center gap-[12px]">
            <span aria-hidden />
            <ul aria-label="Agents that support MCP" className="flex items-center justify-center gap-x-[24px] text-zinc-400 sm:gap-x-[32px] lg:gap-x-[44px] xl:gap-x-[48px]">
              {AGENT_MARKS.map((mark) => (
                <li key={mark.id} className="flex items-center gap-[8px]">
                  <span aria-hidden className="block h-[16px] w-[16px] shrink-0" style={{ transform: `scale(${MARK_SCALE[mark.id] ?? 1})` }}>
                    <AgentGlyph mark={mark} className="h-full w-full" />
                  </span>
                  <span className="sr-only whitespace-nowrap text-[14px] font-medium tracking-[-0.01em] md:not-sr-only">{mark.name}</span>
                </li>
              ))}
            </ul>
            {!quiet ? (
              <button
                type="button"
                onClick={() => setPaused((p) => !p)}
                aria-label={paused ? 'Play the background motion' : 'Pause the background motion'}
                aria-pressed={paused}
                title={paused ? 'Play the light' : 'Pause the light'}
                className="relative flex h-[28px] w-[28px] items-center justify-center rounded-full border border-white/[0.10] bg-[#0b0b0e]/70 text-zinc-400 transition-[border-color,color,transform] duration-150 [@media(hover:hover)_and_(pointer:fine)]:hover:border-white/[0.24] [@media(hover:hover)_and_(pointer:fine)]:hover:text-white active:scale-[0.94] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:ring-offset-2 focus-visible:ring-offset-[#08090a]"
              >
                <AnimatePresence initial={false} mode="popLayout">
                  <motion.span
                    key={paused ? 'play' : 'pause'}
                    initial={{ opacity: 0, scale: 0.25, filter: 'blur(4px)' }}
                    animate={{ opacity: 1, scale: 1, filter: 'blur(0px)' }}
                    exit={{ opacity: 0, scale: 0.25, filter: 'blur(4px)' }}
                    transition={{ duration: 0.3, ease: EASE_OUT }}
                    className="flex"
                  >
                    {paused ? <Play aria-hidden className="h-[10px] w-[10px] translate-x-[1px]" fill="currentColor" /> : <Pause aria-hidden className="h-[10px] w-[10px]" fill="currentColor" />}
                  </motion.span>
                </AnimatePresence>
              </button>
            ) : (
              <span aria-hidden />
            )}
          </div>
        </div>
      </div>
    </section>
  )
}
