/**
 * INTEGRATION KEY VERIFICATION
 * ============================
 * Ask the PROVIDER whether a credential is real, at connect time.
 *
 * ── Why ──────────────────────────────────────────────────────────────────────
 *
 * Storing a key and having a working integration are different facts, and
 * Backenly used to report the first as though it were the second. Only Resend
 * and SendGrid keys were ever checked; Stripe, OpenAI, Anthropic, PostHog and
 * Twilio keys were encrypted and filed with no contact made. A deliberately
 * fabricated Stripe secret produced a green `connected` badge and a project
 * that would not fail until the first real customer payment — the single worst
 * moment to discover a bad credential.
 *
 * Format checks (lib/services/integrationKeyStore#validateIntegrationKeyFormat)
 * cannot close this: `sk_test_FAKE0000000000000000000000` has a perfectly valid
 * Stripe prefix. Only the provider can tell a real key from a well-formed one.
 *
 * ── The four honest answers ──────────────────────────────────────────────────
 *
 *   verified      the provider accepted it (a 2xx), or said in its own words
 *                 that the key is real (Resend's answer to a Sending-access
 *                 key). Safe to call `connected`.
 *   rejected      the provider refused it (401/403, or the answer a provider
 *                 documents for a key that does not exist). Refuse to store —
 *                 a wrong credential in the vault is worse than none, because
 *                 it looks like a working one.
 *   unverifiable  no endpoint exists that can confirm this credential. Webhook
 *                 signing secrets and write-only ingest keys are the real cases.
 *                 Say so; do NOT pretend it passed and do NOT pretend it failed.
 *   unreachable   we could not get an answer that says either way (network,
 *                 timeout, provider down, or a status that neither accepts nor
 *                 refuses the key). Store it, mark it, re-check later. Refusing
 *                 here would make Backenly unusable during someone else's
 *                 outage.
 *
 * Nothing in this file may ever invent a credential value. See
 * `looksFabricated` — a placeholder is rejected before a request is made, so a
 * fabricated value can never be spent against a provider's rate limit either.
 */

import { twilioCredentialParts, twilioCredentialProblem } from './twilio-credential'

export type VerificationStatus = 'verified' | 'rejected' | 'unverifiable' | 'unreachable' | 'unchecked'

export interface VerificationResult {
  status: VerificationStatus
  /** One sentence a human or an agent can act on. */
  detail: string
}

const TIMEOUT_MS = 8000

/**
 * Placeholder detection.
 *
 * An agent asked for a credential it does not have will sometimes produce a
 * plausible-looking one rather than stop and ask. That is the failure mode
 * behind a stored `stripe_webhook_secret` nobody supplied. These values are
 * refused before any network call, with a message that names the problem
 * instead of returning a generic auth error the agent might retry around.
 */
export function looksFabricated(rawKey: string): string | null {
  const k = String(rawKey ?? '')
  const body = k.replace(/^(sk|rk|pk|re|phc|whsec|SG)[-_]?(live|test)?[-_]?/i, '')

  if (!body || body.length < 8) return 'the key is too short to be a real credential'
  if (/^(x+|0+|1+|a+|z+)$/i.test(body)) return 'the key is a single repeated character'
  if (/(FAKE|DUMMY|PLACEHOLDER|EXAMPLE|CHANGEME|YOUR[-_]?KEY|TEST[-_]?KEY|XXXX|REPLACE[-_]?ME|NOT[-_]?A[-_]?REAL)/i.test(k)) {
    return 'the key contains a placeholder marker'
  }
  // 0000…, abcdef…, 123456… — a real secret is high-entropy.
  if (/^(0{6,}|1{6,}|(abcdef|123456|qwerty)\w*)$/i.test(body)) return 'the key is a filler pattern, not a secret'
  return null
}

// ── Per-provider probes ───────────────────────────────────────────────────────

type Probe = (key: string) => Promise<VerificationResult>

/**
 * Turn an HTTP status into the right one of the four answers.
 *
 * Only a 2xx accepts a key. A 4xx other than 401, 403 and 429 says nothing
 * about the key either way: it used to read as `verified`, which is how
 * Resend's 400 for a deleted key stored that key as confirmed (#608).
 */
function fromStatus(status: number, provider: string): VerificationResult {
  if (status >= 200 && status < 300) {
    return { status: 'verified', detail: `${provider} accepted this key.` }
  }
  if (status === 401 || status === 403) {
    return { status: 'rejected', detail: `${provider} rejected this key (HTTP ${status}) — it is not a valid credential for that account.` }
  }
  if (status >= 500) {
    return { status: 'unreachable', detail: `${provider} returned HTTP ${status}; the key could not be checked right now.` }
  }
  if (status === 429) {
    return { status: 'unreachable', detail: `${provider} rate-limited the verification request; the key could not be checked right now.` }
  }
  return {
    status: 'unreachable',
    detail: `${provider} answered HTTP ${status}, which says neither that the key works nor that it does not; the key could not be checked.`,
  }
}

