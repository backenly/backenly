/**
 * `npm run db:seed`.
 *
 * A public checkout has nothing to seed. Backenly's billing seed
 * (prisma/seed-billing.ts) is commercial data for the Cloud plans table and it
 * lives in the private overlay; a self-hosted install needs no Plan row and no
 * Subscription row, because single-tenant entitlements come from the edition.
 *
 * So this wrapper runs the private seeder when the overlay has been applied and
 * succeeds quietly when it has not. Pointing package.json straight at a file
 * that OSS does not ship would make `npm run db:seed` fail with a
 * module-not-found on a fresh clone, which reads as a broken install rather
 * than an absent feature.
 *
 * Deliberately NOT a fallback that creates a Free plan. Manufacturing a
 * commercial row to satisfy an assumption the public product no longer makes
 * would put the seed requirement back, which is the thing single-tenant exists
 * without.
 */
import { existsSync } from 'fs'
import { spawnSync } from 'child_process'
import * as path from 'path'

const SEEDER = path.join(process.cwd(), 'prisma', 'seed-billing.ts')

if (!existsSync(SEEDER)) {
  console.log('[db:seed] No billing seed in this checkout.')
  console.log('[db:seed] Nothing to do: self-hosted Backenly needs no Plan or Subscription row.')
  process.exit(0)
}

console.log('[db:seed] Running the Cloud billing seed...')
const run = spawnSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', SEEDER], {
  stdio: 'inherit',
  cwd: process.cwd(),
})

// Surface the seeder's real status. A seed that failed must not look like one
// that was simply absent.
process.exit(run.status ?? 1)
