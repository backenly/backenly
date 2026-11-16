/**
 * How the import screens word their numbers and times, in the console's
 * formats (project-design decision 13): "1,240" with tabular figures, dates
 * as "Nov 12" ("Nov 12, 2025" in another year), durations as "48 s" or
 * "3 min 12 s", a running clock as "2:41".
 */

const NUM = new Intl.NumberFormat('en-US')

/** "1,240". */
export function num(value: number): string {
  return NUM.format(Math.round(value))
}

/** "1 table", "8 tables". */
export function count(value: number, one: string, many: string): string {
  return `${num(value)} ${value === 1 ? one : many}`
}

/** "940 KB", "86 MB", "2.1 GB": decimal units, as the sources report them. */
export function size(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`
  if (bytes >= 1e3) return `${Math.round(bytes / 1e3)} KB`
  return `${num(bytes)} bytes`
}

/** "48 s", "3 min 12 s", "1 h 4 min". */
export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s} s`
  if (s < 3600) {
    const m = Math.floor(s / 60)
    const rest = s % 60
    return rest ? `${m} min ${rest} s` : `${m} min`
  }
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return m ? `${h} h ${m} min` : `${h} h`
}

/** A running clock: "0:42", "3:12", "1:04:10". */
export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`
}

/** "Nov 12", or "Nov 12, 2025" in another year. */
export function shortDate(at: string | number | Date, now: number = Date.now()): string {
  const d = new Date(at)
  const sameYear = d.getFullYear() === new Date(now).getFullYear()
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) })
}

/** "2:14 PM", for "Showing progress from 2:14 PM". */
export function clockTime(at: number): string {
  return new Date(at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' })
}
