/**
 * THE ONE PLACE THAT DECIDES WHETHER AN API KEY'S PLAINTEXT MAY BE PERSISTED
 * ==========================================================================
 *
 * Short answer: it may not. `ApiKey.key` is never written. This module exists
 * to make that a named, shared rule rather than an assumption repeated at three
 * issuance sites, because it was the disagreement between those three sites
 * that produced the defect.
 *
 * ── WHAT WAS WRONG ─────────────────────────────────────────────────────────
 *
 * `ApiKey` carries two columns for one credential: `keyHash` (SHA-256, unique,
 * indexed) and `key` (nullable plaintext). Authentication reads ONLY the hash —
 * lib/auth/apiKeyAuth.ts, lib/auth/server.ts, lib/mcp/auth.ts and
 * lib/middleware/apiKeyAuth.ts all look up by `keyHash`. The plaintext column
 * is not load-bearing for auth and never was.
 *
 * It was nonetheless written unconditionally at issuance, under a comment
 * claiming "Development only", with no environment gate anywhere. A database
 * dump therefore handed over working credentials rather than useless hashes,
 * and an `mcp`-scoped key can create, alter and drop a customer's tables.
 *
 * ── WHY THERE IS NO "PUBLIC KEYS ARE FINE" EXEMPTION ───────────────────────
 *
 * The obvious fix is to keep plaintext for public keys and drop it for secret
 * ones. `ApiKey.keyType` looks like the field for that. It is not, and this is
 * the trap worth writing down:
 *
 *   • `keyType` only ever takes `'dashboard' | 'public'`. `'public'` means
 *     "not a dashboard key" — it does NOT mean "safe to publish".
 *   • A `keyType: 'public'` key with `role: 'admin'` is issued with an
 *     `sk_live_` prefix. Every `sk_*` credential in the system is a
 *     `keyType: 'public'` row.
 *
 * So a `keyType === 'public'` exemption would have preserved plaintext storage
 * for precisely the secret credentials this change exists to protect, while
 * looking like a fix.
 *
 * The genuinely public credential is the project's anon key, and it does not
 * need this column: app/api/projects/[id]/anon-key/route.ts already registers
 * the anon key in `ApiKey` with a hash and NO `key` value, and stores the
 * plaintext on `Project.anonKey`, which is public by design and is what the
 * dashboard and generated frontend snippets read. Nothing needs `ApiKey.key`
 * to be recoverable, so nothing gets it.
 *
 * ── DISPLAY ────────────────────────────────────────────────────────────────
 *
 * The list endpoint's mask was the last reader of the plaintext, and it used it
 * only to render four trailing characters. `maskFromPrefix` rebuilds the
 * display from `keyPrefix`, which is non-secret metadata already on every row.
 * Losing those four characters is the entire user-visible cost.
 */

/**
 * The value to write to `ApiKey.key` at issuance.
 *
 * Always null. A function rather than a literal so that every issuance path
 * names the decision, and so that a future change of policy happens here once
 * instead of at each call site — which is how the paths drifted apart before.
 *
 * The full key is still returned to the caller EXACTLY ONCE, in the HTTP
 * response at creation or rotation. Persisting it is what stops.
 */
export function plaintextForStorage(): null {
  return null
}

/**
 * Display form for a key that is no longer recoverable.
 *
 * Built from `keyPrefix`, never from the secret.
 */
export function maskFromPrefix(keyPrefix: string | null | undefined): string {
  if (!keyPrefix) return ''
  return `${keyPrefix}${'•'.repeat(8)}`
}

/**
 * Does this row still carry persisted plaintext?
 *
 * Used by the manual backfill script to find pre-existing rows, and by the
 * regression tests. Kept here so "what counts as a leaked row" has one
 * definition rather than a repeated `key !== null` scattered around.
 */
export function hasPersistedPlaintext(row: { key?: string | null }): boolean {
  return typeof row.key === 'string' && row.key.length > 0
}
