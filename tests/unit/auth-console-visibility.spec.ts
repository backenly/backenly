/**
 * Auth console coverage pins (AUTH-F7, AUTH-F9).
 *
 * F7: the Configuration tab and lib/services/auth-status.ts listed only
 * google/github, while the OAuth runtime also serves discord and facebook —
 * an agent-activated provider worked for end users but had no console row to
 * see or disable it.
 *
 * F9: the Users tab stored one 50-row page from an uncapped fetch and showed
 * its length as the user count, so large projects under-reported and rows
 * past the first page were unreachable.
 */

import fs from 'fs'
import path from 'path'

const ROOT = process.cwd()
const configPage = fs.readFileSync(path.join(ROOT, 'components', 'auth', 'AuthConfiguration.tsx'), 'utf8')
const workbench = fs.readFileSync(path.join(ROOT, 'components', 'auth', 'AuthWorkbench.tsx'), 'utf8')
const authStatus = fs.readFileSync(path.join(ROOT, 'lib', 'services', 'auth-status.ts'), 'utf8')
const oauthRoutes = fs.readFileSync(path.join(ROOT, 'server', 'routes', 'oauth.ts'), 'utf8')
const saveRoute = fs.readFileSync(path.join(ROOT, 'app', 'api', 'projects', '[id]', 'credentials', 'route.ts'), 'utf8')
const keyStore = fs.readFileSync(path.join(ROOT, 'lib', 'services', 'integrationKeyStore.ts'), 'utf8')

describe('AUTH-F7: provider universe', () => {
  it('the runtime really serves discord and facebook', () => {
    expect(oauthRoutes).toContain('discord')
    expect(oauthRoutes).toContain('facebook')
  })

  it('the Configuration tab renders every served provider', () => {
    expect(configPage).toContain("'google', 'github', 'discord', 'facebook'")
  })

  it('auth-state knows the same set', () => {
    expect(authStatus).toMatch(/KNOWN_OAUTH_PROVIDERS[^\n]*\n?[^\n]*'discord'/)
  })

  it('saving a card reaches workspaceOAuthConfig for every provider', () => {
    // The save route recognises each provider's env keys, through the key
    // store's one env-var map (INT-08 moved it there so a credential is one row)…
    expect(saveRoute).toContain('vaultIdForEnvVar(envVar)')
    expect(keyStore).toContain("discord_client_id: 'discord'")
    expect(keyStore).toContain("facebook_client_id: 'facebook'")
    // …and gates the workspaceOAuthConfig upsert on the provider SET, not on a
    // hardcoded google/github pair that silently drops everyone else.
    expect(saveRoute).toContain('OAUTH_PROVIDERS.includes(integrationId)')
    expect(saveRoute).not.toContain("integrationId === 'google' || integrationId === 'github'")
  })
})

describe('AUTH-F9: the Users tab', () => {
  it('pages through the route cap instead of storing one page', () => {
    expect(workbench).toContain('limit=200&page=')
    expect(workbench).toContain('totalPages')
  })

  it('shows the server total, not the loaded length', () => {
    expect(workbench).toContain("${total.toLocaleString()} ${total === 1 ? 'user' : 'users'}")
    expect(workbench).not.toContain("${users.length.toLocaleString()} ${users.length === 1")
  })
})
