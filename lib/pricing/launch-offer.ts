/**
 * The Product Hunt launch, and the Pro offer that runs until launch day ends.
 *
 * TEMPORARY, like the launch bar it feeds (components/site/LaunchBar.tsx): it
 * comes out after the launch, together with the offer on /pricing.
 *
 * Times are Product Hunt's. A Product Hunt day runs from 12:01 AM to 11:59 PM
 * Pacific, and October 31, 2026 is still daylight time (UTC-7): daylight time
 * ends on November 1. So the launch goes live at 07:01 UTC on October 31 and
 * launch day ends at 07:00 UTC on November 1.
 *
 * Plain values and pure functions, no React: the pages read the clock through
 * lib/hooks/useMinuteClock.ts, and the tests pass their own.
 */

export const PRODUCT_HUNT_LAUNCH = {
  /** 12:01 AM PDT on October 31, 2026, when the launch goes live. */
  startsAt: Date.UTC(2026, 9, 31, 7, 1),
  /** Midnight PDT, when launch day is over. */
  endsAt: Date.UTC(2026, 10, 1, 7, 0),
  /** The date as the bar prints it. */
  dateLabel: 'Oct 31',
} as const

/**
 * The launch offer: 50% off Pro for the first three months, with a code, until
 * launch day ends.
 *
 * The code only works because Stripe knows it. The Cloud overlay's
 * scripts/create-launch-promo-code.ts creates the coupon and the promotion code
 * with this same code, percentage, duration and expiry, and Checkout takes
 * promotion codes. Change one side and you must change the other.
 *
 * Three months on a monthly plan; on a yearly plan Stripe takes 50% off the
 * whole first year, because that year's one invoice falls inside the three
 * months (docs.stripe.com/billing/subscriptions/coupons, "Coupon duration").
 * The page says both, each on its own billing period.
 */
export const LAUNCH_OFFER = {
  code: 'PRODUCTHUNT50',
  percentOff: 50,
  months: 3,
  endsAt: PRODUCT_HUNT_LAUNCH.endsAt,
  /** The deadline in Product Hunt's own time, for the page. */
  endsLabel: 'Oct 31, 11:59 PM PT',
} as const

export type LaunchPhase = 'upcoming' | 'live' | 'over'

/** Before the launch, on launch day, or after it. */
export function launchPhase(now: number): LaunchPhase {
  if (now < PRODUCT_HUNT_LAUNCH.startsAt) return 'upcoming'
  if (now < PRODUCT_HUNT_LAUNCH.endsAt) return 'live'
  return 'over'
}

export function launchOfferActive(now: number): boolean {
  return now < LAUNCH_OFFER.endsAt
}

export interface TimeLeft {
  days: number
  hours: number
  minutes: number
}

/**
 * What is left until `until`, in whole minutes rounded UP, so the countdown
 * reads 00m only once the moment has come and never for the minute before it.
 */
export function timeLeft(until: number, now: number): TimeLeft {
  const minutes = Math.max(0, Math.ceil((until - now) / 60_000))
  return {
    days: Math.floor(minutes / 1440),
    hours: Math.floor((minutes % 1440) / 60),
    minutes: minutes % 60,
  }
}

/** "6 days, 4 hours and 1 minute", for a screen reader. */
export function spokenTimeLeft({ days, hours, minutes }: TimeLeft): string {
  const parts = (
    [
      [days, 'day'],
      [hours, 'hour'],
      [minutes, 'minute'],
    ] as const
  )
    .filter(([n]) => n !== 0)
    .map(([n, unit]) => `${n} ${unit}${n === 1 ? '' : 's'}`)
  if (parts.length === 0) return 'less than a minute'
  return parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
}

/** A price with the offer taken off, in cents, rounded to the cent. */
export function launchPrice(cents: number): number {
  return Math.round((cents * (100 - LAUNCH_OFFER.percentOff)) / 100)
}

/** "$25", "$12.50": whole dollars without cents, anything else with both digits. */
export function usd(cents: number): string {
  return cents % 100 === 0 ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`
}
