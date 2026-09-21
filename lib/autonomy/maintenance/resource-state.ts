/**
 * WHAT THIS STEP ACTUALLY TOUCHED, AS THE DATABASE SEES IT
 * =========================================================
 *
 * Rollback needs to answer one question before it undoes anything:
 *
 *     is the thing in front of me still the thing THIS execution created?
 *
 * Nothing in the ledger could answer that. `maintenance_step_executions` has
 * columns called `preconditionEvidence` and `postconditionEvidence`, and what
 * they hold is:
 *
 *     { declared: ['target column does not already exist'], ... }
 *
 * A sentence the planner wrote in advance. Not an observation. Same family as
 * every other defect this audit turned up — a field named for evidence holding
 * a description — and it is disqualifying here, because the one thing a stale
 * guard cannot be built from is a claim made before the work happened.
 *
 * `switch_readers` is the exception: it already records `previousCode` per
 * function, which is genuine captured state and is why its rollback was the
 * only one ever written.
 *
 * ── Why identity is not enough ─────────────────────────────────────────────
 *
 * `workspace_x.sessions.state` names a column. It does not distinguish the
 * column this ladder added from a different column somebody recreated under
 * the same name an hour later, and dropping the second because the ledger
 * remembers the first is how automatic recovery destroys somebody's work.
 *
 * So every observation carries the resource's SHAPE as well as its name, and
 * rollback proceeds only when the shape still matches what this execution
 * left behind.
 *
 * ── Catalog reads, deliberately ────────────────────────────────────────────
 *
 * Everything here reads `information_schema` or `pg_catalog`, which RLS does
 * not filter, so these correctly need no claim. The schema NAME still comes
 * from `resolveWorkspaceSchema` rather than being computed, because a project
 * whose stored schema differs from the default would otherwise be observed in
 * a schema that does not exist — which reads as "absent" and would make every
 * stale check pass by accident.
 */

import { createHash } from 'node:crypto'
import { prisma } from '@/lib/db'
import { queryWorkspace, resolveWorkspaceSchema } from '@/lib/services/workspace-pool'

const sha = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16)

/**
 * Exported so the executor hashes reader code the SAME way this module does.
 *
 * Two hashers would be two opinions about whether a reader changed, and the
 * one that drifts lenient is the one that lets a stale rollback through.
 */
export const hashCode = sha

// ── Identity: what a step operated on, in real identifiers ──────────────────

export type ResourceIdentity =
  | { kind: 'column'; table: string; column: string }
  | {
      kind: 'trigger'
      table: string
      trigger: string
      /**
       * Carried alongside the trigger name because `removeDualWrite` derives
       * the object name from it, and two derivations of the same name are two
       * chances to disagree about which trigger is being dropped.
       */
      targetColumn: string
    }
  /** Readers are platform rows, not catalog objects, so they are keyed by id. */
  | { kind: 'readers'; functionIds: string[] }

// ── Observation: the shape, as the database reports it right now ────────────

export type ResourceState =
  | { kind: 'column'; present: false }
  | {
      kind: 'column'
      present: true
      /** `udt_name`, not `data_type`: it tells uuid from text and an array from its element. */
      udtName: string
      isNullable: boolean
      columnDefault: string | null
      isGenerated: boolean
    }
  | { kind: 'trigger'; present: false }
  | {
      kind: 'trigger'
      present: true
      /** The function the trigger fires. A trigger repointed elsewhere is not ours. */
      functionName: string
      enabled: boolean
      /** Hash of the full CREATE TRIGGER text, so a redefinition is visible. */
      definitionHash: string
    }
  | {
      kind: 'readers'
      /** One entry per function, hashed so the row stays small. */
      entries: Array<{ id: string; codeHash: string; missing?: true }>
    }

/**
 * Read the resource as it is now.
 *
 * Absence is a legitimate observation and is reported as `present: false`.
 * Failure is NOT: it throws, because "I could not look" and "it is not there"
 * are the two answers a stale guard must never confuse, and confusing them
 * here would let rollback proceed against a resource it never actually saw.
 */