/**
 * Resend's answer to GET /domains, read as Resend's error reference gives it
 * (https://resend.com/docs/api-reference/errors). Read by status alone, two of
 * its answers meant the opposite of what happened (#608):
 *
 *   401 restricted_api_key  "This API key is restricted to only send emails."
 *       The key is real and has Sending access, Resend's least-privilege
 *       option and all that sending mail needs. It was refused.
 *   400 validation_error    "API key is invalid"
 *       What every endpoint except sending answers for a key that does not
 *       exist or was deleted. It was stored as confirmed.
 *
 * 403 restricted_api_key ("API key is not active") and 403 suspended_api_key
 * are refusals, and say which. Anything else is read by its status. Also read
 * by the live check of GET /api/integrations/health.
 */
export function readResendAnswer(status: number, body: unknown): VerificationResult {
  const error = (body !== null && typeof body === 'object' ? body : {}) as { name?: unknown; message?: unknown }
  const name = typeof error.name === 'string' ? error.name : ''
  const message = typeof error.message === 'string' ? error.message : ''

  if (status === 401 && name === 'restricted_api_key') {
    return {
      status: 'verified',
      detail:
        'Resend accepted this key. It has Sending access, which is what sending email needs; ' +
        "Resend's other endpoints, called with ctx.integrations.resend.request(), need a key with Full access.",
    }
  }
  if (status === 400 && name === 'validation_error' && /api key is invalid/i.test(message)) {
    return {
      status: 'rejected',
      detail:
        'Resend says this API key is invalid (HTTP 400): no such key exists, or it was deleted. ' +
        'Create a key at resend.com/api-keys and use that one.',
    }
  }
  if (status === 403 && name === 'restricted_api_key' && /not active/i.test(message)) {
    return {
      status: 'rejected',
      detail: 'Resend says this API key is not active (HTTP 403). Check it at resend.com/api-keys, or create a new one.',
    }
  }
  if (status === 403 && name === 'suspended_api_key') {
    return {
      status: 'rejected',
      detail: 'Resend says this API key is suspended (HTTP 403). Resend support can say why.',
    }
  }
  return fromStatus(status, 'Resend')
}

/** A refusal's JSON body, or null when it has none. */
export async function errorBody(res: Response): Promise<unknown> {
  try {
    return await res.json()
  } catch {
    return null
  }
}

/**
 * Ask `url` with the key in `headers`. A provider whose status codes alone do
 * not say what happened to the key gives `read`, which gets the status and
 * the body of anything but a 2xx. A 2xx body is never read: it is the
 * account's own data.
 */
async function probeGet(
  url: string,
  headers: Record<string, string>,
  provider: string,
  read?: (status: number, body: unknown) => VerificationResult,
): Promise<VerificationResult> {
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) })
    if (!read || (res.status >= 200 && res.status < 300)) return fromStatus(res.status, provider)
    return read(res.status, await errorBody(res))
  } catch (err: any) {
    return {
      status: 'unreachable',
      detail: `Could not reach ${provider} to verify the key (${err?.name === 'TimeoutError' ? 'timed out' : String(err?.message ?? err)}). Stored unverified.`,
    }
  }
}

const UNVERIFIABLE = (why: string): Probe => async () => ({ status: 'unverifiable', detail: why })

/**
 * The registry. Keyed by the exact `integrationId` used in the vault, so
 * compound ids (`stripe_webhook_secret`) get their own honest answer rather
 * than inheriting the parent provider's probe.
 */
