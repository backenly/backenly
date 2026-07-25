/**
 * A DECLARED tool argument must survive every hop to the executor.
 *
 * ── The bug class this exists to kill ────────────────────────────────────────
 *
 * Three of the worst defects reported from a live MCP session were the same bug
 * wearing different clothes: a field was declared in the tool schema, accepted
 * from the agent, and then silently dropped between layers. Both sides
 * type-checked. Nothing failed. The tool reported success.
 *
 *   #4  `create_index` declared `unique`. The dispatch mapper did not forward it,
 *       so `CREATE UNIQUE INDEX ON profiles (user_id)` produced a NON-unique
 *       index and nothing stopped duplicate profiles per user.
 *   #5  The same mapper forwarded `columns`, but the executor read `columns[0]`.
 *       Two columns became one, so a composite unique index over
 *       `(user_a, user_b)` became a plain index on `user_a`.
 *   #2  The migration parser and the brain mapper both send a CHECK predicate as
 *       `expression`. `executeAddConstraint` read `constraintDefinition`, which
 *       was therefore always undefined, and fell through to a hardcoded
 *       `CHECK ("col" IS NOT NULL)`. The author's value domain was replaced by a
 *       different constraint entirely — and reported as applied.
 *
 * A schema-shape test cannot catch these; the shapes were right. What was wrong
 * was the WIRING. So this drives each mapper with a unique sentinel per declared
 * property and asserts every sentinel comes out the other side.
 */

import { BRAIN_TOOLS, TOOL_TO_ACTION } from '@/lib/ai/brain/tools'

/** Declared property names for a tool, from its own JSON Schema. */
function declaredProps(toolName: string): string[] {
  const tool = BRAIN_TOOLS.find((t) => t.function?.name === toolName)
  if (!tool) throw new Error(`No such brain tool: ${toolName}`)
  const params = (tool.function?.parameters ?? {}) as { properties?: Record<string, unknown> }
  return Object.keys(params.properties ?? {})
}

/** A distinguishable value for each declared property, typed to match its schema. */
function sentinelArgs(toolName: string): Record<string, unknown> {
  const tool = BRAIN_TOOLS.find((t) => t.function?.name === toolName)!
  const params = (tool.function?.parameters ?? {}) as {
    properties?: Record<string, { type?: string; enum?: unknown[]; items?: { type?: string } }>
  }
  const out: Record<string, unknown> = {}
  for (const [key, spec] of Object.entries(params.properties ?? {})) {
    if (spec?.enum?.length) { out[key] = spec.enum[0]; continue }
    switch (spec?.type) {
      case 'boolean': out[key] = true; break
      case 'number':
      case 'integer': out[key] = 4242; break
      case 'array': out[key] = [`__${key}_a__`, `__${key}_b__`]; break
      // A distinctive STRING leaf, not `true`. Comparing object sentinels by
      // reference would report every object-typed field as dropped even when the
      // mapper forwards it, and `true` is too common to distinguish.
      case 'object': out[key] = { probe: `__${key}_leaf__` }; break
      default: out[key] = `__${key}__`
    }
  }
  return out
}

/** Every primitive value reachable in a params object, flattened. */
function flatten(value: unknown, acc: unknown[] = []): unknown[] {
  if (Array.isArray(value)) { for (const v of value) flatten(v, acc); return acc }
  if (value && typeof value === 'object') {
    for (const v of Object.values(value)) flatten(v, acc)
    return acc
  }
  acc.push(value)
  return acc
}

/**
 * Tools whose mapper deliberately TRANSFORMS a declared field rather than passing
 * it through, so the sentinel legitimately does not appear verbatim.
 *
 * Each entry must name the reason. This list is the only escape from the
 * invariant, so an unexplained addition to it is the bug re-entering.
 */
const TRANSFORMS: Record<string, Record<string, string>> = {
  add_rls: {
    // Brain-side policy names are MAPPED onto executor template names
    // (owner_read_write → own_rows, participants → party_rows). The value is
    // meant to change; that translation is the point of the field.
    policy: 'translated to the executor template vocabulary',
  },
  create_trigger: {
    on: 'folded into a generated trigger name and the AppTrigger event field',
    kind: 'selects the actionType and the field mappings',
    tableName: 'becomes sourceTable and part of the generated name',
  },
  generate_function: {
    trigger: 'selects the function shape (http vs event-driven)',
    // The two branches take disjoint fields, and that is correct: `method` is
    // meaningless for an event-driven function and `table` is meaningless for an
    // HTTP one. Verified against the mapper — the event branch does forward
    // `table` as `triggerTable`, and the http branch does forward `method`.
    table: 'only forwarded on the event branch, as triggerTable',
    method: 'only forwarded on the http branch',
  },
}

