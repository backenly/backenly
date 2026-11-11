/**
 * A typed schema call, written as the SQL a preview branch logs for its merge
 * (lib/branches/build-branch.ts, schemaCallSql).
 *
 * backend_chat builds a protected project's schema on a branch, and a merge
 * replays the branch's logged SQL through apply_migration's parser. So each
 * typed call is written as SQL and read back by that parser before anything
 * runs: what the branch builds, what it logs and what production gets all come
 * from one statement. Every case here is read back by the real parser.
 */

import { schemaCallSql } from '@/lib/branches/build-branch'
import { planMigration } from '@/lib/mcp/apply-migration'

function readBack(tool: string, args: Record<string, unknown>) {
  const written = schemaCallSql(tool, args)
  if ('error' in written) throw new Error(written.error)
  const plan = planMigration(written.sql) as { ok: boolean; planned?: Array<{ tool: string; args: Record<string, unknown> }> }
  if (!plan.ok || !plan.planned) throw new Error(`the parser refused: ${written.sql}`)
  return { sql: written.sql, planned: plan.planned }
}

describe('a typed schema call, written as SQL', () => {
  it('keeps every column a create_table declares, and infers nothing from a name', () => {
    const { planned } = readBack('create_table', {
      tableName: 'wishlists',
      columns: [
        { name: 'user_id', type: 'uuid', fkTo: 'users' },
        { name: 'name', type: 'text', nullable: false },
        { name: 'email', type: 'text' },
        { name: 'share_token', type: 'text', unique: true },
        { name: 'is_public', type: 'boolean', nullable: false, default: 'false' },
        { name: 'tags', type: 'text[]' },
        { name: 'price', type: 'numeric(10,2)' },
      ],
    })
    expect(planned).toHaveLength(1)
    expect(planned[0]).toMatchObject({ tool: 'create_table', args: { tableName: 'wishlists', asWritten: true } })
    expect(planned[0].args.columns).toEqual([
      expect.objectContaining({ name: 'user_id', type: 'uuid', fkTo: 'users', nullable: true }),
      expect.objectContaining({ name: 'name', type: 'text', nullable: false }),
      // No UNIQUE on email: a name is not a declaration.
      expect.not.objectContaining({ unique: true }),
      expect.objectContaining({ name: 'share_token', unique: true }),
      expect.objectContaining({ name: 'is_public', type: 'boolean', nullable: false, default: 'false' }),
      expect.objectContaining({ name: 'tags', type: 'text[]' }),
      expect.objectContaining({ name: 'price', sqlType: 'numeric(10,2)' }),
    ])
  })

  it('writes a bare default as the text it means, and keeps one that is already SQL', () => {
    const { planned } = readBack('create_table', {
      tableName: 'orders',
      columns: [
        { name: 'status', type: 'text', default: 'pending' },
        { name: 'note', type: 'text', default: "it's" },
        { name: 'qty', type: 'int', default: 1 },
        { name: 'placed_at', type: 'timestamp', default: 'now()' },
        { name: 'meta', type: 'jsonb', default: "'{}'::jsonb" },
      ],
    })
    const defaults = (planned[0].args.columns as Array<{ name: string; default?: string }>).map((c) => [c.name, c.default])
    expect(defaults).toEqual([
      ['status', "'pending'"],
      ['note', "'it''s'"],
      ['qty', '1'],
      ['placed_at', 'now()'],
      ['meta', "'{}'::jsonb"],
    ])
  })

  it('quotes every identifier, so a name cannot become SQL', () => {
    const { sql, planned } = readBack('create_table', { tableName: 'odd"name', columns: [{ name: 'a"b', type: 'text' }] })
    expect(sql).toBe('CREATE TABLE "odd""name" ("a""b" text)')
    expect(planned[0].args).toMatchObject({ tableName: 'odd"name', columns: [expect.objectContaining({ name: 'a"b' })] })
  })

  it.each([
    ['add_column', 'add_column', { tableName: 't', column: { name: 'notes', type: 'text', nullable: false, default: 'none' } }, { column: expect.objectContaining({ name: 'notes', nullable: false, default: "'none'" }) }],
    ['add_column, flat', 'add_column', { tableName: 't', columnName: 'score', columnType: 'int' }, { column: expect.objectContaining({ name: 'score', type: 'int' }) }],
    ['create_index', 'create_index', { tableName: 't', columns: ['a', 'b'], unique: true, indexName: 't_a_b', where: 'a > 0' }, { columns: ['a', 'b'], unique: true, indexName: 't_a_b', where: 'a > 0' }],
    ['rename_column', 'rename_column', { tableName: 't', oldName: 'a', newName: 'b' }, { oldName: 'a', newName: 'b' }],
    ['a unique constraint', 'add_constraint', { tableName: 't', constraintType: 'unique', columns: ['a', 'b'] }, { constraintType: 'unique', columns: ['a', 'b'] }],
    ['a check', 'add_constraint', { tableName: 't', constraintType: 'check', expression: 'a > 0', constraintName: 'a_positive' }, { constraintType: 'check', expression: 'a > 0', constraintName: 'a_positive' }],
    ['a foreign key', 'add_constraint', { tableName: 't', constraintType: 'foreign_key', columnName: 'owner_id', referencedTable: 'users' }, { constraintType: 'foreign_key', columnName: 'owner_id', referencedTable: 'users' }],
    ['NOT NULL', 'add_constraint', { tableName: 't', constraintType: 'not_null', columnName: 'a' }, { constraintType: 'not_null', columnName: 'a' }],
    ['a default', 'add_constraint', { tableName: 't', constraintType: 'set_default', columnName: 'a', expression: '0' }, { constraintType: 'set_default', columnName: 'a', expression: '0' }],
  ])('%s reads back as the same call', (_name, tool, args, expected) => {
    const { planned } = readBack(tool, args as Record<string, unknown>)
    expect(planned).toEqual([expect.objectContaining({ tool, args: expect.objectContaining({ tableName: 't', ...expected }) })])
  })

  it.each([
    ['a type the parser cannot read', 'create_table', { tableName: 't', columns: [{ name: 'shape', type: 'geometry' }] }, /type "geometry"/],
    ['a table with no columns', 'create_table', { tableName: 't', columns: [] }, /declares no columns/],
    ['a call a branch migration does not take', 'enable_teams', { tableName: 't' }, /cannot be built on a branch/],
    ['a constraint of no known kind', 'add_constraint', { tableName: 't', constraintType: 'exclusion' }, /cannot be built on a branch/],
  ])('refuses %s, writing nothing', (_name, tool, args, reason) => {
    const written = schemaCallSql(tool, args as Record<string, unknown>)
    expect(written).toEqual({ error: expect.stringMatching(reason) })
  })
})
