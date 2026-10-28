/**
 * What the data plane adds to a table by its own sync is not a change since.
 *
 * Found reproducing a customer's report: a project's schema was registered with
 * PostgREST after its first tables were built (the PGRST106 self-heal, or the
 * schema_not_registered repair, both run backenly_pgrst_prepare_schema). That
 * added the soft-delete policy and owner-column defaults to every table outside
 * any change, and History then refused every earlier restore: "posts has
 * changed since this change (~ column author_id: default none →
 * backenly_jwt_claim('sub'); + policy bkn_pgrst_soft_delete)".
 */
import { sameTable, tableSignature, type TableState } from '@/lib/changes/catalog'

const SCHEMA = 'workspace_00000000-0000-0000-0000-000000000001'

function table(over: Partial<TableState> = {}): TableState {
  return {
    name: 'posts',
    oid: 1,
    columns: [
      { name: 'id', attnum: 1, type: 'uuid', notNull: true, default: 'gen_random_uuid()', identity: '', generated: null },
      { name: 'author_id', attnum: 2, type: 'uuid', notNull: true, default: null, identity: '', generated: null },
      { name: 'title', attnum: 3, type: 'text', notNull: true, default: null, identity: '', generated: null },
    ],
    constraints: [],
    indexes: [],
    rls: { enabled: true, forced: true },
    policies: [
      { name: 'backenly_own_rows_select', cmd: 'r', permissive: true, roles: ['authenticated'], using: '(author_id = x)', check: null },
    ],
    triggers: [],
    grants: [],
    comment: null,
    ...over,
  }
}

/** The same table after the data plane prepared it. */
function prepared(t: TableState): TableState {
  return {
    ...t,
    columns: t.columns.map((c) =>
      c.name === 'author_id' ? { ...c, default: `("${SCHEMA}".backenly_jwt_claim('sub'::text))::uuid` } : c,
    ),
    policies: [
      ...t.policies,
      { name: 'bkn_pgrst_soft_delete', cmd: 'r', permissive: false, roles: ['anon', 'authenticated'], using: '(deleted_at IS NULL)', check: null },
    ],
  }
}

describe('a restore compares what a change made, not what the data plane keeps', () => {
  it('reads a table the data plane prepared afterwards as unchanged', () => {
    const asTheChangeLeftIt = table()
    expect(sameTable(prepared(asTheChangeLeftIt), asTheChangeLeftIt)).toBe(true)
  })

  it('also ignores an owner default on a text owner column, unquoted schema', () => {
    const t = table({
      columns: [{ name: 'user_id', attnum: 2, type: 'text', notNull: false, default: null, identity: '', generated: null }],
    })
    const after = { ...t, columns: [{ ...t.columns[0], default: "ws.backenly_jwt_claim('sub'::text)" }] }
    expect(sameTable(after, t)).toBe(true)
  })

  it('still sees a real change since', () => {
    const base = table()
    expect(sameTable({ ...base, columns: [...base.columns, { name: 'body', attnum: 4, type: 'text', notNull: false, default: null, identity: '', generated: null }] }, base)).toBe(false)
    expect(sameTable({ ...base, policies: [] }, base)).toBe(false)
    expect(sameTable({ ...base, columns: base.columns.map((c) => (c.name === 'title' ? { ...c, default: "'untitled'::text" } : c)) }, base)).toBe(false)
  })

  it('compares any other claim-shaped default, which nothing installs by itself', () => {
    const base = table()
    const other = { ...base, columns: base.columns.map((c) => (c.name === 'author_id' ? { ...c, default: `"${SCHEMA}".backenly_jwt_claim('role'::text)::uuid` } : c)) }
    expect(tableSignature(other)).not.toBe(tableSignature(base))
  })
})
