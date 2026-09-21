/**
 * PHASE 4 — the observations themselves.
 *
 * Each function answers exactly ONE diagnostic question with one of the outcome
 * strings the catalog predicts. The vocabulary is closed on purpose: an outcome
 * no hypothesis predicted eliminates every hypothesis and the investigation
 * correctly reports "unexplained" — which is the honest result, and the signal
 * that the catalog needs extending.
 *
 * These probes NEVER swallow errors into a plausible-looking outcome. A probe
 * that returns 'no_rows' because its query failed is not reporting an
 * observation, it is fabricating evidence — and here that fabricated evidence
 * goes on to justify a production change. Failures throw, and the investigation
 * records the test as unavailable rather than as answered.
 */

import { prisma } from '@/lib/db/prisma'
import { queryWorkspaceAsOwner, resolveWorkspaceSchema } from '@/lib/services/workspace-pool'
import { usesLegacyGucs } from '@/lib/postgrest/rls-translation'
import { probePostgrest } from '@/lib/postgrest/health'

export interface ProbeContext {
  projectId: string
  /** Table under investigation; absent for project-wide symptoms. */
  table?: string
  /** Whether the failing request carried an end-user identity. */
  callerIdentityPresent?: boolean
  /**
   * Member tables of the subsystem under investigation. Present only for the
   * structural symptom; the runtime symptoms reason about one table.
   */
  membership?: string[]
}

export type ProbeFn = (ctx: ProbeContext) => Promise<{ outcome: string; detail?: string }>

/**
 * The project's workspace schema, as STORED rather than as computed.
 *
 * This used to be `workspace_${projectId}` inline. `resolveWorkspaceSchema`
 * prefers `Workspace.postgresSchema`, which is authoritative — and for any
 * project whose stored name differs from the default, the computed one names a
 * schema that does not exist. Every catalog probe below then reads an empty
 * `information_schema` and reports the table missing, which is a confident
 * wrong answer rather than a failure.
 */
async function schemaFor(projectId: string): Promise<string> {
  return resolveWorkspaceSchema(projectId)
}

/** Identifier guard — these values reach raw SQL. */
const IDENT = /^[a-zA-Z_][a-zA-Z0-9_]*$/
function requireTable(ctx: ProbeContext): string {
  const t = ctx.table ?? ''
  if (!IDENT.test(t)) throw new Error(`Probe requires a valid table name, got "${ctx.table}"`)
  return t
}

// ── empty_reads ─────────────────────────────────────────────────────────────

/**
 * Does the data physically exist, ignoring row security?
 *
 * The single most valuable observation for this symptom: it separates "the rows
 * are hidden from you" from "there are no rows", which are the two families of
 * cause and have nothing in common.
 *
 * ── AS OWNER, because it was asking as nobody ──────────────────────────────
 *
 * This ran through `prisma.$queryRawUnsafe`, which sets no RLS session
 * variables at all. Under FORCE ROW LEVEL SECURITY — which every workspace
 * table has, and which binds the table's owner too — the policy's claim is
 * null, so the count came back 0 for a table full of rows.
 *
 * It read correctly in development only because the local role happens to be a
 * superuser and superusers bypass RLS. Production's role is NOSUPERUSER
 * NOBYPASSRLS by design, so the answer inverted between environments with
 * nothing to say it had.
 *
 * That made this the worst possible probe to get wrong. `no_rows` is the SOLE
 * prediction of `table_genuinely_empty`, so a blinded count did not degrade the
 * diagnosis into uncertainty — it drove it confidently to "the table contains
 * no rows" about a table the customer's app was reading from, and that
 * conclusion is what the Review Queue then showed a human. The docstring above
 * promised "ignoring row security" and the query did nothing of the kind.
 */
export const serviceRows: ProbeFn = async ctx => {
  const table = requireTable(ctx)
  const schema = await schemaFor(ctx.projectId)
  const rows = await queryWorkspaceAsOwner<{ n: bigint }>(
    ctx.projectId,
    `SELECT count(*)::bigint AS n FROM "${schema}"."${table}"`,
  ).catch((err: unknown) => {
    // Thrown, never coerced to zero. "I could not count" and "I counted none"
    // are different observations and only one of them is evidence.
    throw new Error(
      `could not count rows in ${table}: ${err instanceof Error ? err.message : String(err)}`,
    )
  })
  const n = Number(rows[0]?.n ?? 0)
  return { outcome: n > 0 ? 'rows_exist' : 'no_rows', detail: `${n} row(s) present` }
}

/**
 * Do the policies read the identity the data plane actually sets?
 *
 * There is one engine. PostgREST sets `request.jwt.claims` and never the legacy
 * `app.*` GUCs, so a policy on the old dialect matches nothing — the empty-read
 * symptom this hypothesis is trying to explain.
 *
 * A project with no policies reports 'match': nothing depends on the identity
 * contract, so it cannot be wrong about it.
 */
