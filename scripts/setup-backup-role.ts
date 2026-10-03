/**
 * THE BACKUP CREDENTIAL, CREATED AND CONVERGED BY THE INSTALLER
 * ============================================================
 *
 *   npx tsx scripts/setup-backup-role.ts            # report only
 *   npx tsx scripts/setup-backup-role.ts --apply
 *   npx tsx scripts/setup-backup-role.ts --apply --rotate-password
 *
 * ── The defect this closes ──────────────────────────────────────────────────
 *
 * `scripts/setup-app-role.ts` has documented a FOUR-role architecture since the
 * credential split, and README.md tabulates it. Only one of the four was ever
 * created by code: `backenly_app`. `backenly_backup` existed in prose, and in a
 * README section telling operators to run the CREATE ROLE by hand.
 *
 * So Deployment Recovery ran `pg_dump` over `DATABASE_URL`, which names
 * `backenly_app`, and on a correctly split install it failed:
 *
 *   pg_dump: error: query failed:
 *   ERROR: permission denied for table backenly_pgrst_schema_registry
 *
 * Found by the final synthetic-production qualification. Every existing
 * recovery test passed because they run where the role is a superuser — the
 * same blind spot that hid the four-day backup outage `workspace-backup.ts`
 * records.
 *
 * Granting the registry to `backenly_app` would have cleared that error and
 * stopped at the next one: workspace tables are FORCE ROW LEVEL SECURITY and
 * `backenly_app` is deliberately NOBYPASSRLS, so the workspace dump fails too.
 * The credential is the problem, not the grant.
 *
 * ── The contract ────────────────────────────────────────────────────────────
 *
 *   LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE BYPASSRLS NOINHERIT
 *
 *   may:  CONNECT to the database
 *         USAGE on public and on every workspace schema
 *         SELECT on their tables and sequences
 *   may NOT: CREATE, INSERT, UPDATE, DELETE, TRUNCATE
 *         and it is a member of nothing, and owns nothing
 *
 * BYPASSRLS is the whole point and is confined to this role: a dump subject to
 * policies writes an incomplete backup that looks successful.
 *
 * DUMP USES THIS ROLE. RESTORE DOES NOT. `buildConnection('write')` ignores
 * BACKUP_DATABASE_URL on purpose — pg_dump runs with --no-owner, so psql
 * recreates whatever it replays as the role it connected with, and restoring
 * over this credential would make the BACKUP role own the restored schema.
 * FORCE RLS keys on the owner, so that silently rewrites who every policy
 * binds. See lib/services/workspace-backup.ts.
 *
 * ── Order matters, so this runs LATE ────────────────────────────────────────
 *
 * Existing-object grants and future-object grants are different problems, and
 * the objects appear at different times: the platform tables come from the
 * migration chain, the PostgREST registry and event triggers from the elevated
 * SQL after that, and the workspace schema from bootstrap after that. A role
 * created early with grants taken once would miss most of it.
 *
 * So this converges EXISTING objects every run, and installs DEFAULT PRIVILEGES
 * for both creating roles — `backenly_app` for everything it makes later, and
 * the installer role for support objects it adds in public.
 */

import { Client } from 'pg'
import { randomBytes } from 'crypto'

const BACKUP_ROLE = process.env.BACKENLY_BACKUP_ROLE?.trim() || 'backenly_backup'
const APP_ROLE = process.env.BACKENLY_APP_ROLE?.trim() || 'backenly_app'
/** Roles and databases: plain SQL identifiers. */
const SAFE_IDENT = /^[a-zA-Z_][a-zA-Z0-9_]*$/

/**
 * Schemas, which are NOT plain identifiers here.
 *
 * A workspace schema is `workspace_<project uuid>`, and a UUID contains
 * HYPHENS. Validating schema names with the role pattern rejected every real
 * one - the installer stopped with "unsafe identifier:
 * workspace_7776fdf8-8e38-4c3e-a162-16c800d4aafc" on a live install, while the
 * test fixture used a hex name and never saw it.
 *
 * Still validated rather than trusted: these come from pg_namespace, but a
 * name is about to be interpolated into DDL and "it came from the catalog" is
 * the kind of assumption that stops being true later.
 */
const SAFE_SCHEMA = /^[a-zA-Z_][a-zA-Z0-9_-]*$/

const has = (flag: string) => process.argv.includes(flag)
function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag)
  return i === -1 ? undefined : process.argv[i + 1]
}

function quoteIdent(name: string): string {
  if (!SAFE_IDENT.test(name)) throw new Error(`unsafe identifier: ${name}`)
  return `"${name}"`
}

function quoteSchema(name: string): string {
  if (!SAFE_SCHEMA.test(name)) throw new Error(`unsafe schema name: ${name}`)
  return `"${name}"`
}

function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

function generatePassword(): string {
  return randomBytes(24).toString('base64url')
}

