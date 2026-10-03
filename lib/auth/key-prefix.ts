/**
 * The prefixes of the credentials Backenly issues, in one place.
 *
 * Keys used to be minted with whatever prefix the issuing site chose: the
 * dashboard's key route, key rotation and every project's default key used
 * `sk_live_` / `sk_test_`, which is Stripe's secret-key format (and `sk_test_`
 * there meant the WRITE role, not a test key). Everywhere else the product
 * treats that prefix as Stripe's: the chat asks users to paste Stripe keys in
 * that form and files a pasted `sk_live_…` as a Stripe integration key. So a
 * Backenly key looked like a provider secret to every human and tool reading
 * it, while the brain's own create_api_key already minted `proj_live_` /
 * `svc_live_`.
 *
 * New keys take their prefix from what the key IS, not from its role; the role
 * is in the row. Keys already issued keep working: authentication is by hash
 * and never reads the prefix.
 */

import crypto from 'crypto'

export const ISSUED_PREFIX = {
  /** Bound by row-level security; safe in a browser bundle. */
  project: 'proj_live_',
  /** Bypasses row-level security; server-side only. */
  service: 'svc_live_',
  /** An MCP connection for a coding agent. */
  mcp: 'mcp_live_',
  /** A platform key for the dashboard API. */
  dashboard: 'dk_admin_',
} as const

/** Prefixes keys were minted with before this taxonomy. Still valid; never issued again. */
export const LEGACY_PREFIXES = ['sk_live_', 'sk_test_', 'sk_read_', 'sk_ai_', 'sk_client_', 'sk_service_'] as const

export function issuedKeyPrefix(kind: { keyType?: string | null; scope?: string | null; serviceRole?: boolean | null }): string {
  if (kind.keyType === 'dashboard') return ISSUED_PREFIX.dashboard
  if (kind.scope === 'mcp') return ISSUED_PREFIX.mcp
  if (kind.serviceRole) return ISSUED_PREFIX.service
  return ISSUED_PREFIX.project
}

/** A new credential of this kind: its prefix and 32 random bytes as hex. */
export function mintKey(kind: Parameters<typeof issuedKeyPrefix>[0]): { key: string; prefix: string } {
  const prefix = issuedKeyPrefix(kind)
  return { key: `${prefix}${crypto.randomBytes(32).toString('hex')}`, prefix }
}

const BACKENLY_SHAPE = new RegExp(
  `^(?:${[...Object.values(ISSUED_PREFIX), ...LEGACY_PREFIXES].join('|')})[a-f0-9]{32,}$`,
  'i',
)

/**
 * Whether a value has the shape of a key Backenly issued, current or legacy.
 * Backenly keys are hex after the prefix; a Stripe secret is mixed-case
 * alphanumeric, so `sk_live_` alone does not decide it.
 */
export function looksLikeBackenlyKey(value: string): boolean {
  return BACKENLY_SHAPE.test(value.trim())
}
