/**
 * PHASE 3 — provision the PostgreSQL roles PostgREST authenticates as.
 *
 * PostgREST connects as ONE login role (the "authenticator") and then does
 * `SET LOCAL ROLE` to whatever the JWT's `role` claim names. The authenticator
 * is deliberately powerless: it can switch into the other roles and nothing
 * else, so a leaked connection string is not a leaked database.
 *
 *   backenly_authenticator   login role; NOINHERIT so it holds no privilege of
 *                            its own, only the ability to become the others
 *   anon                     unauthenticated requests
 *   authenticated            end users — every row still filtered by RLS
 *   service_role             owner tooling; RLS policies grant it the escape
 *
 * NOINHERIT is the load-bearing detail. With INHERIT the authenticator would
 * passively hold the union of every granted role's privileges, and a request
 * that failed to switch role would run with service_role's reach.
 *
 * Grants are per workspace schema, plus ALTER DEFAULT PRIVILEGES so tables
 * created later are covered — otherwise every new table would be invisible
 * until someone remembered to grant on it, which is the kind of step that gets
 * forgotten exactly once.
 *
 *   npx tsx scripts/setup-postgrest-roles.ts --project <id>
 *   npx tsx scripts/setup-postgrest-roles.ts --project <id> --apply
 */

import { PrismaClient } from '@prisma/client'
import { randomBytes } from 'crypto'

const prisma = new PrismaClient()

const AUTHENTICATOR = 'backenly_authenticator'
const ROLES = ['anon', 'authenticated', 'service_role'] as const

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag)
  return i === -1 ? undefined : process.argv[i + 1]
}

