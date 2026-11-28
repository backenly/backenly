/**
 * DIRECT DATABASE ACCESS — the open-loop service
 * ================================================
 * Hands developers real PostgreSQL logins to their own project's data, without
 * giving the app CREATEROLE or weakening the governance kernel:
 *
 *   READ_ONLY  (bkn_ro_<hex12>) — SELECT on every workspace table/sequence.
 *               psql, TablePlus, EXPLAIN, BI tools, self-serve pg_dump.
 *               Cannot mutate anything: no INSERT/UPDATE/DELETE/DDL grants.
 *   READ_WRITE (bkn_rw_<hex12>) — DML. Schema changes over it skip the
 *               approvals and History every other door goes through, and on a
 *               database shared by several projects a trigger, function or view
 *               created through it would run in the sessions that serve all of
 *               them. So Postgres refuses a login any schema change (no CREATE
 *               anywhere, no owner-role membership, nothing it owns): on a
 *               shared database always, and on one dedicated to a single
 *               project until its admin allows them (setSchemaChanges). Allowed,
 *               every DDL statement it runs is captured by the backenly_ddl_watch
 *               event trigger into SchemaDriftEvent, and the autonomy loop
 *               adopts or flags it (see lib/autonomy/drift-watch.ts).
 *
 * WHERE A LOGIN CONNECTS. A project with a database of its own (tenancy
 * 'dedicated', lib/data-plane/regional.ts) is reached through its region's
 * connection pooler and nothing else (lib/data-plane/pooler.ts): port 5432 for
 * sessions (migrations, psql) and 6543 for transactions (application traffic),
 * with sslmode=verify-full against the pooler's publicly trusted certificate.
 * Where the region does not offer the pooler (POOLER_HOST[_<REGION>] unset),
 * such a project gets no connection string. A project in its region's shared
 * database gets the host its operator gives (DIRECT_DB_HOST[_<REGION>]), which
 * is how a self-hosted deployment's single project is reached, and on Backenly
 * Cloud, where no region has one, no connection string at all. Either way the
 * answer says why rather than naming a host nothing answers on.
 *
 * PASSWORDS. On a project's own database a login's password is set as a
 * SCRAM-SHA-256 verifier computed here (lib/data-plane/scram.ts), and the
 * identical verifier is written to the pooler's row for the login, so the
 * pooler can sign the login in to the server. The credential row keeps that
 * verifier (encrypted at rest), never the password:
 *   - READ_WRITE: a random password, shown once, in the answer that made or
 *     rotated it. Nothing can produce it again; a lost one is rotated.
 *   - READ_ONLY: the platform itself signs in as this login (run_query), so
 *     its password is derived from a key of the platform's (projectEnvCrypto
 *     derivedKey) and the verifier's salt, and shown on every read, as before.
 * Resuming a paused project re-keys its logins with what the row keeps
 * (lib/projects/paused-logins.ts), which is the verifier, so the server and the
 * pooler still agree afterwards. On a shared database the password itself is
 * kept, AES-256-GCM encrypted (projectEnvCrypto), so the dashboard can show the
 * connection string again.
 *
 * Every privileged operation is delegated to a SECURITY DEFINER function
 * installed by scripts/setup-direct-access.sql (hard input validation, EXECUTE
 * granted to the application role only). This module never builds role DDL
 * itself. Rotation terminates live sessions server-side.
 */

import crypto from 'crypto'
import { prisma } from '@/lib/db/prisma'
import {
  projectDatabase,
  projectDriftEvents,
  projectRegion,
  regionDatabaseUrl,
  regionRawClient,
  regionSetting,
  databaseClient,
  workspaceRawClient,
  type ProjectDatabase,
} from '@/lib/data-plane/regional'
import {
  ensurePoolerLogins,
  isPoolerDatabaseMissing,
  poolerEndpoint,
  poolerHostVariable,
  prunePoolerLogins,
  putPoolerLogin,
  removePoolerLogins,
  setPoolerLoginsActive,
  type PoolerLogin,
} from '@/lib/data-plane/pooler'
import { isScramVerifier, SCRAM_SALT_BYTES, scramSha256Verifier } from '@/lib/data-plane/scram'
import { poolerPortShares, type PoolerPortShares } from '@/lib/data-plane/pooler-shares'
import { CLOUD_REGIONS, HOME_REGION, type CloudRegionId } from '@/lib/regions'
import { DELETED_PAUSE_REASON } from '@/lib/projects/serving-state'
import { resolveWorkspaceSchema } from '@/lib/services/workspace-pool'
import { assertValidProjectId, quoteIdent } from '@/lib/security/workspace-schema'
import { decryptValue, derivedKey, encryptValue } from '@/lib/security/projectEnvCrypto'
import { rotateProjectChannel } from '@/lib/realtime/channels'
import { directPostgresAllowanceFor } from '@/lib/entitlements/direct-postgres'

export type DirectAccessMode = 'READ_ONLY' | 'READ_WRITE'

/** Whether a read-write login may change the schema (scripts/setup-direct-access.sql, section 5b). */
export type SchemaChanges = 'allowed' | 'refused'

/**
 * Why schema changes cannot be allowed over a read-write login here: the
 * database is shared by several projects (scripts/setup-direct-access.sql,
 * section 5c), the project's own database has no pooler in its region to be
 * reached through, or its direct-access helpers predate the check.
 */
export type SchemaChangesUnavailable = 'shared_database' | 'pooler_not_offered' | 'helpers_outdated'

export const SCHEMA_CHANGES_UNAVAILABLE_MESSAGE: Record<SchemaChangesUnavailable, string> = {
  shared_database:
    "This project's database is shared with other projects, so a read-write login changes rows only and schema changes " +
    'cannot be allowed over it: a trigger, function or view made through it would run with access to every project in ' +
    'the database. Change the schema with apply_migration or the dashboard.',
  pooler_not_offered:
    "Schema changes over a read-write login are allowed only on a project's own database reached through the connection " +
    "pooler, which isn't offered in this project's region yet. Change the schema with apply_migration or the dashboard.",
  helpers_outdated: 'This database needs its direct-access helpers updated before this setting can change.',
}

/** Allowing schema changes over a read-write login was asked for where it cannot be. */
export class SchemaChangesUnavailableError extends Error {
  readonly code = 'SCHEMA_CHANGES_UNAVAILABLE'
  constructor(readonly reason: SchemaChangesUnavailable) {
    super(SCHEMA_CHANGES_UNAVAILABLE_MESSAGE[reason])
    this.name = 'SchemaChangesUnavailableError'
  }
}

/**
 * Why a project has no connection string:
 *   no_host             a shared database whose operator gave no host
 *                       (DIRECT_DB_HOST): nothing outside can reach it
 *   shared_database     on Backenly Cloud, a project still in its region's
 *                       shared database, which nothing outside reaches;
 *                       direct connections are for a project's own database
 *   pooler_not_offered  a project's own database in a region whose pooler is
 *                       not offered yet (POOLER_HOST[_<REGION>] unset)
 */
export type DirectAccessUnavailable = 'no_host' | 'shared_database' | 'pooler_not_offered'

export const DIRECT_ACCESS_UNAVAILABLE_MESSAGES: Record<DirectAccessUnavailable, string> = {
  no_host:
    "Direct Postgres connections aren't available in this project's region yet: nothing outside Backenly can reach its database, so there is no connection string to give.",
  shared_database:
    "Direct Postgres connections are for projects with a database of their own, reached through Backenly's connection pooler. This project's data is in its region's shared database, which nothing outside Backenly can reach, so there is no connection string for it.",
  pooler_not_offered:
    "This project has a database of its own, but the connection pooler that direct Postgres connections go through isn't offered in its region yet, so there is no connection string for it yet.",
}

/**
 * The sentence for a shared database with no host, under its old name: a
 * self-hosted deployment whose operator gave no host reads exactly this.
 * Production QA re-test, 2026-11-16, N4: the home region used to fall back to
 * backenly.com:5432, where nothing listens.
 */