export async function observeResource(
  projectId: string,
  identity: ResourceIdentity,
): Promise<ResourceState> {
  if (identity.kind === 'readers') {
    const rows = await prisma.aiFunction.findMany({
      where: { id: { in: identity.functionIds } },
      select: { id: true, generatedCode: true },
    })
    const byId = new Map(rows.map(r => [r.id, r.generatedCode ?? '']))
    return {
      kind: 'readers',
      entries: identity.functionIds.map(id =>
        byId.has(id)
          ? { id, codeHash: sha(byId.get(id)!) }
          : { id, codeHash: '', missing: true as const },
      ),
    }
  }

  const schema = await resolveWorkspaceSchema(projectId)

  if (identity.kind === 'column') {
    const rows = await queryWorkspace<{
      udt_name: string
      is_nullable: string
      column_default: string | null
      is_generated: string
    }>(
      projectId,
      `SELECT udt_name, is_nullable, column_default, is_generated
         FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = $2 AND column_name = $3`,
      [schema, identity.table, identity.column],
    )
    const r = rows[0]
    if (!r) return { kind: 'column', present: false }
    return {
      kind: 'column',
      present: true,
      udtName: r.udt_name,
      isNullable: r.is_nullable === 'YES',
      columnDefault: r.column_default,
      isGenerated: r.is_generated !== 'NEVER',
    }
  }

  const rows = await queryWorkspace<{ fn: string; enabled: string; def: string }>(
    projectId,
    `SELECT p.proname AS fn,
            t.tgenabled::text AS enabled,
            pg_get_triggerdef(t.oid) AS def
       FROM pg_trigger t
       JOIN pg_class c   ON c.oid = t.tgrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_proc p    ON p.oid = t.tgfoid
      WHERE n.nspname = $1 AND c.relname = $2 AND t.tgname = $3 AND NOT t.tgisinternal`,
    [schema, identity.table, identity.trigger],
  )
  const r = rows[0]
  if (!r) return { kind: 'trigger', present: false }
  return {
    kind: 'trigger',
    present: true,
    functionName: r.fn,
    enabled: r.enabled !== 'D',
    definitionHash: sha(r.def),
  }
}

/**
 * Is the resource in exactly the state this execution left it in?
 *
 * Deliberately exact. A looser comparison — "the column still exists", "the
 * trigger is still called that" — is what lets rollback destroy a replacement
 * that happens to share a name.
 */
export function stateMatches(expected: ResourceState, actual: ResourceState): boolean {
  if (expected.kind !== actual.kind) return false

  if (expected.kind === 'column' && actual.kind === 'column') {
    if (expected.present !== actual.present) return false
    if (!expected.present || !actual.present) return true
    return (
      expected.udtName === actual.udtName &&
      expected.isNullable === actual.isNullable &&
      expected.columnDefault === actual.columnDefault &&
      expected.isGenerated === actual.isGenerated
    )
  }

  if (expected.kind === 'trigger' && actual.kind === 'trigger') {
    if (expected.present !== actual.present) return false
    if (!expected.present || !actual.present) return true
    return (
      expected.functionName === actual.functionName &&
      expected.enabled === actual.enabled &&
      expected.definitionHash === actual.definitionHash
    )
  }

  if (expected.kind === 'readers' && actual.kind === 'readers') {
    if (expected.entries.length !== actual.entries.length) return false
    const a = new Map(expected.entries.map(e => [e.id, e]))
    return actual.entries.every(e => {
      const x = a.get(e.id)
      return !!x && x.codeHash === e.codeHash && !!x.missing === !!e.missing
    })
  }

  return false
}

/**
 * What changed, in words an operator can act on.
 *
 * A refusal that says only "stale" sends somebody to read source. This names
 * the specific attribute that moved, because the usual cause is a person or
 * another process legitimately changing the same object — and they need to
 * recognise their own change in the message.
 */
export function describeDrift(expected: ResourceState, actual: ResourceState): string {
  if (expected.kind !== actual.kind) {
    return `expected a ${expected.kind}, found a ${actual.kind}`
  }

  if (expected.kind === 'column' && actual.kind === 'column') {
    if (expected.present && !actual.present) return 'the column is already gone'
    if (!expected.present && actual.present) return 'a column now exists where none was recorded'
    if (expected.present && actual.present) {
      const d: string[] = []
      if (expected.udtName !== actual.udtName) d.push(`type ${expected.udtName} -> ${actual.udtName}`)
      if (expected.isNullable !== actual.isNullable) d.push(`nullability changed`)
      if (expected.columnDefault !== actual.columnDefault) d.push(`default changed`)
      if (expected.isGenerated !== actual.isGenerated) d.push(`generated-ness changed`)
      return d.length > 0 ? `the column was altered (${d.join(', ')})` : 'no difference'
    }
  }

  if (expected.kind === 'trigger' && actual.kind === 'trigger') {
    if (expected.present && !actual.present) return 'the trigger is already gone'
    if (!expected.present && actual.present) return 'a trigger now exists where none was recorded'
    if (expected.present && actual.present) {
      if (expected.functionName !== actual.functionName) {
        return `the trigger now fires ${actual.functionName}, not ${expected.functionName}`
      }
      if (expected.definitionHash !== actual.definitionHash) return 'the trigger was redefined'
      if (expected.enabled !== actual.enabled) return 'the trigger was enabled or disabled'
      return 'no difference'
    }
  }

  if (expected.kind === 'readers' && actual.kind === 'readers') {
    const a = new Map(expected.entries.map(e => [e.id, e]))
    const moved = actual.entries.filter(e => {
      const x = a.get(e.id)
      return !x || x.codeHash !== e.codeHash || !!x.missing !== !!e.missing
    })
    if (moved.length === 0) return 'no difference'
    return `${moved.length} reader(s) changed since the switch: ${moved.map(m => m.id).join(', ')}`
  }

  return 'the resource is not in the recorded state'
}
