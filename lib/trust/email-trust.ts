/**
 * Server-side signup email trust assessment.
 * ===========================================
 *
 * This is the *deep* check. `lib/auth/signup-email-eligibility.ts` stays client-safe
 * and cheap (it renders inline form errors, so whatever it knows is public);
 * everything expensive or worth keeping private lives here and runs only on
 * the server, behind `assertSignupAllowed`.
 *
 * WHAT THIS DOES AND DOES NOT SOLVE
 * ---------------------------------
 * Measured against the four domains that actually got through in July 2026
 * (aganseo.com, gravik.org, dysonc.com, cropimg.com):
 *
 *   - A 121,570-entry disposable-domain list matched ZERO of them.
 *   - All four resolve valid MX records, so MX existence matched zero.
 *   - Two are 13 and 17 years old, so domain-age heuristics matched zero
 *     and would have false-positived on legitimate new startups.
 *
 * The conclusion that matters: these are not temp-mail services you can
 * enumerate. They are attacker-controlled domains, and a fresh one costs
 * about a dollar. No list will ever contain tomorrow's.
 *
 * So this module is deliberately *not* the primary control — Turnstile
 * (lib/trust/bot-defense.ts) is, because the shared property of these signups
 * is that they were automated, not that the domain was cheap. What this
 * module adds is a second layer that (a) kills the classic disposable
 * services for free, (b) catches the form-filler fingerprints that no captcha
 * budget should have to pay for, and (c) learns from what the operator blocks
 * by hand, so a domain farm dies as a farm rather than one domain at a time.
 *
 * Verdicts, not booleans. `deny` refuses the signup. `challenge` lets the
 * account exist but marks it untrusted, which forces a verified email before
 * it can consume anything. That split is what keeps a real founder on their
 * own two-week-old company domain from being turned away.
 */

// NO `import 'server-only'` here — it took the Express runtime down.
//
// `server-only` throws on import outside a Next.js server context, and this
// module is reached by the standalone Express runtime through a chain it cannot
// avoid: server/lib/auth.ts and server/routes/bootstrap.ts import
// lib/platform/controls.ts, which imports assessEmailTrust from here. So
// `backenly-runtime` crashed at module load, entered a restart loop (66
// restarts), and every /api/v1/* route answered 502 while the Next app kept
// serving 200 — the split that makes this look like a routing problem rather
// than a crash.
//
// Client safety is unaffected: nothing in components/ or app/ client code
// imports this, and the expensive/private checks stay behind
// assertSignupAllowed. The Next-only bundler guard is what had to go, not the
// server-side boundary it was standing in for.
import dns from 'dns'
import { prisma } from '@/lib/db/prisma'
import { checkSignupEmailEligibility } from '@/lib/auth/signup-email-eligibility'

// ─── Public shape ─────────────────────────────────────────────────────────────

export type TrustVerdict = 'allow' | 'challenge' | 'deny'

export interface EmailTrustResult {
  verdict: TrustVerdict
  /** 0 = pristine, 100 = certainly abusive. Recorded on SecurityEvent. */
  score: number
  /** Machine-readable reason codes, for the admin feed and for tuning. */
  signals: string[]
  /** User-facing message. Only meaningful when the verdict is `deny`. */
  reason?: string
}

export const SIGNUP_DENIED_MESSAGE =
  'Please sign up with a real personal or work email. Temporary, disposable, and auto-generated addresses are not accepted.'

/** Threshold at which we refuse the signup outright. */
const DENY_AT = 70
/** Threshold at which the account is created but marked untrusted. */
const CHALLENGE_AT = 35

// ─── Signal weights ───────────────────────────────────────────────────────────
//
// Anything at or above DENY_AT on its own is a hard fail. The rest compose:
// no single soft signal should ever refuse a real user, but two or three
// together are a strong enough case to demand a verified mailbox.

const WEIGHTS = {
  hardFail: 100,
  /** MX points at a free catch-all forwarder — what burner-domain farms use. */
  catchallForwarderMx: 30,
  /** MX host already serves a domain the operator blocked by hand. */
  knownBadMxOperator: 40,
  /** No MX, mail implied by the A record. Legal, but unusual for a real business. */
  implicitMxOnly: 25,
  /** Local part looks machine-generated (no vowel structure, base36-ish). */
  randomLocalPart: 35,
  /** Local part is nonsense-word + digits — the classic bot generator shape. */
  generatedLocalPart: 25,
  /** Domain isn't a mailbox provider we recognise. Weak on its own, by design. */
  unknownDomain: 20,
  /** Credits. A real mailbox provider or an institution buys back suspicion. */
  majorProvider: -20,
  institutional: -20,
} as const

// ─── Reference data ───────────────────────────────────────────────────────────