describe('declared tool arguments reach the executor', () => {
  const mapped = Object.keys(TOOL_TO_ACTION).filter((name) =>
    BRAIN_TOOLS.some((t) => t.function?.name === name),
  )

  it('covers a meaningful share of the mutation surface', () => {
    // Guards the test itself: if the mapper table is renamed or the export
    // breaks, this fails loudly instead of the suite passing over zero tools.
    expect(mapped.length).toBeGreaterThan(15)
  })

  for (const toolName of mapped) {
    it(`${toolName} forwards every declared property`, () => {
      const args = sentinelArgs(toolName)
      const action = TOOL_TO_ACTION[toolName](args)
      const present = new Set(flatten(action.params).map((v) => String(v)))

      const dropped: string[] = []
      for (const key of declaredProps(toolName)) {
        if (TRANSFORMS[toolName]?.[key]) continue
        // Compare LEAF values, so an object or array sentinel is checked by what
        // it contains rather than by identity.
        const leaves = flatten(args[key])
        const arrived = leaves.every((v) => present.has(String(v)))
        if (!arrived) dropped.push(key)
      }

      expect({ tool: toolName, dropped }).toEqual({ tool: toolName, dropped: [] })
    })
  }
})

describe('the specific fields whose loss was reported', () => {
  it('#4 create_index forwards unique', () => {
    const params = TOOL_TO_ACTION.create_index({
      tableName: 'profiles', columns: ['user_id'], unique: true,
    }).params as Record<string, unknown>
    expect(params.unique).toBe(true)
  })

  it('#5 create_index forwards EVERY column, not just the first', () => {
    const params = TOOL_TO_ACTION.create_index({
      tableName: 'conversations', columns: ['user_a', 'user_b'], unique: true,
    }).params as Record<string, unknown>
    expect(params.columns).toEqual(['user_a', 'user_b'])
  })

  it('#2 add_constraint forwards the CHECK predicate as `expression`', () => {
    const params = TOOL_TO_ACTION.add_constraint({
      tableName: 'connections',
      columnName: 'status',
      constraintType: 'check',
      expression: "status IN ('pending','accepted','declined')",
    }).params as Record<string, unknown>
    // The executor reads `expression`. When this was dropped, the value domain
    // was replaced by `CHECK (status IS NOT NULL)` and reported as applied.
    expect(params.expression).toBe("status IN ('pending','accepted','declined')")
  })

  it('#2 add_constraint forwards an explicit constraintName', () => {
    // Without this the name defaults to one derived from the column alone, which
    // collides with every other constraint on that column — and the collision was
    // then swallowed as "✅ Constraint already exists".
    const params = TOOL_TO_ACTION.add_constraint({
      tableName: 'connections',
      constraintType: 'check',
      expression: 'requester_id <> addressee_id',
      columns: ['requester_id', 'addressee_id'],
      constraintName: 'connections_no_self',
    }).params as Record<string, unknown>
    expect(params.constraintName).toBe('connections_no_self')
    expect(params.columns).toEqual(['requester_id', 'addressee_id'])
  })

  it('#3 add_rls carries a custom predicate through instead of discarding it', () => {
    const params = TOOL_TO_ACTION.add_rls({
      tableName: 'profiles',
      policy: 'custom',
      using: "is_public OR user_id::text = backenly_jwt_claim('sub')",
    }).params as Record<string, unknown>
    expect(params.template).toBe('custom')
    expect(params.using).toBe("is_public OR user_id::text = backenly_jwt_claim('sub')")
  })

  it('#3 add_rls does NOT silently rewrite an unrecognised policy to auto', () => {
    // Collapsing an unknown name to `auto` is what made three requests to replace
    // a policy report success while changing nothing. The name is passed through
    // so the executor refuses it and lists the real templates.
    const params = TOOL_TO_ACTION.add_rls({
      tableName: 'messages', policy: 'participant_of_conversation',
    }).params as Record<string, unknown>
    expect(params.template).toBe('participant_of_conversation')
  })

  it('#3 add_rls still resolves an OMITTED policy to auto', () => {
    // Omission genuinely means "you decide" and must keep working — the fix
    // distinguishes "unspecified" from "unrecognised", it does not remove `auto`.
    const params = TOOL_TO_ACTION.add_rls({ tableName: 'posts' }).params as Record<string, unknown>
    expect(params.template).toBe('auto')
  })

  it('#12 add_rls forwards partyColumns for a two-party table', () => {
    const params = TOOL_TO_ACTION.add_rls({
      tableName: 'connections',
      policy: 'participants',
      partyColumns: ['requester_id', 'addressee_id'],
    }).params as Record<string, unknown>
    expect(params.template).toBe('party_rows')
    expect(params.partyColumns).toEqual(['requester_id', 'addressee_id'])
  })
})
