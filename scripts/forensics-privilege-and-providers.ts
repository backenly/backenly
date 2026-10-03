/**
 * INCIDENT VERIFICATION FOR THE ROLE AND IDENTITY-PROVIDER DEFECTS
 * ===============================================================
 *
 *   DATABASE_URL=<the environment to examine> \
 *     npx tsx scripts/forensics-privilege-and-providers.ts
 *
 *   ... --json     machine-readable, for attaching to an incident record
 *
 * READ ONLY. Never writes. Companion to
 * scripts/forensics-user-record-takeover.ts, which covers the account-record
 * defect; this covers the two that an account-level inventory cannot see.
 *
 * ── Why a user inventory is not enough ──────────────────────────────────────
 *
 * `/api/roles/[roleId]` let any authenticated account edit a role's
 * `permissions` array. An attacker therefore never needed to change anybody's
 * roleId: widening a role that accounts already hold grants privilege to every
 * holder at once, and leaves the user table looking entirely normal. Checking
 * "who is an admin" would find nothing.
 *
 * `/api/providers/[providerId]` let any authenticated account READ the whole
 * AuthProvider row, including `clientSecret`, and WRITE it. Those are separate
 * harms. Reading disclosed an upstream OAuth secret. Writing could redirect or
 * disable sign-in - a changed redirectUri or a flipped `enabled` matters even
 * if the secret was never read.
 *
 * ── What this cannot tell you ───────────────────────────────────────────────
 *
 * Neither route wrote an audit entry, and there is no historical table to diff
 * permissions against. This reports CURRENT state plus timestamps. A clean
 * result means no evidence found, not that nothing happened.
 *
 * It never selects `clientSecret`. An incident script must not become another
 * place the secret is printed, logged, or pasted into a ticket.
 */

import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

/** The window both routes were exposed: initial commit to the fix. */
const INTRODUCED = new Date('2026-07-23T00:00:00Z')
const FIXED = new Date('2026-09-18T23:59:59Z')

interface Finding {
  check: string
  concerning: boolean
  detail: string
  rows?: unknown[]
}

const findings: Finding[] = []
const record = (check: string, concerning: boolean, detail: string, rows?: unknown[]) =>
  findings.push({ check, concerning, detail, rows })

/** Edited after creation, inside the window. One minute of slack for the write itself. */
function editedInWindow(createdAt: Date, updatedAt: Date): boolean {
  return updatedAt >= INTRODUCED && updatedAt <= FIXED &&
    updatedAt.getTime() - createdAt.getTime() > 60_000
}

async function roleDefinitions(): Promise<void> {
  const roles = await prisma.role.findMany({
    select: { id: true, name: true, permissions: true, projectId: true, createdAt: true, updatedAt: true },
    orderBy: { updatedAt: 'desc' },
  }).catch(() => [])

  const changed = roles.filter(r => editedInWindow(r.createdAt, r.updatedAt))

  record(
    'role definitions edited during the window',
    changed.length > 0,
    changed.length > 0
      ? `${changed.length} of ${roles.length} role(s) were edited after creation inside the window. A widened role is invisible in a user inventory, so compare each permissions array against what it should grant.`
      : `${roles.length} role(s), none edited appreciably after creation inside the window.`,
    // Printed whether or not anything looks changed: "what do these roles grant
    // right now" is the question, and there is nothing to diff against.
    roles,
  )

  const withUserCounts = await Promise.all(
    roles.map(async r => ({
      role: r.name,
      permissions: r.permissions,
      holders: await prisma.user.count({ where: { roleId: r.id } }).catch(() => -1),
    })),
  )
  const populated = withUserCounts.filter(r => r.holders > 0)
  record(
    'how many accounts each role grants its permissions to',
    false,
    'Blast radius per role, for judging what a widened definition would have reached.',
    populated,
  )
}

async function providerConfiguration(): Promise<void> {
  const providers = await prisma.authProvider.findMany({
    select: {
      id: true, name: true, type: true, enabled: true, configured: true,
      clientId: true, redirectUri: true, scopes: true,
      lastModified: true, modifiedBy: true, createdAt: true, updatedAt: true,
      // clientSecret deliberately NOT selected. See the header.
    },
    orderBy: { updatedAt: 'desc' },
  }).catch(() => [])

  const changed = providers.filter(p => editedInWindow(p.createdAt, p.updatedAt))
  record(
    'identity provider configuration changed during the window',
    changed.length > 0,
    changed.length > 0
      ? `${changed.length} of ${providers.length} provider(s) were modified after creation inside the window. Check clientId, redirectUri, scopes and enablement against what you configured - a changed callback redirects sign-in without touching the secret.`
      : `${providers.length} provider(s), none modified appreciably after creation inside the window.`,
    providers,
  )

  const configured = providers.filter(p => p.configured || p.clientId)
  record(
    'providers whose UPSTREAM secret should be rotated',
    configured.length > 0,
    configured.length > 0
      ? `${configured.length} provider(s) carry configuration. Their client secrets were readable by any authenticated account during the window. Rotate AT THE PROVIDER (Google/GitHub console) and then update Backenly - rotating only here changes nothing upstream.`
      : 'No configured providers, so no upstream secret was exposed through this route.',
    configured.map(p => ({ name: p.name, type: p.type, enabled: p.enabled, clientId: p.clientId })),
  )
}

