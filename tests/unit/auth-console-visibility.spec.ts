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
 * past the first page were unreachable. Since the console rebuild
 * (2026-11-16) the server pages and searches the list, and the count is the
 * server's total.
 */

import fs from 'fs'
import path from 'path'

const ROOT = process.cwd()
const configPage = fs.readFileSync(path.join(ROOT, 'components', 'auth', 'AuthConfiguration.tsx'), 'utf8')
const providers = fs.readFileSync(path.join(ROOT, 'components', 'auth', 'providers.tsx'), 'utf8')
const workbench = fs.readFileSync(path.join(ROOT, 'components', 'auth', 'AuthWorkbench.tsx'), 'utf8')
const usersApi = fs.readFileSync(path.join(ROOT, 'components', 'auth', 'api.ts'), 'utf8')
const usersPane = fs.readFileSync(path.join(ROOT, 'components', 'auth', 'UsersPane.tsx'), 'utf8')
const authStatus = fs.readFileSync(path.join(ROOT, 'lib', 'services', 'auth-status.ts'), 'utf8')
const oauthRoutes = fs.readFileSync(path.join(ROOT, 'server', 'routes', 'oauth.ts'), 'utf8')
const saveRoute = fs.readFileSync(path.join(ROOT, 'app', 'api', 'projects', '[id]', 'credentials', 'route.ts'), 'utf8')
const keyStore = fs.readFileSync(path.join(ROOT, 'lib', 'services', 'integrationKeyStore.ts'), 'utf8')

describe('AUTH-F7: provider universe', () => {
  it('the runtime really serves discord and facebook', () => {
    expect(oauthRoutes).toContain('discord')
    expect(oauthRoutes).toContain('facebook')
  })

  it('the Sign-in methods tab renders every served provider', () => {
    expect(providers).toContain("'google', 'github', 'discord', 'facebook'")
    expect(configPage).toContain('OAUTH_PROVIDER_IDS.map(')
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
  it('asks the server for each page and each search, instead of storing one page', () => {
    expect(usersApi).toContain('page: String(opts.page)')
    expect(usersApi).toContain("qs.set('search', opts.search)")
    expect(usersApi).toContain('totalPages')
    expect(usersPane).toContain('pages={data.totalPages}')
  })

  it('shows the server total, not the loaded length', () => {
    expect(workbench).toContain('const total = stats?.totalUsers')
    expect(workbench).toContain("${total.toLocaleString('en-US')} ${total === 1 ? 'user' : 'users'}")
    expect(workbench).not.toMatch(/users\.length\.toLocaleString/)
  })
})
