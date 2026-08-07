/**
 * Making a workspace schema servable by PostgREST — the one call that does it.
 *
 * ── The bug this exists to make impossible ──────────────────────────────────
 *
 * `backenly_pgrst_register_schema()` has existed since the Phase 3 cutover. It
 * was called by the one-off migration script and by NOTHING ELSE. Every project
 * created after the cutover therefore came up with a schema PostgREST had never
 * been told about, and the entire `/db/*` data plane answered:
 *
 *   PGRST106  Invalid schema: workspace_<id>
 *
 * for every table, forever. Reported from a real build on 2026-07-22 after a
 * user rebuilt their whole data layer on HTTP functions to work around it.
 *
 * The failure was invisible from the inside for three compounding reasons:
 *
 *   1. The autonomy loop probes for DANGLING registrations (registered schema
 *      that no longer exists). The inverse — an existing schema that was never
 *      registered — had no probe at all, so nothing looked for it.
 *   2. `backenly_pgrst_on_ddl` skips any schema not already in the registry
 *      (`CONTINUE WHEN NOT (obj.schema_name = ANY (registered))`), so an
 *      unregistered project silently gets no grants either. Registering alone
 *      would have produced 403s instead of 406s — a second failure hiding
 *      behind the first.
 *   3. `/auth/*` and `/fn/*` run on the Express runtime as the schema owner and
 *      never touch PostgREST, so they kept working. The project looked alive.
 *
 * ── Why registration is idempotent and cheap, and called liberally ──────────
 *
 * Correctness here cannot rest on remembering to call this from the right
 * place. Every path that can create a workspace schema calls it, AND the
 * runtime self-heals on PGRST106 (see server/routes/postgrest-handler.ts). The
 * belt and the braces are deliberate: a schema-creation path added next year
 * will not know to call this, and the runtime repair covers it anyway.
 *
 * The underlying SQL prunes, grants, revokes credential tables, applies
 * soft-delete parity and owner defaults, appends to the list and reloads — all
 * idempotent. Repeat calls cost one round trip and change nothing.
 */

import { prisma } from '@/lib/db'
import { workspaceSchemaName } from '@/lib/security/workspace-schema'

/**
 * A branch schema, and nothing else that merely contains `_br_`.
 *
 * Anchored on the canonical project form so `workspace_<uuid>_staging` — the
 * migration dry-run schema, which has no key binding and no owner — can never
 * match. Widening this to anything looser reintroduces the exposure the
 * registry's own check was narrowed to close.
 */
const BRANCH_SCHEMA_RE =
  /^workspace_[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}_br_[a-z][a-z0-9_]{1,30}$/

/**
 * Is every table protected on the project also protected on the branch?
 *
 * Read-only, and one-directional: a branch may be MORE restrictive than main,
 * never less. Uses the platform pool because it inspects the catalog only.
 */
async function verifyBranchProtection(
  mainSchema: string,
  branchSchema: string,
): Promise<{ ok: boolean; reason?: string }> {
  try {
    const rows = await prisma.$queryRawUnsafe<Array<{ relname: string }>>(
      `WITH main_protected AS (
         SELECT c.relname FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = $1
          WHERE c.relkind = 'r' AND c.relrowsecurity
       ), branch_protected AS (
         SELECT c.relname FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = $2
          WHERE c.relkind = 'r' AND c.relrowsecurity
       )
       SELECT m.relname FROM main_protected m
        WHERE m.relname NOT IN (SELECT relname FROM branch_protected)`,
      mainSchema,
      branchSchema,
    )
    if (rows.length > 0) {
      return {
        ok: false,
        reason: `${rows.length} table(s) protected on the project are unprotected on the branch (${rows.slice(0, 3).map(r => r.relname).join(', ')})`,
      }
    }
    return { ok: true }
  } catch (e: any) {
    // Fail CLOSED. An unverifiable branch is not a servable branch.
    return { ok: false, reason: `protection could not be verified (${e?.message ?? e})` }
  }
}

/**
 * Registration is idempotent but not free, and the self-heal path can be hit by
 * a burst of concurrent requests for the same project. This collapses that
 * burst into one round trip.
 *
 * Deliberately short: it caches SUCCESS only, and a five-second window is long
 * enough to absorb a thundering herd while never being long enough to keep
 * serving a stale "already registered" after someone drops the schema.
 */
const recentlyRegistered = new Map<string, number>()
const REGISTER_TTL_MS = 5_000

/** In-flight de-duplication — two concurrent requests share one repair. */
const inFlight = new Map<string, Promise<RegistrationResult>>()

export interface RegistrationResult {
  registered: boolean
  schema: string
  /** Absent on success. Registration NEVER throws — see `ensureSchemaRegistered`. */
  error?: string
  /** True when the answer came from the short-lived success cache. */
  cached?: boolean
}