/**
 * Mailbox providers where the local part tells us nothing. Millions of real
 * people hold addresses on these that look machine-generated, so shape-based
 * signals must not be allowed to convict them. This credit is the single most
 * important false-positive guard in the module.
 */
const MAJOR_PROVIDERS = new Set([
  'aol.com', 'daum.net', 'fastmail.com', 'gmail.com', 'googlemail.com',
  'gmx.com', 'gmx.de', 'gmx.net', 'hey.com', 'hotmail.co.uk', 'hotmail.com',
  'hotmail.fr', 'icloud.com', 'kakao.com', 'live.com', 'live.co.uk', 'mac.com',
  'mail.com', 'mail.ru', 'me.com', 'naver.com', 'outlook.com', 'outlook.fr',
  'pm.me', 'proton.me', 'protonmail.ch', 'protonmail.com', 'qq.com',
  'rediffmail.com', 'seznam.cz', 'tutanota.com', 'web.de', 'yahoo.co.in',
  'yahoo.co.jp', 'yahoo.co.uk', 'yahoo.com', 'yahoo.fr', 'yandex.com',
  'yandex.ru', 'zoho.com',
])

/**
 * Free catch-all mail routing. Entirely legitimate on its own — plenty of real
 * small teams route their domain through Cloudflare or ImprovMX — which is why
 * this is weighted as a contributing signal and never as a hard fail. It earns
 * its place because standing up a throwaway domain with catch-all forwarding is
 * the cheapest way to mint unlimited "unique" addresses, and cropimg.com (one of
 * the four that got through) does exactly this.
 */
const CATCHALL_FORWARDER_MX = [
  'mx.cloudflare.net',
  'improvmx.com',
  'forwardemail.net',
  'mailgun.org',
  'migadu.com',
  'mxroute.com',
  'privateemail.com',
  'zoho.com',
  'zoho.eu',
]

/** Academic and government suffixes — expensive to obtain, so they earn credit. */
const INSTITUTIONAL_SUFFIXES = ['.edu', '.ac.uk', '.ac.kr', '.ac.jp', '.ac.in', '.edu.au', '.edu.cn', '.gov', '.gov.uk', '.mil']

// ─── Disposable list (lazy, server-only, ~121k entries) ──────────────────────

let _disposable: Set<string> | null = null
let _disposableWildcards: string[] | null = null

function disposableSets(): { exact: Set<string>; wildcards: string[] } {
  if (!_disposable) {
    try {
      // Required lazily so the ~2 MB list never loads in a process that never
      // sees a signup, and never has a chance of reaching a client bundle.
      const list: string[] = require('disposable-email-domains')
      const wildcard: string[] = require('disposable-email-domains/wildcard.json')
      _disposable = new Set(list)
      _disposableWildcards = wildcard
    } catch {
      // Package missing (e.g. a pruned install) — degrade to the small
      // hardcoded list in email-eligibility rather than failing signup.
      _disposable = new Set()
      _disposableWildcards = []
    }
  }
  return { exact: _disposable, wildcards: _disposableWildcards ?? [] }
}

function isDisposableDomain(domain: string): boolean {
  const { exact, wildcards } = disposableSets()
  if (exact.has(domain)) return true
  return wildcards.some((w) => domain === w || domain.endsWith(`.${w}`))
}

// ─── DNS with a hard timeout and a cache ─────────────────────────────────────
//
// A signup must never hang on a slow resolver. We cap the lookup and treat a
// timeout as "unknown", never as "bad" — a resolver hiccup must not lock a real
// user out of the product.

const MX_TTL_MS = 6 * 60 * 60_000
const MX_TIMEOUT_MS = 2_500

export interface MailRouting {
  /** MX hosts, `[]` when the domain answers but publishes none, `null` on timeout. */
  mx: string[] | null
  /** Whether the domain has an address record, i.e. it exists at all. */
  hasAddressRecord: boolean
}

const _mxCache = new Map<string, { routing: MailRouting; expiresAt: number }>()

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('dns_timeout')), ms)),
  ])
}

/**
 * Resolve how (and whether) a domain can receive mail.
 *
 * The A-record fallback matters. RFC 5321 §5.1 says a domain with no MX but a
 * valid address record still accepts mail there, and a handful of small
 * self-hosted domains genuinely rely on it. Treating "no MX" as an automatic
 * refusal would turn those people away at the door, so the absence of MX is
 * only fatal when the domain does not resolve at all.
 */
