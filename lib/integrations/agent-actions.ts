/**
 * What each integration can do from a function, and whether its key still works.
 *
 * An agent could store a provider key but not learn what it then had: the
 * methods ctx.integrations.<id> exposes lived only in the codegen prompt, and
 * re-asking the provider about a stored key was reachable only through
 * fix_backend. Both come from the existing authorities here: the provider
 * registry (integration-registry.ts) and the key vault's own re-check.
 *
 * Nothing here returns a key. The vault's masked form is the most it shows.
 */

import { INTEGRATION_PROVIDERS, resolveProviderId } from '@/lib/services/ai-functions/integration-registry'
import { listKeyVaultStatuses, recheckIntegrationKey } from '@/lib/services/integrationKeyStore'
import { verificationLabel } from '@/lib/integrations/key-verification'

export interface IntegrationActionResult {
  ok: boolean
  summary: string
  data?: unknown
  code?: string
}

/** Vault ids that are not providers, but facts about one. */
const SUB_RECORD = /_webhook_secret$/

/** Stored under a second name for historical reasons. */
const VAULT_ALIASES: Record<string, string[]> = { stripe: ['stripe_secret_key'] }

function origin(): string {
  return (process.env.NEXT_PUBLIC_APP_URL || 'https://backenly.com').replace(/\/+$/, '')
}

export async function integrationCapabilities(
  projectId: string,
  args: { integrationId?: unknown },
): Promise<IntegrationActionResult> {
  let wanted: string | null = null
  if (typeof args.integrationId === 'string' && args.integrationId.trim()) {
    wanted = resolveProviderId(args.integrationId.trim())
    if (!wanted) {
      return {
        ok: false,
        code: 'NOT_FOUND',
        summary: `"${args.integrationId}" is not an integration Backenly has. Known: ${Object.keys(INTEGRATION_PROVIDERS).join(', ')}.`,
      }
    }
  }

  const statuses = await listKeyVaultStatuses(projectId)
  const byId = new Map(statuses.map((s) => [s.integrationId.toLowerCase(), s]))
  const stored = (vaultId: string) =>
    [vaultId, ...(VAULT_ALIASES[vaultId] ?? [])].map((id) => byId.get(id)).find(Boolean)

  const providers = Object.values(INTEGRATION_PROVIDERS)
    .filter((spec) => !wanted || spec.id === wanted)
    .map((spec) => {
      const key = spec.keyStoreIds.map(stored).find(Boolean)
      const entry: Record<string, unknown> = {
        id: spec.id,
        displayName: spec.displayName,
        category: spec.category,
        connected: Boolean(key),
        ...(key
          ? { maskedKey: key.maskedKey, verification: key.verification, verificationDetail: key.verificationDetail ?? null }
          : {}),
        methods: spec.methods.map((m) => ({ name: m.name, call: `await ctx.integrations.${spec.id}.${m.signature}` })),
        ...(spec.keyFormat ? { keyFormat: spec.keyFormat } : {}),
        ...(spec.docsUrl ? { docsUrl: spec.docsUrl } : {}),
      }
      if (spec.id === 'stripe') {
        entry.receiverUrl = `${origin()}/api/v1/${projectId}/webhooks/stripe`
        entry.signingSecretStored = Boolean(byId.get('stripe_webhook_secret'))
        entry.eventLog =
          'Verified events are recorded in the workspace table payment_events when it exists (read it with run_query), ' +
          'and fire functions whose trigger is on_webhook, whose runs are in functions { action: "logs" }.'
      }
      return entry
    })

  const lines = providers.map((p) => {
    const state = p.connected ? verificationLabel(p.verification as any) : 'not connected'
    const names = (p.methods as Array<{ name: string }>).map((m) => m.name).join(', ')
    return `• ${p.id} (${state}): ${names}`
  })
  const stripe = providers.find((p) => p.id === 'stripe')
  const stripeNote = stripe?.connected && !stripe.signingSecretStored
    ? `\n\nStripe has no signing secret yet, so its receiver rejects every event. A human adds ${String(stripe.receiverUrl)} ` +
      'as an endpoint in the Stripe dashboard (Developers → Webhooks) and gives you the whsec_… value for ' +
      'integrations { action: "connect", integrationId: "stripe", webhookSecret }. No API can do that step for them.'
    : ''

  return {
    ok: true,
    summary:
      `Integrations and what a function can call on each (full signatures in data.providers):\n${lines.join('\n')}` +
      stripeNote,
    data: { providers },
  }
}

export async function verifyIntegration(
  projectId: string,
  args: { integrationId?: unknown },
): Promise<IntegrationActionResult> {
  if (typeof args.integrationId !== 'string' || !args.integrationId.trim()) {
    return { ok: false, code: 'INVALID_ARGUMENT', summary: 'integrationId is required, e.g. "stripe".' }
  }
  const raw = args.integrationId.trim().toLowerCase()
  if (SUB_RECORD.test(raw)) {
    return { ok: false, code: 'INVALID_ARGUMENT', summary: 'A webhook signing secret cannot be checked against its provider; verify the provider key instead.' }
  }
  const spec = INTEGRATION_PROVIDERS[resolveProviderId(raw) ?? '']
  const statuses = await listKeyVaultStatuses(projectId)
  const candidates = spec ? spec.keyStoreIds.flatMap((id) => [id, ...(VAULT_ALIASES[id] ?? [])]) : [raw]
  const vaultId = candidates.find((id) => statuses.some((s) => s.integrationId.toLowerCase() === id))
  if (!vaultId) {
    return {
      ok: false,
      code: 'NOT_CONNECTED',
      summary: `No ${raw} key is stored in this project, so there is nothing to verify. Connect it with integrations { action: "connect" }.`,
    }
  }

  const result = await recheckIntegrationKey(projectId, vaultId)
  if (!result) {
    return { ok: false, code: 'KEY_UNREADABLE', summary: `The stored ${vaultId} key could not be decrypted. Store it again.` }
  }
  const label = verificationLabel(result.verification)
  return {
    ok: result.verification !== 'rejected',
    code: result.verification === 'rejected' ? 'KEY_REJECTED' : undefined,
    summary:
      `${vaultId} (${result.maskedKey}): ${label}.` +
      (result.verificationDetail ? ` ${result.verificationDetail}` : '') +
      (result.verification === 'rejected' ? ' Functions calling it will fail until a working key is stored.' : ''),
    data: {
      integrationId: vaultId,
      maskedKey: result.maskedKey,
      verification: result.verification,
      verificationDetail: result.verificationDetail ?? null,
    },
  }
}
