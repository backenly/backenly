/**
 * One-time backfill: purge leaked synthetic auth artifacts across every project.
 *
 * The behavioral / contract verifiers sign up throwaway `…@*.internal` accounts
 * through the real signup / logout endpoints on every deploy. Those endpoints
 * have side effects (an `_email_verifications` token on signup, a blacklisted
 * `jti` on logout) that the old verifier cleanup never removed — so orphaned
 * rows piled up in `_email_verifications`, `_magic_links`, `_password_resets`
 * and `_token_blacklist` and surfaced in the developer's Tables inspector.
 *
 * Source-level guards now stop these writes going forward (signup / logout skip
 * `.internal`), and the verifiers self-heal their own run. This script clears
 * the historical backlog once, for every project.
 *
 * It only ever deletes reserved-internal accounts (safe — a real end-user can
 * never own a `.internal` address) plus expired / zero-user blacklist rows.
 *
 * Run:  npx tsx scripts/purge-synthetic-auth-artifacts.ts
 * (On prod: ssh into the deployment host, cd to the app directory, run it.)
 */

import { prisma } from '@/lib/db'
import { purgeSyntheticAuthArtifacts } from '@/lib/services/end-user-auth-table'

async function main() {
  console.log('[PurgeSynthetic] Scanning projects…')
  const projects = await prisma.project.findMany({ select: { id: true, name: true } })
  console.log(`[PurgeSynthetic] ${projects.length} projects to sweep\n`)

  const totals: Record<string, number> = {}
  let touchedProjects = 0

  for (const p of projects) {
    let deleted: { table: string; deleted: number }[] = []
    try {
      deleted = await purgeSyntheticAuthArtifacts(p.id)
    } catch (err: any) {
      console.warn(`  ! ${p.id} (${p.name}) — error: ${err?.message ?? err}`)
      continue
    }
    if (deleted.length === 0) continue
    touchedProjects++
    const summary = deleted.map((d) => `${d.table}:${d.deleted}`).join(', ')
    console.log(`  ✓ ${p.name} [${p.id.slice(0, 8)}…] — ${summary}`)
    for (const d of deleted) totals[d.table] = (totals[d.table] ?? 0) + d.deleted
  }

  console.log('\n[PurgeSynthetic] Done.')
  console.log(`[PurgeSynthetic] Projects cleaned: ${touchedProjects}/${projects.length}`)
  if (Object.keys(totals).length === 0) {
    console.log('[PurgeSynthetic] No synthetic artifacts found — nothing to remove.')
  } else {
    for (const [table, n] of Object.entries(totals)) {
      console.log(`[PurgeSynthetic]   ${table}: ${n} rows removed`)
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[PurgeSynthetic] Fatal:', err)
    process.exit(1)
  })
