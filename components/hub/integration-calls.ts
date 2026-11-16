/**
 * Which providers a function's stored code calls, found by reading the code.
 *
 * Integrations shows "Called from" on a connector (the functions that would
 * fail if its key went bad), and a function's Code view shows the providers it
 * calls. Both read the exact source the API already returns
 * (GET /api/projects/[id]/ai-functions, `generatedCode`), so no new route is
 * needed. A call made through a computed name (`ctx.integrations[name]`) is
 * missed, which is why the console labels the list "Found in code".
 *
 * Accessors are the names after `ctx.integrations.`, as the runtime builds
 * them (lib/services/ai-functions/integration-context.ts): a provider's id
 * (`stripe`, `onesignal`), an alias (`claude`, `sms`), or `email`, which sends
 * through whichever of Resend and SendGrid is connected.
 */

import { getProviderSpec, resolveProviderId } from '@/lib/services/ai-functions/integration-registry'

const DOT = /ctx\s*\.\s*integrations\s*\??\.\s*([A-Za-z_$][\w$]*)/g
const BRACKET = /ctx\s*\.\s*integrations\s*\??\.?\s*\[\s*(['"`])([A-Za-z_$][\w$-]*)\1\s*\]/g
/** Members of ctx.integrations that are not providers. */
const NOT_PROVIDERS = new Set(['isConnected'])

/** The accessors after `ctx.integrations` in the code, first seen first: ['email', 'onesignal']. */
export function integrationAccessors(code: string | null | undefined): string[] {
  if (!code) return []
  const found: Array<{ at: number; name: string }> = []
  for (const m of code.matchAll(DOT)) found.push({ at: m.index ?? 0, name: m[1] })
  for (const m of code.matchAll(BRACKET)) found.push({ at: m.index ?? 0, name: m[2] })
  const seen = new Set<string>()
  const out: string[] = []
  for (const { name } of found.sort((a, b) => a.at - b.at)) {
    if (NOT_PROVIDERS.has(name) || seen.has(name)) continue
    seen.add(name)
    out.push(name)
  }
  return out
}

/**
 * The connectable providers an accessor reaches: `email` reaches Resend and
 * SendGrid, `claude` reaches Anthropic, an unknown name reaches nothing.
 */
export function providersForAccessor(accessor: string): string[] {
  const id = resolveProviderId(accessor)
  if (!id) return []
  const spec = getProviderSpec(id)
  // `email` is not a provider you connect; it routes to the ones whose keys it reads.
  if (id === 'email' && spec) return [...spec.keyStoreIds]
  return [id]
}

/** The provider ids the code calls, first seen first. */
export function providersCalledIn(code: string | null | undefined): string[] {
  const out: string[] = []
  for (const accessor of integrationAccessors(code)) {
    for (const id of providersForAccessor(accessor)) if (!out.includes(id)) out.push(id)
  }
  return out
}

/** The accessors in the code that reach this provider: ['email'] for Resend. */
export function accessorsFor(providerId: string, code: string | null | undefined): string[] {
  return integrationAccessors(code).filter((a) => providersForAccessor(a).includes(providerId))
}

/** The functions whose code calls the provider, in the order given: Integrations' "Called from". */
export function functionsCalling<T extends { generatedCode?: string | null }>(providerId: string, functions: readonly T[]): T[] {
  return functions.filter((f) => providersCalledIn(f.generatedCode).includes(providerId))
}

/**
 * The functions whose calls wait on this provider: they call it, and nothing
 * connected serves that call. `ctx.integrations.email` is served by Resend or
 * SendGrid, so with Resend connected it does not wait on SendGrid.
 */
export function functionsWaitingOn<T extends { generatedCode?: string | null }>(
  providerId: string,
  functions: readonly T[],
  connected: readonly string[],
): T[] {
  return functions.filter((f) =>
    integrationAccessors(f.generatedCode).some((a) => {
      const reach = providersForAccessor(a)
      return reach.includes(providerId) && !reach.some((p) => connected.includes(p))
    }),
  )
}
