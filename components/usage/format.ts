/**
 * How the Usage and Billing pages write numbers, money and times.
 *
 * Counts are written out in full ("1,240", never "1.2k"): these pages are
 * where an owner checks a number, so it is the number. Sizes use the same
 * 1024-based units as the plan quotas. Money is US dollars. The billing cycle
 * is a calendar month in UTC, so cycle dates are read in UTC; a subscription's
 * dates are instants Stripe reports and are read in the viewer's own time.
 *
 * Plain functions, no React, shared by public and Cloud code alike.
 */

const KIB = 1024
const MIB = KIB * 1024
const GIB = MIB * 1024
const TIB = GIB * 1024

/** "1,240". */
export function fmtCount(n: number): string {
  return Math.round(n).toLocaleString('en-US')
}

function oneDecimal(v: number): string {
  return v >= 100 ? Math.round(v).toLocaleString('en-US') : v.toFixed(1).replace(/\.0$/, '')
}

/** "6.1 GB", "512 MB", "40 KB", "0 MB". */
export function fmtBytes(bytes: number): string {
  if (bytes >= TIB) return `${oneDecimal(bytes / TIB)} TB`
  if (bytes >= GIB) return `${oneDecimal(bytes / GIB)} GB`
  if (bytes >= MIB) return `${Math.round(bytes / MIB)} MB`
  if (bytes > 0) return `${Math.max(1, Math.round(bytes / KIB))} KB`
  return '0 MB'
}

/** A size given in MB, as the plan quotas state it: "512 MB", "8 GB". */
export function fmtMegabytes(mb: number): string {
  return fmtBytes(mb * MIB)
}

export type CurrencyCode = 'USD' | 'EUR' | 'GBP' | 'INR' | 'CAD' | 'AUD' | 'JPY'

export interface CurrencyConfig {
  code: CurrencyCode
  symbol: string
  rate: number // units per 1 USD
  locale: string
}

export const CURRENCIES: Record<CurrencyCode, CurrencyConfig> = {
  USD: { code: 'USD', symbol: '$', rate: 1.0, locale: 'en-US' },
  EUR: { code: 'EUR', symbol: '€', rate: 0.92, locale: 'de-DE' },
  GBP: { code: 'GBP', symbol: '£', rate: 0.79, locale: 'en-GB' },
  INR: { code: 'INR', symbol: '₹', rate: 86.5, locale: 'en-IN' },
  CAD: { code: 'CAD', symbol: 'CA$', rate: 1.38, locale: 'en-CA' },
  AUD: { code: 'AUD', symbol: 'A$', rate: 1.54, locale: 'en-AU' },
  JPY: { code: 'JPY', symbol: '¥', rate: 155.0, locale: 'ja-JP' },
}

export function detectUserCurrency(): CurrencyCode {
  if (typeof window === 'undefined') return 'USD'
  try {
    const saved = localStorage.getItem('backenly_currency') as CurrencyCode
    if (saved && CURRENCIES[saved]) return saved
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || ''
    if (timeZone.includes('Calcutta') || timeZone.includes('Kolkata') || timeZone.includes('India')) return 'INR'
    if (timeZone.includes('London')) return 'GBP'
    if (timeZone.includes('Europe') || timeZone.includes('Paris') || timeZone.includes('Berlin')) return 'EUR'
    if (timeZone.includes('Tokyo')) return 'JPY'
    if (timeZone.includes('Toronto') || timeZone.includes('Vancouver')) return 'CAD'
    if (timeZone.includes('Sydney') || timeZone.includes('Melbourne')) return 'AUD'
  } catch {
    // fallback
  }
  return 'USD'
}

let activeCurrency: CurrencyCode = 'USD'
if (typeof window !== 'undefined') {
  activeCurrency = detectUserCurrency()
}

export function setPreferredCurrency(code: CurrencyCode) {
  activeCurrency = code
  if (typeof window !== 'undefined') {
    try { localStorage.setItem('backenly_currency', code) } catch {}
  }
}

