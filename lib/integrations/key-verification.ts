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
 *   verified      the provider accepted it. Safe to call `connected`.
 *   rejected      the provider refused it (401/403). Refuse to store — a wrong
 *                 credential in the vault is worse than none, because it looks
 *                 like a working one.
 *   unverifiable  no endpoint exists that can confirm this credential. Webhook
 *                 signing secrets and write-only ingest keys are the real cases.
 *                 Say so; do NOT pretend it passed and do NOT pretend it failed.
 *   unreachable   we could not get an answer (network, timeout, provider down).
 *                 Store it, mark it, re-check later. Refusing here would make
 *                 Backenly unusable during someone else's outage.
 *
 * Nothing in this file may ever invent a credential value. See
 * `looksFabricated` — a placeholder is rejected before a request is made, so a
 * fabricated value can never be spent against a provider's rate limit either.
 */

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

/** Turn an HTTP status into the right one of the four answers. */
function fromStatus(status: number, provider: string): VerificationResult {
  if (status === 401 || status === 403) {
    return { status: 'rejected', detail: `${provider} rejected this key (HTTP ${status}) — it is not a valid credential for that account.` }
  }
  if (status >= 500) {
    return { status: 'unreachable', detail: `${provider} returned HTTP ${status}; the key could not be checked right now.` }
  }
  if (status === 429) {
    return { status: 'unreachable', detail: `${provider} rate-limited the verification request; the key could not be checked right now.` }
  }
  return { status: 'verified', detail: `${provider} accepted this key.` }
}

async function probeGet(url: string, headers: Record<string, string>, provider: string): Promise<VerificationResult> {
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) })
    return fromStatus(res.status, provider)
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

  resend: (k) => probeGet('https://api.resend.com/domains', { Authorization: `Bearer ${k}` }, 'Resend'),

  sendgrid: (k) => probeGet('https://api.sendgrid.com/v3/scopes', { Authorization: `Bearer ${k}` }, 'SendGrid'),

  // PostHog project keys are write-only ingest keys: every endpoint that would
  // confirm one requires a personal API key instead. Verifying by SENDING an
  // event would pollute the customer's analytics, which is not a trade we make.
  posthog: UNVERIFIABLE(
    'PostHog project API keys are write-only ingest keys with no endpoint that can confirm them without emitting a test event into your analytics. Format checked only.',
  ),

  // Twilio authenticates with Account SID + auth token. We hold one value, so
  // the pair cannot be assembled here.
  twilio: UNVERIFIABLE(
    'Twilio authenticates with an Account SID and auth token together; a single stored value cannot be confirmed on its own.',
  ),
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

  const fabricated = looksFabricated(rawKey)
  if (fabricated) {
    return {
      status: 'rejected',
      detail: `This does not look like a real credential — ${fabricated}. Backenly will not store a placeholder: it would read as "connected" and fail at the first live request. Paste the actual key from your ${id || 'provider'} dashboard.`,
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
