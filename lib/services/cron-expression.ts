/**
 * CRON EXPRESSIONS — one grammar for storing, validating and matching.
 *
 * Three jobs, deliberately in one dependency-free module so the parser that
 * ACCEPTS a schedule and the matcher that FIRES it can never disagree:
 *
 *   - scheduleToCron(text)        natural language or five-field cron → cron,
 *                                 or null when the text is not understood.
 *                                 Null is a refusal, never a default: this used
 *                                 to fall through to "daily at 09:00 UTC", so
 *                                 "every night at 02:00" — the console's own
 *                                 example prompt — silently became 09:00.
 *   - isValidCronExpression(expr) the five fields parse and sit in bounds.
 *   - matchesCronExpression(expr, date)  UTC match supporting *, steps,
 *                                 ranges, stepped ranges and comma lists.
 *                                 parseInt('1-5') is 1, so the old matcher ran
 *                                 "0 9 * * 1-5" on Mondays only.
 *
 * All times are UTC — the five fields are matched against the UTC clock, and
 * every message shown to a user or agent should say so.
 */

interface FieldBounds {
  min: number
  max: number
}

// minute, hour, day-of-month, month, day-of-week
const FIELD_BOUNDS: FieldBounds[] = [
  { min: 0, max: 59 },
  { min: 0, max: 23 },
  { min: 1, max: 31 },
  { min: 1, max: 12 },
  { min: 0, max: 7 }, // 0 and 7 are both Sunday, as in vixie cron
]

/** One field token: `*`, `n`, `a-b`, any of those with `/step`, or a comma list. */
function parsePart(part: string, bounds: FieldBounds): Array<{ lo: number; hi: number; step: number }> | null {
  const out: Array<{ lo: number; hi: number; step: number }> = []
  for (const rawItem of part.split(',')) {
    const item = rawItem.trim()
    if (!item) return null
    let range = item
    let step = 1
    if (item.includes('/')) {
      const bits = item.split('/')
      if (bits.length !== 2) return null
      range = bits[0]
      step = Number(bits[1])
      if (!Number.isInteger(step) || step <= 0) return null
    }
    let lo: number
    let hi: number
    if (range === '*') {
      lo = bounds.min
      hi = bounds.max
    } else if (/^\d+$/.test(range)) {
      lo = Number(range)
      // `n/step` means "from n to the field's end", per vixie cron
      hi = step > 1 ? bounds.max : lo
    } else {
      const m = range.match(/^(\d+)-(\d+)$/)
      if (!m) return null
      lo = Number(m[1])
      hi = Number(m[2])
    }
    if (lo < bounds.min || hi > bounds.max || lo > hi) return null
    out.push({ lo, hi, step })
  }
  return out.length > 0 ? out : null
}

function partMatches(ranges: Array<{ lo: number; hi: number; step: number }>, value: number): boolean {
  return ranges.some((r) => value >= r.lo && value <= r.hi && (value - r.lo) % r.step === 0)
}

export function isValidCronExpression(expr: string): boolean {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) return false
  return parts.every((part, i) => parsePart(part, FIELD_BOUNDS[i]) !== null)
}

export function matchesCronExpression(expr: string, now: Date): boolean {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) return false

  const values = [now.getUTCMinutes(), now.getUTCHours(), now.getUTCDate(), now.getUTCMonth() + 1, now.getUTCDay()]

  for (let i = 0; i < 5; i++) {
    const ranges = parsePart(parts[i], FIELD_BOUNDS[i])
    if (!ranges) return false
    // Sunday is 0 on the clock but may be written 7 in the expression.
    const matched =
      i === 4 && values[i] === 0
        ? partMatches(ranges, 0) || partMatches(ranges, 7)
        : partMatches(ranges, values[i])
    if (!matched) return false
  }
  return true
}

/** "at 14:30", "at 2:30pm", "at 9am", "at 21" → { hour, minute }, else null. */
function parseAtTime(s: string): { hour: number; minute: number } | null {
  const m = s.match(/\bat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/)
  if (!m) return null
  let hour = Number(m[1])
  const minute = m[2] ? Number(m[2]) : 0
  if (m[3] === 'pm' && hour < 12) hour += 12
  if (m[3] === 'am' && hour === 12) hour = 0
  if (hour > 23 || minute > 59) return null
  return { hour, minute }
}

const DAY_NAMES: Record<string, number> = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
}

/**
 * Natural language or raw five-field cron → cron expression, or null when the
 * text is not understood. Callers must treat null as a refusal and ask for a
 * five-field expression — never substitute a default schedule.
 */