export const contractMatch: ProbeFn = async ctx => {
  const policies = await prisma.$queryRawUnsafe<Array<{ qual: string | null; with_check: string | null }>>(
    `SELECT qual, with_check FROM pg_policies WHERE schemaname = $1`,
    await schemaFor(ctx.projectId),
  )
  if (policies.length === 0) {
    return { outcome: 'match', detail: 'no row-security policies on this schema' }
  }

  const legacy = policies.filter(p => usesLegacyGucs(p.qual) || usesLegacyGucs(p.with_check)).length
  const jwt = policies.length - legacy

  return {
    outcome: legacy > 0 ? 'mismatch' : 'match',
    detail: `${legacy} legacy-GUC / ${jwt} jwt-claims policies`,
  }
}

/**
 * Did the failing request carry an end-user identity?
 *
 * Supplied by the caller rather than measured, because it is a property of the
 * request and cannot be recovered afterwards. When it was not captured the probe
 * refuses rather than assuming — assuming 'absent' would make "you forgot to
 * send a token" the leading explanation for every empty read.
 */
export const callerIdentity: ProbeFn = async ctx => {
  if (ctx.callerIdentityPresent === undefined) {
    throw new Error('Caller identity was not captured for this request; cannot observe it after the fact')
  }
  return { outcome: ctx.callerIdentityPresent ? 'present' : 'absent' }
}

export const softDeleted: ProbeFn = async ctx => {
  const table = requireTable(ctx)
  const schema = await schemaFor(ctx.projectId)

  // Catalog read. RLS does not filter `information_schema`, so this one
  // correctly needs no claim.
  const hasCol = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
    `SELECT count(*)::bigint AS n FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = $2 AND column_name = 'deleted_at'`,
    schema,
    table,
  )
  if (Number(hasCol[0]?.n ?? 0) === 0) {
    return { outcome: 'no_column', detail: 'table has no deleted_at column' }
  }

  // Tenant rows, so AS OWNER for the same reason as `serviceRows`. Blinded,
  // this reported `total: 0` and returned 'some_live' — which reads as "the
  // rows are fine" and eliminates `all_rows_soft_deleted` on no evidence.
  const counts = await queryWorkspaceAsOwner<{ total: bigint; live: bigint }>(
    ctx.projectId,
    `SELECT count(*)::bigint AS total,
            count(*) FILTER (WHERE deleted_at IS NULL)::bigint AS live
       FROM "${schema}"."${table}"`,
  ).catch((err: unknown) => {
    throw new Error(
      `could not count soft-deleted rows in ${table}: ${err instanceof Error ? err.message : String(err)}`,
    )
  })
  const total = Number(counts[0]?.total ?? 0)
  const live = Number(counts[0]?.live ?? 0)
  return {
    outcome: total > 0 && live === 0 ? 'all_deleted' : 'some_live',
    detail: `${live}/${total} rows not soft-deleted`,
  }
}

// ── endpoint_404 ────────────────────────────────────────────────────────────

export const tableExists: ProbeFn = async ctx => {
  const table = requireTable(ctx)
  const rows = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
    `SELECT count(*)::bigint AS n FROM information_schema.tables
      WHERE table_schema = $1 AND table_name = $2`,
    await schemaFor(ctx.projectId),
    table,
  )
  return { outcome: Number(rows[0]?.n ?? 0) > 0 ? 'exists' : 'missing' }
}

/**
 * Is this table reachable as a REST resource?
 *
 * Asks the CATALOG. It used to ask `ApiDefinition`, which has had no create
 * path since the PostgREST cutover, so on every project built after it this
 * probe answered 'absent' for EVERY table — always, regardless of reality.
 *
 * That is not a cosmetic wrong answer here. 'absent' is the sole prediction of
 * the `missing_api_definition` hypothesis, whose remedy is GENERATE_API with
 * autoApplicable: true — and GENERATE_API cannot create the row this probe was
 * looking for. Left alone it would have confirmed that hypothesis on every
 * table of every modern project, auto-applied a repair that changes nothing,
 * and re-diagnosed it on the next tick: the same false-fix loop the
 * ApiDefinition detectors produced, rebuilt inside the diagnosis engine.
 *
 * 'present_disabled' is no longer reachable and that is correct: per-resource
 * enable/disable was a property of the projection. Under PostgREST a table is
 * reachable or it is not, decided by the catalog plus the role's grants.
 */
export const apiDefinition: ProbeFn = async ctx => {
  const table = requireTable(ctx)
  const { listExposedTables } = await import('@/lib/mcp/schema-introspection')
  const exposed = await listExposedTables(ctx.projectId)
  const found = exposed.some(t => t.name.toLowerCase() === table.toLowerCase())
  return { outcome: found ? 'present_enabled' : 'absent' }
}

/**
 * Can PostgREST see the table?
 *
 * Reports 'not_applicable' when this project is not served by PostgREST — an
 * outcome no hypothesis predicts, so it eliminates the stale-cache explanation
 * rather than lending it accidental support.
 */
