/**
 * The v1 data routes' filter vocabulary (lib/api/v1/where.ts) and what a
 * refused request answers (lib/api/v1/data-errors.ts), without a database:
 * the SQL each SDK filter becomes, the json/jsonb exception, and the
 * SQLSTATEs that are the caller's to correct. The routes themselves run
 * against a real table in tests/integration/sdk-filters-both-servers.spec.ts.
 */

import { refusedDataRequest } from '@/lib/api/v1/data-errors'
import { typedParams } from '@/lib/api/v1/typed-params'
import { FilterError, whereConditions } from '@/lib/api/v1/where'

const TYPES = new Map([
  ['id', 'uuid'],
  ['qty', 'integer'],
  ['title', 'text'],
  ['meta', 'jsonb'],
])

function build(where: Record<string, unknown>) {
  const bound = typedParams(TYPES)
  return { conditions: whereConditions(where, bound, TYPES), values: bound.values }
}

describe('the filter each SDK method sends', () => {
  it('isNull() and isNotNull() become IS NULL and IS NOT NULL, binding nothing', () => {
    expect(build({ id: null, qty: { not: null } })).toEqual({
      conditions: ['"id" IS NULL', '"qty" IS NOT NULL'],
      values: [],
    })
  })

  it('eq(), neq(), gt() and in() cast each value to its column', () => {
    expect(build({ id: 'a', qty: { not: 3, gt: 1, in: [4, 5] } })).toEqual({
      conditions: ['"id" = $1::uuid', '"qty" > $2::integer', '"qty" != $3::integer', '"qty" IN ($4::integer, $5::integer)'],
      values: ['a', '1', '3', '4', '5'],
    })
  })

  it('like() and ilike() match the text, ilike() with its mode', () => {
    expect(build({ title: { contains: 'irs', mode: 'insensitive' } })).toEqual({
      conditions: ['"title"::text ILIKE $1'],
      values: ['%irs%'],
    })
  })

  it('in() with no values matches nothing', () => {
    expect(build({ id: { in: [] } }).conditions).toEqual(['FALSE'])
  })

  it('an object on a jsonb column is a value to compare with, unless it names an operator', () => {
    expect(build({ meta: { tier: 'gold' } })).toEqual({ conditions: ['"meta" = $1::jsonb'], values: ['{"tier":"gold"}'] })
    expect(build({ meta: { not: null } }).conditions).toEqual(['"meta" IS NOT NULL'])
  })
})

describe('a filter that cannot be applied', () => {
  it.each([
    ['an unknown operator', { title: { equals: 'x' } }, 'title'],
    ['a name that is not a column name', { 'title; --': 'x' }, 'title; --'],
    ['an operator object naming no condition', { qty: {} }, 'qty'],
    ['in() without a list', { qty: { in: 3 } }, 'qty'],
  ])('is refused, not skipped: %s', (_label, where, column) => {
    expect(() => build(where)).toThrow(FilterError)
    try {
      build(where)
    } catch (error) {
      expect(refusedDataRequest(error)).toMatchObject({ status: 400, code: 'VALIDATION_ERROR', details: { column } })
    }
  })
})

describe('what a refused request answers', () => {
  // The shape Prisma gives a failed raw query, which lib/db/query-errors.ts reads.
  const pgError = (code: string, message: string) =>
    new Error(`Invalid \`tx.$queryRawUnsafe()\` invocation:\n\n\nRaw query failed. Code: \`${code}\`. Message: \`ERROR: ${message}\``)

  it('names the column a value could not be read for, from what was bound', () => {
    const bound = typedParams(TYPES)
    whereConditions({ id: 'not-a-uuid' }, bound, TYPES)
    expect(refusedDataRequest(pgError('22P02', 'invalid input syntax for type uuid: "not-a-uuid"'), bound.context('tasks')))
      .toMatchObject({ status: 400, code: 'VALIDATION_ERROR', details: { column: 'id', expected: 'uuid' } })
  })

  it('answers a duplicate and a missing parent 409', () => {
    expect(refusedDataRequest(pgError('23505', 'duplicate key value violates unique constraint "tasks_title_key"')))
      .toMatchObject({ status: 409, code: 'CONFLICT' })
    expect(refusedDataRequest(pgError('23503', 'insert or update on table "tasks" violates foreign key constraint "tasks_owner_fk"')))
      .toMatchObject({ status: 409, code: 'CONFLICT' })
  })

  it('leaves anything else to the route: a fault on this side is still a 500', () => {
    expect(refusedDataRequest(pgError('53300', 'sorry, too many clients already'))).toBeNull()
    expect(refusedDataRequest(new TypeError('Cannot read properties of undefined'))).toBeNull()
  })
})
