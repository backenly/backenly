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
 * remove_rls, in the console, an approval or through their agent, or a
 * preview branch merged; a rule Backenly does not set by itself) is left as it
 * is and listed, for its owner to be told. So is a project whose teams tables
 * cannot take the rules (one of them missing, or a column the rules read). An
 * organization_invitations table kept that way still gets the trigger that
 * keeps tokens as hashes, which accept-invite needs.
 *
 *   npx tsx scripts/secure-teams-tables.ts                    # report only
 *   npx tsx scripts/secure-teams-tables.ts --apply            # every project
 *   npx tsx scripts/secure-teams-tables.ts --apply --project <uuid>
 *
 * Invitations written before the rules cannot be trusted: under the earlier
 * ones any signed-in user could write one to themselves, naming the owner as
 * its inviter, with a token anyone could read. --apply withdraws (deletes, as
 * the service role, inside that same change) every one still pending, and
 * marks every one accepted, which then proves nothing about how its member
 * joined. Each withdrawn invitation is listed, in both modes, one line each:
 * project, owner's email, schema, organization id, the invitee's address
 * masked (a***@d***.com), role, created_at, so its organization's owner can
 * invite again. accept-invite has not taken them since the fix (it matches a
 * token only by its hash).
 *
 * Existing memberships are never changed, in either mode: a row an end user
 * wrote under the old rules is still there afterwards. The ones not accounted
 * for are listed, one line each: project, owner's email, schema, organization
 * id, member user id, role, created_at. A member is accounted for when they
 * own the organization, or joined through an accepted invitation to their
 * email, written under the teams rules by someone else who is accounted for
 * and is the organization's owner or an admin of it, at no higher a role than
 * that invitation gave. An invitation from before the rules counts for no
 * one, so until a project holds them every member but an organization's owner
 * is listed, for its owner to judge; so is a member a server added with a
 * service-role key.
 *
 * Also listed, never changed: an invitation table made unique on email or token
 * across every organization (newer ones are unique per organization).
 */
import { prisma } from '@/lib/db'
import { secureTeamsTables } from '@/lib/services/workspace-rls'

const APPLY = process.argv.includes('--apply')
const flag = process.argv.indexOf('--project')
const ONLY = flag > -1 ? process.argv[flag + 1] : null

const when = (d: Date | null) => (d ? new Date(d).toISOString() : '-')

async function main(): Promise<void> {
  const projects = await prisma.project.findMany({
    where: ONLY ? { id: ONLY } : {},
    select: { id: true, user: { select: { email: true } } },
    orderBy: { createdAt: 'asc' },
  })
  let tables = 0
  let kept = 0
  let blocked = 0
  let suspects = 0
  let withdrawn = 0
  let shared = 0
  let affected = 0
  let failed = 0
  for (const p of projects) {
    try {
      const found = await secureTeamsTables(p.id, { apply: APPLY })
      if (found.some((f) => f.tables.length)) affected++
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
        if (f.sharedUniques.length) {
          shared++
          console.log(`${where}\tinvitations unique across every organization, not per organization: ${f.sharedUniques.join(', ')}`)
        }
        for (const w of f.withdrawn) {
          withdrawn++
          console.log(
            `${where}\t${f.secured ? 'invitation withdrawn' : 'invitation to withdraw'}\torganization ${w.organizationId}\t` +
              `${w.address}\trole ${w.role ?? '-'}\tcreated_at ${when(w.createdAt)}`,
          )
        }
        for (const s of f.suspects) {
          suspects++
          console.log(
            `${where}\tmember not accounted for\torganization ${s.organizationId}\tuser ${s.userId}\t` +
              `role ${s.role ?? '-'}\tcreated_at ${when(s.createdAt)}`,
          )
        }
      }
    } catch (err) {
      failed++
      console.error(`${p.id}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  console.log(
    `${APPLY ? 'Secured' : 'Found'} ${tables} teams table(s) ${APPLY ? '' : 'to secure '}in ${affected} of ${projects.length} project(s); ` +
      `${kept} kept because a person chose their rules; ` +
      `${withdrawn} invitation(s) from before the rules ${APPLY ? 'withdrawn' : 'to withdraw'}, listed for their owners to send again; ` +
      `${suspects} membership(s) not accounted for listed, none changed` +
      (shared ? `; ${shared} invitation table(s) unique across organizations listed` : '') +
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
