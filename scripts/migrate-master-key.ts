/**
 * One-shot migration: re-encrypt every Project.jwtSecret with the new
 * MASTER_ENCRYPTION_KEY.
 *
 * Run order:
 *   1. Generate a new 32-byte key:
 *        node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 *   2. Set MASTER_ENCRYPTION_KEY=<new key> in .env on prod.
 *      Leave ALLOW_LEGACY_MASTER_KEY=1 (or unset) so we can still decrypt
 *      the existing all-zero-key ciphertext.
 *   3. Deploy.
 *   4. Run this script:        npx tsx scripts/migrate-master-key.ts
 *   5. Verify the report shows 0 failures.
 *   6. Set ALLOW_LEGACY_MASTER_KEY=0 in .env to disable the zero-key fallback.
 *
 * Idempotent: rows are decrypted then re-encrypted with the active key. If a
 * row was already encrypted with the new key it succeeds on the first decrypt
 * attempt and gets re-written (with a fresh IV — harmless).
 */

import { prisma } from '@/lib/db'
import { JWTSecretManager } from '@/lib/services/jwtSecretManager'

async function main() {
  if (!process.env.MASTER_ENCRYPTION_KEY) {
    console.error('FATAL: set MASTER_ENCRYPTION_KEY in env before running this script.')
    process.exit(1)
  }

  const rows = await prisma.project.findMany({
    where: { jwtSecret: { not: null } },
    select: { id: true, name: true },
  })

  console.log(`Found ${rows.length} projects with jwtSecret. Migrating…`)

  let ok = 0
  let skipped = 0
  const failures: Array<{ id: string; name: string; error: string }> = []

  for (const row of rows) {
    try {
      const result = await JWTSecretManager.reencryptForProject(row.id)
      if (result.migrated) ok++
      else skipped++
    } catch (e: any) {
      failures.push({ id: row.id, name: row.name, error: e?.message ?? 'unknown' })
    }
  }

  console.log(`\nDone.\n  migrated: ${ok}\n  skipped:  ${skipped}\n  failures: ${failures.length}`)
  if (failures.length > 0) {
    console.log('\nFailures:')
    for (const f of failures) console.log(`  ${f.id} (${f.name}): ${f.error}`)
    process.exit(2)
  }
  await prisma.$disconnect()
}

main().catch((e) => {
  console.error('Migration crashed:', e)
  process.exit(1)
})
