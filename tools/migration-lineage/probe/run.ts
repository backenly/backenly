/**
 * MIGRATION LINEAGE PROBE — one database state per run
 * ====================================================
 *
 * Modes:
 *
 *   tls-rls          Verified TLS to staging, with two negative controls that
 *                    must be refused by certificate verification; RLS
 *                    visibility on staging read directly from the catalogs; and
 *                    a positive control proving those reads see a policy that
 *                    exists, in a scratch database.
 *   capture-staging  C: read-only semantic capture of staging's platform
 *                    schemas, plus the provisioning inventory.
 *   replay           A or P: replay the carried SQL into a scratch database,
 *                    then capture what it built.
 *
 * Staging is only ever read. The reference session is read-only from its first
 * statement, and every capture runs in a READ ONLY transaction on top of that.
 * DDL happens only inside a scratch database this run created, through
 * `scratch.ts`, and only a second, separate session can create or drop one.
 *
 * Local runs (`local: true`) exist for development and tests against a loopback
 * PostgreSQL. They skip TLS, and their verdict is LOCAL_ONLY, never PASS.
 */

import { createHash } from 'node:crypto'
import { captureCapabilities, PLATFORM_EXTENSIONS, type CapabilityReport } from './capabilities'
import { captureSnapshot, rlsVisibility, type RlsVisibility, type Snapshot } from './capture'
import { checkRlsControl, RLS_CONTROL_SQL } from './rls-control'
import {
  clientConfig,
  connect,
  expectVerificationRefusal,
  isLoopback,
  observeTls,
  parseDatabaseUrl,
  publicRootsOnly,
  type PgClient,
  type TlsControl,
  type TlsObservation,
  type TlsPolicy,
} from './connect'
import { decodeInput } from './input'
import { captureInventory, platformSchemas, type Inventory } from './inventory'
import { loadRdsCa } from './rds-ca'
import { listScratchDatabases, replayFiles, withScratchDatabase, type ReplayReport, type ScratchCleanup } from './scratch'

export type ProbeMode = 'tls-rls' | 'capture-staging' | 'replay'
export type ProbeVerdict = 'PASS' | 'FAIL' | 'INCONCLUSIVE' | 'LOCAL_ONLY'

export interface ProbeEnv {
  mode: string | undefined
  databaseUrl: string
  local: boolean
  inputB64?: string
}

/** The probe declined to start. Nothing was connected to. */
export class ProbeRefusal extends Error {}

export interface ProbeResult {
  probe: 'migration-lineage'
  version: 1
  mode: ProbeMode
  local: boolean
  startedAt: string
  finishedAt: string
  verdict: ProbeVerdict
  failures: string[]
  inconclusive: string[]
  target: { database: string; rdsEndpoint: boolean; ignoredUrlParameters: string[] }
  role: Record<string, unknown> | null
  tls: TlsObservation | { applicable: false; reason: string } | null
  tlsControls: TlsControl[]
  rls: RlsVisibility | null
  rlsControl: { visibility: RlsVisibility | null; failures: string[]; error: string | null } | null
  snapshot: Snapshot | null
  inventory: Inventory | null
  capabilities: CapabilityReport | null
  input: { purpose: string; source: Record<string, unknown>; files: Array<{ name: string; sha256: string; bytes: number }> } | null
  replay: ReplayReport | null
  scratch: ScratchCleanup[]
  scratchDatabasesAfter: string[] | null
  error: string | null
}

const ROLE_SQL = `
  SELECT current_user AS "user", session_user AS "session_user",
         r.rolsuper AS superuser, r.rolcreatedb AS createdb, r.rolcreaterole AS createrole,
         r.rolbypassrls AS bypassrls, current_setting('server_version') AS server_version
    FROM pg_roles r WHERE r.rolname = current_user`

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