export const postgrestVisibility: ProbeFn = async ctx => {
  const table = requireTable(ctx)
  const baseUrl = process.env.POSTGREST_URL
  const secret = process.env.POSTGREST_JWT_SECRET
  if (!baseUrl || !secret) return { outcome: 'not_applicable', detail: 'PostgREST not configured' }

  // No per-project engine check: PostgREST is the only data plane, so this
  // probe applies to every project wherever PostgREST is configured at all.

  const { mintInternalToken, internalClaimsFor, upstreamUrl } = await import('@/lib/postgrest/gateway')
  const token = mintInternalToken(
    internalClaimsFor({ projectId: ctx.projectId, serviceRole: true }),
    secret,
  )
  const res = await fetch(upstreamUrl(baseUrl, table, 'limit=0'), {
    headers: {
      Authorization: `Bearer ${token}`,
      'Accept-Profile': await schemaFor(ctx.projectId),
    },
  })
  if (res.ok) return { outcome: 'visible' }
  const body = await res.text()
  if (body.includes('PGRST205')) {
    return { outcome: 'not_in_cache', detail: body.slice(0, 200) }
  }
  return { outcome: 'other_error', detail: `HTTP ${res.status}: ${body.slice(0, 200)}` }
}

// ── endpoint_403 ────────────────────────────────────────────────────────────

export const isInternalTable: ProbeFn = async ctx => {
  const table = requireTable(ctx)
  const internal = table.startsWith('_') || table.toLowerCase() === 'users'
  return { outcome: internal ? 'internal' : 'not_internal' }
}

export const roleGrants: ProbeFn = async ctx => {
  const table = requireTable(ctx)
  const rows = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
    `SELECT count(*)::bigint AS n FROM information_schema.role_table_grants
      WHERE table_schema = $1 AND table_name = $2
        AND grantee IN ('authenticated', 'service_role')`,
    await schemaFor(ctx.projectId),
    table,
  )
  return { outcome: Number(rows[0]?.n ?? 0) > 0 ? 'present' : 'absent' }
}

/**
 * Key scope is a property of the specific failing request, not of the project.
 * Without the request there is nothing to observe, and inventing an answer here
 * would let "your key is wrong" win by default.
 */
export const keyScope: ProbeFn = async () => {
  throw new Error('Key scope can only be observed from the failing request context')
}

// ── all_tenants_failing ─────────────────────────────────────────────────────

export const postgrestReachable: ProbeFn = async () => {
  const status = await probePostgrest()
  if (status.state === 'not_configured') return { outcome: 'not_applicable' }
  return {
    outcome: status.state === 'unreachable' ? 'unreachable' : 'reachable',
    detail: status.state,
  }
}

export const schemaCacheState: ProbeFn = async () => {
  const status = await probePostgrest()
  if (status.state === 'not_configured') return { outcome: 'not_applicable' }
  return {
    outcome: status.state === 'schema_cache_failed' ? 'failed' : 'ok',
    detail: status.state,
  }
}

export const danglingRegistrations: ProbeFn = async () => {
  const rows = await prisma.$queryRawUnsafe<Array<{ list: string | null }>>(
    `SELECT public.backenly_pgrst_current_schemas() AS list`,
  )
  const registered = (rows[0]?.list ?? '').split(',').filter(Boolean)
  if (registered.length === 0) return { outcome: 'absent', detail: 'nothing registered' }

  const existing = await prisma.$queryRawUnsafe<Array<{ schema_name: string }>>(
    `SELECT schema_name FROM information_schema.schemata WHERE schema_name = ANY($1::text[])`,
    registered,
  )
  const present = new Set(existing.map(e => e.schema_name))
  const dangling = registered.filter(s => !present.has(s))

  return {
    outcome: dangling.length > 0 ? 'present' : 'absent',
    detail: dangling.length > 0 ? `dangling: ${dangling.join(', ')}` : 'all registered schemas exist',
  }
}

export const databaseReachable: ProbeFn = async () => {
  await prisma.$queryRawUnsafe(`SELECT 1`)
  return { outcome: 'reachable' }
}

/** testId → probe. Keys must match the catalog's test ids exactly. */
// Structural probes live in their own module because their admissibility was
// decided in advance (docs/structural-probe-inventory.md) and their failure
// mode is different: they THROW when an instrument is unavailable rather than
// returning a confident negative.
import { STRUCTURAL_PROBES } from './structural-probes'

export const PROBE_REGISTRY: Record<string, ProbeFn> = {
  ...STRUCTURAL_PROBES,
  service_rows: serviceRows,
  contract_match: contractMatch,
  caller_identity: callerIdentity,
  soft_deleted: softDeleted,
  table_exists: tableExists,
  api_definition: apiDefinition,
  postgrest_visibility: postgrestVisibility,
  is_internal_table: isInternalTable,
  role_grants: roleGrants,
  key_scope: keyScope,
  postgrest_reachable: postgrestReachable,
  schema_cache_state: schemaCacheState,
  dangling_registrations: danglingRegistrations,
  database_reachable: databaseReachable,
}
