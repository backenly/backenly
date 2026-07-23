/**
 * INTEGRATION KEY STORE
 * =====================
 * Secure storage for user-provided API keys (Stripe, OpenAI, Resend, etc.).
 *
 * Keys are encrypted with AES-256-GCM before storage.
 * Only the masked version (first 7 + last 4 chars) is ever returned to the UI.
 * The raw key is only decrypted server-side when actually calling the provider.
 */

import { prisma } from '@/lib/db/prisma'
import { encrypt, decrypt } from '@/lib/services/encryption'
import { maskApiKey, scanForDangerousSecret } from '@/lib/ai/api-key-detector'
import {
  verifyIntegrationKey,
  blocksStorage,
  type VerificationStatus,
} from '@/lib/integrations/key-verification'

export interface KeyVaultStatus {
  integrationId: string
  maskedKey: string
  connectedAt: string
  /**
   * Did the provider confirm the key? Never fold this into a boolean
   * "connected" — `unverifiable` and `unreachable` are real, different states,
   * and a UI that renders them as connected is the bug that let a fabricated
   * Stripe key sit in a project looking healthy.
   */
  verification: VerificationStatus
  verificationDetail?: string
}

const INTEGRATION_KEY_ALIASES: Record<string, string[]> = {
  stripe: ['stripe_secret_key'],
}

// ─── Per-integration format validators ────────────────────────────────────────

interface KeyFormatSpec {
  /** Returns true when the key passes format validation */
  valid: (key: string) => boolean
  /** Human-readable hint shown when format check fails */
  hint: string
  /** Returns a warning string when the key is likely a test/sandbox key, null otherwise */
  testModeWarning?: (key: string) => string | null
}

const INTEGRATION_KEY_FORMATS: Record<string, KeyFormatSpec> = {
  stripe: {
    valid: (k) => k.startsWith('sk_live_') || k.startsWith('rk_live_'),
    hint: 'Stripe live secret keys must start with sk_live_. Test keys (sk_test_) only work in Stripe test mode and will silently fail for real payments.',
    testModeWarning: (k) =>
      k.startsWith('sk_test_') || k.startsWith('rk_test_')
        ? 'This is a Stripe TEST mode key. It will be stored, but production payments will fail — replace with your sk_live_ key before going live.'
        : null,
  },
  // Explicit entry so stripe_webhook_secret is not validated against the stripe sk_live_ rule
  stripe_webhook_secret: {
    valid: (k) => k.startsWith('whsec_'),
    hint: 'Stripe webhook signing secrets must start with whsec_. Find yours in the Stripe Dashboard → Webhooks → your endpoint → Signing secret.',
  },
  openai: {
    valid: (k) => k.startsWith('sk-'),
    hint: 'OpenAI API keys must start with sk-',
  },
  anthropic: {
    valid: (k) => k.startsWith('sk-ant-'),
    hint: 'Anthropic API keys must start with sk-ant-. Find yours in the Anthropic Console → API keys.',
  },
  resend: {
    valid: (k) => k.startsWith('re_'),
    hint: 'Resend API keys must start with re_',
  },
  posthog: {
    valid: (k) => k.startsWith('phc_'),
    hint: 'PostHog project API keys start with phc_. Find yours in PostHog → Project Settings → Project API key.',
  },
}

/**
 * Validate a key against its integration's known format requirements.
 * Returns { ok: true } when the key passes (or no format spec exists for this integration).
 * Returns { ok: false, error } when the key fails format validation outright.
 * Returns { ok: true, warning } when the key passes but appears to be test/sandbox mode.
 */
export function validateIntegrationKeyFormat(
  integrationId: string,
  rawKey: string,
): { ok: true; warning?: string } | { ok: false; error: string } {
  const exactId = integrationId.toLowerCase()

  // Check exact integrationId first — compound keys like stripe_webhook_secret have
  // their own format spec and must NOT fall through to the base (stripe) spec, which
  // validates against sk_live_ and would incorrectly reject whsec_ secrets.
  const exactSpec = INTEGRATION_KEY_FORMATS[exactId]
  if (exactSpec) {
    if (exactSpec.testModeWarning) {
      const warn = exactSpec.testModeWarning(rawKey)
      if (warn) return { ok: true, warning: warn }
    }
    return exactSpec.valid(rawKey) ? { ok: true } : { ok: false, error: exactSpec.hint }
  }

  // Fall back to normalized baseId (strip _webhook_secret, _api_key suffixes)
  const baseId = exactId.replace(/_(webhook_secret|api_key|secret_key|key)$/i, '')
  const spec = INTEGRATION_KEY_FORMATS[baseId]
  if (!spec) return { ok: true }

  if (spec.testModeWarning) {
    const warn = spec.testModeWarning(rawKey)
    if (warn) return { ok: true, warning: warn }
  }

  return spec.valid(rawKey) ? { ok: true } : { ok: false, error: spec.hint }
}

/**
 * Store or update an integration API key for a project.
 * The raw key is encrypted; only the masked version is persisted in plaintext.
 *
 * Three gates, in order, all of which run before anything touches the DB:
 *
 *   1. dangerous-secret scan — private keys, DB URLs, JWTs never get vaulted;
 *   2. format validation     — wrong provider / wrong mode;
 *   3. LIVE VERIFICATION     — the provider is asked whether the key works.
 *
 * Gate 3 is the one that was missing. Gates 1 and 2 cannot tell a real
 * `sk_test_…` from a fabricated one with the same prefix, so a made-up
 * credential passed straight through and the project reported `connected`
 * until the first real payment. A key the provider REJECTS is now refused
 * outright: a wrong credential in the vault is worse than an empty slot,
 * because an empty slot is visibly empty.
 *
 * Keys that genuinely cannot be verified (webhook signing secrets, write-only
 * ingest keys) are stored with that state recorded, not laundered into
 * "connected".
 *
 * Throws with `isFormatError` on gate 2 and `isVerificationError` on gate 3 so
 * routes can map them to 422 and say which check failed.
 */
