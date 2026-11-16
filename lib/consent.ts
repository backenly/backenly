/**
 * Cookie consent: what a visitor has allowed, kept in one first-party cookie.
 *
 * Two kinds of storage exist on backenly.com:
 *
 *   essential   the session that keeps you signed in, security cookies, and
 *               this record of your choice. Always on; the site cannot work
 *               without them.
 *   analytics   Amplitude (the Cloud overlay's components/app/AmplitudeAnalytics),
 *               which keeps a browser identifier in its own cookies and local
 *               storage. Off until you allow it.
 *
 * Nothing else is set: no advertising or marketing cookies, so there is no
 * category for them. The root layout mounts the analytics initializer only
 * inside <ConsentGate> (components/site/ConsentGate.tsx), so before a choice,
 * after "Reject all", and under a browser's Global Privacy Control signal,
 * Amplitude's code is never loaded at all.
 *
 * Browser-only: every function here is safe to call during render on the
 * server, where it answers "no choice yet".
 */

export const CONSENT_COOKIE = 'backenly_consent'
/** Bump to ask everyone again, for example when a new kind of storage is added. */
export const CONSENT_VERSION = 1
const ONE_YEAR = 60 * 60 * 24 * 365

/** Fired on window whenever the choice changes, with the new Consent as detail. */
export const CONSENT_EVENT = 'backenly:consent'
/** Fired on window to open the preferences dialog (the footer's "Cookie preferences"). */
export const PREFERENCES_EVENT = 'backenly:cookie-preferences'

export type Consent = {
  version: number
  analytics: boolean
  /** ISO date the choice was made. */
  decidedAt: string
}

const isBrowser = () => typeof document !== 'undefined'

/** The stored choice, or null when there is none (or it is from an older version). */
export function readConsent(): Consent | null {
  if (!isBrowser()) return null
  const raw = document.cookie
    .split('; ')
    .find((part) => part.startsWith(`${CONSENT_COOKIE}=`))
    ?.slice(CONSENT_COOKIE.length + 1)
  if (!raw) return null
  try {
    const parsed = JSON.parse(decodeURIComponent(raw)) as Partial<Consent>
    if (parsed.version !== CONSENT_VERSION || typeof parsed.analytics !== 'boolean') return null
    return { version: CONSENT_VERSION, analytics: parsed.analytics, decidedAt: String(parsed.decidedAt ?? '') }
  } catch {
    return null
  }
}

/** Whether the browser sends Global Privacy Control, which we honour as a "no" to analytics. */
export function globalPrivacyControl(): boolean {
  if (typeof navigator === 'undefined') return false
  return (navigator as Navigator & { globalPrivacyControl?: boolean }).globalPrivacyControl === true
}

/** Whether analytics may run: only after an explicit yes. */
export function analyticsAllowed(consent: Consent | null = readConsent()): boolean {
  return consent?.analytics === true
}

/** Store a choice for a year and tell the page about it. */
export function saveConsent(analytics: boolean): Consent {
  const consent: Consent = { version: CONSENT_VERSION, analytics, decidedAt: new Date().toISOString().slice(0, 10) }
  if (isBrowser()) {
    const secure = window.location.protocol === 'https:' ? '; Secure' : ''
    document.cookie = `${CONSENT_COOKIE}=${encodeURIComponent(JSON.stringify(consent))}; Max-Age=${ONE_YEAR}; Path=/; SameSite=Lax${secure}`
    window.dispatchEvent(new CustomEvent<Consent>(CONSENT_EVENT, { detail: consent }))
  }
  return consent
}

/** Open the preferences dialog from anywhere (a footer link, a settings page). */
export function openCookiePreferences(): void {
  if (isBrowser()) window.dispatchEvent(new Event(PREFERENCES_EVENT))
}

/** Amplitude's storage keys and cookie names all start with AMP (AMP_<key>, AMP_MKTG_<key>, AMP_unsent_<key>). */
const ANALYTICS_KEY = /^amp_/i

/**
 * Remove what analytics stored, after consent is withdrawn: Amplitude's cookies
 * (on this host and on the parent domain it may have chosen) and its local
 * storage keys.
 */
export function clearAnalyticsStorage(): void {
  if (!isBrowser()) return
  const host = window.location.hostname
  const labels = host.split('.')
  const domains = ['', host, labels.length > 2 ? labels.slice(-2).join('.') : host]
  for (const part of document.cookie.split('; ')) {
    const name = part.split('=')[0]
    if (!ANALYTICS_KEY.test(name)) continue
    for (const domain of domains) {
      document.cookie = `${name}=; Max-Age=0; Path=/${domain ? `; Domain=${domain}` : ''}`
    }
  }
  try {
    for (const key of Object.keys(window.localStorage)) {
      if (ANALYTICS_KEY.test(key)) window.localStorage.removeItem(key)
    }
  } catch {
    // Storage can be unavailable (private windows, blocked site data); there is then nothing to clear.
  }
}
