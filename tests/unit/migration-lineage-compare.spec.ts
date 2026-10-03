/**
 * The comparison, attribution and gate.
 *
 * These decide whether staging can be baselined, so the cases that matter are
 * the ones where something could be waved through: a name that matches while a
 * definition does not, a manifest that claims an object it does not describe,
 * and evidence that is missing rather than clean.
 */

import { attribute, validateManifest, type Manifest } from '../../tools/migration-lineage/attribute'
import { countByKind, diffSnapshots } from '../../tools/migration-lineage/diff'
import { gate, type Evidence } from '../../tools/migration-lineage/gate'
import type { Snapshot } from '../../tools/migration-lineage/probe/capture'

const EMPTY: Snapshot = {
  meta: { database: 'd', serverVersion: '16.13', schemas: ['public'] },
  schemas: [{ name: 'public', owner: 'owner' }],
  tables: [], columns: [], constraints: [], indexes: [], types: [], sequences: [],
  policies: [], triggers: [], routines: [], views: [], eventTriggers: [], extensions: [],
}

const snapshot = (patch: Partial<Snapshot>): Snapshot => ({ ...EMPTY, ...patch })

const table = (name: string, extra: Record<string, unknown> = {}) => ({
  schema: 'public', name, kind: 'r', persistence: 'p', partition: false, rls: false, force_rls: false, ...extra,
})
const column = (t: string, name: string, extra: Record<string, unknown> = {}) => ({
  schema: 'public', table: t, name, type: 'text', type_schema: 'pg_catalog', udt: 'text', typtype: 'b',
  not_null: false, default_expr: null, identity: '', generated: '', collation: null, ...extra,
})
const policy = (t: string, name: string, extra: Record<string, unknown> = {}) => ({
  schema: 'public', table: t, name, command: 'r', permissive: true, roles: ['public'], role_count: 1,
  using_expr: '(id > 0)', check_expr: null, ...extra,
})

describe('semantic diff', () => {
  it('finds objects missing, extra, and defined differently', () => {
    const left = snapshot({ tables: [table('a'), table('b')], columns: [column('a', 'id', { not_null: true })] })
    const right = snapshot({ tables: [table('a'), table('c')], columns: [column('a', 'id', { not_null: false })] })

    const d = diffSnapshots(left, right)
    expect(d.map(x => [x.status, x.key])).toEqual([
      ['differs', 'column public.a.id'],
      ['missing_in_right', 'table public.b'],
      ['extra_in_right', 'table public.c'],
    ])
    expect(d[0].fields).toEqual([{ field: 'not_null', left: true, right: false }])
    expect(countByKind(d)).toEqual([
      { kind: 'table', missing: 1, differs: 0, extra: 1 },
      { kind: 'column', missing: 0, differs: 1, extra: 0 },
    ])
  })

  it.each([
    ['a foreign key action', 'constraints', { schema: 'public', table: 'a', name: 'fk', type: 'f', definition: 'FOREIGN KEY (b) REFERENCES public.b(id) ON DELETE CASCADE', deferrable: false, deferred: false, validated: true }, { definition: 'FOREIGN KEY (b) REFERENCES public.b(id) ON DELETE SET NULL' }],
    ['a partial index predicate', 'indexes', { schema: 'public', table: 'a', name: 'i', definition: 'CREATE INDEX i ON public.a USING btree (x) WHERE (x > 1)', unique: false, primary: false, method: 'btree', predicate: '(x > 1)', constraint_backed: false }, { predicate: '(x > 2)' }],
    ['policy roles', 'policies', policy('a', 'p'), { roles: ['authenticated'] }],
    ['trigger enablement', 'triggers', { schema: 'public', table: 'a', name: 't', definition: 'CREATE TRIGGER t BEFORE INSERT ON public.a FOR EACH ROW EXECUTE FUNCTION public.f()', enabled: 'O', function: 'public.f' }, { enabled: 'D' }],
    ['SECURITY DEFINER', 'routines', { schema: 'public', name: 'f', identity_args: '', result: 'trigger', kind: 'f', language: 'plpgsql', security_definer: true, volatility: 'v', strict: false, leakproof: false, config: ['search_path=pg_catalog'], body_sha256: 'x' }, { security_definer: false }],
    ['a routine body', 'routines', { schema: 'public', name: 'f', identity_args: '', result: 'trigger', kind: 'f', language: 'plpgsql', security_definer: true, volatility: 'v', strict: false, leakproof: false, config: [], body_sha256: 'x' }, { body_sha256: 'y' }],
    ['FORCE row security', 'tables', table('a', { rls: true, force_rls: true }), { force_rls: false }],
  ])('does not normalise away %s', (_label, collection, row, change) => {
    const left = snapshot({ [collection]: [row] } as Partial<Snapshot>)
    const right = snapshot({ [collection]: [{ ...row, ...change }] } as Partial<Snapshot>)
    const d = diffSnapshots(left, right)
    expect(d).toHaveLength(1)
    expect(d[0].status).toBe('differs')
  })

  it('sees an extra schema even when it holds nothing', () => {
    const right = snapshot({ schemas: [{ name: 'public', owner: 'owner' }, { name: 'backenly_pgrst_idle', owner: 'someone_else' }] })
    const d = diffSnapshots(EMPTY, right)
    expect(d).toEqual([expect.objectContaining({ status: 'extra_in_right', key: 'schema backenly_pgrst_idle' })])
  })

  it('does not call a schema different because its owner differs', () => {
    const right = snapshot({ schemas: [{ name: 'public', owner: 'backenly_admin' }] })
    expect(diffSnapshots(EMPTY, right)).toEqual([])
  })

  it('refuses a snapshot with two objects of the same identity', () => {
    const dup = snapshot({ tables: [table('a'), table('a')] })
    expect(() => diffSnapshots(dup, EMPTY)).toThrow(/two objects keyed/)
  })
})

