/**
 * Every field the Integrations page stores lands under a vault id the functions
 * runtime reads for that provider (report 52). The credentials route files a
 * field by its name (vaultIdForEnvVar), and falls back to the provider id, so a
 * second field without a name of its own (OneSignal's App ID) would overwrite
 * the provider's key.
 */
import { integrationCatalog } from '@/components/hub/integration-catalog'
import { connectableProviders, getProviderSpec } from '@/lib/services/ai-functions/integration-registry'
import { vaultIdForEnvVar } from '@/lib/services/integrationKeyStore'

const stored = (envVar: string, providerId: string) => vaultIdForEnvVar(envVar) ?? providerId

it('offers exactly the providers the registry serves', () => {
  const offered = integrationCatalog().flatMap((c) => c.providers.map((p) => p.id))
  expect(offered.sort()).toEqual(connectableProviders().map((p) => p.id).sort())
  for (const category of integrationCatalog()) {
    for (const p of category.providers) expect(getProviderSpec(p.id)!.category).toBe(category.id)
  }
})

it('stores each provider’s key under a vault id its runtime reads', () => {
  for (const p of integrationCatalog().flatMap((c) => c.providers)) {
    expect(getProviderSpec(p.id)!.keyStoreIds).toContain(stored(p.envVar, p.id))
  }
})

it('stores a second credential under its own vault id, never over the key', () => {
  for (const p of integrationCatalog().flatMap((c) => c.providers)) {
    if (!p.webhookKey) continue
    expect(vaultIdForEnvVar(p.webhookKey.envVar)).toBe(p.webhookKey.vaultId)
    expect(p.webhookKey.vaultId).not.toBe(stored(p.envVar, p.id))
  }
  expect(vaultIdForEnvVar('ONESIGNAL_REST_API_KEY')).toBe('onesignal')
  expect(vaultIdForEnvVar('ONESIGNAL_APP_ID')).toBe(getProviderSpec('onesignal')!.auxKeyStoreId)
})