const PROBES: Record<string, Probe> = {
  stripe: (k) => probeGet('https://api.stripe.com/v1/account', { Authorization: `Bearer ${k}` }, 'Stripe'),

  // A webhook signing secret is only ever exercised by an inbound event's
  // signature — Stripe exposes nothing that can confirm one. Saying
  // "unverifiable" is the truth; saying "connected" was not.
  stripe_webhook_secret: UNVERIFIABLE(
    'Stripe has no endpoint that can confirm a webhook signing secret. It is validated the first time Stripe delivers an event — until then, treat signature verification as unproven.',
  ),

  openai: (k) => probeGet('https://api.openai.com/v1/models', { Authorization: `Bearer ${k}` }, 'OpenAI'),

  anthropic: (k) => probeGet('https://api.anthropic.com/v1/models', { 'x-api-key': k, 'anthropic-version': '2023-06-01' }, 'Anthropic'),

  // GET /domains needs Full access, so a Sending-access key is told no by name
  // (readResendAnswer).
  resend: (k) => probeGet('https://api.resend.com/domains', { Authorization: `Bearer ${k}` }, 'Resend', readResendAnswer),

  sendgrid: (k) => probeGet('https://api.sendgrid.com/v3/scopes', { Authorization: `Bearer ${k}` }, 'SendGrid'),

  // PostHog project keys are write-only ingest keys: every endpoint that would
  // confirm one requires a personal API key instead. Verifying by SENDING an
  // event would pollute the customer's analytics, which is not a trade we make.
  posthog: UNVERIFIABLE(
    'PostHog project API keys are write-only ingest keys with no endpoint that can confirm them without emitting a test event into your analytics. Format checked only.',
  ),

  // Twilio's one stored value is accountSid:authToken:fromNumber
  // (lib/integrations/twilio-credential.ts), so the pair that authenticates is
  // in it, and Twilio answers for its own account. A value without that shape
  // gives functions nothing to call, so it is refused here too: that is what a
  // re-check says about one stored before the shape was checked.
  twilio: (k) => {
    const problem = twilioCredentialProblem(k)
    if (problem) return Promise.resolve({ status: 'rejected', detail: problem })
    const { accountSid, authToken } = twilioCredentialParts(k)!
    return probeGet(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}.json`,
      { Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}` },
      'Twilio',
    )
  },
}

/** How each provider is written where a person reads it ("your Stripe dashboard"). */
const PROVIDER_NAMES: Record<string, string> = {
  stripe: 'Stripe',
  stripe_webhook_secret: 'Stripe',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  resend: 'Resend',
  sendgrid: 'SendGrid',
  posthog: 'PostHog',
  twilio: 'Twilio',
  onesignal: 'OneSignal',
  replicate: 'Replicate',
  runway: 'Runway',
  stability: 'Stability AI',
}

export function providerName(integrationId: string): string {
  const id = String(integrationId ?? '').toLowerCase()
  if (PROVIDER_NAMES[id]) return PROVIDER_NAMES[id]
  return id ? id.charAt(0).toUpperCase() + id.slice(1) : 'provider'
}

/**
 * Verify a credential with its provider.
 *
 * Never throws — a verification failure must not be able to take down the
 * connect flow. Unknown providers return `unverifiable`, which is accurate:
 * Backenly has no probe for them, and claiming otherwise is the bug this file
 * exists to remove.
 */
export async function verifyIntegrationKey(
  integrationId: string,
  rawKey: string,
): Promise<VerificationResult> {
  const id = String(integrationId ?? '').toLowerCase()

  // Sender email is an email address (e.g. notifications@yourdomain.com), not an API key.
  // Validate email format and bypass high-entropy API key placeholder checks.
  if (id === 'email_from' || id.endsWith('_from') || id.endsWith('_from_email')) {
    const trimmed = String(rawKey ?? '').trim()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      return {
        status: 'rejected',
        detail: `"${rawKey}" is not a valid email address format. Provide a valid sender email address like noreply@yourdomain.com.`,
      }
    }
    return {
      status: 'unverifiable',
      detail: 'Sender email stored.',
    }
  }

  const fabricated = looksFabricated(rawKey)
  if (fabricated) {
    return {
      status: 'rejected',
      detail: `This does not look like a real credential — ${fabricated}. Backenly will not store a placeholder: it would read as "connected" and fail at the first live request. Paste the actual key from your ${providerName(id)} dashboard.`,
    }
  }

  const probe = PROBES[id]
  if (!probe) {
    return {
      status: 'unverifiable',
      detail: `Backenly has no verification probe for "${id}" — the key's format was checked but the provider was not contacted.`,
    }
  }

  try {
    return await probe(rawKey)
  } catch (err: any) {
    return { status: 'unreachable', detail: `Verification failed unexpectedly: ${String(err?.message ?? err)}` }
  }
}

/** True when the credential must NOT be stored. */
export function blocksStorage(result: VerificationResult): boolean {
  return result.status === 'rejected'
}

/**
 * The one-line status a dashboard or an agent should show. Deliberately never
 * collapses `unverifiable` / `unreachable` into "connected".
 */
export function verificationLabel(status: VerificationStatus): string {
  switch (status) {
    case 'verified':     return 'connected · key confirmed by the provider'
    case 'rejected':     return 'rejected by the provider'
    case 'unverifiable': return 'stored · provider offers no way to confirm this credential'
    case 'unreachable':  return 'stored · provider could not be reached to confirm it'
    default:             return 'stored · not yet checked'
  }
}