async function resolveMailRouting(domain: string): Promise<MailRouting> {
  const now = Date.now()
  const cached = _mxCache.get(domain)
  if (cached && cached.expiresAt > now) return cached.routing

  let mx: string[] | null
  try {
    const records = await withTimeout(dns.promises.resolveMx(domain), MX_TIMEOUT_MS)
    mx = records
      .map((r) => r.exchange.toLowerCase().replace(/\.$/, ''))
      // A single "." exchange is the RFC 7505 null MX: explicitly no mail.
      .filter((h) => h.length > 0 && h !== '.')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code
    mx = code === 'ENOTFOUND' || code === 'ENODATA' ? [] : null
  }

  let hasAddressRecord = false
  if (mx !== null && mx.length === 0) {
    // Only worth a second lookup when MX came back genuinely empty.
    try {
      const a = await withTimeout(dns.promises.resolve4(domain), MX_TIMEOUT_MS)
      hasAddressRecord = a.length > 0
    } catch {
      try {
        const aaaa = await withTimeout(dns.promises.resolve6(domain), MX_TIMEOUT_MS)
        hasAddressRecord = aaaa.length > 0
      } catch {
        hasAddressRecord = false
      }
    }
  }

  const routing: MailRouting = { mx, hasAddressRecord }
  if (_mxCache.size > 10_000) _mxCache.clear()
  _mxCache.set(domain, { routing, expiresAt: now + MX_TTL_MS })
  return routing
}

// ─── Learned MX operators ────────────────────────────────────────────────────
//
// Domain farms reuse mail infrastructure. dysonc.com routes through
// mail.wabblywabble.com — a host that serves a stable of throwaway domains. When
// the operator blocklists one domain by hand, this lets the rest of the farm
// inherit the judgement instead of arriving one at a time.

const BAD_MX_TTL_MS = 10 * 60_000
let _badMxCache: { hosts: Set<string>; expiresAt: number } | null = null

async function knownBadMxHosts(): Promise<Set<string>> {
  const now = Date.now()
  if (_badMxCache && _badMxCache.expiresAt > now) return _badMxCache.hosts
  try {
    const rows = await prisma.blocklist.findMany({
      where: { kind: 'mx' },
      select: { value: true },
    })
    const hosts = new Set(rows.map((r) => r.value.toLowerCase().trim()))
    _badMxCache = { hosts, expiresAt: now + BAD_MX_TTL_MS }
    return hosts
  } catch {
    return _badMxCache?.hosts ?? new Set()
  }
}

export function invalidateMxBlocklistCache() {
  _badMxCache = null
}

// ─── Local-part shape ────────────────────────────────────────────────────────

/**
 * Does the local part look like a machine emitted it?
 *
 * Tuned against real users already in the database — sandranair1661,
 * adhuadarshzz1, yingquan526, roma.gamer.2017, beau.t.wino, kyawswarno825 must
 * all read as human — and against the bot addresses that got through.
 *
 * Note these only ever *contribute*. On a major provider the credit cancels
 * them out, which is the intended behaviour: a weird-looking Gmail address is
 * still a Gmail address, and Google already did the identity work for us.
 */
function localPartShape(local: string): { random: boolean; generated: boolean } {
  const base = local.split('+')[0]
  // Separators are a strong humanity signal (first.last, first_last).
  const segments = base.split(/[._-]+/).filter(Boolean)
  const letters = base.replace(/[^a-z]/g, '')
  const digits = base.replace(/[^0-9]/g, '')

  if (!letters) return { random: true, generated: false }

  const vowels = (letters.match(/[aeiou]/g) || []).length
  const vowelRatio = vowels / letters.length
  // Annotated: `match` returns RegExpMatchArray | null, and the `?? []` fallback
  // otherwise infers as never[], which collapses the reduce accumulator.
  const consonantRuns: string[] = letters.match(/[^aeiou]+/g) ?? []
  const longestConsonantRun = consonantRuns.reduce((max, run) => Math.max(max, run.length), 0)
  // Digits interleaved between letters (mrej6qi3ucj1) rather than trailing
  // (sandranair1661) is base36-ish output, not a human picking a number.
  const interleavedDigits = /[a-z]\d[a-z]/.test(base)

  const random =
    (vowelRatio < 0.28 && letters.length >= 6) ||
    longestConsonantRun >= 5 ||
    (interleavedDigits && digits.length >= 2 && segments.length === 1)

  // Nonsense word followed by a short digit run, one unbroken segment:
  // nehafic171, neliyit144. Real users overwhelmingly use a name, a separator,
  // or a longer meaningful number (a birth year, a handle they've had for years).
  const generated =
    !random &&
    segments.length === 1 &&
    /^[a-z]{5,9}\d{2,4}$/.test(base) &&
    vowelRatio < 0.45

  return { random, generated }
}

/**
 * The single cleanest fingerprint in the sample: `backenly.com@gravik.org`.
 * The local part is our own hostname, because a form-filler bot pasted its
 * target into the email field. No human types this, ever.
 */