export const DIRECT_ACCESS_UNAVAILABLE_MESSAGE = DIRECT_ACCESS_UNAVAILABLE_MESSAGES.no_host

export class DirectAccessUnavailableError extends Error {
  readonly code = 'DIRECT_ACCESS_UNAVAILABLE'
  constructor(
    readonly reason: DirectAccessUnavailable,
    readonly region: CloudRegionId,
    /** The setting that would offer connections: DIRECT_DB_HOST[_R] for a shared database, POOLER_HOST[_R] for a project's own. */
    readonly variable: string,
  ) {
    super(DIRECT_ACCESS_UNAVAILABLE_MESSAGES[reason])
    this.name = 'DirectAccessUnavailableError'
  }
}

/**
 * A login asked for while the project is paused, or asked to be deleted, which
 * pauses it. Its logins are stopped while it is (lib/projects/paused-logins.ts),
 * so none is created or re-keyed: that would let one connect again.
 */
export class DirectAccessPausedError extends Error {
  readonly code = 'PROJECT_PAUSED'
  constructor(readonly deleted: boolean) {
    super(
      deleted
        ? 'This project was deleted, so it gets no Postgres login. Restore it first.'
        : "This project is paused, so its Postgres logins don't connect and no new one is made. Resume it first.",
    )
    this.name = 'DirectAccessPausedError'
  }
}

async function refuseWhilePaused(projectId: string): Promise<void> {
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { pausedAt: true, pauseReason: true } })
  if (project?.pausedAt) throw new DirectAccessPausedError(project.pauseReason === DELETED_PAUSE_REASON)
}

/**
 * When a login's password is part of what is shown:
 *   always  on every read: a login on a shared database, and the read-only
 *           login of a project's own database, which the platform signs in with
 *   once    only in the answer that made or rotated it: the read-write login
 *           of a project's own database
 *   rotate  not until it is rotated: a login made before its project had a
 *           database of its own, whose verifier was never kept for the pooler
 */
export type PasswordShown = 'always' | 'once' | 'rotate'

/** In a connection string whose password is not shown. */
export const PASSWORD_PLACEHOLDER = '[YOUR-PASSWORD]'

export interface DirectAccessCredential {
  mode: DirectAccessMode
  roleName: string
  /** Null where it is not shown (passwordShown). */
  password: string | null
  passwordShown: PasswordShown
  host: string
  /** The session port through the pooler (5432), or the database's own port. */
  port: number
  database: string
  /**
   * The string for psql, pg_dump, migrations and anything that holds a
   * session. Through the pooler: port 5432, sslmode=verify-full. With
   * PASSWORD_PLACEHOLDER in place of a password that is not shown.
   */
  connectionString: string
  /** Through the pooler only: port 6543, transaction pooling, for application traffic and serverless functions. */
  transactionConnectionString?: string
  /** Through the pooler only: the transaction-pooling port. */
  transactionPort?: number
  psqlCommand: string
  pgDumpCommand: string
  createdAt: string
  rotatedAt: string | null
  /** READ_WRITE only: whether schema changes over the login are allowed. */
  schemaChanges?: SchemaChanges
  /** READ_WRITE only, and only where they cannot be allowed: why. */
  schemaChangesUnavailable?: SchemaChangesUnavailable
}

export interface DirectAccessStatus {
  schema: string
  /** Whether a connection from outside Backenly can reach this project's database. */
  available: boolean
  /** Why not, in a sentence, where it cannot. */
  unavailable?: string
  unavailableReason?: DirectAccessUnavailable
  /** Where the project's data is: its region's shared database, or one of its own. */
  tenancy: ProjectDatabase['tenancy']
  /** Where connections go through the pooler: its host, both ports, and which to use for what. */
  pooler?: { host: string; sessionPort: number; transactionPort: number; guidance: string[] }
  credentials: DirectAccessCredential[]
  /**
   * Where connections cannot be made: the logins that exist, by name, so they
   * can still be revoked. Their passwords and strings are not given.
   */
  logins?: Array<{ mode: DirectAccessMode; roleName: string; createdAt: string; rotatedAt: string | null }>
  /**
   * Where connections can be made: how many each login may hold at once, by
   * the project's plan (Postgres CONNECTION LIMIT). Null where the database
   * cannot set it yet (helpers from before section 3b).
   */
  connectionLimit?: number | null
  /**
   * Through the pooler only: how that number is shared by its two ports, the
   * sessions a login may have open on the session port and the server
   * connections its transactions share on the transaction port
   * (lib/data-plane/pooler-shares.ts). Using one port never takes from the
   * other.
   */
  connectionShares?: PoolerPortShares
  pendingDriftEvents: number
}

/** Which port is for what, said wherever pooler strings are handed out (console, MCP). */
export const POOLER_GUIDANCE: string[] = [
  'Port 5432 is session pooling: use it for migrations, psql, pg_dump and anything that holds a session (LISTEN, advisory locks, session SET).',
  'Port 6543 is transaction pooling: use it for application traffic and serverless functions.',
  'Prisma: the application on 6543 (url) and Prisma Migrate on 5432 (directUrl).',
  "sslmode=verify-full checks the pooler's publicly trusted certificate. psql and pg_dump 16 or later take sslrootcert=system as your system's trusted roots, which the commands given here add.",
]

// ── Naming ────────────────────────────────────────────────────────────────────

/** Deterministic, opaque per-project role names (rolnames are cluster-visible). */
export function directAccessRoleNames(projectId: string): { ro: string; rw: string; owner: string } {
  assertValidProjectId(projectId)
  const hex = crypto.createHash('sha256').update(projectId).digest('hex').slice(0, 12)
  return { ro: `bkn_ro_${hex}`, rw: `bkn_rw_${hex}`, owner: `bkn_own_${hex}` }
}

function generatePassword(): string {
  // 24 random bytes → 32 chars base64url: URL-safe (no encoding surprises in
  // connection strings), printable ASCII without spaces (what a SCRAM verifier
  // needs, lib/data-plane/scram.ts), and past the definer function's length
  // floor.
  return crypto.randomBytes(24).toString('base64url')
}

// ── Passwords on a project's own database ────────────────────────────────────

/** Never the key projectEnvCrypto encrypts with, and versioned so it can be replaced. */
const READ_ONLY_PASSWORD_PURPOSE = 'backenly/project-database-read-only-login/v1'

/**
 * The read-only login's password on a project's own database, from its role
 * name and its verifier's salt: 43 characters of base64url. The platform signs
 * in as this login for run_query, so it must be able to produce the password;
 * deriving it from the salt the verifier already carries lets the credential
 * row keep the verifier alone, which is what a resume re-keys the login with.
 */
function readOnlyPassword(roleName: string, salt: Buffer): string {
  return crypto.createHmac('sha256', derivedKey(READ_ONLY_PASSWORD_PURPOSE)).update(`${roleName}\n`).update(salt).digest('base64url')
}

/** The iteration count and salt a verifier carries (SCRAM-SHA-256$<iterations>:<salt>$...). */
function parametersOf(verifier: string): { iterations: number; salt: Buffer } {
  const [, iterations, salt] = /^SCRAM-SHA-256\$(\d+):([^$]+)\$/.exec(verifier) ?? []
  return { iterations: Number(iterations), salt: Buffer.from(salt ?? '', 'base64') }
}

/** A new login secret on a project's own database: the password, and the verifier the server and the pooler get. */
function newLoginSecret(roleName: string, mode: DirectAccessMode): { password: string; verifier: string } {
  const salt = crypto.randomBytes(SCRAM_SALT_BYTES)
  const password = mode === 'READ_ONLY' ? readOnlyPassword(roleName, salt) : generatePassword()
  return { password, verifier: scramSha256Verifier(password, { salt }) }
}

/**
 * The read-only login's password from the verifier its row keeps, checked
 * against that verifier, so a platform key changed since says so instead of
 * failing every run_query as a wrong password.
 */
