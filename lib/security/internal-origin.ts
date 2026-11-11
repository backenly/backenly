/**
 * Origin classification shared by the Next v1 middleware, the Express runtime
 * auth layer, and the Connection Health reader.
 *
 * Deliberately framework-free: server/ code imports this without dragging
 * next/server in (server/lib/auth.ts mirrors lib/api/v1/middleware.ts and
 * must stay Express-pure).
 */

/**
 * Backenly's own domains and the hosts a developer runs things on. The
 * "external users" milestone (lib/api/v1/middleware.ts) reads these: a request
 * from a developer's own machine is not a real external user.
 */
export const INTERNAL_DOMAINS = ['backenly.com', 'www.backenly.com', 'localhost', '127.0.0.1']

/** Backenly's own domains: the console, the site and the docs. */
const BACKENLY_DOMAIN = 'backenly.com'

/**
 * Classify an Origin/Referer string as the platform itself: Backenly's own
 * domains, and the origin this deployment's console is served on
 * (NEXT_PUBLIC_APP_URL, scheme, host and port). Connection Health leaves those
 * out: the console calling the runtime is not the project's frontend.
 *
 * A developer's app on localhost IS a frontend. Production QA (2026-11-09) ran
 * its store at localhost:5173 against a Cloud project, and every one of its
 * requests was set aside as "the platform", so the console said "Frontend: Not
 * connected". localhost is the platform only where the platform itself is
 * served there (local development of Backenly), and then on its own port only.
 */
export function isInternalOrigin(origin: string | null | undefined): boolean {
  if (!origin) return false
  let url: URL
  try {
    url = new URL(origin)
  } catch {
    return false
  }
  if (url.hostname === BACKENLY_DOMAIN || url.hostname.endsWith(`.${BACKENLY_DOMAIN}`)) return true
  try {
    const platform = process.env.NEXT_PUBLIC_APP_URL ? new URL(process.env.NEXT_PUBLIC_APP_URL).origin : null
    return platform !== null && url.origin === platform
  } catch {
    return false
  }
}