export async function runProbe(env: ProbeEnv): Promise<ProbeResult> {
  const mode = env.mode
  if (mode !== 'tls-rls' && mode !== 'capture-staging' && mode !== 'replay') {
    throw new ProbeRefusal(`unknown mode ${String(mode)}`)
  }

  let parsed: ReturnType<typeof parseDatabaseUrl>
  try {
    parsed = parseDatabaseUrl(env.databaseUrl)
  } catch (err) {
    throw new ProbeRefusal(message(err))
  }
  const { target, ignoredParameters } = parsed
  const rdsEndpoint = /\.rds\.amazonaws\.com$/i.test(target.host)

  if (env.local) {
    if (!isLoopback(target.host)) throw new ProbeRefusal('local mode requires a loopback database')
  } else {
    // Structural refusal, as in the rehearsal: nothing here may reach production.
    if (!/staging/i.test(env.databaseUrl)) throw new ProbeRefusal('database URL does not identify a staging database')
    if (/production|prod-/i.test(env.databaseUrl)) throw new ProbeRefusal('database URL looks like production')
    if (!rdsEndpoint) throw new ProbeRefusal('database host is not an RDS endpoint')
  }

  let input: ReturnType<typeof decodeInput> | null = null
  if (mode === 'replay') {
    try {
      input = decodeInput(env.inputB64)
    } catch (err) {
      throw new ProbeRefusal(message(err))
    }
  }

  const policy: TlsPolicy = env.local ? { mode: 'loopback-plaintext' } : { mode: 'verify-full', ca: loadRdsCa() }

  const r: ProbeResult = {
    probe: 'migration-lineage',
    version: 1,
    mode,
    local: env.local,
    startedAt: new Date().toISOString(),
    finishedAt: '',
    verdict: 'INCONCLUSIVE',
    failures: [],
    inconclusive: [],
    target: { database: target.database, rdsEndpoint, ignoredUrlParameters: ignoredParameters },
    role: null,
    tls: null,
    tlsControls: [],
    rls: null,
    rlsControl: null,
    snapshot: null,
    inventory: null,
    capabilities: null,
    input: null,
    replay: null,
    scratch: [],
    scratchDatabasesAfter: null,
    error: null,
  }
  const fail = (m: string) => r.failures.push(m)
  const unsure = (m: string) => r.inconclusive.push(m)

  let ref: PgClient | null = null
  let admin: PgClient | null = null
  try {
    ref = await connect(clientConfig(target, policy))
    // A dedicated connection, not a pool, so this setting holds for every later
    // statement on it. That is the opposite of the Prisma trap recorded in
    // scripts/rehearse-maintenance-rds.ts, and the reason pg is used here.
    await ref.query('SET default_transaction_read_only = on')
    await ref.query("SET statement_timeout = '120s'")
    r.role = (await ref.query(ROLE_SQL)).rows[0] ?? null

    if (env.local) {
      r.tls = { applicable: false, reason: 'loopback development run' }
    } else {
      const observed = await observeTls(ref)
      r.tls = observed
      if (!observed.authorized) fail(`TLS peer was not authorized: ${observed.authorizationError}`)
      if (!observed.server.ssl) fail('the server reports this session is not using SSL')
    }

    if (mode === 'tls-rls') {
      if (!env.local) {
        r.tlsControls = [
          await expectVerificationRefusal(
            'public roots only, RDS CA withheld',
            clientConfig(target, { mode: 'verify-full', ca: publicRootsOnly() }),
          ),
          await expectVerificationRefusal(
            'RDS CA, wrong server identity',
            clientConfig(target, policy, { identityCheckAs: 'lineage-probe-wrong-host.invalid' }),
          ),
        ]
        for (const c of r.tlsControls) {
          if (c.refusedByVerification) continue
          const text = `negative control "${c.label}" was not refused by certificate verification (${c.code ?? 'no code'}: ${c.message})`
          // Connecting is proof verification is not what it appears. Failing for
          // some other reason proves nothing either way.
          if (c.message === 'connection succeeded') fail(text)
          else unsure(text)
        }
      }

      r.rls = await rlsVisibility(ref)
      if (!r.rls.consistent) fail(`RLS visibility is inconsistent: ${r.rls.inconsistencies.join('; ')}`)

      admin = await connect(clientConfig(target, policy))
      const out = await withScratchDatabase(admin, 'rlsctl', async name => {
        const s = await connect(clientConfig(target, policy, { database: name }))
        try {
          const rep = await replayFiles(s, [{ name: 'rls-control', sql: RLS_CONTROL_SQL }])
          if (rep.status !== 'complete') throw new Error(`control objects not created: ${rep.steps[0]?.error?.message}`)
          const visibility = await rlsVisibility(s)
          const snap = await captureSnapshot(s, ['public'])
          return { visibility, check: checkRlsControl(visibility, snap) }
        } finally {
          await s.end().catch(() => {})
        }
      })
      r.scratch.push(out.cleanup)
      r.rlsControl = {
        visibility: out.value?.visibility ?? null,
        failures: out.value?.check.failures ?? [],
        error: out.error,
      }
      if (out.error) unsure(`RLS positive control did not run: ${out.error}`)
      else if (!out.value?.check.pass) fail(`RLS positive control not observed: ${out.value?.check.failures.join('; ')}`)
    }

    if (mode === 'capture-staging') {
      const schemas = await platformSchemas(ref)
      r.snapshot = await captureSnapshot(ref, schemas)
      r.inventory = await captureInventory(ref, schemas)
      r.capabilities = await captureCapabilities(ref, PLATFORM_EXTENSIONS)
      r.rls = await rlsVisibility(ref)
      if (!r.rls.consistent) fail(`RLS visibility is inconsistent: ${r.rls.inconsistencies.join('; ')}`)
    }

    if (mode === 'replay' && input) {
      const carried = input
      r.input = {
        purpose: carried.purpose,
        source: carried.source,
        files: carried.files.map(f => ({
          name: f.name,
          sha256: createHash('sha256').update(f.sql, 'utf8').digest('hex'),
          bytes: Buffer.byteLength(f.sql, 'utf8'),
        })),
      }
      admin = await connect(clientConfig(target, policy))
      const out = await withScratchDatabase(admin, carried.purpose, async name => {
        const s = await connect(clientConfig(target, policy, { database: name }))
        try {
          const replay = await replayFiles(s, carried.files)
          // Captured even after a failed replay: what a partial replay built is
          // the diagnosis, and it is labelled failed either way.
          const snapshot = await captureSnapshot(s, await platformSchemas(s))
          return { replay, snapshot }
        } finally {
          await s.end().catch(() => {})
        }
      })
      r.scratch.push(out.cleanup)
      r.replay = out.value?.replay ?? null
      r.snapshot = out.value?.snapshot ?? null
      if (out.error) {
        unsure(`replay did not produce a result: ${out.error}`)
      } else if (r.replay?.status !== 'complete') {
        const bad = r.replay?.steps.find(s => !s.ok)
        unsure(`replay stopped at ${bad?.name}: ${bad?.error?.code} ${bad?.error?.message}`)
      }
    }

    if (admin) r.scratchDatabasesAfter = await listScratchDatabases(admin)
  } catch (err) {
    r.error = message(err)
    unsure(`probe error: ${r.error}`)
  } finally {
    await ref?.end().catch(() => {})
    await admin?.end().catch(() => {})
  }

  for (const c of r.scratch) {
    if (c.created && !c.dropped) fail(`scratch database ${c.name} was not dropped: ${c.error}`)
  }
  if (r.scratchDatabasesAfter?.length) {
    fail(`lineage scratch databases still exist on the instance: ${r.scratchDatabasesAfter.join(', ')}`)
  }

  r.finishedAt = new Date().toISOString()
  r.verdict = r.failures.length ? 'FAIL' : r.inconclusive.length ? 'INCONCLUSIVE' : env.local ? 'LOCAL_ONLY' : 'PASS'
  return r
}
