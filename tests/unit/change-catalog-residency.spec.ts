/**
 * What the record of a regional project's change keeps of a catalog
 * (lib/changes/residency.ts catalogStructure), without a database: every
 * definition becomes a keyed digest, everything else is kept as it is, and a
 * footprint read from two catalogs' structure says what the catalogs
 * themselves would, without quoting a definition (lib/changes/diff.ts). The
 * ledger, the region's copy and the restores run against real databases in
 * tests/integration/change-ledger-residency.spec.ts.
 */

import type { CatalogSnapshot, TableState } from '@/lib/changes/catalog'
import { diffCatalogs } from '@/lib/changes/diff'
import { describeChange } from '@/lib/changes/describe'
import { catalogStructure, newCatalogKey } from '@/lib/changes/residency'

const SECRET = 'MARKER_7f3a'

function table(name: string, overrides: Partial<TableState> = {}): TableState {
  return {
    name,
    oid: 1001,
    columns: [
      { name: 'id', attnum: 1, type: 'integer', notNull: true, default: `nextval('${name}_id_seq'::regclass)`, identity: '', generated: null },
      { name: 'note', attnum: 2, type: 'text', notNull: false, default: `'${SECRET} default'::text`, identity: '', generated: null },
      { name: 'shout', attnum: 3, type: 'text', notNull: false, default: null, identity: '', generated: `(upper(note) || '${SECRET} generated'::text)` },
    ],
    constraints: [
      { name: `${name}_pkey`, type: 'p', definition: 'PRIMARY KEY (id)', columns: ['id'], refTable: null, refSchema: null },
      { name: `${name}_note_check`, type: 'c', definition: `CHECK ((note <> '${SECRET} check'::text))`, columns: ['note'], refTable: null, refSchema: null },
      { name: `${name}_owner_fkey`, type: 'f', definition: 'FOREIGN KEY (id) REFERENCES ws.users(id)', columns: ['id'], refTable: 'users', refSchema: 'ws' },
    ],
    indexes: [{ name: `${name}_partial`, definition: `CREATE INDEX ${name}_partial ON ws.${name} USING btree (note) WHERE (note <> '${SECRET} index'::text)`, unique: false }],
    rls: { enabled: true, forced: false },
    policies: [{ name: `${name}_policy`, cmd: '*', permissive: true, roles: ['public'], using: `(note <> '${SECRET} policy'::text)`, check: null }],
    triggers: [{ name: `${name}_stamp`, definition: `CREATE TRIGGER ${name}_stamp BEFORE INSERT ON ws.${name} FOR EACH ROW WHEN ((new.note <> '${SECRET} trigger'::text)) EXECUTE FUNCTION ws.stamp()`, enabled: 'O' }],
    grants: [{ grantee: 'bkn_ro_x', privilege: 'SELECT' }],
    comment: `${SECRET} comment`,
    ...overrides,
  }
}

function catalog(tables: TableState[]): CatalogSnapshot {
  return {
    schema: 'ws',
    capturedAt: '2026-10-19T00:00:00.000Z',
    tables: Object.fromEntries(tables.map((t) => [t.name, t])),
    objects: {
      notes_view: { kind: 'view', name: 'notes_view', identity: 'notes_view', definition: ` SELECT id, '${SECRET} view'::text AS tag FROM ws.notes;`, options: ['security_invoker=true'] },
      'stamp()': { kind: 'function', name: 'stamp', identity: 'stamp()', definition: `CREATE OR REPLACE FUNCTION ws.stamp() RETURNS trigger AS $$ BEGIN /* ${SECRET} function */ RETURN NEW; END $$`, options: [] },
      mood: { kind: 'type', name: 'mood', identity: 'mood', definition: `CREATE TYPE ws.mood AS ENUM ('${SECRET.toLowerCase()}_label')`, options: [] },
    },
  }
}

const DIGEST = /^kept-in-region:[0-9a-f]{32}$/

