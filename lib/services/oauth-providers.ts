/**
 * The end-user OAuth providers the runtime actually serves: the keys of
 * PROVIDER_AUTH_URLS in server/routes/oauth.ts.
 *
 * Every surface that tells an agent which providers exist reads this list, so
 * nothing can advertise a provider with no sign-in flow behind it. Apple was
 * offered by add_oauth_provider, its client secret was stored and the
 * receipt said "Routes activated", while every end-user attempt answered 404
 * (medium finding AUTH-F8). tests/integration/agent-doors-agree.spec.ts pins
 * this list to the runtime's.
 *
 * Dependency-free on purpose: the brain's tool schemas import it at load.
 */
export const SERVED_OAUTH_PROVIDERS = ['google', 'github', 'discord', 'facebook'] as const

export type ServedOAuthProvider = (typeof SERVED_OAUTH_PROVIDERS)[number]

export function isServedOAuthProvider(provider: string): provider is ServedOAuthProvider {
  return (SERVED_OAUTH_PROVIDERS as readonly string[]).includes(provider)
}
