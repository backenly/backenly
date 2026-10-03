/**
 * INCIDENT VERIFICATION FOR THE /api/users/[userId] TAKEOVER DEFECT
 * ================================================================
 *
 *   DATABASE_URL=<the environment to examine> \
 *     npx tsx scripts/forensics-user-record-takeover.ts
 *
 *   ... --json     machine-readable, for attaching to an incident record
 *
 * READ ONLY. This script never writes, and it is deliberately separate from
 * any remediation: evidence is collected before anything is rotated, because
 * rotating first destroys the state that would answer whether rotation was
 * needed.
 *
 * ── The defect ──────────────────────────────────────────────────────────────
 *
 * `PUT /api/users/[userId]` called `requireAuth` and discarded the result, then
 * applied the request body to `where: { id: params.userId }`. The body accepts
 * `password`, `roleId`, `email`, `emailVerified` and `twoFactorEnabled`.
 *
 * So any authenticated account could set another account's password, grant
 * itself a role, disable someone's second factor, or flip a verification flag.
 * `GET` on the same route returned any account's record.
 *
 * ── Exposure window ─────────────────────────────────────────────────────────
 *
 * Introduced:  11a806ad, 2026-07-23 (the initial commit)
 * Fixed:       439447f6, 2026-09-18
 *
 * The Next 16 upgrade (a61b46da, 2026-08-19) changed how the route reads its
 * path parameter but did not change its authorization, so the whole window is
 * affected rather than only part of it.
 *
 * ── What this can and cannot tell you ───────────────────────────────────────
 *
 * It reports what the platform's own tables record. It CANNOT prove absence of
 * abuse: the route wrote no audit entry of its own, so a successful call leaves
 * no direct trace beyond its effects. Treat a clean result as "no evidence
 * found", never as "did not happen" — the distinction that matters when
 * deciding whether to force a reset.
 */

import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

const INTRODUCED = new Date('2026-07-23T00:00:00Z')
const FIXED = new Date('2026-09-18T23:59:59Z')

interface Finding {
  check: string
  concerning: boolean
  detail: string
  rows?: unknown[]
}

const findings: Finding[] = []

function record(check: string, concerning: boolean, detail: string, rows?: unknown[]): void {
  findings.push({ check, concerning, detail, rows })
}

async function requestsToTheRoute(): Promise<void> {
  // The Log model carries endpoint and method for request-level entries.
  const rows = await prisma.log.findMany({
    where: {
      timestamp: { gte: INTRODUCED, lte: FIXED },
      OR: [
        { endpoint: { contains: '/api/users/' } },
        { message: { contains: '/api/users/' } },
      ],
    },
    select: { timestamp: true, method: true, endpoint: true, statusCode: true, userId: true, message: true },
    orderBy: { timestamp: 'desc' },
    take: 200,
  }).catch(() => [])

  const mutations = rows.filter(r => r.method && r.method !== 'GET')
  record(
    'requests logged against /api/users/*',
    mutations.length > 0,
    mutations.length > 0
      ? `${mutations.length} non-GET request(s) recorded in the window. Each needs the caller compared to the target id.`
      : `No non-GET requests recorded (${rows.length} entries of any method). Request logging may not cover this route, so this is weak evidence.`,
    mutations.slice(0, 50),
  )
}

async function accountsWithPrivilege(): Promise<void> {
  const admins = await prisma.user.findMany({
    where: { role: { name: 'admin' } },
    select: { id: true, email: true, createdAt: true, updatedAt: true },
    orderBy: { updatedAt: 'desc' },
  }).catch(() => [])

  // An admin whose record was modified well after it was created is the shape
  // a promotion would leave, since the route updates `updatedAt`.
  const promotedLater = admins.filter(
    a => a.updatedAt.getTime() - a.createdAt.getTime() > 60_000,
  )

  record(
    'accounts currently holding an admin role',
    promotedLater.length > 0,
    promotedLater.length > 0
      ? `${admins.length} admin account(s); ${promotedLater.length} modified more than a minute after creation. Confirm each promotion was intended.`
      : `${admins.length} admin account(s), none modified appreciably after creation.`,
    admins,
  )
}

