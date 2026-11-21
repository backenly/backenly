/**
 * SCHEMA DRIFT EVENTS, READ WHERE THEY WERE CAPTURED
 * ==================================================
 * The DDL-capture event triggers (scripts/setup-direct-access.sql) record each
 * statement a direct-access role runs into public.schema_drift_events of the
 * database that ran it: the platform database for a project kept in the home
 * region's shared database, the region's database for one kept in another
 * region's, and the project's own database for a project that has one. The
 * table is the same everywhere (scripts/sql/schema-drift-events.sql is kept
 * identical to the Prisma model SchemaDriftEvent).
 *
 * This store is the one way the application reads and changes those events,
 * over raw SQL on whichever client reaches that database
 * (lib/data-plane/regional.ts projectDriftEvents, regionDriftEvents). It has
 * the operations the application uses and no others, and answers exactly as
 * the model's accessor did on the same rows
 * (tests/integration/project-database-resolution.spec.ts compares them).
 *
 * Its writes are bookkeeping, not part of a change to the project's schema:
 * they run outside any SQL capture (lib/execution/sql-recorder.ts), as the
 * model's typed writes were never captured.
 */

import { outsideSqlCapture } from '@/lib/execution/sql-recorder'

/** One captured statement, as the model SchemaDriftEvent has it. */
export interface DriftEvent {
  id: string
  /** Parsed from the schema name by the trigger; null when not a workspace schema. */
  projectId: string | null
  roleName: string
  commandTag: string
  objectType: string | null
  objectIdentity: string | null
  schemaName: string | null
  capturedAt: Date
  /** pending | adopted | ignored */
  status: string
  resolvedAt: Date | null
  findingId: string | null
}

/** Pending events of one project, or of none, and the oldest capture among them. */
export interface PendingGroup {
  projectId: string | null
  count: number
  oldestCapturedAt: Date | null
}

/** The raw methods the store needs: any Prisma client, or a project database's. */
export interface DriftEventSql {
  $queryRawUnsafe<T = unknown>(query: string, ...values: any[]): Promise<T>
  $executeRawUnsafe(query: string, ...values: any[]): Promise<number>
}

const TABLE = 'public.schema_drift_events'
const COLUMNS =
  '"id", "projectId", "roleName", "commandTag", "objectType", "objectIdentity", "schemaName", "capturedAt", "status", "resolvedAt", "findingId"'

/**
 * A time as the table stores it: TIMESTAMP(3) holding UTC, as Prisma writes
 * DateTime. Bound as text and read as UTC, so the session's time zone never
 * moves it.
 */
const at = (n: number) => `($${n}::timestamptz AT TIME ZONE 'UTC')`

/** Prisma returns a TIMESTAMP as a Date; a driver that returns text is read as UTC. */
function asDate(value: unknown): Date {
  if (value instanceof Date) return value
  const text = String(value)
  return new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(text) ? text : `${text.replace(' ', 'T')}Z`)
}

function asEvent(row: Record<string, unknown>): DriftEvent {
  return {
    id: row.id as string,
    projectId: (row.projectId as string | null) ?? null,
    roleName: row.roleName as string,
    commandTag: row.commandTag as string,
    objectType: (row.objectType as string | null) ?? null,
    objectIdentity: (row.objectIdentity as string | null) ?? null,
    schemaName: (row.schemaName as string | null) ?? null,
    capturedAt: asDate(row.capturedAt),
    status: row.status as string,
    resolvedAt: row.resolvedAt === null || row.resolvedAt === undefined ? null : asDate(row.resolvedAt),
    findingId: (row.findingId as string | null) ?? null,
  }
}

function limit(take: number | undefined): string {
  if (take === undefined) return ''
  if (!Number.isInteger(take) || take < 0) throw new Error(`take must be a whole number, not ${take}`)
  return ` LIMIT ${take}`
}

export class DriftEventStore {
  constructor(private readonly db: DriftEventSql) {}

