/**
 * PHASE 3 — migrate a project's RLS policies onto PostgREST's JWT claims.
 *
 * Rewrites every policy that still depends on the `app.*` GUCs so it reads
 * `request.jwt.claims` instead. Dry-run by default; --apply executes inside a
 * single transaction per project so a partial migration is impossible.
 *
 * WHY A PARTIAL MIGRATION IS THE REAL DANGER
 * A policy left on the old contract does not error under PostgREST — the GUC is
 * simply never set, so `current_setting('app.current_user_id', true)` is NULL
 * and the predicate matches NOTHING. The table reads as empty. That looks like
 * "secure" and behaves like an outage, and it is discovered by a user, not by a
 * monitor. So: all policies for a project migrate together, or none do.
 *
 * Anything the translator does not recognise is REPORTED, never guessed at.
 *
 *   npx tsx scripts/migrate-rls-to-postgrest.ts --project <id>
 *   npx tsx scripts/migrate-rls-to-postgrest.ts --project <id> --apply
 */

import { PrismaClient } from '@prisma/client'
import {
  jwtClaimFunctionSql,
  translatePolicyExpression,
  usesLegacyGucs,
} from '@/lib/postgrest/rls-translation'

const prisma = new PrismaClient()

interface LivePolicy {
  schemaname: string
  tablename: string
  policyname: string
  cmd: string
  qual: string | null
  with_check: string | null
}

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag)
  return i === -1 ? undefined : process.argv[i + 1]
}

/** PostgreSQL has no ALTER POLICY ... USING for all cases; drop + recreate. */
function recreate(p: LivePolicy, qual: string | null, withCheck: string | null): string[] {
  const target = `"${p.schemaname}"."${p.tablename}"`
  const cmd = p.cmd === 'ALL' ? 'ALL' : p.cmd
  const parts = [`CREATE POLICY "${p.policyname}" ON ${target} FOR ${cmd}`]
  if (qual) parts.push(`USING (${qual})`)
  if (withCheck) parts.push(`WITH CHECK (${withCheck})`)
  return [
    `DROP POLICY IF EXISTS "${p.policyname}" ON ${target}`,
    parts.join(' '),
  ]
}

async function main() {
  const projectId = arg('--project')
  const apply = process.argv.includes('--apply')
  if (!projectId) {
    console.error('Missing --project <projectId>')
    process.exit(2)
  }

  const schema = `workspace_${projectId}`

  const policies = await prisma.$queryRawUnsafe<LivePolicy[]>(
    `SELECT schemaname, tablename, policyname, cmd, qual, with_check
       FROM pg_policies WHERE schemaname = $1
      ORDER BY tablename, policyname`,
    schema,
  )

  if (policies.length === 0) {
    console.log(`\n  No policies found in ${schema}.\n`)
    await prisma.$disconnect()
    return
  }

  const statements: string[] = [jwtClaimFunctionSql(schema)]
  const migrated: string[] = []
  const alreadyDone: string[] = []
  const unrecognised: LivePolicy[] = []

  for (const p of policies) {
    const legacy = usesLegacyGucs(p.qual) || usesLegacyGucs(p.with_check)
    if (!legacy) {
      alreadyDone.push(`${p.tablename}.${p.policyname}`)
      continue
    }

    const qual = p.qual ? translatePolicyExpression(p.qual, schema) : null
    const check = p.with_check ? translatePolicyExpression(p.with_check, schema) : null

    // If a clause was legacy but produced no translation, we do not understand
    // it — and a policy we do not understand must not be rewritten by guesswork.
    const qualFailed = p.qual ? usesLegacyGucs(p.qual) && qual === null : false
    const checkFailed = p.with_check ? usesLegacyGucs(p.with_check) && check === null : false
    if (qualFailed || checkFailed) {
      unrecognised.push(p)
      continue
    }

    statements.push(...recreate(p, qual ?? p.qual, check ?? p.with_check))
    migrated.push(`${p.tablename}.${p.policyname}`)
  }

  console.log(`\n  schema      ${schema}`)
  console.log(`  policies    ${policies.length} total`)
  console.log(`  migrate     ${migrated.length}`)
  console.log(`  already ok  ${alreadyDone.length}`)
  console.log(`  UNKNOWN     ${unrecognised.length}`)

  if (unrecognised.length > 0) {
    console.log('\n  Not migrated — translator did not recognise these. Review by hand:')
    for (const p of unrecognised) {
      console.log(`    ! ${p.tablename}.${p.policyname} (${p.cmd})`)
      console.log(`        USING      ${p.qual ?? '—'}`)
      console.log(`        WITH CHECK ${p.with_check ?? '—'}`)
    }
  }

  if (migrated.length === 0) {
    console.log('\n  Nothing to migrate.\n')
    await prisma.$disconnect()
    return
  }

  if (!apply) {
    console.log('\n  --- SQL that WOULD run ---')
    for (const s of statements) console.log(`  ${s.replace(/\s+/g, ' ').slice(0, 200)}`)
    console.log('\n  Dry run. Re-run with --apply to execute.\n')
    await prisma.$disconnect()
    return
  }

  // Refuse a partial migration: an unrecognised policy left on the old contract
  // matches nothing under PostgREST, which reads as an empty table rather than
  // an error.
  if (unrecognised.length > 0) {
    console.error(
      `\n  REFUSING to apply: ${unrecognised.length} policy/policies could not be translated.\n` +
      `  Migrating the rest would leave this project half on each contract, and the\n` +
      `  untranslated half would silently match no rows under PostgREST.\n`,
    )
    await prisma.$disconnect()
    process.exit(1)
  }

  await prisma.$transaction(async (tx) => {
    for (const s of statements) await tx.$executeRawUnsafe(s)
  })

  console.log(`\n  Applied ${statements.length} statement(s); ${migrated.length} policy/policies migrated.\n`)
  await prisma.$disconnect()
}

main().catch(async (err) => {
  console.error('migration failed:', err instanceof Error ? err.message : err)
  await prisma.$disconnect()
  process.exit(1)
})
