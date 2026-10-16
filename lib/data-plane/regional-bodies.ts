/**
 * A REGIONAL PROJECT'S CUSTOMER DATA STAYS IN ITS REGION
 * ======================================================
 * Some platform rows record a project's customer data:
 *
 *   webhook, trigger    a delivery's payload (the row that fired it), what the
 *                       receiver answered, and the full failure text
 *   function_run        what a function run logged, and the error it raised
 *   function_error      a function's last error
 *   conversation_message  a message to or from the agent, which can quote rows
 *                       and end users' emails
 *   backfill_cursor     where a maintenance backfill's next batch starts: the
 *                       last primary key it scanned, which for a natural key is
 *                       a customer's own value (an email, a slug)
 *   storage_file        a stored file's name and original name, often an end
 *                       user's own words (lib/storage/file-names.ts)
 *
 * For a project in the home region all of it stays on the platform rows, as
 * it always has. For a project in another region it never leaves that region
 * (founders, 2026-10-16: a region opens only once its customers' data stays in
 * it). The platform row then keeps only what the platform needs to schedule,
 * list, retry and alert: ids, status, HTTP status, attempts, counts and times.
 * The data is kept in the region's own database, in public.regional_bodies
 * (scripts/sql/regional-bodies.sql, installed by the region's database
 * procedure), under the row's kind and id: a log body for
 * REGIONAL_BODY_RETENTION_DAYS after its last change, a conversation's words
 * for as long as the messages are kept (PRUNED_KINDS).
 *
 * A body is written BEFORE its platform row, under the id the row then takes,
 * so a row never exists without its body. A log body whose row was never
 * written is pruned with the rest.
 *
 * A region whose database cannot be reached is an error, never a fallback: a
 * body is not written to the home database instead, and work that needs a
 * body it cannot read waits for a later attempt.
 */

import { regionRawClient, projectRegion } from '@/lib/data-plane/regional'
import { HOME_REGION, type CloudRegionId } from '@/lib/regions'

export type BodyKind =
  | 'webhook'
  | 'trigger'
  | 'function_run'
  | 'function_error'
  | 'conversation_message'
  | 'backfill_cursor'
  | 'storage_file'

/** How long a region keeps a log body (PRUNED_KINDS) after its last change. */
export const REGIONAL_BODY_RETENTION_DAYS = 30

/**
 * The kinds kept REGIONAL_BODY_RETENTION_DAYS: logs of work done. A
 * conversation's words are not a log: the agent reads them back, and a home
 * project keeps them as long as the project. A regional project's are kept the
 * same way, until the messages or the project are deleted. A backfill's cursor
 * is needed only while its chain of batches runs, minutes or hours. A file's
 * names last as long as its row.
 */
const PRUNED_KINDS: BodyKind[] = ['webhook', 'trigger', 'function_run', 'function_error', 'backfill_cursor']

export interface Body {
  payload: unknown
  responseBody: string | null
  error: string | null
}

/** The fields a write sets; a field left undefined is kept as it was. */
export type BodyFields = Partial<Body>

export interface RegionalBodies {
  /** The region the bodies are held in, or null when they stay on the platform row. */
  readonly region: CloudRegionId | null
  /** Write a body, creating it or changing the fields given. */
  set(kind: BodyKind, id: string, fields: BodyFields): Promise<void>
  get(kind: BodyKind, id: string): Promise<Body | null>
  getMany(kind: BodyKind, ids: string[]): Promise<Map<string, Body>>
  /** Remove bodies whose platform rows are being removed; every one of a kind when ids is omitted. */
  remove(kind: BodyKind, ids?: string[]): Promise<void>
  /**
   * The ids of a kind's bodies whose payload `field` contains `term` (any case)
   * or starts with it (exact case): a search the platform row can no longer
   * answer, because what it searched is kept here.
   */
  idsMatching(kind: BodyKind, field: string, term: string, how: 'contains' | 'starts'): Promise<string[]>
}

/** A home project's bodies: on the platform row, so nothing is kept elsewhere. */
export const BODIES_ON_THE_ROW: RegionalBodies = {
  region: null,
  set: async () => {},
  get: async () => null,
  getMany: async () => new Map(),
  remove: async () => {},
  idsMatching: async () => [],
}

/** Where a project's bodies are kept. */
export async function regionalBodiesFor(projectId: string): Promise<RegionalBodies> {
  const region = await projectRegion(projectId)
  return region === HOME_REGION ? BODIES_ON_THE_ROW : bodiesIn(region, projectId)
}

interface BodyRow extends Body {
  id: string
}

