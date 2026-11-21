/**
 * THE CONNECTION POOLER, AS THE APPLICATION SEES IT
 * =================================================
 * Customers connect psql, an ORM or any other PostgreSQL client to a project's
 * own database (p_<32 hex>) through its region's connection pooler
 * (services/pooler), and through nothing else:
 *
 *   <host>:5432   session pooling: migrations, psql, anything holding a session
 *   <host>:6543   transaction pooling: application traffic, serverless
 *
 * The host is POOLER_HOST in the home region and POOLER_HOST_<REGION> in any
 * other (regionSetting): on Backenly Cloud <region>.db.backenly.com, and
 * <region>.staging.db.backenly.com on staging. A region that does not offer
 * the pooler leaves it unset, and its projects get no connection string.
 *
 * The pooler checks a login against the row this module keeps for it in
 * backenly_pooler.logins, a database of the pooler's own on the same data
 * instance as the project databases (tools/managed-db/regional/sql/pooler.sql):
 * the login, the SCRAM-SHA-256 verifier it has on the server
 * (lib/data-plane/scram.ts), the database it belongs to, and whether it is
 * served. The pooler can sign a login in to the server only while the two
 * verifiers are identical, so a row always carries exactly what the server was
 * given. A row is served only while its role can log in on the server, so a
 * login made NOLOGIN or dropped is refused even before its row changes.
 *
 * Reached as the application role on the region's data instance, with its
 * database part replaced by backenly_pooler (poolerDatabaseUrl: withDatabase
 * deliberately takes only a project database's name). One short connection
 * per call: these writes happen when a login is made, rotated, stopped or
 * removed, and on a scheduled pass, never on a request's path.
 *
 * Nothing here logs or returns a verifier. A failure is reported by its
 * SQLSTATE only, because a refused row would come back with its values in the
 * error's detail.
 */

import { Client } from 'pg'
import type { CloudRegionId } from '@/lib/regions'
import { isProjectDatabaseName, regionSetting, requireRegionDataInstanceUrl } from './regional'
import { isScramVerifier, SCRAM_ITERATIONS } from './scram'

type Env = Readonly<Record<string, string | undefined>>

/** The pooler's own database on each data instance. */
export const POOLER_DATABASE = 'backenly_pooler'
/** Session pooling: migrations, psql, LISTEN, advisory locks. */
export const POOLER_SESSION_PORT = 5432
/** Transaction pooling: application traffic and serverless functions. */
export const POOLER_TRANSACTION_PORT = 6543

/** Where a region's customers connect to its project databases. */
export interface PoolerEndpoint {
  host: string
  sessionPort: number
  transactionPort: number
}

const HOST_NAME = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/
const misconfigurationSaid = new Set<string>()

/** POOLER_HOST, or POOLER_HOST_<REGION> outside the home region. */
export function poolerHostVariable(region: CloudRegionId): string {
  return regionSetting('POOLER_HOST', region, {}).variable
}

/**
 * The region's pooler, or null where the region does not offer it: its
 * variable unset, or not a host name (said once, and treated as unset rather
 * than handed to customers).
 */
export function poolerEndpoint(region: CloudRegionId, env: Env = process.env): PoolerEndpoint | null {
  const { variable, value } = regionSetting('POOLER_HOST', region, env)
  if (!value) return null
  const host = value.trim().toLowerCase()
  if (!HOST_NAME.test(host)) {
    if (!misconfigurationSaid.has(variable)) {
      misconfigurationSaid.add(variable)
      console.warn(`[Pooler] ${variable} is not a host name, so no connection string names it until it is`)
    }
    return null
  }
  return { host, sessionPort: POOLER_SESSION_PORT, transactionPort: POOLER_TRANSACTION_PORT }
}

/** The pooler's logins could not be read or written. `code` is the SQLSTATE, where there is one. */
export class PoolerLoginsError extends Error {
  constructor(message: string, readonly code: string | undefined) {
    super(message)
    this.name = 'PoolerLoginsError'
  }
}

/** The data instance has no database backenly_pooler yet: the region's procedure has not made it. */
export function isPoolerDatabaseMissing(err: unknown): boolean {
  return err instanceof PoolerLoginsError && err.code === '3D000'
}

/**
 * The application role's connection string for backenly_pooler on the
 * region's data instance: DATA_DATABASE_URL[_<REGION>] (or, outside the home
 * region, the region's own connection) with that database in place of the one
 * it names. Refuses what withDatabase refuses, and never quotes the URL, which
 * carries a password.
 */
export function poolerDatabaseUrl(region: CloudRegionId, env: Env = process.env): string {
  const url = requireRegionDataInstanceUrl(region, 'app', { env })
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new PoolerLoginsError(`The data instance connection string for ${region} is not a URL.`, undefined)
  }
  if ((parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') || !parsed.hostname) {
    throw new PoolerLoginsError(`The data instance connection string for ${region} is not a postgresql:// URL with a host.`, undefined)
  }
  if (parsed.searchParams.has('dbname') || parsed.searchParams.has('database')) {
    throw new PoolerLoginsError(
      `The data instance connection string for ${region} names its database in a parameter, which would win over ${POOLER_DATABASE}.`,
      undefined,
    )
  }
  parsed.pathname = `/${POOLER_DATABASE}`
  return parsed.toString()
}

/** One customer login's row, as backenly_pooler.logins holds it. */
export interface PoolerLogin {
  rolname: string
  verifier: string
  database: string
  active: boolean
}

const LOGIN_NAME = /^bkn_[a-z0-9_]+$/

