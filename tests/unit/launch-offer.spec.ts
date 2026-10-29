/**
 * The Product Hunt launch and its offer run on Product Hunt's clock.
 *
 *   - The launch goes live at 12:01 AM Pacific on October 31, 2026, and launch
 *     day ends at midnight Pacific. The offer runs a week longer, to the end of
 *     November 7, after daylight time has ended. The labels the page prints
 *     are those same moments, so a typo in a UTC constant cannot pass.
 *   - The countdown rounds up, so it reads 00m only once the moment has come.
 *   - The offer is half of monthly Pro, $12.50 for three months. Yearly billing
 *     has no offer.
 *   - The code is one Stripe accepts as a promotion code.
 */
import {
  LAUNCH_OFFER,
  PRODUCT_HUNT_LAUNCH,
  launchOfferActive,
  launchPhase,
  launchPrice,
  spokenTimeLeft,
  timeLeft,
  usd,
} from '@/lib/pricing/launch-offer'

const MINUTE = 60_000

/** A moment as Product Hunt's clock shows it, e.g. "Oct 31, 12:01 AM". */
function pacific(ms: number): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(ms)
}

describe('the launch runs on Product Hunt time', () => {
  it('goes live at 12:01 AM Pacific on October 31', () => {
    expect(new Date(PRODUCT_HUNT_LAUNCH.startsAt).toISOString()).toBe('2026-10-31T07:01:00.000Z')
    expect(pacific(PRODUCT_HUNT_LAUNCH.startsAt)).toBe('Oct 31, 12:01 AM')
    expect(
      new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', month: 'long', day: 'numeric' }).format(
        PRODUCT_HUNT_LAUNCH.startsAt,
      ),
    ).toBe(PRODUCT_HUNT_LAUNCH.dateLabel)
  })

  it('ends launch day at midnight Pacific', () => {
    expect(pacific(PRODUCT_HUNT_LAUNCH.endsAt)).toBe('Nov 1, 12:00 AM')
  })

  it('ends the offer a week later, at midnight Pacific after November 7', () => {
    // Standard time by then (UTC-8), so an hour later in UTC than launch day's end.
    expect(new Date(LAUNCH_OFFER.endsAt).toISOString()).toBe('2026-11-08T08:00:00.000Z')
    expect(pacific(LAUNCH_OFFER.endsAt)).toBe('Nov 8, 12:00 AM')
    // The labels are the last minute the code works, and its day.
    expect(`${pacific(LAUNCH_OFFER.endsAt - MINUTE)} PT`).toBe(LAUNCH_OFFER.endsLabel)
    expect(LAUNCH_OFFER.endsLabel.startsWith(`${LAUNCH_OFFER.lastDayLabel},`)).toBe(true)
  })

  it('moves from upcoming to live to over at exactly those moments', () => {
    expect(launchPhase(Date.UTC(2026, 9, 24))).toBe('upcoming')
    expect(launchPhase(PRODUCT_HUNT_LAUNCH.startsAt - 1)).toBe('upcoming')
    expect(launchPhase(PRODUCT_HUNT_LAUNCH.startsAt)).toBe('live')
    expect(launchPhase(PRODUCT_HUNT_LAUNCH.endsAt - 1)).toBe('live')
    expect(launchPhase(PRODUCT_HUNT_LAUNCH.endsAt)).toBe('over')
  })

  it('keeps the offer through launch day and the week after, and not a moment longer', () => {
    expect(launchOfferActive(Date.UTC(2026, 9, 24))).toBe(true)
    expect(launchOfferActive(PRODUCT_HUNT_LAUNCH.startsAt)).toBe(true)
    expect(launchOfferActive(PRODUCT_HUNT_LAUNCH.endsAt)).toBe(true)
    expect(launchOfferActive(LAUNCH_OFFER.endsAt - 1)).toBe(true)
    expect(launchOfferActive(LAUNCH_OFFER.endsAt)).toBe(false)
  })
})

describe('the countdown', () => {
  it('splits what is left into days, hours and minutes, rounding up', () => {
    // 6 days, 16 hours, 22 minutes and 40 seconds before the launch.
    const now = PRODUCT_HUNT_LAUNCH.startsAt - ((6 * 24 + 16) * 60 + 22) * MINUTE - 40_000
    expect(timeLeft(PRODUCT_HUNT_LAUNCH.startsAt, now)).toEqual({ days: 6, hours: 16, minutes: 23 })
  })

  it('reads one minute until the very moment, then zero, and never goes negative', () => {
    const at = PRODUCT_HUNT_LAUNCH.startsAt
    expect(timeLeft(at, at - 1)).toEqual({ days: 0, hours: 0, minutes: 1 })
    expect(timeLeft(at, at)).toEqual({ days: 0, hours: 0, minutes: 0 })
    expect(timeLeft(at, at + 5 * MINUTE)).toEqual({ days: 0, hours: 0, minutes: 0 })
  })

  it('carries a whole day into the days', () => {
    expect(timeLeft(PRODUCT_HUNT_LAUNCH.startsAt, PRODUCT_HUNT_LAUNCH.startsAt - 24 * 60 * MINUTE)).toEqual({
      days: 1,
      hours: 0,
      minutes: 0,
    })
  })

  it('says it in words for a screen reader', () => {
    expect(spokenTimeLeft({ days: 6, hours: 16, minutes: 23 })).toBe('6 days, 16 hours and 23 minutes')
    expect(spokenTimeLeft({ days: 1, hours: 0, minutes: 1 })).toBe('1 day and 1 minute')
    expect(spokenTimeLeft({ days: 0, hours: 17, minutes: 0 })).toBe('17 hours')
    expect(spokenTimeLeft({ days: 0, hours: 0, minutes: 0 })).toBe('less than a minute')
  })
})

describe('the offer', () => {
  it('halves monthly Pro, $25 to $12.50', () => {
    expect(LAUNCH_OFFER.percentOff).toBe(50)
    expect(usd(launchPrice(2500))).toBe('$12.50')
  })

  it('prints whole dollars bare and anything else to the cent', () => {
    expect(usd(2500)).toBe('$25')
    expect(usd(24000)).toBe('$240')
    expect(usd(1250)).toBe('$12.50')
    expect(usd(1205)).toBe('$12.05')
  })

  it('uses a code Stripe accepts, lasting three months', () => {
    // Stripe: letters, digits and dashes; matched without regard to case.
    expect(LAUNCH_OFFER.code).toMatch(/^[A-Za-z0-9-]+$/)
    expect(LAUNCH_OFFER.code).toBe(LAUNCH_OFFER.code.toUpperCase())
    expect(LAUNCH_OFFER.months).toBe(3)
  })
})