function adminUrl(): string {
  const explicit = process.env.BACKENLY_ADMIN_DATABASE_URL?.trim()
  if (explicit) return explicit
  const fallback = process.env.DIRECT_URL?.trim() || process.env.DATABASE_URL?.trim()
  if (!fallback) {
    throw new Error(
      'Set BACKENLY_ADMIN_DATABASE_URL to a superuser connection. Creating a role and ' +
        'granting BYPASSRLS both require elevation.',
    )
  }
  return fallback
}

interface RoleState {
  exists: boolean
  superuser: boolean
  bypassrls: boolean
  canLogin: boolean
  inherit: boolean
  createdb: boolean
  createrole: boolean
  hasPassword: boolean | null
}

async function readRole(client: Client, role: string): Promise<RoleState> {
  const { rows } = await client.query(
    `SELECT r.rolsuper, r.rolbypassrls, r.rolcanlogin, r.rolinherit,
            r.rolcreatedb, r.rolcreaterole,
            (SELECT a.rolpassword IS NOT NULL FROM pg_authid a WHERE a.rolname = r.rolname) AS has_password
       FROM pg_roles r WHERE r.rolname = $1`,
    [role],
  )
  if (rows.length === 0) {
    return {
      exists: false,
      superuser: false,
      bypassrls: false,
      canLogin: false,
      inherit: false,
      createdb: false,
      createrole: false,
      hasPassword: null,
    }
  }
  const r = rows[0]
  return {
    exists: true,
    superuser: r.rolsuper === true,
    bypassrls: r.rolbypassrls === true,
    canLogin: r.rolcanlogin === true,
    inherit: r.rolinherit === true,
    createdb: r.rolcreatedb === true,
    createrole: r.rolcreaterole === true,
    hasPassword: r.has_password === null ? null : r.has_password === true,
  }
}

/** Every schema this deployment serves data from, plus public. */
async function readableSchemas(client: Client): Promise<string[]> {
  const { rows } = await client.query<{ nspname: string }>(
    `SELECT nspname FROM pg_namespace
      WHERE nspname = 'public' OR nspname LIKE 'workspace\\_%'
      ORDER BY nspname`,
  )
  return rows.map(r => r.nspname)
}

