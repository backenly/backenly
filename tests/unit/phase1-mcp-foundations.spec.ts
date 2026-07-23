/**
 * Phase 1's two core deliverables, neither of which had a test.
 *
 * These are not incidental helpers. `castTarget`/`coerceValue` are the fix for
 * the bug that made the founder's first MCP session fail — Prisma binds a
 * parameter with a type derived from the JS RUNTIME type, and PostgreSQL
 * refuses an implicit text→timestamp/numeric coercion in VALUES (SQLSTATE
 * 42804), so a perfectly valid ISO timestamp could not be written at all.
 *
 * `explainDbError` is what turned the resulting blind failures into something a
 * caller could act on. PostgreSQL reports the TYPE and the VALUE on 22007/22P02
 * but not the COLUMN, which is why the original errors were unactionable — the
 * mapper correlates the bound value back to the column that took it.
 */

import { castTarget, coerceValue } from '@/lib/mcp/runtime-db'
import { explainDbError, exampleForType } from '@/lib/db/query-errors'

describe('castTarget — every strictly-typed column gets an explicit cast', () => {
  it('casts the types Prisma inference got wrong', () => {
    expect(castTarget('timestamp with time zone')).toBe('timestamptz')
    expect(castTarget('timestamp without time zone')).toBe('timestamp')
    expect(castTarget('numeric')).toBe('numeric')
    expect(castTarget('uuid')).toBe('uuid')
    expect(castTarget('jsonb')).toBe('jsonb')
  })

  it('leaves text-family columns uncast', () => {
    // Text binds natively. Casting it would be harmless but pointless, and the
    // empty string is what the caller checks to decide whether to add `::`.
    expect(castTarget('text')).toBe('')
    expect(castTarget('character varying')).toBe('')
  })

  it('leaves an unknown data type uncast rather than guessing', () => {
    // A wrong cast fails the whole statement; no cast at least lets a
    // text-compatible column through.
    expect(castTarget(undefined)).toBe('')
    expect(castTarget('some_custom_domain')).toBe('')
  })
})

describe('coerceValue — bind as text so PostgreSQL parses it', () => {
  it('stringifies values for cast columns so PG\'s own parser runs', () => {
    // The heart of the fix. Binding a JS Date or number lets Prisma pick the
    // parameter type; binding text with an explicit cast makes PostgreSQL
    // decide, which is the same contract a REST layer applies.
    expect(coerceValue('timestamp with time zone', '2026-07-20T10:00:00Z')).toBe('2026-07-20T10:00:00Z')
    expect(coerceValue('numeric', 2500)).toBe('2500')
    expect(coerceValue('numeric', '2500.00')).toBe('2500.00')
  })

  it('accepts the string-encoded numerics JSON clients naturally send', () => {
    // "2500.00" arriving from JSON was one of the shapes that failed outright.
    expect(coerceValue('numeric', '2500.00')).toBe('2500.00')
    expect(coerceValue('integer', '42')).toBe('42')
  })

  it('serialises objects for json columns', () => {
    expect(coerceValue('jsonb', { a: 1 })).toBe('{"a":1}')
    expect(coerceValue('json', [1, 2])).toBe('[1,2]')
  })

  it('preserves null rather than turning it into the string "null"', () => {
    // A nullable column set to the text "null" is a silent data corruption that
    // reads as valid.
    expect(coerceValue('numeric', null)).toBeNull()
    expect(coerceValue('text', undefined)).toBeNull()
    expect(coerceValue('jsonb', null)).toBeNull()
  })

  it('round-trips a boolean through its text form', () => {
    expect(String(coerceValue('boolean', true))).toMatch(/true/i)
    expect(String(coerceValue('boolean', false))).toMatch(/false/i)
  })
})

describe('explainDbError — names the column PostgreSQL does not', () => {
  // Errors arrive as Prisma's raw invocation text, which is where the SQLSTATE
  // and the server message actually live — not on an `err.code` property.
  const pgErr = (code: string, message: string) =>
    new Error(
      `Invalid \`prisma.$queryRawUnsafe()\` invocation:

` +
      `Raw query failed. Code: \`${code}\`. Message: \`ERROR: ${message}\``,
    )

  const ctx = (columns: string[], values: unknown[], types: [string, string][]) => ({
    table: 'orders',
    columns,
    values,
    types: new Map(types),
  })

  it('identifies the offending column on an invalid datetime', () => {
    // 22007 reports the type and the value but never the column, which is
    // exactly what made the original failures unactionable.
    const err = explainDbError(
      pgErr('22007', 'invalid input syntax for type timestamp: "not-a-date"'),
      ctx(['id', 'created_at'], [1, 'not-a-date'], [
        ['id', 'integer'],
        ['created_at', 'timestamp with time zone'],
      ]),
    )
    expect(err.structured.column).toBe('created_at')
    expect(err.structured.code).toBe('22007')
    // The caller gets a value it can copy, not a description of one.
    expect(err.structured.example).toBeDefined()
  })

  it('identifies the offending column on an invalid numeric', () => {
    const err = explainDbError(
      pgErr('22P02', 'invalid input syntax for type numeric: "abc"'),
      ctx(['id', 'total'], [1, 'abc'], [['id', 'integer'], ['total', 'numeric']]),
    )
    expect(err.structured.column).toBe('total')
  })

  it('reports the real column list on an unknown column', () => {
    // Guessing what the caller meant is worse than telling them what exists.
    const err = explainDbError(
      pgErr('42703', 'column "titel" does not exist'),
      ctx(['id', 'title', 'body'], [], [
        ['id', 'integer'], ['title', 'text'], ['body', 'text'],
      ]),
    )
    expect(err.structured.code).toBe('42703')
    expect(err.structured.available).toEqual(expect.arrayContaining(['title']))
  })

  it('maps the constraint families to their own codes', () => {
    for (const code of ['23502', '23505', '23503', '23514', '42P01']) {
      const err = explainDbError(pgErr(code, 'boom'), undefined)
      expect(err.structured.code).toBe(code)
    }
  })

  it('never surfaces the raw Prisma invocation dump', () => {
    // That text can carry the query and its bound values.
    const err = explainDbError(
      pgErr('22007', 'invalid input syntax for type timestamp: "x"'),
      ctx(['created_at'], ['x'], [['created_at', 'timestamp with time zone']]),
    )
    expect(JSON.stringify(err.structured)).not.toMatch(/prisma|invocation/i)
  })

  it('still produces a structured error with no context at all', () => {
    // Context is an aid, not a requirement — a mapper that threw without it
    // would replace the real error with its own.
    const err = explainDbError(pgErr('23505', 'duplicate key value'), undefined)
    expect(err.structured.code).toBe('23505')
    expect(err.structured.message).toBeTruthy()
  })

  it('survives a context whose arrays do not line up', () => {
    expect(() =>
      explainDbError(
        pgErr('22007', 'invalid input syntax for type timestamp: "x"'),
        ctx([], [], []),
      ),
    ).not.toThrow()
  })
})

describe('exampleForType — show the shape, do not describe it', () => {
  it('gives a concrete parseable example per family', () => {
    // An agent retrying a failed write needs a value it can copy, not prose.
    const ts = exampleForType('timestamp with time zone')
    expect(ts).toBeDefined()
    expect(Number.isNaN(Date.parse(String(ts)))).toBe(false)

    expect(String(exampleForType('uuid'))).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    )
    expect(Number.isNaN(Number(exampleForType('numeric')))).toBe(false)
  })

  it('returns undefined rather than inventing one for an unknown type', () => {
    expect(exampleForType('some_custom_domain')).toBeUndefined()
  })
})
