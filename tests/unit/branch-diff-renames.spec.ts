/**
 * A branch diff says a renamed column was renamed (production QA, 2026-11-09).
 *
 * The diff said "orders: +legacy_email, +legacy_status" for statements that
 * renamed two populated columns and added new ones under the old names. A diff
 * of two catalogs sees only names; the branch's statements say what happened
 * (lib/branches/renames.ts).
 */
import { computeSchemaDiff } from '@/lib/branches/diff'
import { renamesIn, renameText, withRenames } from '@/lib/branches/renames'

const col = (columnName: string, dataType = 'text') => ({ columnName, dataType, isNullable: true })
const snapshot = (tables: Record<string, Array<ReturnType<typeof col>>>) => ({
  tables: Object.entries(tables).map(([tableName, columns]) => ({ tableName, columns })),
})
const diffOf = (base: ReturnType<typeof snapshot>, branch: ReturnType<typeof snapshot>, statements: string[]) =>
  withRenames(computeSchemaDiff(base as any, branch as any), statements, base, branch)

describe('a branch diff says a renamed column was renamed', () => {
  it('the QA migration: two populated columns moved aside, new ones under their names', () => {
    const base = snapshot({ orders: [col('id', 'uuid'), col('email'), col('status'), col('total', 'integer')] })
    const branch = snapshot({
      orders: [col('id', 'uuid'), col('legacy_email'), col('legacy_status'), col('total', 'integer'), col('email'), col('status')],
    })
    const statements = [
      'ALTER TABLE orders RENAME COLUMN email TO legacy_email',
      'ALTER TABLE orders RENAME COLUMN status TO legacy_status',
      'ALTER TABLE orders ADD COLUMN email text',
      "ALTER TABLE orders ADD COLUMN status text DEFAULT 'pending'",
    ]
    // What a comparison of names alone says.
    expect(computeSchemaDiff(base as any, branch as any).altered).toEqual([
      expect.objectContaining({ table: 'orders', addedColumns: [expect.objectContaining({ name: 'legacy_email' }), expect.objectContaining({ name: 'legacy_status' })], droppedColumns: [] }),
    ])

    const d = diffOf(base, branch, statements)
    expect(d.altered).toEqual([{
      table: 'orders',
      renamedColumns: [
        { from: 'email', to: 'legacy_email', readded: true },
        { from: 'status', to: 'legacy_status', readded: true },
      ],
      addedColumns: [
        { name: 'email', dataType: 'text', isNullable: true },
        { name: 'status', dataType: 'text', isNullable: true },
      ],
      droppedColumns: [],
      typeChanged: [],
    }])
    expect(d.altered[0].renamedColumns!.map(renameText)).toEqual([
      'email renamed legacy_email; a new email takes its place',
      'status renamed legacy_status; a new status takes its place',
    ])
  })

  it('a rename alone is neither a dropped column nor a new one', () => {
    const base = snapshot({ users: [col('id', 'uuid'), col('email')] })
    const branch = snapshot({ users: [col('id', 'uuid'), col('login_email')] })
    const d = diffOf(base, branch, ['ALTER TABLE users RENAME COLUMN email TO login_email'])
    expect(d.altered).toEqual([{
      table: 'users',
      renamedColumns: [{ from: 'email', to: 'login_email', readded: false }],
      addedColumns: [],
      droppedColumns: [],
      typeChanged: [],
    }])
    expect(d.identical).toBe(false)
    expect(renameText(d.altered[0].renamedColumns![0])).toBe('email renamed login_email')
  })

  it('follows a column through several renames, and statements given together', () => {
    const base = snapshot({ t: [col('a')] })
    const branch = snapshot({ t: [col('c')] })
    const d = diffOf(base, branch, ['ALTER TABLE t RENAME COLUMN a TO b;\nALTER TABLE t RENAME COLUMN b TO c'])
    expect(d.altered[0]).toMatchObject({ renamedColumns: [{ from: 'a', to: 'c', readded: false }], addedColumns: [], droppedColumns: [] })
  })

  it('a column the branch added and then renamed is a new column, not a rename', () => {
    const base = snapshot({ t: [col('a')] })
    const branch = snapshot({ t: [col('a'), col('y')] })
    const d = diffOf(base, branch, ['ALTER TABLE t ADD COLUMN x text', 'ALTER TABLE t RENAME COLUMN x TO y'])
    expect(d.altered).toEqual([{ table: 't', addedColumns: [{ name: 'y', dataType: 'text', isNullable: true }], droppedColumns: [], typeChanged: [] }])
  })

  it('a new column under an old name is a new column, not a retype of the one moved aside', () => {
    const base = snapshot({ t: [col('status')] })
    const branch = snapshot({ t: [col('legacy_status'), col('status', 'integer')] })
    const statements = ['ALTER TABLE t RENAME COLUMN status TO legacy_status', 'ALTER TABLE t ADD COLUMN status integer']
    // Names alone call it a retype of status, from text to integer.
    expect(computeSchemaDiff(base as any, branch as any).altered[0].typeChanged).toEqual([{ column: 'status', from: 'text', to: 'integer' }])
    expect(diffOf(base, branch, statements).altered[0]).toMatchObject({
      renamedColumns: [{ from: 'status', to: 'legacy_status', readded: true }],
      addedColumns: [{ name: 'status', dataType: 'integer', isNullable: true }],
      typeChanged: [],
    })
  })

  it('a renamed column whose type differs shows the change under its new name', () => {
    const base = snapshot({ t: [col('amount', 'integer')] })
    const branch = snapshot({ t: [col('amount_cents', 'bigint')] })
    expect(diffOf(base, branch, ['ALTER TABLE t RENAME COLUMN amount TO amount_cents']).altered[0]).toMatchObject({
      renamedColumns: [{ from: 'amount', to: 'amount_cents', readded: false }],
      addedColumns: [],
      droppedColumns: [],
      typeChanged: [{ column: 'amount_cents', from: 'integer', to: 'bigint' }],
    })
  })

  it('two columns that swapped names are two renames, and nothing else', () => {
    const base = snapshot({ t: [col('a', 'text'), col('b', 'integer')] })
    const branch = snapshot({ t: [col('b', 'text'), col('a', 'integer')] })
    const d = diffOf(base, branch, [
      'ALTER TABLE t RENAME COLUMN a TO tmp',
      'ALTER TABLE t RENAME COLUMN b TO a',
      'ALTER TABLE t RENAME COLUMN tmp TO b',
    ])
    expect(d.altered[0]).toMatchObject({
      renamedColumns: [{ from: 'a', to: 'b', readded: false }, { from: 'b', to: 'a', readded: false }],
      addedColumns: [],
      droppedColumns: [],
      typeChanged: [],
    })
  })

  it('leaves alone a rename the snapshots do not bear out, and a statement it cannot read', () => {
    const base = snapshot({ t: [col('a'), col('keep')] })
    // `b` is gone from the branch, so the diff's dropped `a` stands.
    const branch = snapshot({ t: [col('keep')] })
    const statements = ['DROP TABLE nothing', 'ALTER TABLE t RENAME COLUMN a TO b']
    expect(renamesIn(statements).get('t')).toEqual([{ from: 'a', to: 'b', readded: false }])
    expect(diffOf(base, branch, statements)).toEqual(computeSchemaDiff(base as any, branch as any))
  })

  it('returns the diff as it is when no statement renames anything', () => {
    const base = snapshot({ t: [col('a')] })
    const branch = snapshot({ t: [col('a'), col('b')] })
    const plain = computeSchemaDiff(base as any, branch as any)
    expect(withRenames(plain, ['ALTER TABLE t ADD COLUMN b text'], base, branch)).toBe(plain)
  })
})