describe('the structure a record outside the region keeps', () => {
  const key = newCatalogKey()
  const full = catalog([table('notes')])
  const kept = catalogStructure(full, key)

  it('holds no definition of any kind', () => {
    expect(JSON.stringify(kept)).not.toContain(SECRET)
    expect(JSON.stringify(kept)).not.toContain(SECRET.toLowerCase())
  })

  it('digests every definition, and keeps a missing one missing', () => {
    const t = kept.tables.notes
    expect(t.columns.map((c) => c.default)).toEqual([expect.stringMatching(DIGEST), expect.stringMatching(DIGEST), null])
    expect(t.columns.map((c) => c.generated)).toEqual([null, null, expect.stringMatching(DIGEST)])
    for (const d of [...t.constraints.map((c) => c.definition), t.indexes[0].definition, t.policies[0].using, t.triggers[0].definition, t.comment]) {
      expect(d).toMatch(DIGEST)
    }
    expect(t.policies[0].check).toBeNull()
    for (const o of Object.values(kept.objects!)) expect(o.definition).toMatch(DIGEST)
  })

  it('keeps every name, kind, type, number, flag, role, grant and reference as it is', () => {
    const strip = (t: TableState) => ({
      name: t.name,
      oid: t.oid,
      columns: t.columns.map(({ name, attnum, type, notNull, identity }) => ({ name, attnum, type, notNull, identity })),
      constraints: t.constraints.map(({ name, type, columns, refTable, refSchema }) => ({ name, type, columns, refTable, refSchema })),
      indexes: t.indexes.map(({ name, unique }) => ({ name, unique })),
      rls: t.rls,
      policies: t.policies.map(({ name, cmd, permissive, roles }) => ({ name, cmd, permissive, roles })),
      triggers: t.triggers.map(({ name, enabled }) => ({ name, enabled })),
      grants: t.grants,
    })
    expect(strip(kept.tables.notes)).toEqual(strip(full.tables.notes))
    expect(Object.values(kept.objects!).map(({ kind, name, identity, options }) => ({ kind, name, identity, options })))
      .toEqual(Object.values(full.objects!).map(({ kind, name, identity, options }) => ({ kind, name, identity, options })))
    expect({ schema: kept.schema, capturedAt: kept.capturedAt }).toEqual({ schema: full.schema, capturedAt: full.capturedAt })
  })

  it('digests equal definitions equal under one key, and differently under another', () => {
    expect(catalogStructure(full, key)).toEqual(kept)
    expect(catalogStructure(full, newCatalogKey()).tables.notes.constraints[1].definition).not.toBe(kept.tables.notes.constraints[1].definition)
  })

  it('keeps fields beside the catalog, such as the result data counts', () => {
    const withData = { ...full, data: { notes: { rows: 3, checksum: '42' } } }
    expect(catalogStructure(withData, key).data).toEqual({ notes: { rows: 3, checksum: '42' } })
  })
})

describe('a footprint read from two catalogs’ structure', () => {
  const key = newCatalogKey()
  const before = catalog([table('notes')])
  const after = catalog([
    table('notes', {
      columns: [
        ...table('notes').columns.map((c) => (c.name === 'note' ? { ...c, default: `'${SECRET} other'::text` } : c)),
        { name: 'qty', attnum: 4, type: 'integer', notNull: false, default: `'${SECRET}'::text`, identity: '', generated: null },
      ],
      constraints: [...table('notes').constraints, { name: 'notes_qty_check', type: 'c', definition: `CHECK ((qty <> 7) OR (note = '${SECRET}'::text))`, columns: ['qty'], refTable: null, refSchema: null }],
    }),
  ])
  delete after.objects!.notes_view

  const fromCatalogs = diffCatalogs(before, after)
  const fromStructure = diffCatalogs(catalogStructure(before, key), catalogStructure(after, key))

  it('names the same objects with the same kinds of change', () => {
    expect(fromStructure.map(({ kind, object, before: b, after: a }) => ({ kind, object, b, a })))
      .toEqual(fromCatalogs.map(({ kind, object, before: b, after: a }) => ({ kind, object, b, a })))
    expect(fromStructure.map((c) => c.details.length)).toEqual(fromCatalogs.map((c) => c.details.length))
  })

  it('quotes no definition, and says each is kept in its region', () => {
    expect(JSON.stringify(fromStructure)).not.toContain(SECRET)
    const lines = fromStructure.flatMap((c) => c.details)
    expect(lines).toEqual(expect.arrayContaining([
      '~ column note: default changed',
      '+ column qty integer DEFAULT (kept in its region)',
      '+ check notes_qty_check: (kept in its region)',
    ]))
  })

  it('reads as the same plain sentence', () => {
    expect(describeChange(fromStructure)).toBe(describeChange(fromCatalogs))
  })
})
