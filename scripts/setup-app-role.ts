/**
 * SEPARATE THE CREDENTIAL THE APPLICATION RUNS AS FROM THE ONE THAT INSTALLS IT
 * ============================================================================
 *
 *   npx tsx scripts/setup-app-role.ts            # report
 *   npx tsx scripts/setup-app-role.ts --apply    # create / converge the role
 *
 * WHY
 * ---
 * On the default Compose path the web and runtime processes connected as
 * `POSTGRES_USER`, which is the role `initdb` creates — a SUPERUSER. That is
 * one credential doing every job in the system, and one property of it matters
 * more than the rest: **a superuser bypasses row-level security**, including
 * `FORCE ROW LEVEL SECURITY`.
 *
 * So every RLS policy the platform writes was, on that path, advisory for the
 * application itself. Tenant isolation held because the application's own code
 * scoped its queries, not because the database would have refused. That is a
 * defensible design only until one query forgets, and it is exactly the class
 * of mistake `__tests__/services/backup-restore-privileges.test.ts` already
 * caught once: a superuser-only test proved nothing about a deployment where
 * the role cannot bypass RLS.
 *
 * It also hid itself. Anything tested as superuser passes whether or not the
 * grants are right, so the first honest report of a missing privilege arrives
 * in production.
 *
 * THE ROLES, AFTER THIS
 * ---------------------
 *   backenly_user          the bootstrap/admin credential. SUPERUSER, created
 *                          by initdb. Used ONLY by the install scripts, for the
 *                          things that genuinely require elevation: creating
 *                          roles, installing event triggers, extensions.
 *                          Never in DATABASE_URL.
 *
 *   backenly_app           the application credential. NOSUPERUSER NOBYPASSRLS.
 *                          Owns the platform tables and the workspace schemas,
 *                          so Backenly's governed typed actions keep the DDL
 *                          rights they need — but RLS applies to it.
 *
 *   backenly_authenticator the PostgREST login role. Unchanged: NOINHERIT, can
 *                          only switch into anon / authenticated / service_role.
 *
 *   backenly_backup        pg_dump only. NOSUPERUSER BYPASSRLS, CONNECT +
 *                          USAGE + SELECT and nothing else. Restore continues
 *                          over the application connection so ownership stays
 *                          with the owner.
 *
 * WHY OWNERSHIP RATHER THAN GRANTS
 * --------------------------------
 * The application must create, alter and drop tables in its workspace schemas —
 * that is what the typed actions do. A grant cannot express "may ALTER this
 * table"; PostgreSQL ties that to ownership. So `backenly_app` owns those
 * objects and is NOSUPERUSER, which is the combination that keeps DDL working
 * while leaving RLS in force.
 *
 * `FORCE ROW LEVEL SECURITY` is what makes that safe. Without it an owner is
 * exempt from its own policies, so ownership alone would re-open the hole this
 * closes. The platform already sets FORCE on workspace tables.
 *
 * THE GUC IS THE SEAM
 * -------------------
 * `public.backenly_app_role()` reads `backenly.app_role`, defaulting to
 * `backenly_user`. The privileged SQL already routes every ownership and grant
 * decision through it, so pointing that setting at the new role is what makes
 * the rest of the system agree — rather than a second hardcoded name.
 */

import { Client } from 'pg'
import { randomBytes } from 'crypto'

const APP_ROLE = process.env.BACKENLY_APP_ROLE?.trim() || 'backenly_app'

/** Identifiers are interpolated, so they must be verified, not trusted. */
const SAFE_IDENT = /^[a-z_][a-z0-9_]*$/

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag)
  return i === -1 ? undefined : process.argv[i + 1]
}
const has = (flag: string) => process.argv.includes(flag)

function quoteIdent(name: string): string {
  if (!SAFE_IDENT.test(name)) throw new Error(`Refusing unsafe identifier: ${name}`)
  return `"${name}"`
}

/**
 * The ADMIN connection.
 *
 * Creating a role and setting a database-level GUC both require elevation, so
 * this is the one place that still needs it. It is explicit rather than
 * inherited from DATABASE_URL, because the entire point of this script is that
 * those two are no longer the same credential.
 */
function adminUrl(): string {
  const explicit = process.env.BACKENLY_ADMIN_DATABASE_URL?.trim()
  if (explicit) return explicit
  const fallback = process.env.DIRECT_URL?.trim() || process.env.DATABASE_URL?.trim()
  if (!fallback) {
    throw new Error(
      'Set BACKENLY_ADMIN_DATABASE_URL to a superuser connection, or DATABASE_URL while it is still the superuser.'
    )
  }
  return fallback
}

function generatePassword(): string {
  // Hex, so it never needs escaping in a URL or a connection string. A
  // password containing `@` or `/` breaks DATABASE_URL in ways that surface as
  // an unrelated connection error.
  return randomBytes(24).toString('hex')
}

