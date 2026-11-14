/**
 * secure-teams-tables.ts — give every existing project's teams tables the teams rules.
 *
 * enable_teams creates organizations, organization_members and
 * organization_invitations. Their row-level security used to be left to the
 * ownership inference, which cannot say that membership decides access: tables
 * created before the users foreign keys had row-level security off on
 * organizations and organization_invitations, and later ones gave any
 * signed-in end user a way to write the row that makes them a member of any
 * organization. New projects get the teams rules from enable_teams
 * (lib/services/workspace-rls.ts, template "teams"); this brings the existing
 * ones in line.
 *
 * Production schemas change as one governed change per project, attributed to
 * Backenly, so each project's history shows it. Active preview branches get
 * the rules too. A table whose rules a person chose (set_rls, add_rls or
 * remove_rls, in the console, an approval or through their agent; a rule
 * Backenly does not set by itself) is left as it is and listed, for its owner
 * to be told. So is a project whose teams tables cannot take the rules (one of
 * them missing, or a column the rules read).
 *
 *   npx tsx scripts/secure-teams-tables.ts                    # report only
 *   npx tsx scripts/secure-teams-tables.ts --apply            # every project
 *   npx tsx scripts/secure-teams-tables.ts --apply --project <uuid>
 *
 * Existing memberships are not changed: a row an end user wrote under the old
 * rules is still there afterwards.
 */
import { prisma } from '@/lib/db'
import { secureTeamsTables } from '@/lib/services/workspace-rls'

const APPLY = process.argv.includes('--apply')
const flag = process.argv.indexOf('--project')
const ONLY = flag > -1 ? process.argv[flag + 1] : null

async function main(): Promise<void> {
  const projects = await prisma.project.findMany({
    where: ONLY ? { id: ONLY } : {},
    select: { id: true, user: { select: { email: true } } },
    orderBy: { createdAt: 'asc' },
  })
  let tables = 0
  let kept = 0
  let blocked = 0
  let affected = 0
  let failed = 0
  for (const p of projects) {
    try {
      const found = await secureTeamsTables(p.id, { apply: APPLY })
      if (found.length) affected++
      for (const f of found) {
        const where = `${p.id}\t${p.user?.email ?? '-'}\t${f.schema}`
        if (f.tables.length) {
          tables += f.tables.length
          console.log(`${where}\t${f.secured ? 'secured' : 'to secure'}: ${f.tables.join(', ')}`)
        }
        for (const k of f.kept) {
          kept++
          console.log(`${where}\tkept ${k.table}: ${k.reason}`)
        }
        if (f.blocked.length) {
          blocked++
          console.log(`${where}\tcannot take the teams rules: ${f.blocked.join('; ')}`)
        }
      }
    } catch (err) {
      failed++
      console.error(`${p.id}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  console.log(
    `${APPLY ? 'Secured' : 'Found'} ${tables} teams table(s) ${APPLY ? '' : 'to secure '}in ${affected} of ${projects.length} project(s); ` +
      `${kept} kept because a person chose their rules` +
      (blocked ? `; ${blocked} schema(s) cannot take the teams rules` : '') +
      (failed ? `; ${failed} project(s) failed` : '') +
      (APPLY ? '.' : '. Run with --apply to secure them.'),
  )
  if (failed) process.exitCode = 1
}

main()
  .catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
