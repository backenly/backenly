/**
 * What the Integrations page knows about each provider, and how it says it.
 *
 * Pure functions over GET /api/projects/[id]/integrations, so the list, the
 * connector page and the tests read one answer the same way.
 *
 * Connected means the provider's key is in the vault: the functions runtime
 * builds ctx.integrations from the vault alone
 * (lib/services/ai-functions/integration-context.ts), so a switch left on in
 * `activeIntegrations` with no key behind it is not connected. A provider that
 * needs a second credential (Stripe's signing secret, OneSignal's App ID)
 * counts as connected only with both stored: the page says which one is
 * missing instead of showing the row as connected.
 *
 * Verification is never folded into "connected" (INT-13): what the provider
 * said about the key is its own state. A confirmed key is the glyph alone; the
 * row writes a word out only where it asks the person to act (Key rejected,
 * Add the webhook secret), and says the quieter states as a faint fact.
 */

import type { GlyphState } from '@/components/inspector/kit'
import type { CatalogCategory, CatalogProvider } from './integration-catalog'

export type KeyVerification = 'verified' | 'rejected' | 'unverifiable' | 'unreachable' | 'unchecked'

/** One stored credential, as the GET route sends it (masked, never the key). */
export interface KeyStatus {
  maskedKey: string
  connectedAt: string
  verification?: KeyVerification | string
  verificationDetail?: string
  /** When the provider last confirmed it; null when it never has. */
  verifiedAt?: string | null
}

export interface IntegrationsAnswer {
  integrations: Record<string, { enabled?: boolean } | undefined>
  keyVault: Record<string, KeyStatus | undefined>
}

export interface ProviderState {
  provider: CatalogProvider
  category: Pick<CatalogCategory, 'id' | 'title'>
  /** The provider's key, when one is stored. */
  key: KeyStatus | null
  /** The second credential, when the provider has one and it is stored. */
  second: KeyStatus | null
  /** The key is stored: functions can call the provider. */
  connected: boolean
  /** Connected, and a second credential it needs is not stored. */
  needsSecond: boolean
  /** Connected with everything it needs: what the header counts. */
  complete: boolean
}

/** Every catalog provider with what the answer says about it, in the catalog's order. */
export function providerStates(
  catalog: readonly CatalogCategory[],
  answer: IntegrationsAnswer | null,
): ProviderState[] {
  const vault = answer?.keyVault ?? {}
  return catalog.flatMap((category) =>
    category.providers.map((provider) => {
      const key = vault[provider.id] ?? null
      const second = provider.webhookKey ? vault[provider.webhookKey.vaultId] ?? null : null
      const connected = !!key
      const needsSecond = connected && !!provider.webhookKey && !second
      return {
        provider,
        category: { id: category.id, title: category.title },
        key,
        second,
        connected,
        needsSecond,
        complete: connected && !needsSecond,
      }
    }),
  )
}

export interface ProviderStatus {
  glyph: GlyphState
  /** The state in words: the glyph's name for screen readers, and the connector page's fact. */
  label: string
  /** Written beside the name in a list, only where the state asks the person to act. */
  word?: string
  /** A quieter state, said as a faint fact under the name (its reason in `detail`). */
  fact?: string
  /** The provider's own words about the key. */
  detail?: string
}

/**
 * How a provider reads. A rejected key is the bigger problem, so it wins over
 * a missing second credential; a quiet verification state is still said as a
 * fact when a word is shown.
 */
export function providerStatus(s: ProviderState): ProviderStatus {
  if (!s.connected) return { glyph: 'idle', label: 'Not connected' }
  const name = s.provider.name
  const verification = s.key?.verification ?? 'unchecked'
  const detail = s.key?.verificationDetail || undefined
  const fact =
    verification === 'unverifiable' ? 'Format checked only'
    : verification === 'unreachable' ? `Couldn’t reach ${name}`
    : verification === 'unchecked' ? 'Not checked yet'
    : undefined
  if (verification === 'rejected') return { glyph: 'failed', label: 'Key rejected', word: 'Key rejected', detail }
  if (s.needsSecond && s.provider.webhookKey) {
    const word = `Add the ${s.provider.webhookKey.noun}`
    return { glyph: 'waiting', label: word, word, fact, detail: fact ? detail : undefined }
  }
  if (fact) return { glyph: 'idle', label: fact, fact, detail }
  return { glyph: 'live', label: 'Connected', detail }
}

/** A stored credential's own state, for its row on the connector page. */
export function credentialGlyph(status: KeyStatus | null): { glyph: GlyphState; label: string } {
  if (!status) return { glyph: 'idle', label: 'Not stored' }
  switch (status.verification) {
    case 'verified':
      return { glyph: 'live', label: 'Confirmed' }
    case 'rejected':
      return { glyph: 'failed', label: 'Rejected' }
    case 'unreachable':
      return { glyph: 'idle', label: 'Could not be checked' }
    case 'unverifiable':
      return { glyph: 'idle', label: 'Format checked only' }
    default:
      return { glyph: 'idle', label: 'Not checked yet' }
  }
}

/**
 * Whether asking the provider again can change anything. A key no probe can
 * confirm (PostHog's write-only ingest key, a webhook signing secret) answers
 * the same every time, so Check again is not offered for it.
 */
export function canRecheck(s: ProviderState): boolean {
  return s.connected && s.key?.verification !== 'unverifiable'
}

/** "re_d7a8…9dac": the stored mask with its run of dots said once. */
export function shortKey(masked: string): string {
  return masked.replace(/•+/g, '…')
}

/** "1 function", "2 functions". */
export function functionsCount(n: number): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? 'function' : 'functions'}`
}

/**
 * The request handed to the coding agent for one thing to build.
 *
 * A bare intent ("Add subscription billing") sent to an agent sitting in the
 * user's app repo reads as a request to write Stripe code in the repo: it asks
 * for the key again and builds nothing in Backenly. So each request says where
 * the work belongs, which door to use (with the CLI for a conversation whose
 * MCP tools have not loaded yet), and that the key is already stored and must
 * stay out of code. One request per option: composing several is faster in the
 * agent itself.
 */
export function buildRequest(provider: Pick<CatalogProvider, 'id' | 'name'>, projectId: string, intent: string): string {
  return (
    `In my Backenly backend (project ${projectId}): ${intent.trim().replace(/\.$/, '')}. ` +
    `Build it in Backenly with its tools: backend_chat over MCP, or ` +
    `npx -y @backenly/cli@latest chat "…" if the MCP tools are not loaded in this conversation. ` +
    `My ${provider.name} key is already stored in Backenly and Backenly functions reach it as ` +
    `ctx.integrations.${provider.id}. Do not ask me for the key and do not put it in code.`
  )
}

/** The options to build with a provider, with one for a provider whose catalog entry has none. */
export function buildOptions(provider: Pick<CatalogProvider, 'name' | 'quickOptions'>): Array<{ label: string; intent: string }> {
  if (provider.quickOptions.length > 0) return provider.quickOptions
  return [{ label: `Use ${provider.name} from a function`, intent: `Add the ${provider.name} integration` }]
}

/** Where a provider sends events, under the project's API base; null when there is no base. */
export function receivingUrl(apiBase: string | null, path: string): string | null {
  if (!apiBase) return null
  return `${apiBase.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`
}