function readOnlyPasswordFrom(roleName: string, verifier: string): string {
  const { iterations, salt } = parametersOf(verifier)
  const password = readOnlyPassword(roleName, salt)
  if (scramSha256Verifier(password, { salt, iterations }) !== verifier) {
    throw new Error(
      `The read-only login ${roleName} was made under another platform key, so its password can't be produced. Rotate it in Connect → Postgres.`,
    )
  }
  return password
}

type CredentialRow = {
  mode: string
  roleName: string
  passwordCipher: string
  passwordIv: string
  passwordTag: string
  createdAt: Date
  rotatedAt: Date | null
}

/** What a credential row keeps: a project database login's verifier, or the password on a shared database. */
function storedSecret(row: Pick<CredentialRow, 'passwordCipher' | 'passwordIv' | 'passwordTag'>): string {
  return decryptValue({ valueCipher: row.passwordCipher, valueIv: row.passwordIv, valueTag: row.passwordTag })
}

// ── Connection info ───────────────────────────────────────────────────────────

export type ConnectionTarget =
  | { kind: 'pooler'; host: string; sessionPort: number; transactionPort: number; database: string }
  | { kind: 'direct'; host: string; port: number; database: string; sslmode: 'require' | 'prefer' }

type Env = Readonly<Record<string, string | undefined>>

/**
 * Backenly Cloud, where a shared database is never reached from outside. Only
 * chooses the sentence: a self-hosted deployment with no host says no_host.
 * Read here rather than through lib/edition, which this module's importers
 * reach through project provisioning (the cycle lib/entitlements notes).
 */
function cloudEdition(env: Env = process.env): boolean {
  return env.BACKENLY_EDITION?.trim().toLowerCase() === 'cloud'
}

/**
 * Where a developer connects to reach a project's data. Pure: the project's
 * placement and the environment decide it.
 *
 * A project's own database: the region's pooler (POOLER_HOST for the home
 * region, POOLER_HOST_<REGION> for any other), its session and transaction
 * ports, and the database's own name. Without one this refuses with
 * DirectAccessUnavailableError (pooler_not_offered).
 *
 * A shared database: the host its operator gives (DIRECT_DB_HOST for the home
 * region, DIRECT_DB_HOST_<REGION> for any other, DIRECT_DB_PORT and its
 * regional form optional), and outside production the home region keeps
 * localhost, the developer's own database. Without one this refuses rather
 * than name a host nothing answers on.
 */
