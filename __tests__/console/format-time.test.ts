/**
 * HOW THE CONSOLE SAYS A MOMENT (components/console/format.ts)
 * ============================================================
 * Project decision 13 (2026-11-16) fixed the exact words, so that "12m ago",
 * "12 minutes ago" and "10/20/2026, 8:00:48 AM" stop appearing on neighbouring
 * pages. These are the strings every section now prints, pinned exactly:
 *
 *   relative   just now · 40 s ago · 12 min ago · 3 h ago · 2 d ago (≤ 6 days)
 *              · then Nov 14 · Nov 14, 2025 in another year
 *   day        Today · Yesterday · Sat, Nov 14
 *   clock      2:09 AM (seconds in runs, requests, logs: 2:18:41 AM)
 *   elsewhere  Nov 14, 6:02 AM
 *   schedules  in UTC
 *   durations  60 ms · 3.2 s
 *
 * Every moment is built from local calendar parts, so the suite reads the
 * same in any time zone the runner is in. Decision 8's undo sentence is
 * pinned here too: it is the same kind of fixed console copy.
 */
import { dayLabel, duration, formatDay, formatStamp, formatTime, fullTime, groupByDay } from '@/components/console/format'
import { undoSentence } from '@/components/console/undo'

// Monday, Nov 16, 2026, 9:30 AM local.
const NOW = new Date(2026, 10, 16, 9, 30, 0)
const at = (ms: number) => new Date(NOW.getTime() - ms)
const S = 1000
const MIN = 60 * S
const H = 60 * MIN
const D = 24 * H

describe('formatTime: relative ("ago")', () => {
  const ago = (ms: number) => formatTime(at(ms), 'ago', { now: NOW })

  it('says "just now" for the first ten seconds, and for a moment slightly ahead of this clock', () => {
    expect(ago(0)).toBe('just now')
    expect(ago(9 * S)).toBe('just now')
    expect(formatTime(new Date(NOW.getTime() + 3 * S), 'ago', { now: NOW })).toBe('just now')
  })

  it('counts seconds, minutes, hours and days in short units', () => {
    expect(ago(10 * S)).toBe('10 s ago')
    expect(ago(40 * S)).toBe('40 s ago')
    expect(ago(59 * S)).toBe('59 s ago')
    expect(ago(60 * S)).toBe('1 min ago')
    expect(ago(12 * MIN)).toBe('12 min ago')
    expect(ago(59 * MIN)).toBe('59 min ago')
    expect(ago(3 * H)).toBe('3 h ago')
    expect(ago(23 * H + 59 * MIN)).toBe('23 h ago')
    expect(ago(2 * D)).toBe('2 d ago')
  })

  it('stays relative up to 6 days, then gives the date', () => {
    expect(ago(6 * D + 23 * H)).toBe('6 d ago')
    expect(ago(7 * D)).toBe('Nov 9')
    expect(formatTime(new Date(2026, 9, 3, 8, 0), 'ago', { now: NOW })).toBe('Oct 3')
  })

  it('adds the year only when it is not this year', () => {
    expect(formatTime(new Date(2025, 10, 14, 6, 2), 'ago', { now: NOW })).toBe('Nov 14, 2025')
  })

  it('is the default mode', () => {
    expect(formatTime(at(12 * MIN), undefined, { now: NOW })).toBe('12 min ago')
  })
})

describe('formatTime: clock, date and dateTime', () => {
  it('writes a twelve-hour clock with no leading zero', () => {
    expect(formatTime(new Date(2026, 10, 16, 2, 9, 41), 'clock', { now: NOW })).toBe('2:09 AM')
    expect(formatTime(new Date(2026, 10, 16, 0, 0), 'clock', { now: NOW })).toBe('12:00 AM')
    expect(formatTime(new Date(2026, 10, 16, 12, 0), 'clock', { now: NOW })).toBe('12:00 PM')
    expect(formatTime(new Date(2026, 10, 16, 23, 59), 'clock', { now: NOW })).toBe('11:59 PM')
  })

  it('adds seconds for runs, requests and logs', () => {
    expect(formatTime(new Date(2026, 10, 16, 2, 18, 41), 'clockSeconds', { now: NOW })).toBe('2:18:41 AM')
    expect(formatTime(new Date(2026, 10, 16, 14, 5, 3), 'clockSeconds', { now: NOW })).toBe('2:05:03 PM')
  })

  it('writes a date without the year this year, with it otherwise', () => {
    expect(formatTime(new Date(2026, 10, 14, 6, 2), 'date', { now: NOW })).toBe('Nov 14')
    expect(formatTime(new Date(2025, 10, 14, 6, 2), 'date', { now: NOW })).toBe('Nov 14, 2025')
  })

  it('writes a date and a time everywhere else', () => {
    expect(formatTime(new Date(2026, 10, 14, 6, 2), 'dateTime', { now: NOW })).toBe('Nov 14, 6:02 AM')
    expect(formatTime(new Date(2025, 10, 14, 18, 2), 'dateTime', { now: NOW })).toBe('Nov 14, 2025, 6:02 PM')
  })

  it('reads schedules in UTC and says so', () => {
    const twoUtc = new Date(Date.UTC(2026, 10, 16, 2, 0))
    expect(formatTime(twoUtc, 'clock', { now: NOW, utc: true })).toBe('2:00 AM UTC')
    expect(formatTime(twoUtc, 'clockSeconds', { now: NOW, utc: true })).toBe('2:00:00 AM UTC')
    expect(formatTime(twoUtc, 'dateTime', { now: NOW, utc: true })).toBe('Nov 16, 2:00 AM UTC')
  })

  it('takes an ISO string, epoch milliseconds or a Date', () => {
    const d = new Date(2026, 10, 16, 2, 9)
    expect(formatTime(d.toISOString(), 'clock', { now: NOW })).toBe('2:09 AM')
    expect(formatTime(d.getTime(), 'clock', { now: NOW })).toBe('2:09 AM')
  })

  it('returns an empty string for a missing or invalid moment', () => {
    expect(formatTime(null, 'ago', { now: NOW })).toBe('')
    expect(formatTime(undefined, 'clock', { now: NOW })).toBe('')
    expect(formatTime('', 'date', { now: NOW })).toBe('')
    expect(formatTime('not a date', 'dateTime', { now: NOW })).toBe('')
  })
})