async function main() {
  const projectId = arg('--project')
  const apply = process.argv.includes('--apply')
  const rotatePassword = process.argv.includes('--rotate-password')
  const password = arg('--password') ?? randomBytes(24).toString('hex')

  if (!projectId) {
    console.error('Missing --project <projectId>')
    process.exit(2)
  }

  // Does the authenticator already exist? This decides whether a password is
  // being SET for the first time or ROTATED out from under a running PostgREST.
  const authenticatorRows = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
    `SELECT count(*)::bigint AS n FROM pg_roles WHERE rolname = $1`,
    AUTHENTICATOR,
  )
  const authenticatorExists = Number(authenticatorRows[0]?.n ?? 0) > 0

  if (authenticatorExists && rotatePassword) {
    console.warn('')
    console.warn(`  !  ROTATING the password of ${AUTHENTICATOR}.`)
    console.warn('     This role is CLUSTER-WIDE. Every PostgREST instance on this cluster')
    console.warn('     authenticates with it, including any you did not intend to touch.')
    console.warn('     They will fail on their next reconnect until postgrest.conf is')
    console.warn('     updated with the connection string printed below and restarted.')
    console.warn('')
  }
  const schema = `workspace_${projectId}`

  const exists = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
    `SELECT count(*)::bigint AS n FROM information_schema.schemata WHERE schema_name = $1`,
    schema,
  )
  if (Number(exists[0]?.n ?? 0) === 0) {
    console.error(`Schema ${schema} does not exist.`)
    process.exit(1)
  }

  const statements: string[] = []

  // Roles are cluster-wide; creating them is idempotent via the DO guard.
  for (const role of ROLES) {
    statements.push(
      `DO $$ BEGIN
         IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN
           CREATE ROLE ${role} NOLOGIN;
         END IF;
       END $$`,
    )
  }
  statements.push(
    `DO $$ BEGIN
       IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${AUTHENTICATOR}') THEN
         CREATE ROLE ${AUTHENTICATOR} LOGIN NOINHERIT;
       END IF;
     END $$`,
  )
  // Re-asserted every run: NOINHERIT is what keeps the authenticator powerless.
  statements.push(`ALTER ROLE ${AUTHENTICATOR} NOINHERIT`)

  // The password is set when the role is CREATED, and otherwise only on an
  // explicit --rotate-password.
  //
  // This used to be `if (apply)`, unconditionally, with a fresh random password
  // every run. The script is documented as idempotent and operators are told to
  // re-run it, so re-running it on any cluster with a live PostgREST silently
  // rotated the credential that PostgREST authenticates with. Existing
  // connections survive on cached auth, so nothing appears to break until the
  // next reconnect or restart — at which point the entire /db/* data plane
  // fails, with no way back, because the script prints the new password once
  // and calls it unrecoverable.
  //
  // `--apply` now means "converge this cluster to the requested state", not
  // "rotate live credentials". Rotation is a separate, deliberate act.
  const willSetPassword = !authenticatorExists || rotatePassword
  if (apply && willSetPassword) {
    statements.push(`ALTER ROLE ${AUTHENTICATOR} PASSWORD '${password}'`)
  }
  for (const role of ROLES) {
    statements.push(`GRANT ${role} TO ${AUTHENTICATOR}`)
  }

  // Per-schema access. RLS does the row filtering; these grants only decide
  // whether the role may reach the table at all.
  statements.push(`GRANT USAGE ON SCHEMA "${schema}" TO anon, authenticated, service_role`)
  statements.push(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "${schema}" TO authenticated, service_role`,
  )
  statements.push(`GRANT SELECT ON ALL TABLES IN SCHEMA "${schema}" TO anon`)
  statements.push(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA "${schema}" TO authenticated, service_role`)
  statements.push(
    `GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA "${schema}" TO anon, authenticated, service_role`,
  )

  // Future tables — without this, anything created after today is unreachable
  // until someone remembers to grant on it.
  statements.push(
    `ALTER DEFAULT PRIVILEGES IN SCHEMA "${schema}" GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO authenticated, service_role`,
  )
  statements.push(
    `ALTER DEFAULT PRIVILEGES IN SCHEMA "${schema}" GRANT SELECT ON TABLES TO anon`,
  )
  statements.push(
    `ALTER DEFAULT PRIVILEGES IN SCHEMA "${schema}" GRANT USAGE, SELECT ON SEQUENCES TO authenticated, service_role`,
  )

  // ── Reserved + auth-managed tables: REVOKE after the blanket grant ─────────
  //
  // THIS IS THE STEP THAT MAKES THE CUTOVER SAFE, and it must come last so it
  // wins over both the ON ALL TABLES grant above and DEFAULT PRIVILEGES.
  //
  // v1 protects these imperatively: runtimeApiExecutor 404s any request whose
  // first path segment is a reserved (`_`-prefixed) or auth-managed (`users`)
  // table. PostgREST has no such layer — it serves whatever the role can reach.
  // So the blanket `GRANT ... ON ALL TABLES` above would have handed `anon`
  // unauthenticated SELECT on `users` (password hashes) and on
  // `_password_resets` / `_magic_links` / `_email_verifications` /
  // `_token_blacklist`, which carry single-use auth tokens and — as the v1
  // comment states plainly — are NOT RLS-protected. That is account takeover,
  // and RLS would not have caught it because there are no policies to apply.
  //
  // Verified on prod 2026-07-20: PostgREST is live on this schema but these
  // grants had never been run, so every such table answered 42501. Running this
  // script as it stood was the thing that would have opened them.
  //
  // Delegated, NOT reimplemented. `backenly_pgrst_revoke_internal` (defined in
  // scripts/sql/postgrest-schema-registry.sql) is the one definition of "which
  // tables must never be client-reachable", and postgrest-ddl-sync.sql's event
  // trigger re-asserts it after every CREATE TABLE — so a reserved table created
  // tomorrow is covered without anyone editing this file.
  //
  // Note it revokes from service_role as well, which is stricter than it first
  // looks and is correct: /auth/* runs on the Express runtime as the schema
  // owner, never through PostgREST, so service_role has no legitimate need to
  // read `users` or consume single-use tokens.
  //
  // Runs LAST so it wins over both the blanket grants and DEFAULT PRIVILEGES
  // above. Ordering is the whole protection here.
  statements.push(`SELECT public.backenly_pgrst_revoke_internal('${schema}')`)

  console.log(`\n  schema  ${schema}`)
  console.log(`  roles   ${AUTHENTICATOR} (NOINHERIT) + ${ROLES.join(', ')}`)
  console.log(`  ${apply ? 'APPLYING' : 'WOULD RUN'} ${statements.length} statement(s)\n`)

  if (!apply) {
    for (const s of statements) console.log(`  ${s.replace(/\s+/g, ' ').slice(0, 150)}`)
    console.log('\n  Dry run. Re-run with --apply to execute.\n')
    await prisma.$disconnect()
    return
  }

  for (const s of statements) {
    await prisma.$executeRawUnsafe(s)
  }

  console.log('  Done.\n')

  if (willSetPassword) {
    console.log('  Connection string for postgrest.conf (store it, it is not recoverable):')
    console.log(`    postgres://${AUTHENTICATOR}:${password}@localhost:5432/<database>\n`)
  } else {
    // Saying nothing here would be worse than saying this. An operator who
    // reran the command and saw no connection string could reasonably assume
    // the run failed, and reach for --rotate-password to "fix" it.
    console.log(`  ${AUTHENTICATOR} already existed, so its password was left ALONE and`)
    console.log('  the grants were converged. Any running PostgREST keeps working.')
    console.log('')
    console.log('  If you genuinely need a new credential, and are ready to update')
    console.log('  postgrest.conf and restart PostgREST:')
    console.log('')
    console.log(`    npx tsx scripts/setup-postgrest-roles.ts --project ${projectId} --apply --rotate-password\n`)
  }

  await prisma.$disconnect()
}

main().catch(async (err) => {
  console.error('setup failed:', err instanceof Error ? err.message : err)
  await prisma.$disconnect()
  process.exit(1)
})