function bodiesIn(region: CloudRegionId, projectId: string): RegionalBodies {
  // Resolved on every call, so a region whose connection goes away is refused
  // rather than served from a client made earlier (lib/data-plane/regional.ts).
  const db = () => regionRawClient(region, projectId)
  const json = (value: unknown) => (value === undefined ? null : JSON.stringify(value))

  return {
    region,

    async set(kind, id, fields) {
      const setPayload = fields.payload !== undefined
      const setReply = fields.responseBody !== undefined
      const setError = fields.error !== undefined
      await db().$executeRaw`
        INSERT INTO public.regional_bodies ("kind", "id", "projectId", "payload", "responseBody", "error")
        VALUES (${kind}, ${id}, ${projectId}, ${json(fields.payload)}::jsonb, ${fields.responseBody ?? null}, ${fields.error ?? null})
        ON CONFLICT ("kind", "id") DO UPDATE SET
          "payload"      = CASE WHEN ${setPayload} THEN EXCLUDED."payload" ELSE regional_bodies."payload" END,
          "responseBody" = CASE WHEN ${setReply} THEN EXCLUDED."responseBody" ELSE regional_bodies."responseBody" END,
          "error"        = CASE WHEN ${setError} THEN EXCLUDED."error" ELSE regional_bodies."error" END,
          "updatedAt"    = now()
        WHERE regional_bodies."projectId" = ${projectId}`
    },

    async get(kind, id) {
      const rows = await db().$queryRaw<BodyRow[]>`
        SELECT "id", "payload", "responseBody", "error" FROM public.regional_bodies
        WHERE "kind" = ${kind} AND "id" = ${id} AND "projectId" = ${projectId}`
      const row = rows[0]
      return row ? { payload: row.payload, responseBody: row.responseBody, error: row.error } : null
    },

    async getMany(kind, ids) {
      if (ids.length === 0) return new Map()
      const rows = await db().$queryRaw<BodyRow[]>`
        SELECT "id", "payload", "responseBody", "error" FROM public.regional_bodies
        WHERE "kind" = ${kind} AND "projectId" = ${projectId} AND "id" = ANY(${ids}::text[])`
      return new Map(rows.map((r) => [r.id, { payload: r.payload, responseBody: r.responseBody, error: r.error }]))
    },

    async remove(kind, ids) {
      if (ids === undefined) {
        await db().$executeRaw`DELETE FROM public.regional_bodies WHERE "kind" = ${kind} AND "projectId" = ${projectId}`
      } else if (ids.length > 0) {
        await db().$executeRaw`
          DELETE FROM public.regional_bodies WHERE "kind" = ${kind} AND "projectId" = ${projectId} AND "id" = ANY(${ids}::text[])`
      }
    },

    async idsMatching(kind, field, term, how) {
      const literal = term.replace(/[\\%_]/g, (c) => `\\${c}`)
      const rows =
        how === 'starts'
          ? await db().$queryRaw<{ id: string }[]>`
              SELECT "id" FROM public.regional_bodies
              WHERE "kind" = ${kind} AND "projectId" = ${projectId} AND "payload"->>${field} LIKE ${`${literal}%`}`
          : await db().$queryRaw<{ id: string }[]>`
              SELECT "id" FROM public.regional_bodies
              WHERE "kind" = ${kind} AND "projectId" = ${projectId} AND "payload"->>${field} ILIKE ${`%${literal}%`}`
      return rows.map((r) => r.id)
    },
  }
}

/**
 * Delete the region's log bodies past their retention; a conversation's words
 * stay (PRUNED_KINDS). Run by the region's own scheduler
 * (lib/services/cron-runner.ts). The home region keeps its data on the
 * platform rows, under those tables' own retention, so there is nothing to
 * prune here for it.
 */
export async function pruneRegionalBodies(region: CloudRegionId, now: Date = new Date()): Promise<number> {
  if (region === HOME_REGION) return 0
  const cutoff = new Date(now.getTime() - REGIONAL_BODY_RETENTION_DAYS * 24 * 60 * 60 * 1000)
  return regionRawClient(region).$executeRaw`
    DELETE FROM public.regional_bodies WHERE "updatedAt" < ${cutoff} AND "kind" = ANY(${PRUNED_KINDS}::text[])`
}

/**
 * What a regional delivery failure may say outside the region: its HTTP
 * status, never the receiver's words, which can quote the row it was sent.
 * The full text is kept with the body, in the region.
 */
export function failureWithoutReply(error: string | undefined, statusCode: number | undefined): string | null {
  if (error === undefined) return null
  if (statusCode !== undefined) return `Webhook returned ${statusCode}`
  const reply = /^Webhook returned (\d{3}):/.exec(error)
  return reply ? `Webhook returned ${reply[1]}` : error
}
