/**
 * Whether a browser origin is a developer's own machine or local network.
 *
 * A project's connected frontends are the CORS allowlist on its SDK routes
 * (middleware.ts), and an empty list admits every origin. A coding agent
 * connects the dev server it is working against, `http://localhost:5173`,
 * long before there is a deployed frontend, and that one connection used to
 * make the list exclusive: once the app was deployed, every browser call from
 * its real origin was refused, while localhost kept working. Development
 * origins therefore never make the list exclusive; only a connected origin
 * that is not one does (allowsAnyOrigin).
 *
 * Edge-safe: the middleware imports it.
 */

function isPrivateIPv4(host: string): boolean {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (!m) return false
  const [a, b] = [Number(m[1]), Number(m[2])]
  return a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254)
}

export function isDevelopmentOrigin(origin: string): boolean {
  let host: string
  try {
    host = new URL(origin).hostname.toLowerCase()
  } catch {
    return false
  }
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1)
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host === '::1' ||
    host === '0.0.0.0' ||
    isPrivateIPv4(host)
  )
}

/**
 * Whether connected origins leave the SDK routes open to every origin: when
 * none is a deployed (non-development) origin.
 */
export function allowsAnyOrigin(connectedOrigins: readonly string[]): boolean {
  return connectedOrigins.every(isDevelopmentOrigin)
}
