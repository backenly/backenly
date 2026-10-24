'use client'

import Link from 'next/link'
import { ArrowRight, ArrowUpRight } from 'lucide-react'
import { useMinuteClock } from '@/lib/hooks/useMinuteClock'
import {
  LAUNCH_OFFER,
  PRODUCT_HUNT_LAUNCH,
  launchOfferActive,
  launchPhase,
  spokenTimeLeft,
  timeLeft,
} from '@/lib/pricing/launch-offer'

/**
 * The launch announcement: a band above the navbar on every marketing page.
 *
 * TEMPORARY, comes out after the Product Hunt launch. Flip SHOW_LAUNCH_BAR in
 * SiteShell to pull it in one edit. To remove it for good, delete this file,
 * its call site in SiteShell, `ROUTES.productHunt`, lib/pricing/launch-offer.ts
 * with the offer on /pricing, and the `.launch-sweep` rules in app/globals.css.
 *
 * History: this was a chip in the landing hero. The founder moved it here on
 * 2026-09-30, which supersedes the earlier rejection of a bar above the navbar
 * (#138). On 2026-10-24 the founder set the date (October 31), asked for a
 * countdown to it and added the launch offer, which supersedes "no hard date".
 * The other founder decisions from the chip still hold:
 * - No Product Hunt brand mark.
 * - Violet is the only colour. Never Product Hunt orange.
 * - The sweep is a CSS keyframe (see app/globals.css), off under reduced motion.
 * - The launch is an external link, not a second signup CTA. The offer links
 *   to /pricing, where the code is, not to signup.
 *
 * It follows the launch on its own: a countdown to 12:01 AM Pacific on October
 * 31, then "live" for launch day, then a plain link once launch day is over,
 * when the offer leaves with it. Times come from lib/pricing/launch-offer.ts.
 *
 * Two links: the launch (Product Hunt, external) and, from md up, the offer
 * (/pricing). On a phone only the launch shows, and it fills the band, so the
 * tap target is the full width rather than a few words. It is not sticky: it
 * scrolls away and the navbar sticks at the top on its own, so every sticky
 * offset on the site (68px, the navbar's height) stays correct.
 */
export function LaunchBar({ href }: { href: string }) {
  const now = useMinuteClock()
  // Before hydration there is no visitor clock (see useMinuteClock). The bar
  // renders as it will be before the launch, with the countdown's room held
  // and its digits hidden, so nothing moves when the real time arrives.
  const phase = now === null ? 'upcoming' : launchPhase(now)
  const offer = now === null || launchOfferActive(now)

  return (
    <aside
      aria-label="Product Hunt launch"
      className="relative isolate flex h-[40px] w-full items-stretch justify-center overflow-hidden bg-[#0b0b0f] text-[13px] tracking-[-0.006em]"
    >
      {/* A violet glow rising from the lit edge, brighter on hover. */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(36%_150%_at_50%_100%,rgba(139,92,246,0.24),transparent_70%)] opacity-80"
      />
      {/* The landing's lit hairline, with the launch sweep travelling along it. */}
      <span aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-px overflow-hidden">
        <span className="absolute inset-0 bg-[linear-gradient(to_right,transparent,rgba(196,181,253,0.5)_28%,rgba(221,214,254,0.75)_50%,rgba(196,181,253,0.5)_72%,transparent)]" />
        <span className="launch-sweep absolute inset-y-0 w-1/3 bg-gradient-to-r from-transparent via-violet-100 to-transparent" />
      </span>

      <div className="flex min-w-0 max-w-full flex-1 items-stretch justify-center md:flex-none">
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="group flex min-w-0 flex-1 items-center justify-center gap-2.5 px-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-violet-300 md:flex-none"
        >
          <LaunchTag phase={phase} />
          <span className="min-w-0 truncate text-zinc-300 transition-colors duration-200 group-hover:text-white">
            {phase === 'upcoming' && (
              <>
                <span className="sm:hidden">Product Hunt launch</span>
                <span className="hidden sm:inline">Launching on Product Hunt</span>
              </>
            )}
            {phase === 'live' && (
              <>
                <span className="sm:hidden">Live on Product Hunt</span>
                <span className="hidden sm:inline">Backenly is live on Product Hunt</span>
              </>
            )}
            {phase === 'over' && 'Backenly is on Product Hunt'}
          </span>
          {phase === 'upcoming' && <Countdown until={PRODUCT_HUNT_LAUNCH.startsAt} now={now} label="until launch" />}
          <ArrowUpRight
            aria-hidden
            className="h-3.5 w-3.5 shrink-0 text-violet-200 transition-transform duration-200 group-hover:-translate-y-px group-hover:translate-x-px"
          />
          <span className="sr-only"> (opens in a new tab)</span>
        </a>

        {offer && (
          <>
            <span aria-hidden className="hidden h-3.5 w-px shrink-0 self-center bg-white/[0.16] md:block" />
            <Link
              href="/pricing#launch-offer"
              className="group hidden shrink-0 items-center gap-2.5 px-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-violet-300 md:flex"
            >
              <span className="text-zinc-300 transition-colors duration-200 group-hover:text-white">
                {LAUNCH_OFFER.percentOff}% off Pro with
              </span>
              <code className="rounded-[5px] border border-violet-300/25 bg-violet-400/[0.10] px-1.5 py-[4px] font-mono text-[11.5px] font-medium leading-none tracking-[0.02em] text-violet-100">
                {LAUNCH_OFFER.code}
              </code>
              {/* On launch day the deadline is hours away, so it is counted
                  down here; before that it is a date, on /pricing. */}
              {phase === 'live' && (
                <span className="hidden items-center gap-2.5 lg:inline-flex">
                  <span className="text-zinc-500">ends in</span>
                  <Countdown until={LAUNCH_OFFER.endsAt} now={now} label="left on the offer" />
                </span>
              )}
              <ArrowRight
                aria-hidden
                className="h-3.5 w-3.5 shrink-0 text-violet-200 transition-transform duration-200 group-hover:translate-x-0.5"
              />
            </Link>
          </>
        )}
      </div>
    </aside>
  )
}