export function directConnectionTarget(placement: ProjectDatabase, env: Env = process.env): ConnectionTarget {
  const { region } = placement
  if (placement.tenancy === 'dedicated') {
    const pooler = poolerEndpoint(region, env)
    if (!pooler) throw new DirectAccessUnavailableError('pooler_not_offered', region, poolerHostVariable(region))
    return { kind: 'pooler', host: pooler.host, sessionPort: pooler.sessionPort, transactionPort: pooler.transactionPort, database: placement.database as string }
  }
  const isProd = env.NODE_ENV === 'production'
  let database = 'backenly'
  try {
    const url = new URL(regionDatabaseUrl(region, 'app', env) ?? '')
    database = url.pathname.replace(/^\//, '').split('?')[0] || 'backenly'
  } catch {
    /* keep default */
  }
  const host = regionSetting('DIRECT_DB_HOST', region, env)
  const hostname = host.value || (!isProd && region === HOME_REGION ? 'localhost' : '')
  if (!hostname) throw new DirectAccessUnavailableError(cloudEdition(env) ? 'shared_database' : 'no_host', region, host.variable)
  return {
    kind: 'direct',
    host: hostname,
    port: parseInt(regionSetting('DIRECT_DB_PORT', region, env).value ?? '5432', 10),
    database,
    // A self-hosted server with a certificate of its own: require (encrypted,
    // no CA verification). Local dev clusters usually have ssl off, so don't
    // demand it there.
    sslmode: isProd ? 'require' : 'prefer',
  }
}

async function connectionTarget(projectId: string): Promise<ConnectionTarget> {
  return directConnectionTarget(await projectDatabase(projectId))
}

/**
 * The strings a login is handed for a target: through the pooler a session
 * string (5432) and a transaction string (6543), both sslmode=verify-full;
 * elsewhere one string. PASSWORD_PLACEHOLDER stands in for a password that is
 * not shown. Pure.
 */
export function credentialStrings(
  target: ConnectionTarget,
  roleName: string,
  password: string | null,
  schema: string,
): Pick<
  DirectAccessCredential,
  'host' | 'port' | 'database' | 'connectionString' | 'transactionConnectionString' | 'transactionPort' | 'psqlCommand' | 'pgDumpCommand'
> {
  const login = `${roleName}:${password ?? PASSWORD_PLACEHOLDER}`
  let connectionString: string
  let libpq: string
  let port: number
  let pooled: Pick<DirectAccessCredential, 'transactionConnectionString' | 'transactionPort'> = {}
  if (target.kind === 'pooler') {
    port = target.sessionPort
    connectionString = `postgresql://${login}@${target.host}:${port}/${target.database}?sslmode=verify-full`
    pooled = {
      transactionConnectionString: `postgresql://${login}@${target.host}:${target.transactionPort}/${target.database}?sslmode=verify-full`,
      transactionPort: target.transactionPort,
    }
    // psql and pg_dump 16 and later take the system's trusted roots this way;
    // without it libpq looks only for ~/.postgresql/root.crt. Not in the
    // strings themselves: node-postgres would read "system" as a file name.
    libpq = `${connectionString}&sslrootcert=system`
  } else {
    port = target.port
    connectionString = `postgresql://${login}@${target.host}:${port}/${target.database}?sslmode=${target.sslmode}`
    libpq = connectionString
  }
  return {
    host: target.host,
    port,
    database: target.database,
    connectionString,
    ...pooled,
    // search_path is pinned per-role server-side, so plain psql lands in the
    // project's schema — `\dt` just works.
    psqlCommand: `psql "${libpq}"`,
    // --enable-row-security is load-bearing: pg_dump defaults row_security to
    // OFF, and PostgreSQL then refuses to dump any RLS table the NOBYPASSRLS
    // bkn_ro_ role is subject to ("query would be affected by row-level
    // security policy"). With the flag on, the role reads through its
    // pass-through SELECT policy and the dump completes. On the session port.
    pgDumpCommand: `pg_dump "${libpq}" --schema="${schema}" --enable-row-security --no-owner --no-privileges > backup.sql`,
  }
}

/**
 * A credential as shown. `made` is the password just set, where the caller has
 * it (provision, rotate): the only time a read-write login's password on a
 * project's own database is shown.
 */
function buildCredential(row: CredentialRow, schema: string, target: ConnectionTarget, made?: { password: string }): DirectAccessCredential {
  const stored = storedSecret(row)
  const verifierKept = isScramVerifier(stored)
  let password: string | null
  let passwordShown: PasswordShown
  if (target.kind === 'pooler' && !verifierKept) {
    // A password kept as it is: no verifier of it was kept for the pooler's
    // row, so it cannot sign in through the pooler, and is shown nowhere
    // until the login is rotated.
    passwordShown = 'rotate'
    password = null
  } else if (target.kind === 'direct') {
    passwordShown = 'always'
    password = made?.password ?? (verifierKept ? null : stored)
  } else if (row.mode === 'READ_ONLY') {
    passwordShown = 'always'
    try {
      password = made?.password ?? readOnlyPasswordFrom(row.roleName, stored)
    } catch {
      // Made under a platform key that has changed since: a rotation gives it
      // a password that can be produced again.
      passwordShown = 'rotate'
      password = null
    }
  } else {
    passwordShown = 'once'
    password = made?.password ?? null
  }
  return {
    mode: row.mode as DirectAccessMode,
    roleName: row.roleName,
    password,
    passwordShown,
    ...credentialStrings(target, row.roleName, password, schema),
    createdAt: row.createdAt.toISOString(),
    rotatedAt: row.rotatedAt ? row.rotatedAt.toISOString() : null,
  }
}

// ── The pooler's rows ─────────────────────────────────────────────────────────
//
// A project database's login is served by the pooler only through its row in
// backenly_pooler.logins (lib/data-plane/pooler.ts), which carries the same
// verifier the server holds. The row is written LAST when a login is made or
// rotated, after the server has the verifier and the credential row records
// it: until then the pooler cannot sign the login in, which is the safe way to
// fail. It is turned off FIRST when a login is revoked, before the role is
// dropped. And the pooler serves a row only while its role can log in, so a
// login made NOLOGIN (a pause) or dropped is refused even before its row
// changes.

const poolerWriteFailedSaid = new Set<string>()

/** A pooler write that must not hold back what called it; logged by its code, never its values. */
async function quietly(what: string, region: CloudRegionId, write: () => Promise<unknown>): Promise<void> {
  try {
    await write()
  } catch (err) {
    // No pooler database on the instance yet: no row to change.
    if (isPoolerDatabaseMissing(err)) return
    const key = `${region}:${what}`
    if (!poolerWriteFailedSaid.has(key)) {
      poolerWriteFailedSaid.add(key)
      console.warn(`[DirectAccess] region=${region}: ${what} not done (${err instanceof Error ? err.message : 'Error'}); the scheduled pass tries again`)
    }
  }
}

/** The pooler's row for a project database's login, from its credential row; null where its row keeps no verifier. */
function poolerLoginOf(
  row: Pick<CredentialRow, 'roleName' | 'passwordCipher' | 'passwordIv' | 'passwordTag'>,
  database: string,
  active: boolean,
): PoolerLogin | null {
  const verifier = storedSecret(row)
  return isScramVerifier(verifier) ? { rolname: row.roleName, verifier, database, active } : null
}

/**
 * Bring the pooler's rows for a project's logins in line with what their
 * credential rows keep, where its region offers the pooler: a missing row (the
 * pooler was offered after the login was made, or a write failed) is written,
 * a different verifier corrected, and a row turned off is turned on again
 * unless the project is paused. Never throws.
 */
async function ensureProjectPoolerLogins(projectId: string, placement: ProjectDatabase, rows: CredentialRow[]): Promise<void> {
  if (placement.tenancy !== 'dedicated' || !poolerEndpoint(placement.region) || rows.length === 0) return
  try {
    const project = await prisma.project.findUnique({ where: { id: projectId }, select: { pausedAt: true } })
    const logins = rows
      .map((r) => poolerLoginOf(r, placement.database as string, !project?.pausedAt))
      .filter((l): l is PoolerLogin => l !== null)
    await quietly('pooler logins', placement.region, () => ensurePoolerLogins(placement.region, logins))
  } catch (err) {
    console.warn(`[DirectAccess] project=${projectId}: pooler logins not checked: ${err instanceof Error ? err.name : 'Error'}`)
  }
}

/**
 * Stop the pooler serving a project's logins, for a pause or a deletion
 * (lib/projects), beside making the logins NOLOGIN and ending their sessions
 * there: the pooler serves no login that cannot log in, so this is the second
 * of two locks, not the only one. Answers how many rows were turned off.
 * Never throws.
 */
export async function stopPoolerLogins(projectId: string): Promise<number> {
  let changed = 0
  try {
    const placement = await projectDatabase(projectId)
    if (placement.tenancy !== 'dedicated') return 0
    const { ro, rw } = directAccessRoleNames(projectId)
    await quietly('pooler logins off', placement.region, async () => {
      changed = await setPoolerLoginsActive(placement.region, [ro, rw], false)
    })
  } catch (err) {
    console.warn(`[DirectAccess] project=${projectId}: pooler logins not turned off: ${err instanceof Error ? err.name : 'Error'}`)
  }
  return changed
}

/**
 * Serve a project's logins through the pooler again, for a resume or a
 * restore (lib/projects), once its logins can log in again. Nothing while the
 * project is paused. Never throws.
 */
export async function restorePoolerLogins(projectId: string): Promise<void> {
  try {
    const placement = await projectDatabase(projectId)
    if (placement.tenancy !== 'dedicated') return
    const rows = await prisma.databaseCredential.findMany({ where: { projectId } })
    await ensureProjectPoolerLogins(projectId, placement, rows)
  } catch (err) {
    console.warn(`[DirectAccess] project=${projectId}: pooler logins not restored: ${err instanceof Error ? err.name : 'Error'}`)
  }
}

/**
 * Remove a project's rows from the pooler, for a deletion (lib/projects), which
 * may already have removed the project's row: then name its region. The
 * scheduled pass removes any a failure left once their roles are gone.
 * Never throws.
 */
export async function forgetPoolerLogins(projectId: string, region?: CloudRegionId): Promise<void> {
  try {
    const where = region ?? (await projectRegion(projectId))
    const { ro, rw } = directAccessRoleNames(projectId)
    await quietly('pooler logins removed', where, () => removePoolerLogins(where, [ro, rw]))
  } catch (err) {
    console.warn(`[DirectAccess] project=${projectId}: pooler logins not removed: ${err instanceof Error ? err.name : 'Error'}`)
  }
}

/**
 * The scheduled pass (instrumentation.ts, from home): in every region that
 * offers the pooler, each project database login's row made as its credential
 * row says (ensureProjectPoolerLogins), and the rows of logins or databases
 * that no longer exist removed. Never throws: a region this process cannot
 * reach is said once and left for the next pass.
 */
export async function reconcilePoolerLogins(): Promise<{ regions: number; changed: number; pruned: number }> {
  const offered = CLOUD_REGIONS.map((r) => r.id).filter((id) => poolerEndpoint(id) !== null)
  if (offered.length === 0) return { regions: 0, changed: 0, pruned: 0 }
  const rows = await prisma.databaseCredential.findMany().catch(() => [])
  const byProject = new Map<string, typeof rows>()
  for (const r of rows) byProject.set(r.projectId, [...(byProject.get(r.projectId) ?? []), r])
  const paused = new Set(
    (
      await prisma.project
        .findMany({ where: { id: { in: [...byProject.keys()] }, pausedAt: { not: null } }, select: { id: true } })
        .catch(() => [] as Array<{ id: string }>)
    ).map((p) => p.id),
  )
  const logins = new Map<CloudRegionId, PoolerLogin[]>()
  for (const [projectId, projectRows] of byProject) {
    try {
      const placement = await projectDatabase(projectId)
      if (placement.tenancy !== 'dedicated' || !offered.includes(placement.region)) continue
      for (const r of projectRows) {
        const login = poolerLoginOf(r, placement.database as string, !paused.has(projectId))
        if (login) logins.set(placement.region, [...(logins.get(placement.region) ?? []), login])
      }
    } catch (err) {
      console.warn(`[DirectAccess] project=${projectId}: pooler logins not checked: ${err instanceof Error ? err.name : 'Error'}`)
    }
  }
  let changed = 0
  let pruned = 0
  for (const region of offered) {
    await quietly('pooler logins', region, async () => {
      changed += await ensurePoolerLogins(region, logins.get(region) ?? [])
      pruned += await prunePoolerLogins(region)
    })
  }
  if (changed + pruned > 0) console.log(`[DirectAccess] pooler logins: ${changed} written, ${pruned} removed, in ${offered.length} region(s)`)
  return { regions: offered.length, changed, pruned }
}

// ── Provision / rotate / revoke ───────────────────────────────────────────────

export async function provisionDirectAccess(projectId: string, mode: DirectAccessMode): Promise<DirectAccessCredential> {
  assertValidProjectId(projectId)
  // Where the developer will connect, settled before any role exists: a
  // region with nothing to connect through refuses here, not after the fact.
  const placement = await projectDatabase(projectId)
  const target = directConnectionTarget(placement)
  const schema = await resolveWorkspaceSchema(projectId)
  const { row, password } = await provisionRole(projectId, mode, schema, placement)
  return withSchemaChanges(projectId, buildCredential(row, schema, target, { password }))
}

/**
 * Whether a read-write login may change the schema, read where the sync reads
 * it: refused while the login is a member of backenly_no_schema_changes. A
 * login made before the setting existed is not, and is allowed, as it was.
 */
async function schemaChangesOf(projectId: string, roleName: string): Promise<SchemaChanges> {
  const db = await workspaceRawClient(projectId)
  const [row] = await db.$queryRaw<Array<{ refused: boolean }>>`
    SELECT EXISTS (
      SELECT 1 FROM pg_auth_members m
       WHERE m.roleid = (SELECT oid FROM pg_roles WHERE rolname = 'backenly_no_schema_changes')
         AND m.member = (SELECT oid FROM pg_roles WHERE rolname = ${roleName})
    ) AS refused`
  return row?.refused ? 'refused' : 'allowed'
}

/**
 * Why schema changes cannot be allowed over the project's read-write login, or
 * null where they can.
 *
 * A project's own database allows them only where its region offers the
 * pooler, the one way a login reaches it. On Backenly Cloud a project in its
 * region's shared database never does. Then the database answers
 * (public.backenly_direct_shared_database): it is shared unless it is marked as
 * holding one project and it does, which a project's own database is
 * (tools/managed-db/regional/sql/project-db.sql) and so is a self-hosted
 * deployment's (scripts/sql/dedicated-database.sql, run by scripts/selfhost.ts).
 * A database whose helpers predate the question cannot answer it, and is
 * treated as unable.
 */
async function schemaChangesUnavailable(projectId: string): Promise<SchemaChangesUnavailable | null> {
  const placement = await projectDatabase(projectId)
  if (placement.tenancy === 'dedicated') {
    if (!poolerEndpoint(placement.region)) return 'pooler_not_offered'
  } else if (cloudEdition()) {
    return 'shared_database'
  }
  const db = await workspaceRawClient(projectId)
  const [probe] = await db.$queryRaw<Array<{ present: boolean }>>`
    SELECT to_regprocedure('public.backenly_direct_shared_database()') IS NOT NULL AS present`
  if (!probe?.present) return 'helpers_outdated'
  const [row] = await db.$queryRaw<Array<{ shared: boolean }>>`SELECT public.backenly_direct_shared_database() AS shared`
  return row?.shared === false ? null : 'shared_database'
}

async function withSchemaChanges(projectId: string, credential: DirectAccessCredential): Promise<DirectAccessCredential> {
  if (credential.mode !== 'READ_WRITE') return credential
  const [schemaChanges, unavailable] = await Promise.all([
    schemaChangesOf(projectId, credential.roleName),
    schemaChangesUnavailable(projectId),
  ])
  return { ...credential, schemaChanges, ...(unavailable ? { schemaChangesUnavailable: unavailable } : {}) }
}

/**
 * Allow or refuse schema changes over the project's read-write login. Refused
 * is the default for a new one: they skip the approvals and History that
 * apply_migration and the dashboard go through, and are only observed as drift
 * afterwards. They can be allowed only on a project's own database reached
 * through the pooler, and never on a database shared by several projects
 * (SchemaChangesUnavailableError): asked here first, so the person is told why,
 * and refused by the database whatever this says. Applied by the grants sync,
 * which runs straight after.
 */
export async function setSchemaChanges(projectId: string, allowed: boolean): Promise<DirectAccessCredential> {
  assertValidProjectId(projectId)
  // A login nothing can connect with has no schema changes to allow.
  const target = await connectionTarget(projectId)
  const existing = await prisma.databaseCredential.findUnique({ where: { projectId_mode: { projectId, mode: 'READ_WRITE' } } })
  if (!existing) throw new Error('This project has no read-write login to change.')
  if (allowed) {
    const unavailable = await schemaChangesUnavailable(projectId)
    if (unavailable) throw new SchemaChangesUnavailableError(unavailable)
  }
  const db = await workspaceRawClient(projectId)
  try {
    await db.$queryRaw`SELECT public.backenly_direct_set_schema_changes(${existing.roleName}, ${allowed})`
  } catch (err) {
    // The database decides; it refuses on a database that became shared since.
    if (allowed && /shared by several projects/.test(err instanceof Error ? err.message : String(err))) {
      throw new SchemaChangesUnavailableError('shared_database')
    }
    throw err
  }
  await syncDirectAccessGrants(projectId)
  await prisma.auditLog.create({
    data: {
      projectId,
      action: allowed ? 'DIRECT_ACCESS_SCHEMA_CHANGES_ALLOWED' : 'DIRECT_ACCESS_SCHEMA_CHANGES_REFUSED',
      type: 'security',
      details: JSON.stringify({ roleName: existing.roleName }),
      timestamp: new Date(),
    },
  }).catch(() => {})
  const schema = await resolveWorkspaceSchema(projectId)
  return withSchemaChanges(projectId, buildCredential(existing, schema, target))
}

/**
 * Create (or re-key) a project's role and record its credential. Roles are
 * cluster-wide, so it is created on the database holding the project's data,
 * in its region: a role anywhere else could never reach the schema.
 *
 * On a project's own database the role is given a verifier computed here, the
 * credential row keeps that verifier, and the pooler's row is written last,
 * after the grants and the realtime channel are in place, so the login is
 * served only once it is complete. Answers the password, which for a
 * read-write login there is never seen again.
 */
async function provisionRole(
  projectId: string,
  mode: DirectAccessMode,
  schema: string,
  placement: ProjectDatabase,
): Promise<{ row: CredentialRow & { id: string }; password: string }> {
  // Creating or re-keying a login gives it LOGIN: not while the project is paused.
  await refuseWhilePaused(projectId)
  const db = await workspaceRawClient(projectId)
  const names = directAccessRoleNames(projectId)
  const roleName = mode === 'READ_ONLY' ? names.ro : names.rw
  const secret = placement.tenancy === 'dedicated' ? newLoginSecret(roleName, mode) : null
  const password = secret ? secret.password : generatePassword()
  // What the server is given and the row keeps: the verifier on a project's
  // own database (PostgreSQL stores a verifier as it is), the password elsewhere.
  const kept = secret ? secret.verifier : password

  // Definer function validates names server-side and is idempotent (re-keys if
  // the role already exists — recovers cleanly from a half-finished provision).
  await db.$queryRaw`SELECT public.backenly_direct_create_role(${roleName}, ${kept}, ${schema}, ${mode})`
  // The plan's number of connections at once, from the login's first moment.
  await applyConnectionLimit(projectId, [roleName])

  const enc = encryptValue(kept)
  const row = await prisma.databaseCredential.upsert({
    where: { projectId_mode: { projectId, mode } },
    create: {
      projectId,
      mode,
      roleName,
      passwordCipher: enc.valueCipher,
      passwordIv: enc.valueIv,
      passwordTag: enc.valueTag,
    },
    update: {
      roleName,
      passwordCipher: enc.valueCipher,
      passwordIv: enc.valueIv,
      passwordTag: enc.valueTag,
      rotatedAt: new Date(),
    },
  })

  await syncDirectAccessGrants(projectId)

  // A read-write login can read its project's realtime channel
  // (lib/realtime/channel-sql.ts). Issued or re-keyed, the project gets a new
  // channel, so what an earlier key could read stops being the channel.
  if (mode === 'READ_WRITE') await rotateProjectChannel(projectId)

  // Last: from here the pooler serves the login.
  if (secret && poolerEndpoint(placement.region)) {
    await putPoolerLogin(placement.region, { rolname: roleName, verifier: secret.verifier, database: placement.database as string, active: true })
  }

  await prisma.auditLog.create({
    data: {
      projectId,
      action: 'DIRECT_ACCESS_PROVISIONED',
      type: 'security',
      details: JSON.stringify({ mode, roleName }),
      timestamp: new Date(),
    },
  }).catch(() => {})

  return { row, password }
}

/** A login carried into the database a project moves into, and what its credential row is to keep once the move commits. */
export interface CarriedLogin {
  mode: DirectAccessMode
  roleName: string
  /** Made on the target's instance by this move, so a move that stops drops it there. */
  created: boolean
  /** The verifier the row keeps from the flip on, encrypted as every credential row is. */
  kept: { passwordCipher: string; passwordIv: string; passwordTag: string }
}

/**
 * A project's direct logins, made ready in the database of its own it is
 * moving into (lib/data-plane/tenancy-migration.ts), before its schemas are
 * copied in, which name them, and before its row names that database. The
 * project is paused for the move, its logins stopped, and they
 * stay stopped here: the resume brings back each one the pause stopped, from
 * what its credential row then keeps (lib/projects/paused-logins.ts), and with
 * it the pooler's row (restorePoolerLogins).
 *
 * What each row is to keep, as on any project database (newLoginSecret): a
 * SCRAM verifier. The read-write login's of the password its row keeps today,
 * so its existing connection details keep signing in once they go through the
 * pooler. The read-only login's re-derived, because the platform signs in as
 * it and must be able to produce its password (readOnlyPasswordFrom). A row
 * that keeps a verifier already keeps it.
 *
 * A login the target's instance does not have (the data instance is another
 * instance than the shared database's, as in the home region) is made there,
 * with that verifier, and stopped at once, NOLOGIN with no password, as the
 * pause left its old self. One it has (the same instance) is left as it is.
 * The read-write login's schema changes are refused there, as the shared
 * database refused them: allowing them later is setSchemaChanges's decision,
 * and only where the region offers the pooler.
 *
 * Nothing is written to the credential rows here: the move writes `kept` in
 * the transaction that flips the project, so a move that stops leaves them as
 * they were. Throws when a password cannot be carried (SCRAM takes printable
 * ASCII without spaces): rotate it first.
 */
export async function carryDirectLogins(projectId: string, target: { region: CloudRegionId; database: string }): Promise<CarriedLogin[]> {
  assertValidProjectId(projectId)
  const rows = await prisma.databaseCredential.findMany({ where: { projectId } })
  if (rows.length === 0) return []
  const db = databaseClient(target.region, target.database, projectId)
  const schema = await resolveWorkspaceSchema(projectId)
  const secrets = rows.map((row) => {
    const mode = row.mode as DirectAccessMode
    const stored = storedSecret(row)
    if (isScramVerifier(stored)) return { row, mode, verifier: stored }
    if (mode === 'READ_ONLY') return { row, mode, verifier: newLoginSecret(row.roleName, 'READ_ONLY').verifier }
    try {
      return { row, mode, verifier: scramSha256Verifier(stored) }
    } catch {
      throw new Error(`The read-write login ${row.roleName} has a password SCRAM cannot carry. Rotate it, then move the project.`)
    }
  })
  const present = new Set(
    (
      await db.$queryRaw<Array<{ rolname: string }>>`
        SELECT rolname::text AS rolname FROM pg_roles WHERE rolname = ANY(${rows.map((r) => r.roleName)}::text[])`
    ).map((r) => r.rolname),
  )
  const missing = secrets.filter((s) => !present.has(s.row.roleName))

  // Made before the project's schema is copied in, because the copy names
  // them (the read-write login's pass-through policies). The helper wants the
  // schema the login is for: the database is new and holds none yet, so it is
  // made empty for the helper and dropped again, and the copy makes it.
  if (missing.length > 0) {
    const [{ exists }] = await db.$queryRaw<Array<{ exists: boolean }>>`SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = ${schema}) AS exists`
    if (!exists) await db.$executeRawUnsafe(`CREATE SCHEMA ${quoteIdent(schema)}`)
    try {
      for (const { row, mode, verifier } of missing) {
        await db.$queryRaw`SELECT public.backenly_direct_create_role(${row.roleName}, ${verifier}, ${schema}, ${mode})`
        await db.$queryRaw`SELECT public.backenly_direct_retire_role(${row.roleName}) AS retired`
      }
    } finally {
      // Made here, empty, a moment ago: CASCADE takes only what registering
      // it with the database's PostgREST registry may have put in it.
      if (!exists) await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS ${quoteIdent(schema)} CASCADE`)
    }
  }

  const carried: CarriedLogin[] = secrets.map(({ row, mode, verifier }) => {
    const enc = encryptValue(verifier)
    return {
      mode,
      roleName: row.roleName,
      created: !present.has(row.roleName),
      kept: { passwordCipher: enc.valueCipher, passwordIv: enc.valueIv, passwordTag: enc.valueTag },
    }
  })
  const rw = carried.find((c) => c.mode === 'READ_WRITE')
  if (rw) await db.$queryRaw`SELECT public.backenly_direct_set_schema_changes(${rw.roleName}, false) AS ok`
  return carried
}

/**
 * The role and password the platform itself connects as for an agent's
 * read-only SQL (lib/mcp/read-query.ts), provisioning the role on first use.
 * No public host is involved: that connection dials the project's database
 * directly, so a region nothing outside can connect to still works. On a
 * project's own database the password is derived from the verifier the row
 * keeps (readOnlyPasswordFrom).
 */
export async function readOnlyLogin(projectId: string): Promise<{ roleName: string; password: string }> {
  assertValidProjectId(projectId)
  const row =
    (await prisma.databaseCredential.findUnique({ where: { projectId_mode: { projectId, mode: 'READ_ONLY' } } })) ??
    (await provisionRole(projectId, 'READ_ONLY', await resolveWorkspaceSchema(projectId), await projectDatabase(projectId))).row
  const stored = storedSecret(row)
  return { roleName: row.roleName, password: isScramVerifier(stored) ? readOnlyPasswordFrom(row.roleName, stored) : stored }
}

export async function rotateDirectAccess(projectId: string, mode: DirectAccessMode): Promise<DirectAccessCredential> {
  assertValidProjectId(projectId)
  const existing = await prisma.databaseCredential.findUnique({
    where: { projectId_mode: { projectId, mode } },
  })
  if (!existing) throw new Error(`No ${mode} credential to rotate — provision first.`)

  const placement = await projectDatabase(projectId)
  const target = directConnectionTarget(placement)
  const schema = await resolveWorkspaceSchema(projectId)
  const secret = placement.tenancy === 'dedicated' ? newLoginSecret(existing.roleName, mode) : null
  const password = secret ? secret.password : generatePassword()
  const kept = secret ? secret.verifier : password
  // The role lives on the project's database, in its region. The helper ends
  // the login's sessions, so the old password stops working now. Through the
  // pooler, the old verifier stays in the pooler's row until the last step
  // below: until then neither password signs in, the safe way round.
  const db = await workspaceRawClient(projectId)
  await db.$queryRaw`SELECT public.backenly_direct_set_password(${existing.roleName}, ${kept})`
  await applyConnectionLimit(projectId, [existing.roleName])

  const enc = encryptValue(kept)
  const row = await prisma.databaseCredential.update({
    where: { id: existing.id },
    data: {
      passwordCipher: enc.valueCipher,
      passwordIv: enc.valueIv,
      passwordTag: enc.valueTag,
      rotatedAt: new Date(),
    },
  })

  // The old password's sessions are ended above; the realtime channel a
  // read-write login could read is replaced after them. A failure here fails
  // the rotation, which is safe to ask for again.
  if (mode === 'READ_WRITE') await rotateProjectChannel(projectId)

  if (secret && poolerEndpoint(placement.region)) {
    // Served only if the project is not paused: a rotation leaves a stopped
    // login stopped (backenly_direct_set_password never sets LOGIN).
    const project = await prisma.project.findUnique({ where: { id: projectId }, select: { pausedAt: true } })
    await putPoolerLogin(placement.region, {
      rolname: existing.roleName,
      verifier: secret.verifier,
      database: placement.database as string,
      active: !project?.pausedAt,
    })
  }

  await prisma.auditLog.create({
    data: {
      projectId,
      action: 'DIRECT_ACCESS_ROTATED',
      type: 'security',
      details: JSON.stringify({ mode, roleName: existing.roleName }),
      timestamp: new Date(),
    },
  }).catch(() => {})

  return withSchemaChanges(projectId, buildCredential(row, schema, target, { password }))
}

export async function revokeDirectAccess(projectId: string, mode: DirectAccessMode): Promise<void> {
  assertValidProjectId(projectId)
  const existing = await prisma.databaseCredential.findUnique({
    where: { projectId_mode: { projectId, mode } },
  })
  if (!existing) return
  // A login a pause stopped is brought back on resume only while its row
  // carries the pause's mark (lib/projects/paused-logins.ts). Cleared first,
  // so a revocation that stops part-way, its row kept to be retried, leaves
  // a login nothing brings back.
  if (existing.stoppedForPauseAt) {
    await prisma.databaseCredential.update({ where: { id: existing.id }, data: { stoppedForPauseAt: null } })
  }

  // The pooler stops serving the login first, so a revocation that stops
  // part-way leaves nothing that signs in through it.
  const placement = await projectDatabase(projectId)
  const dedicated = placement.tenancy === 'dedicated'
  if (dedicated) await quietly('pooler login off', placement.region, () => setPoolerLoginsActive(placement.region, [existing.roleName], false))

  // Terminates live sessions, drops policies naming the role, reassigns any
  // tables it created to the platform role, then drops it. On the project's
  // database, in its region, where the role is. A login that something outside
  // that database still names is retired instead (NOLOGIN, no password) and the
  // helper answers false: revoked either way, since it can no longer log in.
  const db = await workspaceRawClient(projectId)
  let [{ gone }] = await db.$queryRaw<{ gone: boolean }[]>`
    SELECT public.backenly_direct_drop_role(${existing.roleName}) AS gone`
  if (!gone) {
    // NOLOGIN only from the call's own commit, so a session that logged in
    // during it is ended by a second call (see public.backenly_direct_drop_role),
    // whose answer is the one recorded. The login is already retired, so a
    // failure here does not hold the revocation back. Deleting the project
    // later reaches the login again by its derived name.
    try {
      const [again] = await db.$queryRaw<{ gone: boolean }[]>`
        SELECT public.backenly_direct_drop_role(${existing.roleName}) AS gone`
      gone = Boolean(again?.gone)
    } catch (err: any) {
      console.warn(`[LoginRetired] project=${projectId} second call failed reason=${err?.name || 'Error'}`)
    }
  }
  if (!gone) {
    console.warn(
      `[LoginRetired] project=${projectId} logins=${existing.roleName} via=credential revocation: ` +
        'something outside the project database still names it; it cannot log in, and stays until an operator ' +
        'removes what names it and drops it, or the project is deleted after that',
    )
  }
  // The login is gone or cannot log in; the realtime channel it could read is
  // replaced before the credential is forgotten, so a failure here leaves the
  // revocation to be asked for again.
  if (mode === 'READ_WRITE') await rotateProjectChannel(projectId)
  // Its pooler row goes with it. One a failure leaves is never served (its
  // role cannot log in) and the scheduled pass removes it once the role is gone.
  if (dedicated) await quietly('pooler login removed', placement.region, () => removePoolerLogins(placement.region, [existing.roleName]))
  await prisma.databaseCredential.delete({ where: { id: existing.id } })

  await prisma.auditLog.create({
    data: {
      projectId,
      action: 'DIRECT_ACCESS_REVOKED',
      type: 'security',
      details: JSON.stringify({ mode, roleName: existing.roleName, login: gone ? 'dropped' : 'retired' }),
      timestamp: new Date(),
    },
  }).catch(() => {})
}

// ── Status ────────────────────────────────────────────────────────────────────

/**
 * Whether the privileged SECURITY DEFINER helpers a superuser installs via
 * scripts/setup-direct-access.sql are present in this database.
 *
 * Exists so a caller can decline to attempt what is not installed. Calling
 * provisionDirectAccess without them raises `function ... does not exist`, and
 * Prisma logs every failed query at `error` level before the caller ever sees
 * the exception. Bootstrap ran that path twice on its EXPECTED first run, so a
 * normal install opened with raw Prisma error blocks and read as a crash.
 *
 * A catalog probe rather than a caught failure: the question "is this
 * installed" has a cheap direct answer, and asking it directly is also what
 * lets one clear advisory replace one error block per mode.
 *
 * Per database: each region's database needs its own copy of the helpers, and
 * so does each project's own database (`database`, p_<32 hex>, on the region's
 * data instance), which gets them from the template it is cloned from.
 */
export async function directAccessHelpersInstalled(region: CloudRegionId = HOME_REGION, database?: string): Promise<boolean> {
  const rows = await clientFor(region, database).$queryRaw<Array<{ present: boolean }>>`
    SELECT EXISTS (
      SELECT 1
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.proname = 'backenly_direct_create_role'
    ) AS present`
  return rows[0]?.present === true
}

export async function getDirectAccessStatus(projectId: string): Promise<DirectAccessStatus> {
  assertValidProjectId(projectId)
  const [schema, rows, pendingDriftEvents, placement] = await Promise.all([
    resolveWorkspaceSchema(projectId),
    prisma.databaseCredential.findMany({ where: { projectId }, orderBy: { mode: 'asc' } }),
    // Counted in the project's region, where the capture trigger records them.
    projectDriftEvents(projectId).then((events) => events.countPending(projectId)),
    projectDatabase(projectId),
  ])
  let target: ConnectionTarget
  try {
    target = directConnectionTarget(placement)
  } catch (err) {
    if (!(err instanceof DirectAccessUnavailableError)) throw err
    // Nothing outside can connect: no strings, and the logins that exist by
    // name only, so they can still be revoked.
    return {
      schema,
      available: false,
      unavailable: err.message,
      unavailableReason: err.reason,
      tenancy: placement.tenancy,
      credentials: [],
      logins: rows.map((r) => ({
        mode: r.mode as DirectAccessMode,
        roleName: r.roleName,
        createdAt: r.createdAt.toISOString(),
        rotatedAt: r.rotatedAt ? r.rotatedAt.toISOString() : null,
      })),
      pendingDriftEvents,
    }
  }
  const [credentials, connectionLimit] = await Promise.all([
    Promise.all(rows.map((r) => withSchemaChanges(projectId, buildCredential(r, schema, target)))),
    // Every read of the credentials applies the plan's limit, so a plan
    // change reaches the logins at the next one (applyConnectionLimit).
    applyConnectionLimit(projectId, rows.map((r) => r.roleName)),
    // And puts back a row the pooler is missing (a login made before the
    // pooler was offered here, or a write a failure left). Never throws.
    ensureProjectPoolerLogins(projectId, placement, rows),
  ])
  return {
    schema,
    available: true,
    tenancy: placement.tenancy,
    ...(target.kind === 'pooler'
      ? { pooler: { host: target.host, sessionPort: target.sessionPort, transactionPort: target.transactionPort, guidance: POOLER_GUIDANCE } }
      : {}),
    credentials,
    connectionLimit,
    ...(target.kind === 'pooler' && typeof connectionLimit === 'number'
      ? { connectionShares: poolerPortShares(connectionLimit) }
      : {}),
    pendingDriftEvents,
  }
}

// ── Connections at once, by plan ──────────────────────────────────────────────
//
// Each of a project's logins may hold its plan's number of connections at once
// (lib/entitlements/direct-postgres.ts: Free 2, Pro 5, Enterprise 20), set
// through the definer helper (scripts/setup-direct-access.sql, 3b) where it
// differs. When a login is created, on every read of its credentials (the
// console's Postgres tab, MCP database_credentials, a rotation), and every hour
// for every project with a login (reconcileDirectConnectionLimits): a plan
// changes in Backenly Cloud's billing, which has no hook into this repository,
// so the hourly pass is what brings a new plan's limit to logins nobody reads.

const limitHelperMissingSaid = new Set<CloudRegionId>()

/**
 * The plan's limit set on these logins of the project, and how many changed.
 * The limit is null where the region's helpers predate 3b (said once per
 * region). Never throws: on any failure the logins keep the limit they have,
 * and the next read or the hourly pass tries again.
 */
async function setConnectionLimits(projectId: string, roleNames: string[]): Promise<{ limit: number | null; changed: number }> {
  try {
    const { connectionLimit } = await directPostgresAllowanceFor(projectId)
    const region = await projectRegion(projectId)
    const db = await workspaceRawClient(projectId)
    const [probe] = await db.$queryRaw<Array<{ present: boolean }>>`
      SELECT to_regprocedure('public.backenly_direct_set_connection_limit(text,integer)') IS NOT NULL AS present`
    if (!probe?.present) {
      if (!limitHelperMissingSaid.has(region)) {
        limitHelperMissingSaid.add(region)
        console.warn(
          `[DirectAccess] region=${region}: the database's direct-access helpers predate per-plan connection limits; ` +
            'logins keep the limits they were created with until scripts/setup-direct-access.sql is installed again',
        )
      }
      return { limit: null, changed: 0 }
    }
    if (roleNames.length === 0) return { limit: connectionLimit, changed: 0 }
    const logins = await db.$queryRaw<Array<{ rolname: string; rolconnlimit: number }>>`
      SELECT rolname::text AS rolname, rolconnlimit FROM pg_roles WHERE rolname = ANY(${roleNames}::text[])`
    let changed = 0
    for (const login of logins) {
      if (login.rolconnlimit !== connectionLimit) {
        await db.$queryRaw`SELECT public.backenly_direct_set_connection_limit(${login.rolname}, ${connectionLimit}::int)`
        changed += 1
      }
    }
    return { limit: connectionLimit, changed }
  } catch (err) {
    console.warn(
      `[DirectAccess] project=${projectId}: the plan's connection limit was not applied (${err instanceof Error ? err.name : 'Error'}); the next read tries again`,
    )
    return { limit: null, changed: 0 }
  }
}