async function secondFactorState(): Promise<void> {
  const disabled = await prisma.user.findMany({
    where: { twoFactorEnabled: false, updatedAt: { gte: INTRODUCED, lte: FIXED } },
    select: { id: true, email: true, twoFactorEnabled: true, updatedAt: true, createdAt: true },
    orderBy: { updatedAt: 'desc' },
    take: 100,
  }).catch(() => [])

  const changedAfterCreation = disabled.filter(
    u => u.updatedAt.getTime() - u.createdAt.getTime() > 60_000,
  )

  record(
    'second factor switched off during the window',
    changedAfterCreation.length > 0,
    changedAfterCreation.length > 0
      ? `${changedAfterCreation.length} account(s) without 2FA were modified after creation. Most will be ordinary edits; each still needs confirming.`
      : 'No accounts without 2FA were modified appreciably after creation.',
    changedAfterCreation.slice(0, 50),
  )
}

async function verificationFlips(): Promise<void> {
  const verified = await prisma.user.findMany({
    where: { emailVerified: true, updatedAt: { gte: INTRODUCED, lte: FIXED } },
    select: { id: true, email: true, provider: true, createdAt: true, updatedAt: true },
    orderBy: { updatedAt: 'desc' },
    take: 100,
  }).catch(() => [])

  // A verified address on an email-provider account that was edited long after
  // signup is the shape a forced flip would leave.
  const suspicious = verified.filter(
    u => u.provider === 'email' && u.updatedAt.getTime() - u.createdAt.getTime() > 3_600_000,
  )

  record(
    'email verification flipped long after signup',
    suspicious.length > 0,
    suspicious.length > 0
      ? `${suspicious.length} email-provider account(s) verified and modified over an hour after creation.`
      : 'No email-provider accounts show a late verification change.',
    suspicious.slice(0, 50),
  )
}

async function accountInventory(): Promise<void> {
  const total = await prisma.user.count().catch(() => -1)
  record(
    'account inventory',
    false,
    total < 0
      ? 'Could not count accounts.'
      : `${total} account(s) in this database. If these are all founder/family/test accounts the blast radius is small and a precautionary reset is cheap.`,
  )
}

async function main(): Promise<void> {
  const target = (process.env.DATABASE_URL ?? '').replace(/:[^:@/]*@/, ':***@')
  console.log('')
  console.log('  Incident verification: /api/users/[userId] record takeover')
  console.log(`  Database: ${target || '(DATABASE_URL unset)'}`)
  console.log(`  Window:   ${INTRODUCED.toISOString().slice(0, 10)} .. ${FIXED.toISOString().slice(0, 10)}`)
  console.log('')

  await accountInventory()
  await requestsToTheRoute()
  await accountsWithPrivilege()
  await secondFactorState()
  await verificationFlips()

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ window: { from: INTRODUCED, to: FIXED }, findings }, null, 2))
  } else {
    for (const f of findings) {
      console.log(`  ${f.concerning ? 'LOOK' : '  ok'}  ${f.check}`)
      console.log(`        ${f.detail}`)
      if (f.concerning && f.rows?.length) {
        for (const r of f.rows.slice(0, 10)) console.log(`          ${JSON.stringify(r)}`)
      }
      console.log('')
    }
  }

  console.log('  This reports what the platform tables record. The route wrote no')
  console.log('  audit entry of its own, so a clean result means NO EVIDENCE FOUND,')
  console.log('  not that nothing happened. If the deployment was publicly reachable')
  console.log('  and you cannot prove otherwise, treat a reset as the cautious path.')
  console.log('')

  await prisma.$disconnect()
}

main().catch(async err => {
  console.error(err instanceof Error ? err.message : String(err))
  await prisma.$disconnect().catch(() => {})
  process.exit(1)
})
