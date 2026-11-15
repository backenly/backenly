'use client'

import Image from 'next/image'
import Link from 'next/link'
import { ArrowRight, CalendarDays } from 'lucide-react'
import { ROUTES } from '@/components/site/SiteShell'
import { useUserSession } from '@/lib/hooks/useUserSession'
import { BTN_PRIMARY, BTN_SECONDARY, WRAP } from './tokens'

/* ─────────────────────────────────────────────────────────────
   The closing: v7's violet horizon (the live page's own ending), answering the
   hero's line. It is simply there: it used to rise and brighten as it came
   into view, and the founders asked for the light without that (2026-11-15:
   "just showing a gradient purple is enough").

   "A backend it can't break" was flagged as an overclaim on 2026-11-01; the
   line is now the hero's promise, which the console backs (kept with the
   hero's headline, 2026-11-15).

   Not a box (founders, 2026-11-15: "these sections dont need boxes"): as on
   the live page, the horizon runs the full width and owns the bottom of the
   page, so the footer meets the arc.

   Lit (founders, 2026-11-15: "update the footer and this section also", after
   the boxes took Blaxel's coloured light): the horizon is Backenly's painted
   dawn (public/media/v8/light/dome.webp, painted for this page: indigo-blue
   at the left, lilac at the crest, magenta at the right, streaked along the
   rim, quiet above it so the words keep their contrast), and its light runs on down behind the footer, which
   the landing's shell leaves clear (SiteShell footerLit) and clips at the
   page's end.
───────────────────────────────────────────────────────────── */

export function CtaV8() {
  const { isLoggedIn } = useUserSession()

  return (
    <section id="get-started" aria-labelledby="closing-heading" className="relative pb-[260px] pt-[112px] md:pb-[280px] md:pt-[176px]">
      {/* The band is anchored to the section's bottom edge, so the bottom padding sets the room under the buttons: the arc's apex sits
          ~90px under the stacked buttons on a phone and ~110px under the row from md up. */}
      {/* The dawn: its crest sits 170px above the section's bottom edge (the bottom padding sets the room under the buttons: ~90px on a
          phone, ~110px from md up), and the painting runs 1240px further down, behind the footer, where the shell clips it. */}
      <div aria-hidden className="pointer-events-none absolute inset-x-0 top-[calc(100%-430px)] h-[1500px]">
        <Image src="/media/v8/light/dome.webp" alt="" width={1320} height={900} unoptimized className="absolute left-1/2 top-0 h-[1500px] w-[2200px] max-w-none -translate-x-1/2" />
        <div className="absolute left-1/2 top-[260px] h-[1400px] w-[2200px] -translate-x-1/2 rounded-[50%] border-t border-violet-100/60" />
      </div>
      {/* The grain, beside the light rather than inside its layer (a layer of its own would isolate it, and the grain would only grey the black), faded in from the top. */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-[calc(100%-430px)] h-[1500px] bg-[url('/media/v8/light/grain.svg')] opacity-[0.28] mix-blend-soft-light [mask-image:linear-gradient(to_bottom,transparent,#000_220px)]"
      />

      <div className={`${WRAP} relative text-center`}>
        <h2 id="closing-heading" className="mx-auto max-w-[16ch] text-[38px] font-normal leading-[1.04] tracking-[-0.045em] text-white [text-wrap:balance] sm:text-[52px] md:text-[64px] md:leading-[1.0]">
          Give your agent a backend that fixes itself
        </h2>
        <p className="mx-auto mt-[24px] max-w-[52ch] text-[17px] leading-[1.6] text-zinc-400 md:text-[18px]">Free to start. Open source under Apache-2.0.</p>
        <div className="mx-auto mt-[36px] flex max-w-[400px] flex-col gap-[12px] sm:max-w-none sm:flex-row sm:items-center sm:justify-center">
          <Link href={isLoggedIn ? ROUTES.app : ROUTES.signup} className={BTN_PRIMARY}>
            {isLoggedIn ? 'Go to console' : 'Start free'}
            <ArrowRight aria-hidden className="h-[16px] w-[16px] transition-transform duration-150 [@media(hover:hover)_and_(pointer:fine)]:group-hover:translate-x-[3px]" />
          </Link>
          <a href={ROUTES.founder} target="_blank" rel="noopener noreferrer" className={BTN_SECONDARY}>
            <CalendarDays aria-hidden className="h-[16px] w-[16px]" strokeWidth={1.75} />
            Talk to the founders
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        </div>
      </div>
    </section>
  )
}