/**
 * Set these logins of the project to its plan's number of connections at once,
 * where it differs. Answers the limit, or null where the region's helpers
 * predate per-plan limits. Never throws.
 */
export async function applyConnectionLimit(projectId: string, roleNames: string[]): Promise<number | null> {
  return (await setConnectionLimits(projectId, roleNames)).limit
}

/**
 * The same for every login the project has: for a caller that knows only the
 * project, such as Cloud's plan-change handlers, which may call it to apply a
 * new plan's limit at once rather than at the next hourly pass. Never throws.
 */
export async function applyPlanConnectionLimits(projectId: string): Promise<number | null> {
  const rows = await prisma.databaseCredential.findMany({ where: { projectId }, select: { roleName: true } }).catch(() => [])
  return applyConnectionLimit(projectId, rows.map((r) => r.roleName))
}

/**
 * The hourly pass (instrumentation.ts, on the home region's scheduler): every
 * project with a login, its logins set to its plan's limit where they differ,
 * so a plan change reaches them within the hour. One project at a time; a
 * project that fails is logged by setConnectionLimits and left for the next
 * pass. Says how many logins changed, and only when some did.
 */
export async function reconcileDirectConnectionLimits(): Promise<{ projects: number; changed: number }> {
  const rows = await prisma.databaseCredential.findMany({ select: { projectId: true, roleName: true } }).catch(() => [])
  const byProject = new Map<string, string[]>()
  for (const r of rows) byProject.set(r.projectId, [...(byProject.get(r.projectId) ?? []), r.roleName])
  let changed = 0
  for (const [projectId, roleNames] of byProject) changed += (await setConnectionLimits(projectId, roleNames)).changed
  if (changed > 0) console.log(`[DirectAccess] set ${changed} login(s) in ${byProject.size} project(s) to their plan's connection limit`)
  return { projects: byProject.size, changed }
}

