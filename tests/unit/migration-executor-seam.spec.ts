/**
 * The seam between the migration parser and the executor.
 *
 * ── Why a test here specifically ─────────────────────────────────────────────
 *
 * Defect #2 lived in NEITHER component. The parser emitted a correct action and
 * the executor ran correct SQL; they simply disagreed about the name of one field.
 * The parser sent the CHECK predicate as `expression`; `executeAddConstraint` read
 * `constraintDefinition`, found undefined, and synthesised
 * `CHECK ("col" IS NOT NULL)` instead. Both files type-checked. Both had tests.
 * Nothing exercised the join.
 *
 * So this walks a realistic migration all the way from SQL to the values that
 * reach the executor's own validator, asserting at each hop that what one layer
 * produced is what the next layer consumes.
 */

import { parseMigration } from '@/lib/mcp/migration-parser'
import { TOOL_TO_ACTION } from '@/lib/ai/brain/tools'
import { validateBooleanExpression } from '@/lib/db/sql-expression'

/** SQL → the params the executor actually receives. */
function toExecutorParams(sql: string) {
  return parseMigration(sql).map((action) => {
    const builder = TOOL_TO_ACTION[action.tool]
    if (!builder) throw new Error(`No dispatch mapper for ${action.tool}`)
    return { tool: action.tool, params: builder(action.args).params as Record<string, any> }
  })
}

describe('a real migration survives the whole path', () => {
  // The exact schema from the report that lost its constraints.
  const SQL = `
    CREATE TABLE connections (
      requester_id uuid NOT NULL REFERENCES users(id),
      addressee_id uuid NOT NULL REFERENCES users(id),
      status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','declined')),
      CONSTRAINT connections_no_self CHECK (requester_id <> addressee_id),
      UNIQUE (requester_id, addressee_id)
    );
    CREATE UNIQUE INDEX idx_conversations_pair ON conversations (user_a, user_b);
  `

  it('produces every action the SQL declared, and nothing silently vanishes', () => {
    const steps = toExecutorParams(SQL)
    expect(steps.map((s) => s.tool)).toEqual([
      'create_table',
      'create_index',    // UNIQUE (requester_id, addressee_id)
      'add_constraint',  // inline CHECK on status
      'add_constraint',  // table-level connections_no_self
      'create_index',    // the explicit CREATE UNIQUE INDEX
    ])
  })

  it('the CHECK predicate reaches the executor under the field it reads', () => {
    const checks = toExecutorParams(SQL).filter((s) => s.tool === 'add_constraint')
    for (const c of checks) {
      // `expression` is what executeAddConstraint reads. Undefined here is
      // defect #2 exactly.
      expect(typeof c.params.expression).toBe('string')
      expect(c.params.expression.length).toBeGreaterThan(0)
      expect(c.params.constraintType).toBe('check')
    }
    expect(checks[0].params.expression).toBe("status IN ('pending','accepted','declined')")
    expect(checks[1].params.expression).toBe('requester_id <> addressee_id')
  })

  it('every CHECK the parser accepts also passes the executor\'s validator', () => {
    // Two independent validations of the same string would eventually diverge, and
    // the divergence would show up as a migration that parses and then fails at
    // the executor for no reason the caller can see. They share one grammar.
    for (const step of toExecutorParams(SQL)) {
      if (step.tool !== 'add_constraint') continue
      const r = validateBooleanExpression(step.params.expression, { requireColumn: true })
      expect(r.kind).toBe('ok')
    }
  })

  it('the composite unique index keeps BOTH columns and its uniqueness', () => {
    const indexes = toExecutorParams(SQL).filter((s) => s.tool === 'create_index')
    const pair = indexes.find((i) => i.params.tableName === 'conversations')!
    expect(pair.params.columns).toEqual(['user_a', 'user_b'])
    expect(pair.params.unique).toBe(true)

    const fromConstraint = indexes.find((i) => i.params.tableName === 'connections')!
    expect(fromConstraint.params.columns).toEqual(['requester_id', 'addressee_id'])
    expect(fromConstraint.params.unique).toBe(true)
  })

  it('the multi-column CHECK arrives WITHOUT a bogus single columnName', () => {
    const noSelf = toExecutorParams(SQL)
      .filter((s) => s.tool === 'add_constraint')
      .find((s) => s.params.expression === 'requester_id <> addressee_id')!
    // Attaching a table-level constraint to one arbitrary column is how it would
    // look applied while constraining the wrong thing.
    expect(noSelf.params.columnName).toBeUndefined()
    expect(noSelf.params.columns).toEqual(['requester_id', 'addressee_id'])
  })

  it('the declared column shape is not traded against the extracted CHECK', () => {
    const create = toExecutorParams(SQL).find((s) => s.tool === 'create_table')!
    const status = (create.params.columns as any[]).find((c) => c.name === 'status')
    expect(status).toEqual({ name: 'status', type: 'text', nullable: false, default: "'pending'" })
  })

  it('array columns reach the executor as array types', () => {
    const steps = toExecutorParams('CREATE TABLE profiles (skills text[] NOT NULL, views integer)')
    const cols = steps[0].params.columns as any[]
    expect(cols.find((c) => c.name === 'skills').type).toBe('text[]')
  })

  it('NOT NULL becomes a column attribute, not a CHECK impersonating one', () => {
    const steps = toExecutorParams('ALTER TABLE posts ALTER COLUMN title SET NOT NULL')
    expect(steps[0].params.constraintType).toBe('not_null')
    // A `CHECK (title IS NOT NULL)` here is what littered tables with chk_* rows
    // and did not make the column NOT NULL in information_schema.
    expect(steps[0].params.expression).toBeUndefined()
  })
})
