/**
 * SCHEDULES MEAN WHAT THEY SAY
 * ============================
 * Two silent lies in cron handling:
 *
 *   - the matcher read each field with parseInt, so the range in
 *     "0 9 * * 1-5" parsed as 1 and a weekday job ran on Mondays only;
 *   - the schedule parser defaulted every phrase it did not recognise to
 *     daily 09:00 UTC — including "Every night at 02:00", the console's own
 *     example prompt — and reported the job as "on the configured schedule".
 *
 * The grammar now lives in lib/services/cron-expression.ts, shared by the
 * parser that accepts a schedule and the runner that fires it; an
 * unrecognised phrase is a refusal (null), never a default.
 *
 * The matcher is imported through cron-runner (the runner's import site), so
 * swapping cron-runner.ts back to origin/main runs these same assertions
 * against the old matcher.
 */

import { matchesCronExpression, isValidCronExpression } from '@/lib/services/cron-runner'
import { scheduleToCron } from '@/lib/services/cron-expression'

// Known UTC instants (2026-10-14 is a Wednesday).
const at = (iso: string) => new Date(iso)

describe('matchesCronExpression: ranges, steps and lists are real cron', () => {
  it('a weekday range fires on every weekday, not only Monday', () => {
    expect(matchesCronExpression('0 9 * * 1-5', at('2026-10-12T09:00:00Z'))).toBe(true) // Mon
    expect(matchesCronExpression('0 9 * * 1-5', at('2026-10-14T09:00:00Z'))).toBe(true) // Wed
    expect(matchesCronExpression('0 9 * * 1-5', at('2026-10-16T09:00:00Z'))).toBe(true) // Fri
    expect(matchesCronExpression('0 9 * * 1-5', at('2026-10-17T09:00:00Z'))).toBe(false) // Sat
    expect(matchesCronExpression('0 9 * * 1-5', at('2026-10-18T09:00:00Z'))).toBe(false) // Sun
  })

  it('Sunday answers to both of its names, 0 and 7', () => {
    const sunday = at('2026-10-18T09:00:00Z')
    expect(matchesCronExpression('0 9 * * 0', sunday)).toBe(true)
    expect(matchesCronExpression('0 9 * * 7', sunday)).toBe(true)
    expect(matchesCronExpression('0 9 * * 5-7', sunday)).toBe(true)
  })

  it('minute steps fire on the step, minute ranges inside their bounds', () => {
    expect(matchesCronExpression('*/15 * * * *', at('2026-10-14T09:30:00Z'))).toBe(true)
    expect(matchesCronExpression('*/15 * * * *', at('2026-10-14T09:20:00Z'))).toBe(false)
    expect(matchesCronExpression('10-20 * * * *', at('2026-10-14T09:12:00Z'))).toBe(true)
    expect(matchesCronExpression('10-20 * * * *', at('2026-10-14T09:21:00Z'))).toBe(false)
    expect(matchesCronExpression('0-58/2 * * * *', at('2026-10-14T09:12:00Z'))).toBe(true)
    expect(matchesCronExpression('0-58/2 * * * *', at('2026-10-14T09:13:00Z'))).toBe(false)
  })

  it('a day-of-month step starts at day 1, as cron defines it', () => {
    // */5 over 1-31 is 1, 6, 11, ... — not multiples of 5.
    expect(matchesCronExpression('0 0 */5 * *', at('2026-10-06T00:00:00Z'))).toBe(true)
    expect(matchesCronExpression('0 0 */5 * *', at('2026-10-05T00:00:00Z'))).toBe(false)
  })

  it('a list may mix plain values and ranges', () => {
    const wed = at('2026-10-14T09:00:00Z')
    const sat = at('2026-10-17T09:00:00Z')
    const sun = at('2026-10-18T09:00:00Z')
    expect(matchesCronExpression('0 9 * * 0,3-5', wed)).toBe(true)
    expect(matchesCronExpression('0 9 * * 0,3-5', sun)).toBe(true)
    expect(matchesCronExpression('0 9 * * 0,3-5', sat)).toBe(false)
  })

  it('an out-of-bounds or malformed expression never matches', () => {
    const now = at('2026-10-14T09:00:00Z')
    expect(matchesCronExpression('0 25 * * *', now)).toBe(false)
    expect(matchesCronExpression('61 * * * *', now)).toBe(false)
    expect(matchesCronExpression('0 9 * * mon', now)).toBe(false)
    expect(matchesCronExpression('0 9 * *', now)).toBe(false)
  })
})

describe('isValidCronExpression: creation refuses what the runner cannot fire', () => {
  it.each(['0 2 * * *', '*/10 * * * *', '0 9 * * 1-5', '30 21 1,15 * *', '0 0 */5 * *'])('accepts %s', (expr) => {
    expect(isValidCronExpression(expr)).toBe(true)
  })

  it.each(['0 25 * * *', '61 * * * *', '* * * * 1-8', 'x * * * *', '0 9 * *', '0 9 * * 5-1'])('rejects %s', (expr) => {
    expect(isValidCronExpression(expr)).toBe(false)
  })
})

describe('scheduleToCron: parse what is understood, refuse the rest', () => {
  it("understands the console's own example, every night at a given time", () => {
    expect(scheduleToCron('Every night at 02:00')).toBe('0 2 * * *')
  })

  it.each([
    ['every 10 minutes', '*/10 * * * *'],
    ['every 2 hours', '0 */2 * * *'],
    ['every weekday at 8am', '0 8 * * 1-5'],
    ['every day at 21:30', '30 21 * * *'],
    ['every day at 12am', '0 0 * * *'],
    ['daily', '0 9 * * *'],
    ['every monday at 9am', '0 9 * * 1'],
    ['weekly on friday at 5pm', '0 17 * * 5'],
    ['monthly on the 15th at 00:30', '30 0 15 * *'],
    ['midnight', '0 0 * * *'],
    ['hourly', '0 * * * *'],
  ])('%s → %s', (phrase, expr) => {
    expect(scheduleToCron(phrase)).toBe(expr)
  })

  it('passes a five-field expression through unchanged — ranges included', () => {
    expect(scheduleToCron('0 9 * * 1-5')).toBe('0 9 * * 1-5')
  })

  it('refuses an out-of-bounds expression instead of storing it', () => {
    expect(scheduleToCron('0 25 * * *')).toBeNull()
  })

  it('refuses what it does not understand — null, never a default 09:00', () => {
    expect(scheduleToCron('whenever things look quiet')).toBeNull()
    expect(scheduleToCron('')).toBeNull()
    expect(scheduleToCron('fortnightly')).toBeNull()
  })

  it('everything scheduleToCron returns is an expression the runner can fire', () => {
    for (const phrase of ['Every night at 02:00', 'every 10 minutes', 'every weekday at 8am', 'monthly on the 15th', 'noon']) {
      const expr = scheduleToCron(phrase)
      expect(expr).not.toBeNull()
      expect(isValidCronExpression(expr!)).toBe(true)
    }
  })
})
