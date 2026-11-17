/**
 * report-check-accounts.ts — Backenly's own check accounts left in projects'
 * users tables.
 *
 * Backenly's checks sign throwaway end users up to exercise sign-up, sign-in
 * and row-level security, and remove them when they finish. A sign-up that
 * completed after its check gave up, or a process stopped mid-check, left some
 * behind: the Auth page leaves them out, the Database tab and the app's own
 * queries count them (production QA re-test, 2026-11-16, #20). The checks now
 * remove them (lib/services/check-account-cleanup.ts); this lists, and with
 * --apply removes, the ones already there.
 *
 * Only Backenly's exact check-account addresses are matched
 * (lib/services/check-accounts.ts), never every `.internal` address: people
 * have those. --apply removes only accounts older than 15 minutes, which no
 * check still in progress owns, with their email-verification, magic-link and
 * password-reset rows.
 *
 *   npx tsx scripts/report-check-accounts.ts                  # every project, read-only
 *   npx tsx scripts/report-check-accounts.ts --project <uuid>
 *   npx tsx scripts/report-check-accounts.ts --apply          # remove them
 *
 * Prints one line per project that has any: project, owner's email, accounts
 * found, how many are older than 15 minutes, and what --apply removed or why
 * it could not.
 */
import { prisma } from '@/lib/db'

const flag = process.argv.indexOf('--project')
const ONLY = flag > -1 ? process.argv[flag + 1] : null
const APPLY = process.argv.includes('--apply')

async function main(): Promise<void> {
  const { reportCheckAccounts } = await import('@/lib/services/check-account-cleanup')
  const projects = await prisma.project.findMany({
    where: ONLY ? { id: ONLY } : {},
    select: { id: true, user: { select: { email: true } } },
    orderBy: { createdAt: 'asc' },
  })
  let found = 0
  let removed = 0
  let affected = 0
  let failed = 0
  for (const p of projects) {
    try {
      const r = await reportCheckAccounts(p.id, APPLY)
      if (r.found === 0) continue
      affected++
      found += r.found
      removed += r.removed
      const outcome = !APPLY
        ? ''
        : r.failure
          ? `\tnot removed: ${r.failure}`
          : `\tremoved ${r.removed}`
      if (r.failure) failed++
      console.log(`${p.id}\t${p.user?.email ?? '-'}\t${r.found} check account(s)\t${r.stale} older than 15 min${outcome}`)
    } catch (err) {
      failed++
      console.error(`${p.id}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  console.log(
    `${found} check account(s) in ${affected} of ${projects.length} project(s)` +
      (APPLY ? `; ${removed} removed` : '; read-only, run with --apply to remove them') +
      (failed ? `; ${failed} project(s) could not be read or cleaned` : '') + '.',
  )
  if (failed) process.exitCode = 1
}

main()
  .catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