describe('attribution', () => {
  const registry: Manifest = {
    id: 'provisioning/postgrest-schema-registry.sql',
    bucket: 'known_provisioning_effect',
    source: 'scripts/sql/postgrest-schema-registry.sql',
    derivation: 'replayed',
    confidence: 'derived',
    entries: [{ key: 'table public.backenly_pgrst_schema_registry', expect: { kind: 'r', rls: false } }],
  }
  const extra = (row: Record<string, unknown>) =>
    diffSnapshots(EMPTY, snapshot({ tables: [row as never] })).filter(d => d.status === 'extra_in_right')

  it('attributes an object whose definition matches the manifest', () => {
    const a = attribute(extra(table('backenly_pgrst_schema_registry')), [registry])
    expect(a).toHaveLength(1)
    expect(a[0].bucket).toBe('known_provisioning_effect')
    expect(a[0].source).toBe(registry.id)
  })

  it('does not attribute by name when the definition differs', () => {
    const a = attribute(extra(table('backenly_pgrst_schema_registry', { rls: true })), [registry])
    expect(a[0].bucket).toBe('unexplained_divergence')
    expect(a[0].reason).toMatch(/definition differs.*rls/s)
  })

  it('leaves an object no manifest names unexplained', () => {
    const a = attribute(extra(table('mystery')), [registry])
    expect(a[0]).toMatchObject({ bucket: 'unexplained_divergence', reason: 'no manifest names this object' })
  })

  it('refuses an object two manifests both claim', () => {
    const a = attribute(extra(table('backenly_pgrst_schema_registry')), [registry, { ...registry, id: 'other' }])
    expect(a[0].bucket).toBe('unexplained_divergence')
    expect(a[0].reason).toMatch(/more than one manifest/)
  })

  it('never lets a manifest excuse something missing from staging', () => {
    const missing = diffSnapshots(snapshot({ tables: [table('backenly_pgrst_schema_registry')] }), EMPTY)
    const a = attribute(missing, [registry])
    expect(a[0]).toMatchObject({ bucket: 'unexplained_divergence', reason: 'required by the current model and absent from staging' })
  })

  it('rejects manifests that could only attribute by name', () => {
    expect(() => validateManifest({ ...registry, entries: [{ key: 'table public.x', expect: {} }] })).toThrow(/no expectations/)
    expect(() => validateManifest({ ...registry, entries: [{ key: 'notakey', expect: { kind: 'r' } }] })).toThrow(/is not "<kind> <identity>"/)
    expect(() => validateManifest({ ...registry, bucket: 'represented_in_schema_prisma' as never })).toThrow(/cannot be claimed/)
    expect(() => validateManifest({ ...registry, entries: [registry.entries[0], registry.entries[0]] })).toThrow(/appears twice/)
  })
})