/** The date before the launch, a live marker on launch day, nothing after. */
function LaunchTag({ phase }: { phase: 'upcoming' | 'live' | 'over' }) {
  if (phase === 'over') return null
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 rounded-[5px] border border-white/[0.14] bg-white/[0.04] px-1.5 py-[4px] text-[10.5px] font-semibold uppercase leading-none tracking-[0.08em] text-white">
      {phase === 'live' ? (
        <>
          <span aria-hidden className="relative flex h-1.5 w-1.5">
            <span className="absolute inline-flex h-full w-full rounded-full bg-violet-300 opacity-70 motion-safe:animate-ping" />
            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-violet-300" />
          </span>
          Live
        </>
      ) : (
        PRODUCT_HUNT_LAUNCH.dateLabel
      )}
    </span>
  )
}

/**
 * Days, hours and minutes to `until`, the units dimmed and the digits fixed
 * width so the band never shifts as they change. Days drop out on the last day.
 *
 * Until the visitor's clock is known the digits are held invisible at their
 * full width, then fade in. A screen reader gets the same figure as words.
 */
function Countdown({ until, now, label }: { until: number; now: number | null; label: string }) {
  const left = timeLeft(until, now ?? until)
  const units = [
    { value: left.days, unit: 'd' },
    { value: left.hours, unit: 'h' },
    { value: left.minutes, unit: 'm' },
  ].filter((u, i) => i > 0 || u.value > 0 || now === null)

  return (
    <span className="inline-flex shrink-0 items-center rounded-[6px] border border-white/[0.10] bg-white/[0.04] px-2 py-[3px] text-[12.5px] font-medium leading-none tabular-nums">
      {now !== null && <span className="sr-only">{`${spokenTimeLeft(left)} ${label}`}</span>}
      <span
        aria-hidden
        className={`inline-flex gap-[5px] transition-opacity duration-300 ${now === null ? 'opacity-0' : 'opacity-100'}`}
      >
        {units.map(({ value, unit }) => (
          <span key={unit}>
            <span className="text-white">{String(value).padStart(2, '0')}</span>
            <span className="text-zinc-500">{unit}</span>
          </span>
        ))}
      </span>
    </span>
  )
}
