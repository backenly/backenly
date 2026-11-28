/**
 * A FOREIGN KEY IS OFFERED ONLY BETWEEN TYPES POSTGRESQL CAN LINK
 * ===============================================================
 * Production QA, 2026-11-21 and again 2026-11-27: an agent stored the signed-in
 * user as `user_id text`, `users.id` is a uuid, and Backenly offered a foreign
 * key between them from the column's name alone. Approving it answered HTTP
 * 500 with PostgreSQL's "cannot be implemented … incompatible types: text and
 * uuid", four times on one project and five more on a new one.
 *
 * The rule (lib/db/fk-shape.ts) and its two readers (lib/ai/fk-repair.ts), as
 * pure functions. That PostgreSQL agrees with every "yes" and "no" here is
 * pinned against a real database in tests/core/missing-fk-types-must-link.test.ts.
 */

import { foreignKeyTypesMatch } from '@/lib/db/fk-shape'
import { keyCanBeMade, missingKeyOfferIsSettled, KEY_CANNOT_BE_MADE_CODES } from '@/lib/ai/fk-repair'

describe('two types link', () => {
  it.each([
    ['uuid', 'uuid'],
    ['int4', 'int4'],
    ['int8', 'int4'],
    ['int4', 'int8'],
    ['int2', 'int8'],
    ['text', 'text'],
    ['varchar', 'text'],
    ['text', 'varchar'],
    ['UUID', 'uuid'],
  ])('%s to a key of %s', (column, key) => {
    expect(foreignKeyTypesMatch(column, key)).toBe(true)
  })
})

describe('two types do not link', () => {
  it.each([
    ['text', 'uuid'],
    ['uuid', 'text'],
    ['varchar', 'uuid'],
    ['int4', 'uuid'],
    ['text', 'int4'],
    ['int4', 'text'],
    ['numeric', 'int4'],
    ['int8', 'numeric'],
    ['bpchar', 'text'],
    ['timestamptz', 'date'],
  ])('%s to a key of %s', (column, key) => {
    expect(foreignKeyTypesMatch(column, key)).toBe(false)
  })
})

const types = new Map([
  ['users.id', 'uuid'],
  ['posts.id', 'int4'],
  ['reviews.user_id', 'text'],
  ['reviews.post_id', 'int8'],
  ['orders.user_id', 'uuid'],
  ['tags.name', 'text'],
  ['taggings.tag_id', 'uuid'],
])

describe('whether a key can be made', () => {
  it('says yes for the same type and for whole numbers of different widths', () => {
    expect(keyCanBeMade(types, 'orders', 'user_id', 'users')).toEqual({ ok: true })
    expect(keyCanBeMade(types, 'reviews', 'post_id', 'posts')).toEqual({ ok: true })
  })

  it('says no for text beside a uuid, in a sentence that names both columns and both types', () => {
    expect(keyCanBeMade(types, 'reviews', 'user_id', 'users')).toEqual({
      ok: false,
      code: 'INCOMPATIBLE_TYPES',
      message:
        '"reviews"."user_id" is text and "users"."id" is uuid, and PostgreSQL cannot link columns of those two types ' +
        "with a foreign key, so none was added and nothing changed. To link them, change the column's type to uuid first.",
    })
  })

  it('says no when the table referenced has no id', () => {
    expect(keyCanBeMade(types, 'taggings', 'tag_id', 'tags')).toEqual({
      ok: false,
      code: 'REFERENCED_KEY_NOT_FOUND',
      message: '"tags" has no "id" column to reference, so no foreign key was added and nothing changed.',
    })
  })

  it('leaves a column it has no type for to the statement itself', () => {
    expect(keyCanBeMade(types, 'reviews', 'author_id', 'users')).toEqual({ ok: true })
  })

  it('gives both refusals a code an approval answers as a refusal', () => {
    expect([...KEY_CANNOT_BE_MADE_CODES].sort()).toEqual(['INCOMPATIBLE_TYPES', 'REFERENCED_KEY_NOT_FOUND'])
  })
})

describe('an offer already in the queue', () => {
  const tableNameMap = new Map([['users', 'users'], ['posts', 'posts'], ['reviews', 'reviews'], ['orders', 'orders'], ['tags', 'tags']])
  const columns = new Set(['reviews.user_id', 'reviews.post_id', 'orders.user_id', 'orders.stripe_session_id', 'taggings.tag_id'])
  const offer = (table: string, column: string, extra: Partial<Parameters<typeof missingKeyOfferIsSettled>[0]> = {}) =>
    missingKeyOfferIsSettled({ table, column, keyed: new Set(), columns, tableNameMap, columnTypes: types, ...extra })

  it('is withdrawn when its two types cannot be linked, or the table referenced has no id', () => {
    expect(offer('reviews', 'user_id')).toBe(true)
    expect(offer('taggings', 'tag_id')).toBe(true)
  })

  it('stays when the key can be made and is still missing', () => {
    expect(offer('orders', 'user_id')).toBe(false)
    expect(offer('reviews', 'post_id')).toBe(false)
  })

  it('stays when the types could not be read: nothing is closed on what was not seen', () => {
    expect(offer('reviews', 'user_id', { columnTypes: null })).toBe(false)
    expect(offer('reviews', 'user_id', { columnTypes: new Map() })).toBe(false)
  })

  it('is withdrawn, as before, when the key exists, the column is gone, or it names no table here', () => {
    expect(offer('orders', 'user_id', { keyed: new Set(['orders.user_id']) })).toBe(true)
    expect(offer('orders', 'customer_id')).toBe(true)
    expect(offer('orders', 'stripe_session_id')).toBe(true)
  })
})
