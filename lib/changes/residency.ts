/**
 * What a change record may quote, for a project kept outside the home region.
 *
 * The change ledger lives on the platform database, in the home region. For a
 * project kept in another region, the platform's records of its work keep the
 * names, kinds, counts and ids of what was done, never the text the work
 * carried (lib/data-plane/residency.ts, founders 2026-10-16):
 *
 *   kept      what the change did to each object (the footprint), the
 *             catalog before and after it as structure (names, kinds, types,
 *             oids, column numbers, flags, references), counts and checksums,
 *             the outcome of each check, who and when
 *   withheld  the SQL that ran (a migration's statements can carry values),
 *             each step's free-text summary, the request as written, any
 *             error message (PostgreSQL fills those with the offending values),
 *             and every definition in the catalog: a function's body, a
 *             view's query, a CHECK, policy, default or generation expression,
 *             an index's or trigger's statement, a table's comment and an enum's
 *             labels (founders, 2026-10-19)
 *
 * The definitions are kept in the region, in its regional_bodies under the
 * change's id (CatalogBody), and this record keeps a keyed digest of each in
 * its place. The key is kept with the definitions, so a digest neither carries
 * the text nor lets anyone holding only this record test a guess against it,
 * which a plain hash of a short expression would. A restore reads the
 * definitions from the region and uses them only when every one of them
 * digests to what this record holds (definitionsFromRegion).
 *
 * The data a change kept is never on a platform row at all: it is in the
 * change's vault, a schema in the project's own database, in its region.
 */

import { createHmac, randomBytes } from 'crypto'
import { NOT_QUOTED, quotedError, quotesKeptHere } from '@/lib/data-plane/residency'
import { regionalBodiesFor } from '@/lib/data-plane/regional-bodies'
import type { CatalogSnapshot, TableState } from './catalog'
import { KEPT_IN_REGION } from './digest'
import { canonicalJson } from './integrity'
import type { ChangeStep } from './types'
import type { ChangeVerification } from './verify'

export { NOT_QUOTED, quotesKeptHere }

/** An error or reason as the record may keep it. */
export function keptText(text: string, quote: boolean): string {
  return quotedError(text, quote)
}

/** Steps as the record may keep them: what ran and whether it took effect. */
export function keptSteps(steps: ChangeStep[] | null | undefined, quote: boolean): ChangeStep[] | null {
  if (!steps) return null
  if (quote) return steps
  return steps.map((s) => ({ statement: NOT_QUOTED, ...(s.tool ? { tool: s.tool } : {}), ok: s.ok }))
}

/**
 * Checks as the record may keep them. A check Backenly could not run says why
 * in the database's own words, so for a project kept in another region that
 * detail is withheld; every other detail names objects, never values.
 */
export function keptVerification(v: ChangeVerification, quote: boolean): ChangeVerification {
  if (quote) return v
  return { ...v, checks: v.checks.map((c) => (c.outcome === 'inconclusive' ? { ...c, detail: NOT_QUOTED } : c)) }
}

// ── Definitions kept in the region ───────────────────────────────────────────

/** A new key for one change's digests. */
export function newCatalogKey(): string {
  return randomBytes(32).toString('base64')
}

/**
 * The catalog as the record of a change outside the home region keeps it:
 * every name, kind, type, oid, column number, flag, role, grant and reference
 * as it is, and each definition replaced by its digest under `key`. Equal
 * definitions digest equal under one key, so two catalogs compared this way
 * differ exactly where the catalogs themselves do.
 */
export function catalogStructure<T extends CatalogSnapshot>(snapshot: T, key: string): T {
  const secret = Buffer.from(key, 'base64')
  const digest = (text: string) => `${KEPT_IN_REGION}${createHmac('sha256', secret).update(text).digest('hex').slice(0, 32)}`
  const maybe = (text: string | null) => (text === null || text === undefined ? text : digest(text))

  const tables: Record<string, TableState> = {}
  for (const [name, t] of Object.entries(snapshot.tables)) {
    tables[name] = {
      ...t,
      columns: t.columns.map((c) => ({ ...c, default: maybe(c.default), generated: maybe(c.generated) })),
      constraints: t.constraints.map((c) => ({ ...c, definition: digest(c.definition) })),
      indexes: t.indexes.map((i) => ({ ...i, definition: digest(i.definition) })),
      policies: t.policies.map((p) => ({ ...p, using: maybe(p.using), check: maybe(p.check) })),
      triggers: t.triggers.map((g) => ({ ...g, definition: digest(g.definition) })),
      comment: maybe(t.comment),
    }
  }
  const objects = snapshot.objects
    ? Object.fromEntries(Object.entries(snapshot.objects).map(([id, o]) => [id, { ...o, definition: digest(o.definition) }]))
    : undefined
  return { ...snapshot, tables, ...(objects ? { objects } : {}) }
}

/**
 * What the region keeps for one change, in regional_bodies under the kind
 * 'change_catalog' and the change's id. Written before the record that
 * digests it, each time, so the record never names definitions the region
 * does not hold.
 */
export interface CatalogBody {
  /** The key this record's digests were made with. */
  key: string
  /** The whole catalog as the change found it, while the change is open. */
  opened?: CatalogSnapshot
  /** As the change closed: its checkpoint and the state it left, trimmed to what changed. */
  checkpoint?: CatalogSnapshot
  resultState?: CatalogSnapshot
}

export async function keepCatalogInRegion(projectId: string, changeId: string, body: CatalogBody): Promise<void> {
  await (await regionalBodiesFor(projectId)).set('change_catalog', changeId, { payload: body })
}

export async function forgetCatalogInRegion(projectId: string, changeId: string): Promise<void> {
  await (await regionalBodiesFor(projectId)).remove('change_catalog', [changeId])
}

/** The record's own JSON without one key, for comparing its structure. */
function without(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([k]) => k !== key))
}

/**
 * The definitions a change outside the home region keeps there, checked
 * against its record: under the key kept with them, every definition must
 * digest to what the record holds, and everything else must match it exactly.
 * A change that closed was trimmed to what it touched, so its checkpoint and
 * result state are what is checked; one that never closed is checked against
 * the whole catalog it opened with. Null when the region holds nothing for the
 * change or what it holds does not match: the restore point is then not
 * trusted, and nothing is restored from it.
 */
export async function definitionsFromRegion(
  projectId: string,
  row: { id: string; checkpoint: unknown; resultState: unknown },
): Promise<{ checkpoint: CatalogSnapshot; resultState: CatalogSnapshot | null; key: string } | null> {
  const body = (await (await regionalBodiesFor(projectId)).get('change_catalog', row.id))?.payload as CatalogBody | null | undefined
  if (!body?.key) return null

  const closed = row.resultState !== null && row.resultState !== undefined
  const checkpoint = closed ? body.checkpoint : body.opened ?? body.checkpoint
  const resultState = closed ? body.resultState ?? null : null
  if (!checkpoint || (closed && !resultState)) return null

  const recorded = without((row.checkpoint as { database?: unknown } | null)?.database, 'platform')
  if (canonicalJson(catalogStructure(checkpoint, body.key)) !== canonicalJson(recorded)) return null
  if (closed && canonicalJson(catalogStructure(resultState!, body.key)) !== canonicalJson(without(row.resultState, 'data'))) return null
  return { checkpoint, resultState, key: body.key }
}