  /** A project's pending events, oldest capture first. */
  async pending(projectId: string, { take }: { take?: number } = {}): Promise<DriftEvent[]> {
    const rows = await this.db.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT ${COLUMNS} FROM ${TABLE}
        WHERE "projectId" = $1 AND "status" = 'pending'
        ORDER BY "capturedAt" ASC, "id" ASC${limit(take)}`,
      projectId,
    )
    return rows.map(asEvent)
  }

  /** A project's events captured at or after `from` (and at or before `to`), latest first. */
  async capturedBetween(
    projectId: string,
    { from, to, take }: { from: Date; to?: Date; take?: number },
  ): Promise<DriftEvent[]> {
    const rows = await this.db.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT ${COLUMNS} FROM ${TABLE}
        WHERE "projectId" = $1 AND "capturedAt" >= ${at(2)}${to ? ` AND "capturedAt" <= ${at(3)}` : ''}
        ORDER BY "capturedAt" DESC, "id" DESC${limit(take)}`,
      projectId,
      from.toISOString(),
      ...(to ? [to.toISOString()] : []),
    )
    return rows.map(asEvent)
  }

  /** How many of a project's events are pending. */
  async countPending(projectId: string): Promise<number> {
    const [row] = await this.db.$queryRawUnsafe<Array<{ n: number }>>(
      `SELECT count(*)::int AS n FROM ${TABLE} WHERE "projectId" = $1 AND "status" = 'pending'`,
      projectId,
    )
    return Number(row?.n ?? 0)
  }

  /**
   * Mark these of a project's events adopted, those still pending only.
   * Returns how many were.
   */
  async adopt(projectId: string, ids: readonly string[], resolvedAt: Date = new Date()): Promise<number> {
    if (ids.length === 0) return 0
    return outsideSqlCapture(async () =>
      Number(
        await this.db.$executeRawUnsafe(
          `UPDATE ${TABLE} SET "status" = 'adopted', "resolvedAt" = ${at(3)}
            WHERE "projectId" = $1 AND "status" = 'pending' AND "id" = ANY($2::text[])`,
          projectId,
          [...ids],
          resolvedAt.toISOString(),
        ),
      ),
    )
  }

  /** Pending events grouped by the project they name, optionally only those captured before a time. */
  async pendingByProject({ capturedBefore }: { capturedBefore?: Date } = {}): Promise<PendingGroup[]> {
    const rows = await this.db.$queryRawUnsafe<Array<{ projectId: string | null; n: number; oldest: unknown }>>(
      `SELECT "projectId", count(*)::int AS n, min("capturedAt") AS oldest FROM ${TABLE}
        WHERE "status" = 'pending'${capturedBefore ? ` AND "capturedAt" < ${at(1)}` : ''}
        GROUP BY "projectId"`,
      ...(capturedBefore ? [capturedBefore.toISOString()] : []),
    )
    return rows.map((row) => ({
      projectId: row.projectId ?? null,
      count: Number(row.n),
      oldestCapturedAt: row.oldest === null || row.oldest === undefined ? null : asDate(row.oldest),
    }))
  }

  /** Delete adopted or ignored events resolved before `before`. Pending events stay. */
  async deleteResolvedBefore(before: Date): Promise<number> {
    return outsideSqlCapture(async () =>
      Number(
        await this.db.$executeRawUnsafe(
          `DELETE FROM ${TABLE} WHERE "status" IN ('adopted', 'ignored') AND "resolvedAt" < ${at(1)}`,
          before.toISOString(),
        ),
      ),
    )
  }

  /**
   * Delete pending events captured before `before` that name one of
   * `projectIds`, or no project at all when `unnamed`.
   */
  async deletePendingBefore(
    before: Date,
    { projectIds, unnamed }: { projectIds: readonly string[]; unnamed: boolean },
  ): Promise<number> {
    const matches = [
      ...(unnamed ? ['"projectId" IS NULL'] : []),
      ...(projectIds.length > 0 ? ['"projectId" = ANY($2::text[])'] : []),
    ]
    if (matches.length === 0) return 0
    return outsideSqlCapture(async () =>
      Number(
        await this.db.$executeRawUnsafe(
          `DELETE FROM ${TABLE}
            WHERE "status" = 'pending' AND "capturedAt" < ${at(1)} AND (${matches.join(' OR ')})`,
          before.toISOString(),
          ...(projectIds.length > 0 ? [[...projectIds]] : []),
        ),
      ),
    )
  }
}