/**
 * Refuse, before anything is sent, a row the table's checks would refuse: the
 * error would otherwise carry the row's values. The verifier must be one
 * PostgreSQL stores as-is (isScramVerifier) at the table's 4096 iterations.
 */
function checked(login: PoolerLogin): PoolerLogin {
  if (!LOGIN_NAME.test(login.rolname) || login.rolname.length > 63) {
    throw new PoolerLoginsError(`${JSON.stringify(login.rolname.slice(0, 70))} is not a customer login's name.`, undefined)
  }
  if (!isScramVerifier(login.verifier) || !login.verifier.startsWith(`SCRAM-SHA-256$${SCRAM_ITERATIONS}:`)) {
    throw new PoolerLoginsError(`The verifier for ${login.rolname} is not a SCRAM-SHA-256 verifier of ${SCRAM_ITERATIONS} iterations.`, undefined)
  }
  if (!isProjectDatabaseName(login.database)) {
    throw new PoolerLoginsError(`The database for ${login.rolname} is not a project database's name.`, undefined)
  }
  return login
}

function failure(err: unknown, what: string): PoolerLoginsError {
  if (err instanceof PoolerLoginsError) return err
  const code = typeof (err as { code?: unknown })?.code === 'string' ? ((err as { code: string }).code) : undefined
  const name = err instanceof Error ? err.name : 'Error'
  return new PoolerLoginsError(`The pooler's logins could not be ${what} (${code ?? name}).`, code)
}

async function inPoolerDatabase<T>(region: CloudRegionId, what: string, run: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: poolerDatabaseUrl(region), connectionTimeoutMillis: 10_000, statement_timeout: 15_000 } as any)
  // A connection lost while idle is reported here; unhandled, it ends the process.
  client.on('error', () => {})
  try {
    await client.connect()
    return await run(client)
  } catch (err) {
    throw failure(err, what)
  } finally {
    await client.end().catch(() => {})
  }
}

/** Write one login's row as given: when it is made or its password rotated. */
export async function putPoolerLogin(region: CloudRegionId, login: PoolerLogin): Promise<void> {
  const row = checked(login)
  await inPoolerDatabase(region, 'written', (client) =>
    client.query(
      `INSERT INTO backenly_pooler.logins (rolname, verifier, database, active, updated_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (rolname) DO UPDATE
         SET verifier = EXCLUDED.verifier, database = EXCLUDED.database, active = EXCLUDED.active, updated_at = now()`,
      [row.rolname, row.verifier, row.database, row.active],
    ),
  )
}

/**
 * The rows these logins should have: a missing one inserted as given, a
 * different verifier or database corrected, and one marked inactive made
 * active again where `active` is asked for. Never turns a row off: that is
 * only ever done on purpose (setPoolerLoginsActive, removePoolerLogins).
 * Answers how many rows changed.
 */
export async function ensurePoolerLogins(region: CloudRegionId, logins: PoolerLogin[]): Promise<number> {
  if (logins.length === 0) return 0
  const rows = logins.map(checked)
  return inPoolerDatabase(region, 'written', async (client) => {
    const result = await client.query(
      `INSERT INTO backenly_pooler.logins AS l (rolname, verifier, database, active, updated_at)
       SELECT r.rolname, r.verifier, r.database, r.active, now()
         FROM unnest($1::text[], $2::text[], $3::text[], $4::boolean[]) AS r(rolname, verifier, database, active)
       ON CONFLICT (rolname) DO UPDATE
         SET verifier = EXCLUDED.verifier, database = EXCLUDED.database,
             active = l.active OR EXCLUDED.active, updated_at = now()
       WHERE l.verifier IS DISTINCT FROM EXCLUDED.verifier
          OR l.database IS DISTINCT FROM EXCLUDED.database
          OR (EXCLUDED.active AND NOT l.active)`,
      [rows.map((r) => r.rolname), rows.map((r) => r.verifier), rows.map((r) => r.database), rows.map((r) => r.active)],
    )
    return result.rowCount ?? 0
  })
}

/** Serve these logins through the pooler, or stop serving them. Answers how many rows changed. */
export async function setPoolerLoginsActive(region: CloudRegionId, rolnames: string[], active: boolean): Promise<number> {
  if (rolnames.length === 0) return 0
  return inPoolerDatabase(region, 'changed', async (client) => {
    const result = await client.query(
      `UPDATE backenly_pooler.logins SET active = $2, updated_at = now() WHERE rolname = ANY($1::text[]) AND active IS DISTINCT FROM $2`,
      [rolnames, active],
    )
    return result.rowCount ?? 0
  })
}

/** Remove these logins' rows. Answers how many there were. */
export async function removePoolerLogins(region: CloudRegionId, rolnames: string[]): Promise<number> {
  if (rolnames.length === 0) return 0
  return inPoolerDatabase(region, 'removed', async (client) => {
    const result = await client.query(`DELETE FROM backenly_pooler.logins WHERE rolname = ANY($1::text[])`, [rolnames])
    return result.rowCount ?? 0
  })
}

/**
 * Remove the rows whose role or database no longer exists on the instance: a
 * deleted project's, or a login dropped outside this module. The lookup never
 * serves such a row, so this is housekeeping. A row is written only after its
 * role and database exist, so none being made is removed.
 */
export async function prunePoolerLogins(region: CloudRegionId): Promise<number> {
  return inPoolerDatabase(region, 'pruned', async (client) => {
    const result = await client.query(
      `DELETE FROM backenly_pooler.logins l
        WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname = l.rolname::name)
           OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_database d WHERE d.datname = l.database::name)`,
    )
    return result.rowCount ?? 0
  })
}
