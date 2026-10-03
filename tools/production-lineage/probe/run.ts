/**
 * PRODUCTION LINEAGE CAPTURE — read-only, one database, one thing it can do
 * =========================================================================
 *
 * Captures the production catalog and its provisioning inventory, and nothing
 * else. There is no mode switch, no scratch database, no replay, and no SQL
 * payload: those capabilities are not disabled here, they are absent from the
 * module graph, and `tools/production-lineage/readonly-audit.ts` fails the build
 * if any of them reappears.
 *
 * The comparison happens locally afterwards, against the schema.prisma
 * projection captured during the staging investigation. That projection is a
 * property of the repository rather than of an environment, which is why
 * production needs no replay of its own.
 *
 * TLS is mandatory. There is no loopback or plaintext path, unlike the staging
 * probe, because there is no development use for this file.
 */

import {
  captureSnapshot,
  rlsVisibility,
  type RlsVisibility,
  type Snapshot,
} from '../../migration-lineage/probe/capture'
import {
  clientConfig,
  connect,
  observeTls,
  parseDatabaseUrl,
  type PgClient,
  type TlsObservation,
} from '../../migration-lineage/probe/connect'
import { captureInventory, platformSchemas, type Inventory } from '../../migration-lineage/probe/inventory'
import { loadRdsCa } from '../../migration-lineage/probe/rds-ca'
import {
  assertExpectedDatabase,
  assertProductionUrl,
  assertRdsEndpoint,
  assertReadOnlySession,
  ProductionGuardRefusal,
} from './guards'

export type CaptureVerdict = 'PASS' | 'FAIL' | 'INCONCLUSIVE'

export interface CaptureEnv {
  databaseUrl: string
  /** The database this capture is allowed to read, stated by the operator. */
  expectedDatabase: string | undefined
}

export interface ProductionCaptureResult {
  probe: 'production-lineage-capture'
  version: 1
  startedAt: string
  finishedAt: string
  verdict: CaptureVerdict
  failures: string[]
  inconclusive: string[]
  target: { database: string; ignoredUrlParameters: string[] }
  role: Record<string, unknown> | null
  tls: TlsObservation | null
  snapshot: Snapshot | null
  inventory: Inventory | null
  rls: RlsVisibility | null
  error: string | null
}

const ROLE_SQL = `
  SELECT current_user AS "user", session_user AS "session_user",
         r.rolsuper AS superuser, r.rolcreatedb AS createdb, r.rolcreaterole AS createrole,
         r.rolbypassrls AS bypassrls, current_setting('server_version') AS server_version
    FROM pg_roles r WHERE r.rolname = current_user`

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

export async function captureProduction(env: CaptureEnv): Promise<ProductionCaptureResult> {
  assertProductionUrl(env.databaseUrl)

  let parsed: ReturnType<typeof parseDatabaseUrl>
  try {
    parsed = parseDatabaseUrl(env.databaseUrl)
  } catch (err) {
    throw new ProductionGuardRefusal(message(err))
  }
  const { target, ignoredParameters } = parsed
  assertRdsEndpoint(target.host)
  // Checked twice: against the URL before connecting, and against the server's
  // own answer after.
  assertExpectedDatabase(env.expectedDatabase, target.database)

  const r: ProductionCaptureResult = {
    probe: 'production-lineage-capture',
    version: 1,
    startedAt: new Date().toISOString(),
    finishedAt: '',
    verdict: 'INCONCLUSIVE',
    failures: [],
    inconclusive: [],
    target: { database: target.database, ignoredUrlParameters: ignoredParameters },
    role: null,
    tls: null,
    snapshot: null,
    inventory: null,
    rls: null,
    error: null,
  }

  let client: PgClient | null = null
  try {
    client = await connect(clientConfig(target, { mode: 'verify-full', ca: loadRdsCa() }))

    // One dedicated connection, so this holds for every later statement on it.
    await client.query('SET default_transaction_read_only = on')
    await client.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY')
    await client.query("SET statement_timeout = '120s'")
    const readOnly = await client.query('SHOW transaction_read_only')
    assertReadOnlySession(readOnly.rows[0]?.transaction_read_only)

    const observed = await observeTls(client)
    r.tls = observed
    if (!observed.authorized) r.failures.push(`TLS peer was not authorized: ${observed.authorizationError}`)
    if (!observed.server.ssl) r.failures.push('the server reports this session is not using SSL')

    const actual = await client.query('SELECT current_database() AS database')
    assertExpectedDatabase(env.expectedDatabase, actual.rows[0]?.database)

    r.role = (await client.query(ROLE_SQL)).rows[0] ?? null

    const schemas = await platformSchemas(client)
    r.snapshot = await captureSnapshot(client, schemas)
    r.inventory = await captureInventory(client, schemas)
    r.rls = await rlsVisibility(client)
    if (!r.rls.consistent) r.failures.push(`RLS visibility is inconsistent: ${r.rls.inconsistencies.join('; ')}`)
  } catch (err) {
    if (err instanceof ProductionGuardRefusal) throw err
    r.error = message(err)
    r.inconclusive.push(`capture error: ${r.error}`)
  } finally {
    await client?.end().catch(() => {})
  }

  r.finishedAt = new Date().toISOString()
  r.verdict = r.failures.length ? 'FAIL' : r.inconclusive.length ? 'INCONCLUSIVE' : 'PASS'
  return r
}