/**
 * /api/workspace-users — the endpoint that returned every platform account.
 *
 * It authenticated the caller and then passed a projectId from the query
 * string to getWorkspaceUsers, which IGNORED it and ran an unqualified
 * `SELECT ... FROM users` on the platform connection. That resolved to
 * public.users, the account table.
 *
 * This one is different from the others in the incident, and worse in one
 * specific way: it needed only an ORDINARY authenticated session and no
 * guessed identifier. Any signed-in account could enumerate every account
 * email on the deployment. The others needed a target id or admin-shaped
 * intent; this needed a login and a single request.
 */
async function workspaceUserEnumeration(): Promise<void> {
  const rows = await prisma.log.findMany({
    where: {
      timestamp: { gte: INTRODUCED, lte: FIXED },
      OR: [
        { endpoint: { contains: '/api/workspace-users' } },
        { message: { contains: '/api/workspace-users' } },
      ],
    },
    select: { timestamp: true, method: true, endpoint: true, statusCode: true, userId: true },
    orderBy: { timestamp: 'desc' },
    take: 200,
  }).catch(() => [])

  record(
    'requests logged against /api/workspace-users',
    rows.length > 0,
    rows.length > 0
      ? `${rows.length} request(s) recorded in the window. Compare each caller against who should have been listing that project's end users - and note the response contained PLATFORM account emails regardless of the projectId asked for.`
      : 'No requests recorded. If request logging did not cover this route, that is not evidence it was never called.',
    rows.slice(0, 50),
  )

  const accounts = await prisma.user.count().catch(() => -1)
  record(
    'email addresses reachable through that endpoint',
    accounts > 1,
    accounts < 0
      ? 'Could not count accounts.'
      : accounts > 1
        ? `${accounts} account email(s) were returned by a single authenticated request. On a reachable multi-account deployment, treat these addresses as potentially disclosed unless the logs above show the endpoint was never used.`
        : `${accounts} account, so there was nothing to enumerate beyond the caller's own.`,
  )
}

async function policyReads(): Promise<void> {
  const count = await prisma.authPolicy.count().catch(() => -1)
  record(
    'auth policies readable during the window',
    false,
    count < 0
      ? 'Could not count auth policies.'
      : `${count} policy/policies existed and their GET was under-authorized. This is information disclosure - it reveals how access is decided - and is lower evidentiary severity than password reset, role mutation or secret disclosure. Their PUT and DELETE were already admin-gated.`,
  )
}

async function main(): Promise<void> {
  const target = (process.env.DATABASE_URL ?? '').replace(/:[^:@/]*@/, ':***@')
  console.log('')
  console.log('  Incident verification: privilege model, identity providers, account enumeration')
  console.log(`  Database: ${target || '(DATABASE_URL unset)'}`)
  console.log(`  Window:   ${INTRODUCED.toISOString().slice(0, 10)} .. ${FIXED.toISOString().slice(0, 10)}`)
  console.log('')

  await roleDefinitions()
  await providerConfiguration()
  await workspaceUserEnumeration()
  await policyReads()

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ window: { from: INTRODUCED, to: FIXED }, findings }, null, 2))
  } else {
    for (const f of findings) {
      console.log(`  ${f.concerning ? 'LOOK' : '  ok'}  ${f.check}`)
      console.log(`        ${f.detail}`)
      if (f.rows?.length) {
        for (const r of f.rows.slice(0, 12)) console.log(`          ${JSON.stringify(r)}`)
      }
      console.log('')
    }
  }

  console.log('  Neither route wrote an audit entry, and there is no historical table')
  console.log('  to diff permissions against. This is CURRENT state plus timestamps:')
  console.log('  a clean result is NO EVIDENCE FOUND, not proof nothing happened.')
  console.log('')

  await prisma.$disconnect()
}

main().catch(async err => {
  console.error(err instanceof Error ? err.message : String(err))
  await prisma.$disconnect().catch(() => {})
  process.exit(1)
})