// ── Grants sync — the hook called after DDL, for every project ───────────────
//
// For EVERY project, with or without direct-access credentials, because the
// sync is also where the backup role gets read on the workspace: snapshots run
// pg_dump as that role, and a schema it cannot use fails every one of them.
// With credentials it re-applies grants, ownership normalization, and RLS
// pass-through policies for any table created since the last sync — whichever
// side (platform or external) created it. Without them it grants the backup
// role only, and nothing at all on a database without the helpers.

export async function syncDirectAccessGrants(projectId: string): Promise<void> {
  try {
    assertValidProjectId(projectId)
  } catch {
    return // non-workspace callers (invalid ids) are a silent no-op
  }
  const rows = await prisma.databaseCredential.findMany({
    where: { projectId },
    select: { mode: true, roleName: true },
  }).catch(() => [])

  // The grants are on the database holding the project's data, where its roles
  // are: its region's shared database, or its own (workspaceRawClient).
  const db = await workspaceRawClient(projectId)
  // Credentials were provisioned through the helpers, so they are there. With
  // none, the database may be one that never installed them (they are optional
  // on a self-hosted install), and then there is nothing to sync.
  if (rows.length === 0 && !(await syncHelperIn(db))) return

  const names = directAccessRoleNames(projectId)
  const ro = rows.find(r => r.mode === 'READ_ONLY')?.roleName ?? null
  const rw = rows.find(r => r.mode === 'READ_WRITE')?.roleName ?? null
  const owner = rw ? names.owner : null
  const schema = await resolveWorkspaceSchema(projectId)

  await db.$queryRaw`SELECT public.backenly_direct_sync_schema(${schema}, ${ro}, ${rw}, ${owner})`

  // A sync that took schema changes from the read-write login ended its
  // sessions as it ran, but one that logged in before the sync committed saw
  // the owner role still granted and may have taken it. The sync marked the
  // login; now that it has committed, those sessions are ended
  // (scripts/setup-direct-access.sql, section 5c). Asked first: a database
  // whose helpers predate it has nothing to end.
  if (rw) {
    const [probe] = await db.$queryRaw<Array<{ present: boolean }>>`
      SELECT to_regprocedure('public.backenly_direct_end_stripped_sessions(text)') IS NOT NULL AS present`
    if (probe?.present) await db.$queryRaw`SELECT public.backenly_direct_end_stripped_sessions(${rw})`
  }
}