export function scheduleToCron(schedule: string): string | null {
  const s = schedule.toLowerCase().trim()

  // Already a five-field cron expression — validated, not pattern-sniffed.
  if (/^[\d*/,-]+(\s+[\d*/,-]+){4}$/.test(s)) {
    return isValidCronExpression(s) ? s : null
  }

  const at = parseAtTime(s)

  if (/\bevery minute\b/.test(s) || s === 'minutely') return '* * * * *'
  const everyNMin = s.match(/\bevery\s+(\d+)\s*min(ute)?s?\b/)
  if (everyNMin) {
    const n = Number(everyNMin[1])
    return n >= 1 && n <= 59 ? `*/${n} * * * *` : null
  }
  const everyNHours = s.match(/\bevery\s+(\d+)\s*hours?\b/)
  if (everyNHours) {
    const n = Number(everyNHours[1])
    return n >= 1 && n <= 23 ? `0 */${n} * * *` : null
  }
  if (/\bevery hour\b/.test(s) || s === 'hourly') return '0 * * * *'

  // Before the generic week branch: "every weekday" contains "every week".
  if (/\bevery weekday\b/.test(s) || /\bweekdays\b/.test(s)) {
    const t = at ?? { hour: 9, minute: 0 }
    return `${t.minute} ${t.hour} * * 1-5`
  }

  if (/\bevery (day|night|morning|evening)\b/.test(s) || s === 'daily' || /\bdaily\b/.test(s) || /\bnightly\b/.test(s)) {
    // "night"/"evening" without a time mean the day's start, not business hours.
    const t = at ?? (/night|evening/.test(s) ? { hour: 0, minute: 0 } : { hour: 9, minute: 0 })
    return `${t.minute} ${t.hour} * * *`
  }

  if (/\bevery week\b/.test(s) || s === 'weekly' || /\bweekly\b/.test(s)) {
    const dayMatch = Object.keys(DAY_NAMES).find((d) => s.includes(d))
    const dow = dayMatch ? DAY_NAMES[dayMatch] : 1
    const t = at ?? { hour: 9, minute: 0 }
    return `${t.minute} ${t.hour} * * ${dow}`
  }
  // "every monday at 8am" without the word "week"
  const bareDay = Object.keys(DAY_NAMES).find((d) => new RegExp(`\\bevery\\s+${d}s?\\b`).test(s))
  if (bareDay) {
    const t = at ?? { hour: 9, minute: 0 }
    return `${t.minute} ${t.hour} * * ${DAY_NAMES[bareDay]}`
  }

  if (/\bevery month\b/.test(s) || s === 'monthly' || /\bmonthly\b/.test(s)) {
    const dom = s.match(/\bon the (\d{1,2})(st|nd|rd|th)?\b/)
    const day = dom ? Number(dom[1]) : 1
    if (day < 1 || day > 31) return null
    const t = at ?? { hour: 9, minute: 0 }
    return `${t.minute} ${t.hour} ${day} * *`
  }

  if (/\bmidnight\b/.test(s)) return '0 0 * * *'
  if (/\bnoon\b/.test(s)) return '0 12 * * *'

  // A bare time of day: "at 02:00", "2am"
  if (at) return `${at.minute} ${at.hour} * * *`

  return null
}

// ── Words ────────────────────────────────────────────────────────────────────

const WEEKDAY_WORDS = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays']

function ordinal(n: number): string {
  const tens = n % 100
  if (tens >= 11 && tens <= 13) return `${n}th`
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`
}

const hhmm = (h: number, m: number) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`

/**
 * A five-field schedule in words, for a person reading a list: "Daily at
 * 02:00 UTC", "Every 5 minutes", "Weekdays at 09:30 UTC", "Mondays at 08:00
 * UTC", "Monthly on the 1st at 09:00 UTC". Null for a shape it does not say
 * plainly (the caller then shows the expression itself), never a guess: the
 * words have to mean exactly what matchesCronExpression fires on.
 */
export function cronInWords(expr: string | null | undefined): string | null {
  if (!expr || !isValidCronExpression(expr)) return null
  const [min, hour, dom, month, dow] = expr.trim().split(/\s+/)
  const num = (s: string) => (/^\d+$/.test(s) ? Number(s) : null)
  const step = (s: string) => {
    const m = s.match(/^\*\/(\d+)$/)
    return m ? Number(m[1]) : null
  }
  if (month !== '*') return null

  const everyDay = dom === '*' && dow === '*'
  // Sub-daily repetition.
  if (everyDay && hour === '*') {
    if (min === '*') return 'Every minute'
    const everyMin = step(min)
    if (everyMin) return everyMin === 1 ? 'Every minute' : `Every ${everyMin} minutes`
    const at = num(min)
    if (at !== null) return at === 0 ? 'Every hour' : `Every hour at :${String(at).padStart(2, '0')}`
    return null
  }
  const everyHours = step(hour)
  if (everyDay && everyHours && num(min) !== null) {
    const m = num(min)!
    return `Every ${everyHours === 1 ? 'hour' : `${everyHours} hours`}${m ? ` at :${String(m).padStart(2, '0')}` : ''}`
  }

  // Once (or a few times) a day at fixed times.
  const m = num(min)
  const hours = hour.split(',').map(num)
  if (m === null || hours.some((h) => h === null)) return null
  const times = hours.map((h) => hhmm(h!, m))
  const at = `at ${times.length > 1 ? `${times.slice(0, -1).join(', ')} and ${times[times.length - 1]}` : times[0]} UTC`

  if (everyDay) return `Daily ${at}`
  if (dom === '*') {
    if (dow === '1-5') return `Weekdays ${at}`
    if (dow === '0,6' || dow === '6,0' || dow === '6,7') return `Weekends ${at}`
    const days = dow.split(',').map(num)
    if (days.some((d) => d === null)) return null
    const words = days.map((d) => WEEKDAY_WORDS[d! % 7])
    return `${words.length > 1 ? `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}` : words[0]} ${at}`
  }
  const day = num(dom)
  if (day !== null && dow === '*') return `Monthly on the ${ordinal(day)} ${at}`
  return null
}
