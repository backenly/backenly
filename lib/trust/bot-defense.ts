/**
 * Bot verification for the signup surface (Cloudflare Turnstile).
 * ===============================================================
 *
 * This is the primary control, not the domain heuristics next door.
 *
 * The four addresses that got past the old gate — nehafic171@aganseo.com,
 * backenly.com@gravik.org, neliyit144@dysonc.com, mrej6qi3ucj1@cropimg.com —
 * have no usable property in common at the domain layer. Two of the domains
 * predate Backenly by over a decade; all four resolve mail; none appear in a
 * 121k disposable list. What they share is that a script filled the form.
 * `backenly.com@gravik.org` is the proof: the local part is our own hostname,
 * which is what a form-filler emits when it templates the target site into an
 * email field.
 *
 * So the thing worth blocking is the automation, and that is what a proof-of-
 * humanity challenge blocks — regardless of which domain gets registered next.
 *
 * Turnstile over reCAPTCHA/hCaptcha: free with no request ceiling, no Google
 * account coupling, invisible for the large majority of real users (no image
 * grids), and it does not sell the traffic data back into an ad graph. It is
 * what Vercel, Railway, and Supabase-adjacent products converged on.
 *
 * FAIL-OPEN VS FAIL-CLOSED
 * ------------------------
 * Unconfigured (no secret in env) is a no-op: the deploy that ships this code
 * must not lock every real user out before the keys exist. Once configured, a
 * missing or invalid token is refused. If Cloudflare itself is unreachable we
 * fail *open* and record a SecurityEvent — a captcha provider outage taking
 * down signups is a worse failure than a few hours of unfiltered registrations,
 * and the other layers still apply.
 */

// No `import 'server-only'` here, deliberately, for the same reason it was
// removed from lib/trust/email-trust.ts: it throws on import outside a Next.js
// server context, and this module imports lib/platform/controls.ts, which the
// standalone Express runtime already pulls in. Nothing under server/ reaches
// this file today, so the guard was not firing, but it was the identical
// landmine one import away from crash-looping `backenly-runtime` again.
//
// The secret is read from process.env at call time and never returned to a
// caller, so there is nothing here for a client bundle to leak even if one
// somehow imported it.
import { recordSecurityEvent } from '@/lib/platform-controls'

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'
const VERIFY_TIMEOUT_MS = 4_000

export interface BotCheckResult {
  ok: boolean
  /** Reason code when the check fails, for the security feed. */
  code?: 'missing_token' | 'invalid_token' | 'duplicate_token'
  reason?: string
  /** True when no secret is configured, so the caller can surface the gap. */
  unconfigured?: boolean
}

/** Whether a Turnstile secret is present. Public keys are read by the client. */
export function isBotDefenseConfigured(): boolean {
  return Boolean(process.env.TURNSTILE_SECRET_KEY?.trim())
}

/**
 * Verify a Turnstile token against Cloudflare.
 *
 * `remoteIp` is optional but strongly recommended — it lets Cloudflare correlate
 * the solve with the address that requested the challenge.
 */
export async function verifyBotChallenge(
  token: string | null | undefined,
  remoteIp?: string | null,
): Promise<BotCheckResult> {
  const secret = process.env.TURNSTILE_SECRET_KEY?.trim()

  if (!secret) {
    // Not configured. Say so out loud on the server so this can't quietly stay
    // off forever, but let the request through.
    return { ok: true, unconfigured: true }
  }

  if (!token || typeof token !== 'string') {
    return {
      ok: false,
      code: 'missing_token',
      reason: 'Please complete the verification challenge and try again.',
    }
  }

  const body = new URLSearchParams({ secret, response: token })
  if (remoteIp && remoteIp !== 'unknown') body.set('remoteip', remoteIp)

  try {
    const res = await Promise.race([
      fetch(SITEVERIFY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        cache: 'no-store',
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('turnstile_timeout')), VERIFY_TIMEOUT_MS),
      ),
    ])

    const data = (await res.json()) as {
      success?: boolean
      'error-codes'?: string[]
    }

    if (data.success) return { ok: true }

    const errors = data['error-codes'] ?? []

    // A replayed token is a distinct and much louder signal than a stale one:
    // it means someone is scripting against a solved challenge.
    if (errors.includes('timeout-or-duplicate')) {
      return {
        ok: false,
        code: 'duplicate_token',
        reason: 'That verification has already been used. Please try again.',
      }
    }

    return {
      ok: false,
      code: 'invalid_token',
      reason: 'Verification failed. Please try again.',
    }
  } catch (err) {
    // Cloudflare unreachable or slow. Fail open, but leave a trail.
    await recordSecurityEvent({
      kind: 'bot_defense_degraded',
      severity: 'high',
      ip: remoteIp ?? null,
      summary: 'Turnstile verification unavailable — signup allowed without a bot check',
      detail: { error: (err as Error)?.message ?? 'unknown' },
    }).catch(() => {})
    return { ok: true }
  }
}