describe('the gate', () => {
  const clean: Evidence = { tlsRls: 'PASS', captureStaging: true, chainReplay: 'complete', pushReplay: 'complete', inputsVerified: true }

  it('passes only when nothing is missing, different or unexplained', () => {
    expect(gate([], [], clean).verdict).toBe('STAGING_BASELINE_ELIGIBLE')
  })

  it('requires reconciliation when staging lacks something the model requires', () => {
    const d = diffSnapshots(snapshot({ tables: [table('a')] }), EMPTY)
    const r = gate(d, attribute(d, []), clean)
    expect(r.verdict).toBe('RECONCILIATION_REQUIRED')
    expect(r.counts.missingFromStaging).toBe(1)
  })

  it('requires reconciliation when a staging object is unexplained', () => {
    const d = diffSnapshots(EMPTY, snapshot({ tables: [table('mystery')] }))
    const r = gate(d, attribute(d, []), clean)
    expect(r.verdict).toBe('RECONCILIATION_REQUIRED')
    expect(r.counts.buckets.unexplained_divergence).toBe(1)
  })

  it.each([
    ['the TLS and RLS gate did not pass', { tlsRls: 'FAIL' }],
    ['staging was not captured', { captureStaging: false }],
    ['the projection replay is incomplete', { pushReplay: 'failed' }],
    ['a replayed file did not match its hash', { inputsVerified: false }],
  ])('is inconclusive when %s', (_label, patch) => {
    expect(gate([], [], { ...clean, ...patch }).verdict).toBe('INCONCLUSIVE')
  })

  it('reports an incomplete chain replay without letting it decide the staging gate', () => {
    expect(gate([], [], { ...clean, chainReplay: 'failed' }).verdict).toBe('STAGING_BASELINE_ELIGIBLE')
  })

  it('separates a chain that was never replayed from one whose files failed their hash', () => {
    // Since staging was baselined the legacy chain is forensic evidence, not a
    // lineage input, so a run may omit it. What must not happen is the report
    // describing that as a hash mismatch: it would be a false statement about
    // the evidence, and the real mismatch above must keep blocking.
    const notReplayed = gate([], [], { ...clean, chainReplay: null, inputsVerified: null })
    expect(notReplayed.verdict).toBe('STAGING_BASELINE_ELIGIBLE')
    // Stated, so an eligible verdict reached with a leg missing does not read
    // the same as one reached with every leg run.
    expect(notReplayed.notes).toContainEqual(expect.stringContaining('was not replayed'))
    expect([...notReplayed.reasons, ...notReplayed.notes].join(' ')).not.toContain('did not match')

    const mismatch = gate([], [], { ...clean, inputsVerified: false })
    expect(mismatch.verdict).toBe('INCONCLUSIVE')
    expect(mismatch.reasons).toContainEqual(expect.stringContaining('did not match its recorded hash'))
  })

  it('prefers inconclusive over reconciliation when evidence is missing', () => {
    const d = diffSnapshots(EMPTY, snapshot({ tables: [table('mystery')] }))
    expect(gate(d, attribute(d, []), { ...clean, captureStaging: false }).verdict).toBe('INCONCLUSIVE')
  })
})