/**
 * Make `workspace_<projectId>` servable by PostgREST. Safe to call at any time,
 * from any path, as often as you like.
 *
 * DOES NOT THROW. Registration is a repair, and a repair that can take down the
 * caller is worse than the fault it fixes — a project-creation request must not
 * fail because PostgREST is temporarily unreachable, and a data-plane request
 * must not turn a recoverable 406 into a 500. Callers that need to know check
 * `.registered`; callers that are simply being thorough can ignore the result.
 */
export async function ensureSchemaRegistered(projectId: string): Promise<RegistrationResult> {
  let schema: string
  try {
    schema = workspaceSchemaName(projectId)
  } catch (err) {
    return {
      registered: false,
      schema: `workspace_${projectId}`,
      error: err instanceof Error ? err.message : String(err),
    }
  }

  return registerSchemaByName(schema)
}

/**
 * Register a schema PostgREST must serve, by its literal name.
 *
 * Split out from ensureSchemaRegistered so the branch case has somewhere to be
 * refused explicitly rather than failing deep inside a SQL function whose error
 * every caller catches and logs. See the guard below for the measurement.
 */
export async function registerSchemaByName(schema: string): Promise<RegistrationResult> {
  // ── A branch may be served only once it is as protected as its project ────
  //
  // The registry's canonical-name check exists because a branch clone is a copy
  // of a tenant's tables, and `CREATE TABLE ... LIKE INCLUDING ALL` does not
  // copy row security. Verified on PG 16: a fresh clone has relrowsecurity =
  // false and zero policies, and a non-privileged role read every fixture row.
  //
  // The answer is not to trust the caller to have fixed that. Parity is checked
  // HERE, against the live catalog, immediately before the schema is published —
  // so a branch that lost a policy after it was cloned, or gained a table that
  // never had one, is refused even though createBranch succeeded.
  if (BRANCH_SCHEMA_RE.test(schema)) {
    const mainSchema = schema.replace(/_br_[a-z0-9_]+$/, '')
    const parity = await verifyBranchProtection(mainSchema, schema)
    if (!parity.ok) {
      return {
        registered: false,
        schema,
        error:
          `Refusing to serve branch ${schema}: ${parity.reason}. A branch is only exposed once ` +
          `every table protected on the project is protected on the branch.`,
      }
    }
  }

  const hit = recentlyRegistered.get(schema)
  if (hit && hit > Date.now()) {
    return { registered: true, schema, cached: true }
  }

  const existing = inFlight.get(schema)
  if (existing) return existing

  const run = (async (): Promise<RegistrationResult> => {
    try {
      // Grants first, then the registry entry. Both are inside the SQL function
      // now (register_schema calls prepare_schema), but the order is stated here
      // too because getting it backwards produces a schema PostgREST serves and
      // has no privileges on — a 403 that looks like an RLS bug.
      await prisma.$executeRawUnsafe(`SELECT public.backenly_pgrst_register_schema($1)`, schema)
      recentlyRegistered.set(schema, Date.now() + REGISTER_TTL_MS)
      return { registered: true, schema }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(
        `[postgrest/registration] Could not register ${schema}. The /db plane will ` +
        `answer PGRST106 for this project until this succeeds.`,
        message,
      )
      return { registered: false, schema, error: message }
    } finally {
      inFlight.delete(schema)
    }
  })()

  inFlight.set(schema, run)
  return run
}

/**
 * Every workspace schema that exists in Postgres but is missing from the
 * PostgREST registry.
 *
 * This is the probe that did not exist. `danglingRegistrations` asks the
 * opposite question (registered but absent), which catches an outage that takes
 * down every tenant at once — loud, and already covered. This one catches a
 * per-project silent death, which is what actually shipped.
 */
export async function unregisteredSchemas(): Promise<string[]> {
  const listRows = await prisma.$queryRawUnsafe<Array<{ list: string | null }>>(
    `SELECT public.backenly_pgrst_current_schemas() AS list`,
  )
  const registered = new Set((listRows[0]?.list ?? '').split(',').filter(Boolean))

  const existing = await prisma.$queryRawUnsafe<Array<{ schema_name: string }>>(
    `SELECT schema_name FROM information_schema.schemata
      WHERE schema_name LIKE 'workspace\\_%'`,
  )

  return existing.map(e => e.schema_name).filter(s => !registered.has(s))
}

