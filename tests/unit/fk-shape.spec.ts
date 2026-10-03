/**
 * ONE DEFINITION OF "FOREIGN-KEY SHAPED", USED BY BOTH SIDES
 * =========================================================
 * The executor refuses a foreign key on a column that is not FK-shaped, and it
 * refuses it AFTER the column has been created. So a table editor that does not
 * know the rule offers a choice the server rejects, leaving a stray column
 * behind and an error too late to act on.
 *
 * The browser therefore needs the rule, and the fix for needing it in two
 * places is not to write it twice. `lib/ai/fk-repair.ts` re-exports this module
 * rather than carrying its own copy, so this suite constrains the executor's
 * behaviour as much as the UI's.
 */

import { deriveFkBase, isForeignKeyShaped, suggestForeignKeyColumn } from '@/lib/db/fk-shape'

describe('deriveFkBase', () => {
  it.each([
    ['user_id', 'user'],
    ['owner_id', 'owner'],
    ['order_item_id', 'order_item'],
    ['USER_ID', 'user'],
  ])('reads %p as a reference to %p', (column, base) => {
    expect(deriveFkBase(column)).toBe(base)
  })

  it('reads camelCase only when the name really carries an uppercase', () => {
    expect(deriveFkBase('userId')).toBe('user')
    // Lowercase `userid` is not a convention anyone uses deliberately, and
    // treating it as a reference would constrain a column nobody meant to link.
    expect(deriveFkBase('userid')).toBeNull()
  })

  it.each(['id', 'email', 'created_at', 'price', 'is_active'])(
    'reads %p as not a reference',
    column => {
      expect(deriveFkBase(column)).toBeNull()
    }
  )

  it('never treats a table own key as a reference to itself', () => {
    // `id` returning `''` would make isForeignKeyShaped true and let the UI
    // offer a foreign key from a primary key to another table's primary key.
    expect(deriveFkBase('id')).toBeNull()
    expect(deriveFkBase('ID')).toBeNull()
  })
})

describe('isForeignKeyShaped', () => {
  it('ignores surrounding whitespace, because it reads a form field', () => {
    expect(isForeignKeyShaped('  user_id  ')).toBe(true)
  })

  it('is false for the empty string a form starts with', () => {
    expect(isForeignKeyShaped('')).toBe(false)
  })

  it('agrees with deriveFkBase on every case', () => {
    for (const column of ['user_id', 'userId', 'id', 'email', '', 'x_id']) {
      expect(isForeignKeyShaped(column)).toBe(deriveFkBase(column.trim()) !== null)
    }
  })
})

describe('suggestForeignKeyColumn', () => {
  it('singularises the common plural table name', () => {
    expect(suggestForeignKeyColumn('organizations')).toBe('organization_id')
    expect(suggestForeignKeyColumn('users')).toBe('user_id')
  })

  it('leaves an already-singular name alone', () => {
    expect(suggestForeignKeyColumn('person')).toBe('person_id')
  })

  it('always suggests something the rule actually accepts', () => {
    // The suggestion exists to unblock the operator. One that the server would
    // also refuse would be worse than no suggestion at all.
    for (const table of ['organizations', 'users', 'person', 'media', 'data']) {
      expect(isForeignKeyShaped(suggestForeignKeyColumn(table))).toBe(true)
    }
  })
})