export function getPreferredCurrency(): CurrencyCode {
  return activeCurrency
}

/** "$12.40": an amount of money, to the cent, with optional regional converted amount. */
export function fmtCents(cents: number, overrideCurrency?: CurrencyCode): string {
  const currencyCode = overrideCurrency ?? activeCurrency
  const usdDollars = cents / 100
  const usdFormatted = `$${usdDollars.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  if (currencyCode === 'USD') return usdFormatted
  const cfg = CURRENCIES[currencyCode]
  if (!cfg) return usdFormatted
  const converted = usdDollars * cfg.rate
  const localFormatted = `${cfg.symbol}${converted.toLocaleString(cfg.locale, { minimumFractionDigits: cfg.code === 'JPY' ? 0 : 2, maximumFractionDigits: cfg.code === 'JPY' ? 0 : 2 })}`
  return `${usdFormatted} (~${localFormatted})`
}

/** "$50": a limit or a payment, which are whole dollars; cents only when there are any. */
export function fmtDollars(cents: number, overrideCurrency?: CurrencyCode): string {
  const currencyCode = overrideCurrency ?? activeCurrency
  const usdDollars = cents / 100
  const usdFormatted = `$${usdDollars.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`
  if (currencyCode === 'USD') return usdFormatted
  const cfg = CURRENCIES[currencyCode]
  if (!cfg) return usdFormatted
  const converted = usdDollars * cfg.rate
  const localFormatted = `${cfg.symbol}${converted.toLocaleString(cfg.locale, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`
  return `${usdFormatted} (~${localFormatted})`
}

function toDate(value: string | number | Date): Date {
  return value instanceof Date ? value : new Date(value)
}

/**
 * "Dec 1", or "Jan 4, 2027" outside the current year. `utc` reads the date in
 * UTC, which is how the billing cycle's dates are defined.
 */
export function fmtDay(value: string | number | Date, opts: { utc?: boolean; now?: number } = {}): string {
  const d = toDate(value)
  const timeZone = opts.utc ? 'UTC' : undefined
  const yearOf = (x: Date) => Number(x.toLocaleDateString('en-US', { year: 'numeric', timeZone }))
  const sameYear = yearOf(d) === yearOf(new Date(opts.now ?? Date.now()))
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }), timeZone })
}

/**
 * The last day of a billing cycle that resets at `resetAt` (the first instant
 * of the next one): "Nov 30" for a reset on Dec 1.
 */
export function fmtCycleLastDay(resetAt: string | number | Date, now?: number): string {
  return fmtDay(toDate(resetAt).getTime() - 1, { utc: true, now })
}

/** "32 s ago", "4 min ago", "3 h ago", "on Nov 14". */
export function fmtAgo(value: string | number | Date, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - toDate(value).getTime()) / 1000))
  if (seconds < 60) return `${Math.max(1, seconds)} s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  return `on ${fmtDay(value, { now })}`
}

/** `path` for the account in view: `?orgId=` when an organization is named. */
export function scoped(path: string, orgId: string | null | undefined): string {
  return orgId ? `${path}${path.includes('?') ? '&' : '?'}orgId=${encodeURIComponent(orgId)}` : path
}

/** A JSON body for the account in view: `orgId` added when an organization is named. */
export function scopedBody(body: Record<string, unknown>, orgId: string | null | undefined): string {
  return JSON.stringify(orgId ? { ...body, orgId } : body)
}

/**
 * A GET that never throws: the parsed body, or no body and the status that
 * refused it (0 when the request never got an answer). One flat shape rather
 * than a union: this repository compiles with `strict: false`, where
 * `{ ok: true } | { ok: false }` does not narrow.
 */
export async function getJson<T>(url: string): Promise<{ ok: boolean; status: number; data: T | null }> {
  try {
    const res = await fetch(url, { credentials: 'include' })
    if (!res.ok) return { ok: false, status: res.status, data: null }
    return { ok: true, status: res.status, data: (await res.json()) as T }
  } catch {
    return { ok: false, status: 0, data: null }
  }
}