describe('day groups', () => {
  it('heads a day Today, Yesterday, then weekday and date', () => {
    expect(dayLabel(new Date(2026, 10, 16, 0, 1), { now: NOW })).toBe('Today')
    expect(dayLabel(new Date(2026, 10, 15, 23, 59), { now: NOW })).toBe('Yesterday')
    expect(dayLabel(new Date(2026, 10, 14, 2, 9), { now: NOW })).toBe('Sat, Nov 14')
    expect(dayLabel(new Date(2026, 10, 2, 12, 0), { now: NOW })).toBe('Mon, Nov 2')
    expect(dayLabel(new Date(2025, 10, 14, 12, 0), { now: NOW })).toBe('Fri, Nov 14, 2025')
    expect(formatTime(new Date(2026, 10, 15, 8, 0), 'day', { now: NOW })).toBe('Yesterday')
  })

  it('counts calendar days, not 24-hour spans', () => {
    // 9 h 40 min earlier, but across midnight.
    expect(dayLabel(new Date(2026, 10, 15, 23, 50), { now: new Date(2026, 10, 16, 0, 10) })).toBe('Yesterday')
  })

  it('groups consecutive items under the day they happened, newest first', () => {
    const items = [
      { id: 'a', at: new Date(2026, 10, 16, 9, 0) },
      { id: 'b', at: new Date(2026, 10, 16, 1, 0) },
      { id: 'c', at: new Date(2026, 10, 15, 22, 0) },
      { id: 'd', at: new Date(2026, 10, 14, 2, 9) },
      { id: 'e', at: null },
    ]
    const groups = groupByDay(items, (x) => x.at, { now: NOW })
    expect(groups.map((g) => [g.label, g.items.map((x) => x.id).join('')])).toEqual([
      ['Today', 'ab'],
      ['Yesterday', 'c'],
      ['Sat, Nov 14', 'd'],
      ['Unknown day', 'e'],
    ])
  })
})

describe('duration', () => {
  it('reads milliseconds, then seconds with one decimal while it says something', () => {
    expect(duration(0.4)).toBe('<1 ms')
    expect(duration(60)).toBe('60 ms')
    expect(duration(999.4)).toBe('999 ms')
    expect(duration(999.6)).toBe('1 s')
    expect(duration(1000)).toBe('1 s')
    expect(duration(3200)).toBe('3.2 s')
    expect(duration(9940)).toBe('9.9 s')
    expect(duration(42_000)).toBe('42 s')
  })

  it('reads minutes and hours as two units', () => {
    expect(duration(60_000)).toBe('1 min')
    expect(duration(125_000)).toBe('2 min 5 s')
    expect(duration(3_600_000)).toBe('1 h')
    expect(duration(3_840_000)).toBe('1 h 4 min')
  })

  it('returns an empty string for a missing or negative value', () => {
    expect(duration(null)).toBe('')
    expect(duration(undefined)).toBe('')
    expect(duration(-5)).toBe('')
    expect(duration(Number.NaN)).toBe('')
  })
})

describe('the exact moment, for hover and screen readers', () => {
  it('names the weekday, the full date, the seconds and the zone', () => {
    expect(fullTime(new Date(2026, 10, 14, 2, 9, 41))).toMatch(/^Sat, Nov 14, 2026, 2:09:41 AM \S/)
    expect(fullTime(new Date(Date.UTC(2026, 10, 16, 2, 0)), { utc: true })).toBe('Mon, Nov 16, 2026, 2:00:00 AM UTC')
    expect(fullTime(null)).toBe('')
  })

  it('keeps the older helpers in the same words', () => {
    expect(formatStamp(new Date(new Date().getFullYear(), 9, 20, 8, 0))).toBe('Oct 20, 8:00 AM')
    expect(formatDay(new Date(2026, 9, 20, 8, 0))).toBe('Oct 20, 2026')
  })
})

describe('whether History can bring it back (decision 8)', () => {
  it('says each case in its fixed words', () => {
    expect(undoSentence(true)).toBe('You can undo this in History.')
    expect(undoSentence({ detail: 'code and all' })).toBe('You can undo this in History, code and all.')
    expect(undoSentence({ days: 7, detail: 'rows included' })).toBe('You can undo it from History for 7 days, rows included.')
    expect(undoSentence({ days: 1 })).toBe('You can undo it from History for 1 day.')
    expect(undoSentence(false)).toBe("You can't undo this.")
  })
})
