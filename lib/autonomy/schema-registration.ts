/**
 * The probe that did not exist — a project whose schema PostgREST was never told
 * about.
 *
 * ── Why this is a separate probe from the dangling one ──────────────────────
 *
 * `danglingRegistrations` already asks the opposite question: is a REGISTERED
 * schema missing from the database? That fault takes down every tenant at once
 * (PostgREST builds one schema cache over the whole list, so a single absent
 * entry fails the rebuild and every project gets 503). It is loud, it is
 * instance-wide, and it has a probe, a remedy and an event trigger.
 *
 * Nothing asked the inverse: is an EXISTING schema missing from the registry?
 * That fault is per-project and silent. PostgREST answers PGRST106 for every
 * table in that one schema, `/auth/*` and `/fn/*` keep working because they run
 * on the Express runtime, and the project looks alive from every angle the
 * platform was measuring. Metrics show traffic. Health is green. The tables are
 * all there in `read_backend_state`.
 *
 * It shipped that way. `backenly_pgrst_register_schema()` was called by the
 * cutover script and by no application code at all, so EVERY project created
 * after the PostgREST cutover was born with a dead data plane. Five of nine
 * schemas on production were unregistered when this was finally found — and it
 * was found by a customer, who rebuilt their entire data layer on HTTP
 * functions to work around it and then wrote up the symptom.
 *
 * The registration itself is now enforced in three places (every creation path,
 * a CREATE SCHEMA event trigger, and a runtime self-heal on PGRST106). This
 * probe exists because all three of those are mechanisms that can fail, and the
 * thing that actually went wrong last time was not any single mechanism — it was
 * that nobody was asking the question.
 */

import { prisma } from '@/lib/db'
import type { RawFinding } from '@/lib/core/types'
import { workspaceSchemaName } from '@/lib/security/workspace-schema'

/**
 * Is this project's workspace schema absent from PostgREST's exposed list?
 *
 * No try/catch. A probe that returns [] when it could not run reports "healthy"
 * for a project it never examined, which is the same class of silence this
 * whole module exists to end.
 */
export async function detectUnregisteredSchema(projectId: string): Promise<RawFinding[]> {
  const schema = workspaceSchemaName(projectId)

  // The schema has to exist before its absence from the registry means anything
  // — a project that was never provisioned is a different (and correct) state.
  const exists = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
    `SELECT count(*)::bigint AS n FROM information_schema.schemata WHERE schema_name = $1`,
    schema,
  )
  if (Number(exists[0]?.n ?? 0) === 0) return []

  const rows = await prisma.$queryRawUnsafe<Array<{ list: string | null }>>(
    `SELECT public.backenly_pgrst_current_schemas() AS list`,
  )
  const registered = (rows[0]?.list ?? '').split(',').filter(Boolean)

  // Compared against the comma-delimited list rather than by substring, so
  // `workspace_abc` is not considered present merely because `workspace_abcdef`
  // is — the same care the SQL side takes.
  if (registered.includes(schema)) return []

  // How much is actually broken. A project with no tables has a dead plane too,
  // but nothing is reaching for it yet; one with tables is actively failing.
  const tables = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
    `SELECT count(*)::bigint AS n FROM information_schema.tables
      WHERE table_schema = $1 AND table_type = 'BASE TABLE' AND table_name NOT LIKE '\\_%'`,
    schema,
  )
  const tableCount = Number(tables[0]?.n ?? 0)

  return [
    {
      type: 'schema_not_registered',
      severity: 'critical',
      details: {
        reason:
          `This project's schema is not in PostgREST's exposed list, so every request to ` +
          `/db/* returns PGRST106 ("Invalid schema") — the entire REST data plane is dead ` +
          `for this project${tableCount > 0 ? `, across all ${tableCount} table(s)` : ''}. ` +
          `Authentication and functions are unaffected because they run on the Express ` +
          `runtime, which is why the project otherwise looks healthy.`,
        schema,
        tableCount,
        registeredCount: registered.length,
        remediation: `npx tsx scripts/repair-postgrest-registrations.ts --apply`,
      },
      // Auto-fixable, and safely so. Registration is idempotent, additive, and
      // restores the state a correctly-created project would already be in: it
      // grants the data-plane roles, re-revokes `users` and `_`-prefixed tables,
      // applies soft-delete parity and owner defaults, then appends to the list.
      // It cannot widen access beyond what a normal project has, and the
      // alternative is leaving a customer's backend down.
      autoFixable: true,
      fix: async () => {
        const { ensureSchemaRegistered } = await import('@/lib/postgrest/registration')
        const result = await ensureSchemaRegistered(projectId)
        // Throwing on failure is deliberate: `ensureSchemaRegistered` never
        // throws (a repair must not take down its caller), so a silent false
        // here would be recorded as a successful fix and the project would stay
        // down with a green ledger entry. The fix contract wants an exception.
        if (!result.registered) {
          throw new Error(`Could not register ${result.schema}: ${result.error ?? 'unknown error'}`)
        }
      },
    },
  ]
}
