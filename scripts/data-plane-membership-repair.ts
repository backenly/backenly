/**
 * ONE GRANT, AND NOTHING ELSE
 * ===========================
 *
 * Repairs a single deployment defect: the SECURITY DEFINER data-plane functions
 * are owned by a role that is not a member of the application role whose
 * default privileges they set. PostgreSQL permits `ALTER DEFAULT PRIVILEGES FOR
 * ROLE x` only to a member of x, so `backenly_pgrst_prepare_schema` raises
 * 42501 for every caller — and because the CREATE SCHEMA event trigger reaches
 * it, a failing trigger aborts the statement that fired it. The deployment
 * cannot provision a project, while existing workspaces keep working and every
 * health check stays green.
 *
 * ── Why this is not part of the acceptance fixture ──────────────────────────
 *
 * The fixture qualifies the autonomy loop and is built so it cannot become an
 * admin tool. This performs a privileged role change. Putting the two in one
 * file would put a GRANT one flag away from a qualification run.
 *
 * ── What it may do ─────────────────────────────────────────────────────────
 *
 * Exactly one statement, and every part of it is read from the catalog:
 *
 *     GRANT <backenly_app_role()> TO <owner of prepare_schema>
 *
 * There is no SQL input, no role input, no schema input. It refuses if the
 * membership already holds, so a second run changes nothing. It never creates,
 * alters or drops a role, never touches privileges on any object, and never
 * grants anything to the application role.
 *
 * ── What it proves ─────────────────────────────────────────────────────────
 *
 * The grant returning without error is not proof. Afterwards it re-reads
 * membership from `pg_auth_members` through a fresh statement, and reports that
 * — the caller decides on the read, not on the write having been attempted.
 */

import { PrismaClient } from '@prisma/client'

const ENVS = ['staging', 'production'] as const
type Env = (typeof ENVS)[number]

function emit(result: Record<string, unknown>): void {
  console.log('REPAIR-RESULT ' + JSON.stringify(result))
}

function refuse(msg: string): never {
  emit({ ok: false, refused: msg })
  process.exit(2)
}

/**
 * The master credential, as RDS stores it: a JSON document, not a URL. The host,
 * port and database come from the application URL, so the connection this opens
 * is provably the same database the application uses.
 */
function adminUrl(appUrl: string, secretJson: string): string {
  let creds: { username?: string; password?: string }
  try {
    creds = JSON.parse(secretJson)
  } catch {
    refuse('the master secret is not JSON; expected the RDS-managed {username, password} document')
  }
  if (!creds.username || !creds.password) refuse('the master secret has no username/password')
  const u = new URL(appUrl)
  u.username = encodeURIComponent(creds.username)
  u.password = encodeURIComponent(creds.password)
  return u.toString()
}

async function main(): Promise<void> {
  const expect = (process.env.EXPECT_ENVIRONMENT ?? '') as Env
  if (!ENVS.includes(expect)) refuse(`EXPECT_ENVIRONMENT must be staging or production, got "${expect}"`)

  // The container's own environment, set by the task definition. A launcher
  // pointed at the wrong cluster fails here, not after a write.
  const actual = process.env.BACKENLY_ENV ?? ''
  if (actual !== expect) refuse(`container BACKENLY_ENV is "${actual}", expected "${expect}"`)

  if (process.env.CONFIRM_REPAIR !== 'grant-membership') {
    refuse('CONFIRM_REPAIR must be the exact string grant-membership')
  }

  const appUrl = process.env.DATABASE_URL ?? ''
  const secretJson = process.env.ADMIN_SECRET_JSON ?? ''
  if (!appUrl) refuse('DATABASE_URL is not present')
  if (!secretJson) refuse('ADMIN_SECRET_JSON is not present')

  // Matched by environment marker rather than by instance name: this repository
  // is public. Both halves are checked, so a host carrying neither refuses too.
  const host = (() => {
    try {
      return new URL(appUrl).hostname
    } catch {
      return ''
    }
  })()
  const other = expect === 'production' ? 'staging' : 'production'
  if (!host.includes(expect)) refuse(`database host "${host}" does not identify the ${expect} instance`)
  if (host.includes(other)) refuse(`database host "${host}" identifies ${other}, not ${expect}`)

  const admin = new PrismaClient({ datasources: { db: { url: adminUrl(appUrl, secretJson) } } })
  try {
    const before = await admin.$queryRawUnsafe<
      Array<{
        connected_as: string
        database: string
        app_role: string | null
        owner: string | null
        owner_is_member: boolean | null
      }>
    >(
      `select
         current_user::text as connected_as,
         current_database()::text as database,
         public.backenly_app_role() as app_role,
         (select pg_get_userbyid(p.proowner)
            from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = 'backenly_pgrst_prepare_schema') as owner,
         (select case when public.backenly_app_role() is null then null else pg_has_role(
            (select pg_get_userbyid(p.proowner)
               from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname = 'backenly_pgrst_prepare_schema'),
            public.backenly_app_role(), 'MEMBER') end) as owner_is_member`,
    )
    const b = before[0]
    if (b.database !== 'backenly') refuse(`connected to database "${b.database}", expected "backenly"`)
    if (!b.app_role) refuse('backenly_app_role() resolved to nothing; there is no role to grant')
    if (!b.owner) refuse('backenly_pgrst_prepare_schema is not installed; there is nothing to repair')

    if (b.owner_is_member) {
      emit({ ok: true, repaired: false, reason: 'membership already holds', ...b })
      return
    }

    // The one statement. Both identifiers come from the catalog reads above.
    const statement = `GRANT "${b.app_role.replace(/"/g, '""')}" TO "${b.owner.replace(/"/g, '""')}"`
    await admin.$executeRawUnsafe(statement)

    // Re-read rather than trust the write. A grant that returned without error
    // and a membership that now holds are different claims.
    const after = await admin.$queryRawUnsafe<Array<{ owner_is_member: boolean; via_admin_option: boolean }>>(
      `select
         pg_has_role($1, $2, 'MEMBER') as owner_is_member,
         exists (
           select 1 from pg_auth_members m
             join pg_roles r on r.oid = m.roleid
             join pg_roles mem on mem.oid = m.member
            where r.rolname = $2 and mem.rolname = $1
         ) as via_admin_option`,
      b.owner,
      b.app_role,
    )

    emit({
      ok: after[0]?.owner_is_member === true,
      repaired: true,
      statement,
      connectedAs: b.connected_as,
      database: b.database,
      appRole: b.app_role,
      definerOwner: b.owner,
      ownerWasMember: false,
      ownerIsMemberNow: after[0]?.owner_is_member ?? null,
      membershipRowPresent: after[0]?.via_admin_option ?? null,
    })
  } finally {
    await admin.$disconnect().catch(() => {})
  }
}

main().catch(err => {
  emit({ ok: false, error: String(err?.message ?? err).split('\n').filter(Boolean).pop() ?? 'failed' })
  process.exit(1)
})
