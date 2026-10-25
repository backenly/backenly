'use client'

import Link from 'next/link'
import { ArrowUpRight } from 'lucide-react'
import { useMinuteClock } from '@/lib/hooks/useMinuteClock'
import {
  LAUNCH_OFFER,
  PRODUCT_HUNT_LAUNCH,
  launchOfferActive,
  launchPhase,
  spokenTimeLeft,
  timeLeft,
  type TimeLeft,
} from '@/lib/pricing/launch-offer'

/**
 * The launch announcement: a band above the navbar on every marketing page.
 *
 * TEMPORARY, comes out after the Product Hunt launch. Flip SHOW_LAUNCH_BAR in
 * SiteShell to pull it in one edit. To remove it for good, delete this file,
 * its call site in SiteShell, `ROUTES.productHunt`, and
 * lib/pricing/launch-offer.ts with the offer on /pricing.
 *
 * History: this was a chip in the landing hero. The founder moved it here on
 * 2026-09-30 (superseding the rejection of a bar above the navbar in #138). On
 * 2026-10-24 the founder set the date, asked for a countdown and the launch
 * offer, then rejected the first build as "AI slop": a date chip, a boxed
 * countdown, a monospace code chip, a violet glow and a sweeping hairline.
 *
 * So it is built the way devtool sites build theirs (read 2026-10-24: the bars
 * on Supabase, Bun, Langfuse, Render, Upstash and Prisma, and the open-source
 * banners of Supabase, Origin UI, Docusaurus and Fumadocs): one sentence on a
 * flat surface one step off the page, a hairline under it, and the accent used
 * once, on the one underlined call to action. The date and the countdown are
 * words and figures in the sentence, the figures in tabular numerals so they
 * never jiggle. No chips, no glow, no motion. Violet is still the only colour,
 * and still never Product Hunt orange or its logo.
 *
 * It follows the launch on its own, on Product Hunt's clock: a countdown to
 * 12:01 AM Pacific on October 31, then "live" for launch day, then a plain
 * link once launch day is over, when the offer leaves with it.
 *
 * The sentence links to the launch (Product Hunt, external, so it carries the
 * up-right arrow); from md up the offer links to /pricing#launch-offer. On a
 * phone only the sentence shows, and it fills the band, so the tap target is
 * the full width. It is not sticky: it scrolls away and the navbar sticks at
 * the top on its own, so every sticky offset on the site (68px, the navbar's
 * height) stays correct.
 */
export function LaunchBar({ href }: { href: string }) {
  const now = useMinuteClock()
  // Before hydration there is no visitor clock (see useMinuteClock). The bar
  // renders as it will be before the launch, with the countdown's figures held
  // invisible at their width, so nothing moves when the real time arrives.
  const phase = now === null ? 'upcoming' : launchPhase(now)
  const offer = now === null || launchOfferActive(now)

  return (
    <aside
      aria-label="Product Hunt launch"
      className="flex h-[40px] w-full items-stretch justify-center gap-[20px] border-b border-white/[0.08] bg-white/[0.04] px-4 text-[13.5px] leading-none tracking-[-0.006em]"
    >
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="group flex min-w-0 items-center gap-[6px] text-zinc-200 transition-colors duration-200 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-violet-300"
      >
        <span className="min-w-0 truncate">
          {phase === 'upcoming' && (
            <>
              <span className="sm:hidden">
                Launching on <span translate="no">Product&nbsp;Hunt</span>
              </span>
              <span className="hidden sm:inline">
                Backenly launches on <span translate="no">Product&nbsp;Hunt</span> {PRODUCT_HUNT_LAUNCH.dateLabel}
              </span>
              <span className="text-zinc-400">
                <span className="hidden sm:inline">,</span> in <Countdown until={PRODUCT_HUNT_LAUNCH.startsAt} now={now} />
              </span>
            </>
          )}
          {phase === 'live' && (
            <>
              Backenly is live on <span translate="no">Product&nbsp;Hunt</span> today
            </>
          )}
          {phase === 'over' && (
            <>
              Backenly is on <span translate="no">Product&nbsp;Hunt</span>
            </>
          )}
        </span>
        <ArrowUpRight aria-hidden className="h-[14px] w-[14px] shrink-0 opacity-60 transition-opacity duration-200 group-hover:opacity-100" />
        <span className="sr-only"> (opens in a new tab)</span>
      </a>

      {offer && (
        <Link
          href="/pricing#launch-offer"
          className="hidden shrink-0 items-center font-medium text-violet-200 underline decoration-violet-200/40 underline-offset-[5px] transition-[text-decoration-color] duration-200 hover:decoration-violet-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-violet-300 md:flex"
        >
          {/* On launch day the offer ends at midnight Pacific: "today only". */}
          {phase === 'live' ? `Get ${LAUNCH_OFFER.percentOff}% off Pro, today only` : `Get ${LAUNCH_OFFER.percentOff}% off Pro`}
        </Link>
      )}
    </aside>
  )
}

/**
 * Days, hours and minutes to `until` as figures in the sentence ("6d 16h
 * 23m"), in tabular numerals so the width never changes as they tick. Days
 * drop out on the last day. Until the visitor's clock is known the figures are
 * held invisible at their full width; a screen reader gets the same as words.
 */
function Countdown({ until, now }: { until: number; now: number | null }) {
  const left = timeLeft(until, now ?? until)
  return (
    <span className="tabular-nums">
      {now !== null && <span className="sr-only">{spokenTimeLeft(left)}</span>}
      <span aria-hidden className={now === null ? 'invisible' : undefined}>
        {compact(left, now === null)}
      </span>
    </span>
  )
}

function compact({ days, hours, minutes }: TimeLeft, placeholder: boolean): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  const hm = `${pad(hours)}h ${pad(minutes)}m`
  return days > 0 || placeholder ? `${days}d ${hm}` : hm
}
