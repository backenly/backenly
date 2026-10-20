/**
 * Every tool call gets a label a person can read (humanTitle, lib/ai/brain/tools.ts).
 *
 * The label is the line people and agents see in a turn's tool_start and
 * tool_done events and in its `applied` list. A tool without a case fell to the
 * default and was shown as its raw name, so a data migration that rewrote live
 * rows was reported as `run_data_migration`, and a composite constraint lost
 * its columns because the label read only `columnName` (#223).
 */

import { BRAIN_TOOLS, humanTitle } from '@/lib/ai/brain/tools'

describe('the label of a tool call', () => {
  it('exists for every tool in the catalog', () => {
    const names = BRAIN_TOOLS.map((t) => t.function.name)
    expect(names.length).toBeGreaterThan(0)
    // Listed by name, so a new tool added without a label is the one reported.
    expect(names.filter((name) => humanTitle(name, {}) === name)).toEqual([])
  })

  it('names every column of a composite constraint', () => {
    expect(
      humanTitle('add_constraint', { tableName: 'conversations', constraintType: 'unique', columns: ['user_a', 'user_b'] }),
    ).toBe('Adding unique on conversations (user_a, user_b)')
    expect(humanTitle('add_constraint', { tableName: 'users', constraintType: 'unique', columnName: 'email' })).toBe(
      'Adding unique on users.email',
    )
  })

  it('says which tables a data migration rewrites, and when it only counts them', () => {
    const operations = [
      { op: 'backfill', table: 'users', column: 'status', value: 'active' },
      { op: 'cast_column', table: 'users', column: 'age', toType: 'integer' },
      { op: 'normalize_values', table: 'orders', column: 'state', mapping: { PAID: 'paid' } },
    ]
    expect(humanTitle('run_data_migration', { operations })).toBe('Migrating data in users, orders')
    expect(humanTitle('run_data_migration', { operations, dryRun: true })).toBe(
      'Previewing a data migration in users, orders',
    )
  })
})
