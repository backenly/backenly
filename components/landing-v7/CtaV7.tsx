'use client'

import Link from 'next/link'
import { ArrowRight, Calendar } from 'lucide-react'
import { ROUTES } from '@/components/site/SiteShell'
import { LEDE } from '@/components/site/tokens'
import { useUserSession } from '@/lib/hooks/useUserSession'
import { CONTAINER, DISPLAY, PRIMARY_CTA, SECONDARY_CTA } from './shared'

/* ─────────────────────────────────────────────────────────────
   Closing (founders, 2026-10-14, with a screenshot of the live page's end as
   the reference). The live ClosingSection (origin/main app/page.tsx),
   verbatim: centred, and the page's last light, a horizon arc rising behind
   the ask and answering the violet field the hero opens on. It owns the
   bottom of the page, so the footer meets the arc.

   Not the billboard removed in round 7 (backed up at
   F:/landing-v7/alt-closing/); this is the live page's own ending. One word
   differs: "Talk to the founders", because Backenly has two.
───────────────────────────────────────────────────────────── */

export function CtaV7() {
  const { isLoggedIn } = useUserSession()

  return (
    <section
      id="get-started"
      aria-labelledby="closing-heading"
      className="relative overflow-hidden pb-[220px] pt-[112px] font-light md:pb-[280px] md:pt-[176px]"
    >
      {/* The arc's apex sits ~110px under the buttons at every width: the
          container is anchored to the section's bottom edge, and the bottom
          padding above is what keeps the copy clear of it. */}
      <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-[420px] overflow-hidden">
        <div className="absolute left-1/2 top-[140px] h-[1400px] w-[2400px] -translate-x-1/2 rounded-[50%] bg-[radial-gradient(closest-side,rgba(139,92,246,0.26),rgba(139,92,246,0.06)_55%,transparent)]" />
        <div className="absolute left-1/2 top-[250px] h-[1400px] w-[1800px] -translate-x-1/2 rounded-[50%] border-t border-violet-200/50 bg-[#08090a] shadow-[0_-40px_140px_-30px_rgba(167,139,250,0.55),inset_0_1px_40px_-10px_rgba(196,181,253,0.25)] md:w-[2200px]" />
      </div>

      <div className={`${CONTAINER} relative text-center`}>
        <h2 id="closing-heading" className={`mx-auto max-w-[18ch] text-[36px] text-white [text-wrap:balance] md:text-[64px] ${DISPLAY}`}>
          Give your agent a backend it can’t break
        </h2>
        <p className={`mx-auto mt-6 max-w-[52ch] text-[17px] text-zinc-400 [text-wrap:pretty] md:text-[18px] ${LEDE}`}>
          Connect Claude Code or Cursor in one command, ship real infrastructure today, and let autonomy keep it
          healthy tonight.
        </p>
        <div className="mx-auto mt-10 flex max-w-[400px] flex-col gap-3 sm:max-w-none sm:flex-row sm:items-center sm:justify-center">
          <Link href={isLoggedIn ? ROUTES.app : ROUTES.signup} className={PRIMARY_CTA}>
            {isLoggedIn ? 'Go to console' : 'Start free'}
            <ArrowRight aria-hidden className="h-4 w-4 transition-transform duration-200 group-hover:translate-x-0.5" />
          </Link>
          <a href={ROUTES.founder} target="_blank" rel="noopener noreferrer" className={SECONDARY_CTA}>
            <Calendar aria-hidden className="h-4 w-4" />
            Talk to the founders
          </a>
        </div>
      </div>
    </section>
  )
}