/**
 * The backup role's read on a workspace schema just created, from its first
 * moment, so its first snapshot works. lib/projects/provision.ts calls this
 * right after CREATE SCHEMA, before the project's row exists: the caller names
 * the region, because projectRegion() reads a project with no row as home, and
 * for a project with a database of its own, that database (p_<32 hex>), where
 * the schema is. The sync also sets the default privileges that cover each
 * table the application adds to the schema later. The one place this grant is
 * made outside syncDirectAccessGrants.
 *
 * Returns false, having granted nothing, on a database without the helpers.
 */
export async function grantWorkspaceBackupAccess(region: CloudRegionId, schema: string, database?: string): Promise<boolean> {
  const db = clientFor(region, database)
  if (!(await syncHelperIn(db))) return false
  // No direct-access role: the call syncDirectAccessGrants makes for a project
  // without credentials.
  await db.$queryRaw`SELECT public.backenly_direct_sync_schema(${schema}, NULL, NULL, NULL)`
  return true
}

/**
 * The region's database, or a project's own database on its data instance.
 * databaseClient refuses any name but p_<32 hex>, so nothing else is reached.
 */
function clientFor(region: CloudRegionId, database?: string): Pick<ReturnType<typeof regionRawClient>, '$queryRaw'> {
  return database === undefined ? regionRawClient(region) : databaseClient(region, database)
}

/**
 * Whether a database has backenly_direct_sync_schema: the region's, or a
 * project's own. Asked rather than called and caught, because a failed query
 * is logged at error level before the caller sees it (see
 * directAccessHelpersInstalled).
 */
export async function syncHelperInstalled(region: CloudRegionId, database?: string): Promise<boolean> {
  return syncHelperIn(clientFor(region, database))
}

async function syncHelperIn(db: Pick<ReturnType<typeof regionRawClient>, '$queryRaw'>): Promise<boolean> {
  const rows = await db.$queryRaw<Array<{ present: boolean }>>`
    SELECT to_regprocedure('public.backenly_direct_sync_schema(text,text,text,text)') IS NOT NULL AS present`
  return rows[0]?.present === true
}