interface RoleState {
  exists: boolean
  superuser: boolean
  bypassrls: boolean
  canLogin: boolean
}

async function readRole(client: Client, role: string): Promise<RoleState> {
  const { rows } = await client.query(
    `SELECT rolsuper, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname = $1`,
    [role]
  )
  if (rows.length === 0) return { exists: false, superuser: false, bypassrls: false, canLogin: false }
  return {
    exists: true,
    superuser: rows[0].rolsuper === true,
    bypassrls: rows[0].rolbypassrls === true,
    canLogin: rows[0].rolcanlogin === true,
  }
}

async function main(): Promise<void> {
  const apply = has('--apply')
  const passwordArg = arg('--password')

  if (!SAFE_IDENT.test(APP_ROLE)) {
    throw new Error(`BACKENLY_APP_ROLE is not a valid identifier: ${APP_ROLE}`)
  }

  const client = new Client({ connectionString: adminUrl() })
  await client.connect()

  try {
    const { rows: whoami } = await client.query(
      `SELECT current_user AS who, current_database() AS db,
              (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS is_super`
    )
    const db: string = whoami[0].db
    console.log('')
    console.log(`  Connected to ${db} as ${whoami[0].who}${whoami[0].is_super ? ' (superuser)' : ''}`)

    if (!whoami[0].is_super) {
      // Said plainly rather than discovered as a permission error three
      // statements in, half-way through converging the role.
      throw new Error(
        'This script needs a superuser connection: creating a role and setting a ' +
        'database-level GUC both require elevation. Point BACKENLY_ADMIN_DATABASE_URL at one.'
      )
    }

    const before = await readRole(client, APP_ROLE)
    const current = await client.query(
      `SELECT coalesce(nullif(current_setting('backenly.app_role', true), ''), 'backenly_user') AS role`
    )
    console.log(`  Application role setting: ${current.rows[0].role}`)
    console.log(
      `  ${APP_ROLE}: ${before.exists ? 'exists' : 'missing'}` +
      (before.exists ? ` · superuser=${before.superuser} · bypassrls=${before.bypassrls}` : '')
    )

    if (!apply) {
      console.log('')
      console.log('  Report only. Rerun with --apply to converge.')
      console.log('')
      return
    }

    const ident = quoteIdent(APP_ROLE)
    let password: string | null = null

    if (!before.exists) {
      password = passwordArg || generatePassword()
      await client.query(
        `CREATE ROLE ${ident} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB ` +
        `PASSWORD '${password.replace(/'/g, "''")}'`
      )
      console.log(`  created ${APP_ROLE}`)
    } else {
      // Converged rather than recreated, and the password is left alone unless
      // one was passed. Rotating it here would break a running deployment that
      // is already authenticating with the old one.
      if (passwordArg) {
        password = passwordArg
        await client.query(`ALTER ROLE ${ident} PASSWORD '${passwordArg.replace(/'/g, "''")}'`)
        console.log(`  set the password of ${APP_ROLE}`)
      }
      console.log(`  ${APP_ROLE} already exists; leaving its password alone`)
    }

    // The properties that matter, asserted every run. A role that drifted into
    // SUPERUSER — or was created by hand as one — is silently back to bypassing
    // every policy, and nothing else in the system would notice.
    await client.query(`ALTER ROLE ${ident} NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB`)
    console.log(`  ${APP_ROLE} is NOSUPERUSER NOBYPASSRLS`)

    // CREATE on the database: bootstrap creates a schema per project, and
    // production once failed exactly here because the role lacked it.
    await client.query(`GRANT CONNECT, CREATE, TEMPORARY ON DATABASE ${quoteIdent(db)} TO ${ident}`)
    await client.query(`GRANT USAGE, CREATE ON SCHEMA public TO ${ident}`)
    console.log(`  granted CONNECT, CREATE on ${db} and on schema public`)

    // The seam. Every ownership and grant decision in the privileged SQL reads
    // this, so one setting moves the whole system to the new role.
    await client.query(`ALTER DATABASE ${quoteIdent(db)} SET backenly.app_role = '${APP_ROLE}'`)
    console.log(`  backenly.app_role = ${APP_ROLE}`)

    const after = await readRole(client, APP_ROLE)
    if (after.superuser || after.bypassrls || !after.canLogin) {
      throw new Error(
        `${APP_ROLE} did not converge: superuser=${after.superuser} bypassrls=${after.bypassrls} login=${after.canLogin}`
      )
    }

    console.log('')
    if (password) {
      console.log('  Put this in .env as DATABASE_URL and DIRECT_URL (it is not recoverable):')
      const u = new URL(adminUrl())
      console.log(`    postgresql://${APP_ROLE}:${password}@${u.hostname}:${u.port || 5432}${u.pathname}`)
    } else {
      console.log(`  ${APP_ROLE} kept its existing password. DATABASE_URL should already name it.`)
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
