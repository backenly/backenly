/**
 * MANUAL BACKFILL — null out persisted API-key plaintext on existing rows.
 *
 * DELIBERATELY NOT AUTOMATED. This is not wired into `npm run build`, any
 * deploy step, a package lifecycle hook, or a Prisma migration, and it must not
 * be. It rewrites live credential rows, so it runs when a human decides it
 * runs, against a database that human has chosen, after a backup they have
 * taken.
 *
 * ── WHAT IT FIXES ──────────────────────────────────────────────────────────
 *
 * `ApiKey` has two columns for one credential: `keyHash` (SHA-256, what every
 * authentication path actually looks up) and `key` (nullable plaintext). Until
 * the accompanying change, `key` was written unconditionally at issuance under
 * a comment claiming "Development only", with no environment gate. So a
 * database dump handed over working credentials rather than useless hashes, and
 * an `mcp`-scoped key can create, alter and drop a customer's tables.
 *
 * The code no longer writes that column. This clears what was written before.
 *
 * ── WHY IT IS SAFE ─────────────────────────────────────────────────────────
 *
 * Nulling `key` cannot log anyone out or invalidate anything. Authentication
 * reads `keyHash` only — lib/auth/apiKeyAuth.ts, lib/auth/server.ts,
 * lib/mcp/auth.ts, lib/middleware/apiKeyAuth.ts — and this script never touches
 * `keyHash`. Every existing key keeps working; it simply stops being readable
 * out of the database.
 *
 * `Project.anonKey` is NOT touched. Anon keys are public by design and the
 * dashboard and generated frontend snippets read them back.
 *
 * ── OUTPUT DISCIPLINE ──────────────────────────────────────────────────────
 *
 * Counts and non-secret metadata only. No key material, no hashes, no
 * connection strings, no environment contents. `keyPrefix` is deliberately the
 * widest thing printed: it is already returned by the list API to any
 * authenticated owner and is stored precisely so a key can be identified
 * without revealing it.
 *
 * Usage:
 *   npx tsx scripts/scrub-plaintext-api-keys.ts            # dry run, changes nothing
 *   npx tsx scripts/scrub-plaintext-api-keys.ts --apply    # performs the update
 */

import { prisma as defaultPrisma } from '../lib/db/prisma'

/** Rows carrying plaintext. Selects no secret column. */
const WHERE = { key: { not: null } } as const

/**
 * The minimum surface this needs, so a test can pass a fake and prove that a
 * dry run performs no write. The `--apply` guard protects live credential rows;
 * asserting it by reading the source is weaker than exercising it.
 */
export interface ScrubClient {
  apiKey: {
    findMany(args: unknown): Promise<Array<Record<string, unknown>>>
    updateMany(args: unknown): Promise<{ count: number }>
    count(args: unknown): Promise<number>
  }
}

export interface ScrubOptions {
  apply?: boolean
  client?: ScrubClient
  log?: (msg: string) => void
}

export async function scrubPlaintextApiKeys(opts: ScrubOptions = {}): Promise<void> {
  const APPLY = opts.apply ?? false
  const prisma = (opts.client ?? defaultPrisma) as ScrubClient
  const console = { log: opts.log ?? globalThis.console.log, error: globalThis.console.error }

  const affected = await prisma.apiKey.findMany({
    where: WHERE,
    // Never select `key`. Nothing here needs to read the secret to clear it,
    // and a script that fetched it could log it by accident later.
    select: {
      id: true,
      keyPrefix: true,
      keyType: true,
      scope: true,
      serviceRole: true,
      createdAt: true,
    },
    orderBy: { createdAt: 'asc' },
  })

  if (affected.length === 0) {
    console.log('✓ No API key rows carry persisted plaintext. Nothing to do.')
    return
  }

  // Grouped so the operator can see the shape of the exposure without seeing
  // any of it. Service-role and mcp-scoped rows are called out because those
  // are the credentials that can change a customer's schema.
  const byPrefix = new Map<string, number>()
  let serviceRole = 0
  let mcpScoped = 0
  for (const row of affected) {
    const label = (row.keyPrefix as string) || '(no prefix)'
    byPrefix.set(label, (byPrefix.get(label) ?? 0) + 1)
    if (row.serviceRole) serviceRole++
    if (row.scope && row.scope !== 'runtime') mcpScoped++
  }

  console.log(`Rows with persisted plaintext: ${affected.length}`)
  console.log(`  service-role rows: ${serviceRole}`)
  console.log(`  non-runtime scope rows: ${mcpScoped}`)
  console.log('  by key prefix:')
  for (const [prefix, count] of [...byPrefix.entries()].sort()) {
    console.log(`    ${prefix.padEnd(14)} ${count}`)
  }
  const oldest = affected[0]?.createdAt as Date | undefined
  const newest = affected[affected.length - 1]?.createdAt as Date | undefined
  if (oldest && newest) {
    console.log(`  issued between ${oldest.toISOString()} and ${newest.toISOString()}`)
  }

  if (!APPLY) {
    console.log('')
    console.log('DRY RUN — nothing was changed.')
    console.log('Re-run with --apply to null the plaintext on these rows.')
    console.log('Authentication is unaffected: it reads keyHash, which this does not touch.')
    return
  }

  const result = await prisma.apiKey.updateMany({ where: WHERE, data: { key: null } })
  console.log('')
  console.log(`✓ Cleared plaintext on ${result.count} row(s).`)

  // Verify rather than trust the driver's reported count.
  const remaining = await prisma.apiKey.count({ where: WHERE })
  if (remaining > 0) {
    console.error(`✗ ${remaining} row(s) still carry plaintext. Re-run, or investigate.`)
    process.exitCode = 1
    return
  }
  console.log('✓ Verified: no API key row carries persisted plaintext.')
}

// Runs only when invoked directly, never on import, so the test above can
// exercise the function without touching a database.
if (require.main === module) {
  scrubPlaintextApiKeys({ apply: process.argv.includes('--apply') })
    .catch((err: unknown) => {
      // Message only. A Prisma error object can carry the query and its
      // parameters, and the parameter here would be the credential.
      console.error(
        'scrub-plaintext-api-keys failed:',
        err instanceof Error ? err.message : 'unknown error',
      )
      process.exitCode = 1
    })
    .finally(() => defaultPrisma.$disconnect())
}
