/**
 * Origin classification shared by the Next v1 middleware, the Express runtime
 * auth layer, and the Connection Health reader.
 *
 * Deliberately framework-free: server/ code imports this without dragging
 * next/server in (server/lib/auth.ts mirrors lib/api/v1/middleware.ts and
 * must stay Express-pure).
 */

export const INTERNAL_DOMAINS = ['backenly.com', 'www.backenly.com', 'localhost', '127.0.0.1']

/**
 * Classify an Origin/Referer string as "platform itself" (backenly.com, local
 * dev). Used to suppress dashboard-originated traffic from the Connection
 * Health panel — the platform dogfooding its own v1 runtime is not a real
 * frontend and must not surface as one to the project owner.
 */
export function isInternalOrigin(origin: string | null | undefined): boolean {
  if (!origin) return false
  try {
    const host = new URL(origin).hostname
    return INTERNAL_DOMAINS.some(d => host === d || host.endsWith(`.${d}`))
  } catch {
    return false
  }
}