async function main(): Promise<void> {
  const apply = has('--apply')
  const rotate = has('--rotate-password')
  const passwordArg = arg('--password')

  if (!SAFE_IDENT.test(BACKUP_ROLE)) throw new Error(`invalid role name: ${BACKUP_ROLE}`)
  if (!SAFE_IDENT.test(APP_ROLE)) throw new Error(`invalid role name: ${APP_ROLE}`)

  const client = new Client({ connectionString: adminUrl() })
  client.on('error', () => {})
  await client.connect()

  try {
    const { rows: whoami } = await client.query(
      `SELECT current_database() AS db, current_user AS who,
              (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS is_super`,
    )
    const db: string = whoami[0].db
    console.log('')
    console.log(`  Connected to ${db} as ${whoami[0].who}${whoami[0].is_super ? ' (superuser)' : ''}`)

    if (!whoami[0].is_super) {
      throw new Error(
        'This script needs a superuser connection: CREATE ROLE and ALTER ROLE ... BYPASSRLS ' +
          'both require elevation. Point BACKENLY_ADMIN_DATABASE_URL at one.',
      )
    }

    const before = await readRole(client, BACKUP_ROLE)
    console.log(
      `  ${BACKUP_ROLE}: ${before.exists ? 'exists' : 'missing'}` +
        (before.exists
          ? ` · superuser=${before.superuser} · bypassrls=${before.bypassrls}` +
            ` · password=${before.hasPassword === null ? 'unknown' : before.hasPassword}`
          : ''),
    )

    if (!apply) {
      console.log('')
      console.log('  Report only. Rerun with --apply to converge.')
      console.log('')
      return
    }

    const ident = quoteIdent(BACKUP_ROLE)
    let issuedPassword: string | null = null

    // The password is SET when the role is new or has none, and otherwise only
    // on an explicit --rotate-password.
    //
    // Rotating this one is safer than rotating the application or authenticator
    // credential, and the installer does exactly that when .env has lost it:
    // nothing serves live requests with it. It is used by pg_dump, offline, so
    // a rotation costs a failed scheduled snapshot at worst and a deployment
    // that can never be backed up at best. Still explicit rather than implicit,
    // for the reason setup-postgrest-roles.ts documents at length.
    const needsPassword = !before.exists || before.hasPassword === false || rotate

    if (!before.exists) {
      issuedPassword = passwordArg || generatePassword()
      await client.query(
        `CREATE ROLE ${ident} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE BYPASSRLS NOINHERIT ` +
          `PASSWORD ${quoteLiteral(issuedPassword)}`,
      )
      console.log(`  created ${BACKUP_ROLE}`)
    } else if (needsPassword) {
      issuedPassword = passwordArg || generatePassword()
      await client.query(`ALTER ROLE ${ident} PASSWORD ${quoteLiteral(issuedPassword)}`)
      console.log(`  set the password of ${BACKUP_ROLE}`)
    } else {
      console.log(`  ${BACKUP_ROLE} already has a password; leaving it alone`)
    }

    // Re-asserted every run. A role that drifted into SUPERUSER, or lost
    // BYPASSRLS, produces either far too much access or a silently incomplete
    // dump — and nothing else in the system would notice either.
    await client.query(
      `ALTER ROLE ${ident} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE BYPASSRLS NOINHERIT`,
    )
    console.log(`  ${BACKUP_ROLE} is NOSUPERUSER BYPASSRLS, and can log in`)

    // ── Existing objects ────────────────────────────────────────────────────
    await client.query(`GRANT CONNECT ON DATABASE ${quoteIdent(db)} TO ${ident}`)

    const schemas = await readableSchemas(client)
    for (const schema of schemas) {
      const s = quoteSchema(schema)
      await client.query(`GRANT USAGE ON SCHEMA ${s} TO ${ident}`)
      await client.query(`GRANT SELECT ON ALL TABLES IN SCHEMA ${s} TO ${ident}`)
      // pg_dump reads sequence state (last_value) to restore it correctly.
      await client.query(`GRANT SELECT ON ALL SEQUENCES IN SCHEMA ${s} TO ${ident}`)
    }
    console.log(`  granted USAGE + SELECT on ${schemas.length} schema(s): ${schemas.join(', ')}`)

    // ── Future objects ──────────────────────────────────────────────────────
    //
    // A separate problem from the one above, and it needs the CREATING role
    // named: default privileges apply per owner. Two of them create objects
    // here — the application for its own tables, and the installer role for the
    // PostgREST support objects in public.
    const creators = new Set<string>([APP_ROLE, whoami[0].who as string])
    for (const schema of schemas) {
      for (const creator of creators) {
        if (!SAFE_IDENT.test(creator)) continue
        await client.query(
          `ALTER DEFAULT PRIVILEGES FOR ROLE ${quoteIdent(creator)} IN SCHEMA ${quoteSchema(schema)} ` +
            `GRANT SELECT ON TABLES TO ${ident}`,
        )
        await client.query(
          `ALTER DEFAULT PRIVILEGES FOR ROLE ${quoteIdent(creator)} IN SCHEMA ${quoteSchema(schema)} ` +
            `GRANT SELECT ON SEQUENCES TO ${ident}`,
        )
      }
    }
    console.log(`  default privileges set for: ${[...creators].join(', ')}`)

    // ── What it must NOT have ───────────────────────────────────────────────
    //
    // Revoked rather than merely never granted, because PUBLIC carries some of
    // these by default and a previous hand-run may have granted others.
    for (const schema of schemas) {
      await client.query(
        `REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ` +
          `ON ALL TABLES IN SCHEMA ${quoteSchema(schema)} FROM ${ident}`,
      )
    }
    await client.query(`REVOKE CREATE ON SCHEMA public FROM ${ident}`)
    await client.query(`REVOKE CREATE ON DATABASE ${quoteIdent(db)} FROM ${ident}`)
    console.log('  revoked every write privilege, and CREATE')

    const after = await readRole(client, BACKUP_ROLE)
    if (after.superuser || !after.bypassrls || !after.canLogin || after.createdb || after.createrole) {
      throw new Error(
        `${BACKUP_ROLE} did not converge: superuser=${after.superuser} ` +
          `bypassrls=${after.bypassrls} login=${after.canLogin} ` +
          `createdb=${after.createdb} createrole=${after.createrole}`,
      )
    }

    // It must be a member of nothing: membership of the application role would
    // hand it everything the application can do, ownership included.
    const { rows: memberships } = await client.query<{ rolname: string }>(
      `SELECT g.rolname FROM pg_auth_members m
         JOIN pg_roles g ON g.oid = m.roleid
         JOIN pg_roles r ON r.oid = m.member
        WHERE r.rolname = $1`,
      [BACKUP_ROLE],
    )
    if (memberships.length > 0) {
      throw new Error(
        `${BACKUP_ROLE} is a member of ${memberships.map(m => m.rolname).join(', ')}. ` +
          `It must be a member of nothing: membership of the application role would give it ` +
          `ownership rights over the objects it is only supposed to read.`,
      )
    }

    console.log('')
    if (issuedPassword) {
      const u = new URL(adminUrl())
      console.log('  BACKUP_DATABASE_URL (it is not recoverable — the installer records it):')
      console.log(
        `    postgresql://${BACKUP_ROLE}:${issuedPassword}@${u.hostname}:${u.port || 5432}${u.pathname}`,
      )
    } else {
      console.log(`  ${BACKUP_ROLE} kept its existing password.`)
    }
    console.log('')
  } finally {
    await client.end()
  }
}

main().catch(err => {
  console.error('')
  console.error(`  ${err instanceof Error ? err.message : String(err)}`)
  console.error('')
  process.exit(1)
})