function containsBrandToken(local: string): boolean {
  const compact = local.replace(/[^a-z0-9]/g, '')
  const brand = (process.env.NEXT_PUBLIC_APP_URL || 'backenly.com')
    .replace(/^https?:\/\//, '')
    .replace(/[^a-z0-9.]/gi, '')
    .toLowerCase()
  const host = brand.split('.')[0] || 'backenly'
  // Match the bare brand or the full host, but require the local part to be
  // essentially nothing but the brand — `adarsh@backenly.com` style addresses
  // and people who put our name in a tagged address stay unaffected.
  return compact === host || compact === brand.replace(/\./g, '')
}

// ─── Assessment ───────────────────────────────────────────────────────────────

export interface TrustOptions {
  /** Skip DNS entirely (unit tests, or an offline environment). */
  skipDns?: boolean
}

export async function assessEmailTrust(
  email: string,
  opts: TrustOptions = {},
): Promise<EmailTrustResult> {
  const normalized = email.trim().toLowerCase()
  const at = normalized.lastIndexOf('@')
  if (at <= 0 || at === normalized.length - 1) {
    return { verdict: 'deny', score: 100, signals: ['invalid_email'], reason: 'Invalid email address.' }
  }
  const local = normalized.slice(0, at)
  const domain = normalized.slice(at + 1).replace(/\.$/, '')

  const signals: string[] = []
  let score = 0

  // 1. Cheap client-visible rules first — reserved domains, the small
  //    hardcoded disposable set, obvious burner local parts. These already
  //    ran in the browser, but the browser is not a security boundary.
  const basic = checkSignupEmailEligibility(normalized)
  if (!basic.ok) {
    return {
      verdict: 'deny',
      score: 100,
      signals: [(basic.code ?? 'INELIGIBLE').toLowerCase()],
      reason: basic.reason ?? SIGNUP_DENIED_MESSAGE,
    }
  }

  // 2. Hard fails.
  if (containsBrandToken(local)) {
    return {
      verdict: 'deny',
      score: 100,
      signals: ['brand_in_local_part'],
      reason: SIGNUP_DENIED_MESSAGE,
    }
  }

  if (isDisposableDomain(domain)) {
    return {
      verdict: 'deny',
      score: 100,
      signals: ['disposable_domain'],
      reason: SIGNUP_DENIED_MESSAGE,
    }
  }

  // 3. Reputation credits.
  const isMajor = MAJOR_PROVIDERS.has(domain)
  const isInstitutional = INSTITUTIONAL_SUFFIXES.some((s) => domain.endsWith(s))
  if (isMajor) {
    signals.push('major_provider')
    score += WEIGHTS.majorProvider
  } else if (isInstitutional) {
    signals.push('institutional_domain')
    score += WEIGHTS.institutional
  } else {
    signals.push('unknown_domain')
    score += WEIGHTS.unknownDomain
  }

  // 4. Mail routing. Only consulted for domains we don't already trust —
  //    there is no reason to resolve gmail.com on every signup.
  if (!opts.skipDns && !isMajor) {
    const { mx, hasAddressRecord } = await resolveMailRouting(domain)
    if (mx === null) {
      signals.push('mx_unresolved')
      // Deliberately unscored: a resolver timeout is our problem, not the user's.
    } else if (mx.length === 0 && !hasAddressRecord) {
      // Neither mail routing nor an address record — the domain does not exist
      // in any usable form, so no verification email could ever arrive.
      return {
        verdict: 'deny',
        score: 100,
        signals: ['domain_unroutable'],
        reason: 'That domain cannot receive email. Please use an address you can actually check.',
      }
    } else if (mx.length === 0) {
      // Legal per RFC 5321, but rare enough to be worth counting.
      signals.push('implicit_mx_only')
      score += WEIGHTS.implicitMxOnly
    } else {
      const badHosts = await knownBadMxHosts()
      if (mx.some((h) => badHosts.has(h) || Array.from(badHosts).some((b) => h.endsWith(`.${b}`)))) {
        signals.push('known_bad_mx_operator')
        score += WEIGHTS.knownBadMxOperator
      }
      if (mx.some((h) => CATCHALL_FORWARDER_MX.some((f) => h === f || h.endsWith(`.${f}`)))) {
        signals.push('catchall_forwarder_mx')
        score += WEIGHTS.catchallForwarderMx
      }
    }
  }

  // 5. Local-part shape.
  const shape = localPartShape(local)
  if (shape.random) {
    signals.push('random_local_part')
    score += WEIGHTS.randomLocalPart
  } else if (shape.generated) {
    signals.push('generated_local_part')
    score += WEIGHTS.generatedLocalPart
  }

  score = Math.max(0, Math.min(100, score))

  const verdict: TrustVerdict = score >= DENY_AT ? 'deny' : score >= CHALLENGE_AT ? 'challenge' : 'allow'

  return {
    verdict,
    score,
    signals,
    reason: verdict === 'deny' ? SIGNUP_DENIED_MESSAGE : undefined,
  }
}