export async function storeIntegrationKey(
  projectId: string,
  integrationId: string,
  rawKey: string,
  options: { skipVerification?: boolean } = {},
): Promise<KeyVaultStatus & { formatWarning?: string }> {
  // ── Secret scan: block dangerous values before they touch the DB ──────────
  const scan = scanForDangerousSecret(rawKey)
  if (scan.isDangerous) {
    throw new Error(scan.warning ?? `Refused to store value that looks like a ${scan.label}`)
  }

  // ── Format validation: reject clearly wrong keys (wrong provider, wrong mode) ──
  const formatCheck = validateIntegrationKeyFormat(integrationId, rawKey)
  if ('error' in formatCheck) {
    throw Object.assign(new Error(formatCheck.error), { isFormatError: true })
  }

  // ── Live verification: ask the provider ───────────────────────────────────
  // `skipVerification` exists for restore/migration paths that are re-filing a
  // credential already known good. It is NOT a connect-time option.
  const verification = options.skipVerification
    ? { status: 'unchecked' as VerificationStatus, detail: 'Verification skipped (internal re-file).' }
    : await verifyIntegrationKey(integrationId, rawKey)

  if (blocksStorage(verification)) {
    throw Object.assign(new Error(verification.detail), { isVerificationError: true })
  }

  const encryptedKey = encrypt(rawKey)
  const maskedKey = maskApiKey(rawKey)
  const verifiedAt = verification.status === 'verified' ? new Date() : null

  const record = await prisma.projectIntegrationKey.upsert({
    where: { projectId_integrationId: { projectId, integrationId } },
    create: {
      projectId, integrationId, encryptedKey, maskedKey,
      verification: verification.status,
      verificationDetail: verification.detail,
      verifiedAt,
    },
    update: {
      encryptedKey, maskedKey, updatedAt: new Date(),
      verification: verification.status,
      verificationDetail: verification.detail,
      verifiedAt,
    },
  })

  const result: KeyVaultStatus & { formatWarning?: string } = {
    integrationId,
    maskedKey: record.maskedKey,
    connectedAt: record.connectedAt.toISOString(),
    verification: verification.status,
    verificationDetail: verification.detail,
  }

  // Surface test-mode warning to callers (e.g. the API route returns it to the UI)
  if ('warning' in formatCheck && formatCheck.warning) {
    result.formatWarning = formatCheck.warning
  }

  return result
}

/**
 * Retrieve the decrypted raw API key — for server-side provider calls only.
 * Never expose the return value to the client.
 */
export async function getIntegrationKey(
  projectId: string,
  integrationId: string
): Promise<string | null> {
  const integrationIds = [integrationId, ...(INTEGRATION_KEY_ALIASES[integrationId] ?? [])]
  const record = await prisma.projectIntegrationKey.findFirst({
    where: {
      projectId,
      integrationId: { in: integrationIds },
    },
    orderBy: { updatedAt: 'desc' },
  })
  if (!record) return null
  return decrypt(record.encryptedKey)
}

/**
 * List key vault statuses for all integrations in a project.
 * Returns masked keys only — safe to send to the client.
 */
export async function listKeyVaultStatuses(projectId: string): Promise<KeyVaultStatus[]> {
  const records = await prisma.projectIntegrationKey.findMany({
    where: { projectId },
    select: {
      integrationId: true, maskedKey: true, connectedAt: true,
      verification: true, verificationDetail: true,
    },
    orderBy: { connectedAt: 'asc' },
  })

  return records.map((r) => ({
    integrationId: r.integrationId,
    maskedKey: r.maskedKey,
    connectedAt: r.connectedAt.toISOString(),
    verification: (r.verification ?? 'unchecked') as VerificationStatus,
    verificationDetail: r.verificationDetail ?? undefined,
  }))
}

/**
 * Re-ask the provider about a credential that is already stored.
 *
 * Verification is a snapshot, not a property: a key revoked in the provider's
 * dashboard yesterday is still marked `verified` here. This is what the
 * integration-health probe and the "Re-check" action call, and it is also the
 * only path that can move a stored key to `rejected` — connect-time refuses
 * those before they land.
 */
export async function recheckIntegrationKey(
  projectId: string,
  integrationId: string,
): Promise<KeyVaultStatus | null> {
  const raw = await getIntegrationKey(projectId, integrationId)
  if (!raw) return null

  const verification = await verifyIntegrationKey(integrationId, raw)
  const record = await prisma.projectIntegrationKey.update({
    where: { projectId_integrationId: { projectId, integrationId } },
    data: {
      verification: verification.status,
      verificationDetail: verification.detail,
      verifiedAt: verification.status === 'verified' ? new Date() : null,
    },
    select: { integrationId: true, maskedKey: true, connectedAt: true },
  })

  return {
    integrationId: record.integrationId,
    maskedKey: record.maskedKey,
    connectedAt: record.connectedAt.toISOString(),
    verification: verification.status,
    verificationDetail: verification.detail,
  }
}

/**
 * Check whether a specific integration has a key stored.
 */
export async function hasIntegrationKey(
  projectId: string,
  integrationId: string
): Promise<boolean> {
  const integrationIds = [integrationId, ...(INTEGRATION_KEY_ALIASES[integrationId] ?? [])]
  const count = await prisma.projectIntegrationKey.count({
    where: {
      projectId,
      integrationId: { in: integrationIds },
    },
  })
  return count > 0
}