/**
 * Schemas that ARE registered but whose project no longer exists.
 *
 * ── The third state ─────────────────────────────────────────────────────────
 *
 * Two states were already covered: registered-but-absent (wedges the schema
 * cache for every tenant — loud, has a probe and an event trigger) and
 * exists-but-unregistered (per-project silent death — the one that shipped).
 *
 * This is the third, and it was invisible to both. The schema exists, so the
 * dangling probe is satisfied. It is registered, so the unregistered probe is
 * satisfied. But the `Project` row is gone, which means PostgREST is serving a
 * deleted project's schema.
 *
 * Found on production: `workspace_ce18214a` — deleted project, still in the
 * exposed list, still holding 10 end-user records with their password hashes.
 * Not reachable in practice (a deleted project's API keys cascade-delete, so
 * nothing can authenticate for it, and `users` is revoked from the client roles
 * anyway) — but "unreachable because of a chain of other facts" is not the same
 * as "not exposed", and it was in the list that the PGRST106 error used to leak.
 *
 * Unregistering is non-destructive and fully reversible: it removes the schema
 * from PostgREST's exposed list and touches no row. The DATA question — a
 * deleted project's users retained indefinitely — is separate, destructive, and
 * deliberately left to a human.
 */
export async function registeredOrphans(): Promise<
  Array<{ schema: string; projectId: string; tables: string[]; rows: number }>
> {
  const listRows = await prisma.$queryRawUnsafe<Array<{ list: string | null }>>(
    `SELECT public.backenly_pgrst_current_schemas() AS list`,
  )
  const registered = (listRows[0]?.list ?? '').split(',').filter(Boolean)
  if (registered.length === 0) return []

  const ids = registered.map(s => s.replace(/^workspace_/, ''))
  const live = new Set(
    (await prisma.project.findMany({ where: { id: { in: ids } }, select: { id: true } })).map(p => p.id),
  )

  const out: Array<{ schema: string; projectId: string; tables: string[]; rows: number }> = []
  for (const schema of registered) {
    const projectId = schema.replace(/^workspace_/, '')
    if (live.has(projectId)) continue

    // Report how much data is being retained. "An empty shell" and "ten
    // people's credentials" warrant very different urgency, and an operator
    // deciding whether to drop needs to know which one this is.
    const tables = await prisma.$queryRawUnsafe<Array<{ table_name: string }>>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = $1 AND table_type = 'BASE TABLE'`,
      schema,
    )
    let rows = 0
    for (const t of tables) {
      const r = await prisma
        .$queryRawUnsafe<Array<{ n: number }>>(
          `SELECT count(*)::int AS n FROM "${schema}"."${t.table_name}"`,
        )
        .catch(() => [{ n: 0 }])
      rows += r[0]?.n ?? 0
    }
    out.push({ schema, projectId, tables: tables.map(t => t.table_name), rows })
  }
  return out
}

/**
 * Remove a schema from PostgREST's exposed list. Non-destructive — no row is
 * read or written, and re-registering restores it exactly.
 */
export async function unregisterSchema(schema: string): Promise<void> {
  await prisma.$executeRawUnsafe(`SELECT public.backenly_pgrst_unregister_schema($1)`, schema)
  recentlyRegistered.delete(schema)
}

/**
 * Register every workspace schema that is missing one AND belongs to a live
 * project.
 *
 * ── Why orphans are skipped rather than registered ──────────────────────────
 *
 * Production carries workspace schemas whose `Project` row is gone — projects
 * deleted without their schema being dropped. Registering one would publish a
 * deleted project's tables through the data plane. Nothing could reach them
 * today (a deleted project has no API keys, and the gateway derives the schema
 * from an authenticated projectId), but "currently unreachable" is a much weaker
 * property than "not exposed", and this function exists precisely because
 * something that should have been exposed silently was not. Being wrong in the
 * other direction is worse.
 *
 * They are reported instead: orphaned schemas are a real cleanup task, and one
 * that should be a deliberate DROP rather than a side effect of a repair run.
 *
 * Per-schema failures are collected rather than thrown — one project with a
 * broken schema must not stop the rest from being repaired.
 */
export async function reconcileAllSchemas(): Promise<{
  checked: number
  repaired: string[]
  failed: Array<{ schema: string; error: string }>
  orphaned: string[]
}> {
  const missing = await unregisteredSchemas()
  const repaired: string[] = []
  const failed: Array<{ schema: string; error: string }> = []
  const orphaned: string[] = []

  const ids = missing.map(s => s.replace(/^workspace_/, ''))
  const live = new Set(
    ids.length
      ? (await prisma.project.findMany({ where: { id: { in: ids } }, select: { id: true } }))
          .map(p => p.id)
      : [],
  )

  for (const schema of missing) {
    if (!live.has(schema.replace(/^workspace_/, ''))) {
      orphaned.push(schema)
      continue
    }
    try {
      await prisma.$executeRawUnsafe(`SELECT public.backenly_pgrst_register_schema($1)`, schema)
      recentlyRegistered.set(schema, Date.now() + REGISTER_TTL_MS)
      repaired.push(schema)
    } catch (err) {
      failed.push({ schema, error: err instanceof Error ? err.message : String(err) })
    }
  }

  return { checked: missing.length, repaired, failed, orphaned }
}

/** Test seam. */
export function clearRegistrationCache(): void {
  recentlyRegistered.clear()
  inFlight.clear()
}
