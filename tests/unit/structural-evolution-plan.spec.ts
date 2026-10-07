/**
 * THE EXTRACTION LADDER, AS A CONTRACT — without a database
 * =========================================================
 *
 * Consent binds to `planVersion`, and `planVersion` hashes the SQL. These pin
 * the properties that make that binding mean something:
 *
 *   - the version moves when anything the SQL depends on moves (the host's
 *     shape, its grants, the satellite's name)
 *   - it does NOT move when the ladder's own objects appear, or a resumed
 *     ladder would invalidate its own consent halfway down
 *   - `contract` is planned, shown, and never executable
 *   - every rung software runs can be undone, and says how
 *   - the new table is born closed
 *
 * Whether the SQL is CORRECT is a question for PostgreSQL:
 * tests/integration/structural-evolution.spec.ts.
 */

import * as fs from 'fs'
import * as path from 'path'
import { buildExtractionPlan, requiredTier, EXTRACTION_CAPABILITY } from '@/lib/structural-evolution/plan'
import { basisFingerprint } from '@/lib/structural-evolution/facts'
import { ladderNames, type ExtractionSpec } from '@/lib/structural-evolution/sql'
import { ordersFacts } from '../helpers/structural-evolution-fixtures'

const SPEC: ExtractionSpec = {
  host: 'orders',
  members: ['refunded_at', 'refund_amount', 'refund_reason'],
  satellite: 'order_refunds',
  label: 'refund',
}

const plan = (over: Partial<Parameters<typeof buildExtractionPlan>[0]> = {}) =>
  buildExtractionPlan({ projectId: 'p1', spec: SPEC, facts: ordersFacts(), satelliteExists: false, ...over })

describe('the extraction ladder', () => {
  it('is executable, ordered, and ends with a rung only a person performs', () => {
    const p = plan()
    expect(p.validity).toBe('executable')
    expect(p.spec.members).toEqual(['refund_amount', 'refund_reason', 'refunded_at'])
    expect(p.steps.map(s => s.kind)).toEqual([
      'rehearse', 'create_satellite', 'sync_forward', 'backfill', 'verify', 'expose_reads', 'open_writes', 'verify', 'contract',
    ])
    expect(p.steps.map(s => s.tier)).toEqual([0, 1, 2, 2, 0, 2, 2, 0, 3])
    const contract = p.steps[p.steps.length - 1]
    expect(contract.capability).toBe('human_only')
    expect(contract.rollback).toBeNull()
    expect(EXTRACTION_CAPABILITY.contract).toMatch(/^human_only@/)
    expect(requiredTier(p)).toBe(2)
  })

  it('can undo every rung it runs, and names how', () => {
    for (const s of plan().steps.filter(s => s.capability === 'implemented')) {
      expect(s.rollback).not.toBeNull()
      expect(s.rollback!.description.length).toBeGreaterThan(0)
    }
  })

  it('creates the satellite closed: forced row security, a policy for its creator only, every grant revoked', () => {
    const sql = plan().steps.find(s => s.kind === 'create_satellite')!.sql.join('\n')
    expect(sql).toMatch(/FORCE ROW LEVEL SECURITY/)
    // The creating role (the platform, which the forward sync runs as) and
    // nobody else. Not the service-role claim: any role can set a claim.
    // The platform's own policy admits it only inside the ladder's own context:
    // the runtime serves end users as the same role.
    expect(sql).toMatch(
      /FOR ALL TO CURRENT_USER USING \(current_setting\('bkn_evo\.access_[0-9a-f]+', true\) = 'on'\) WITH CHECK \(current_setting\('bkn_evo\.access_[0-9a-f]+', true\) = 'on'\)/,
    )
    expect(sql).not.toMatch(/USING \(true\)/)
    expect(sql).not.toMatch(/service_role/)
    expect(sql).toMatch(/REVOKE ALL ON %s FROM %s/)
    expect(sql).not.toMatch(/GRANT /)
    // Members keep their names and types and carry no defaults.
    expect(sql).toMatch(/"refund_amount" numeric,/)
    expect(sql).not.toMatch(/DEFAULT (?!gen_random_uuid)/)
    // The host's CHECK on a member travels with it, verbatim.
    expect(sql).toMatch(/CHECK \(\(refund_amount >= \(0\)::numeric\)\)/)
    // A satellite row means "this order has a refund".
    expect(sql).toMatch(/CHECK \("refund_amount" IS NOT NULL OR "refund_reason" IS NOT NULL OR "refunded_at" IS NOT NULL\)/)
  })

  it('opens the new table only to roles that hold the same right on its parent', () => {
    const p = plan({
      facts: ordersFacts({
        grants: [
          { grantee: 'anon', privilege: 'SELECT' },
          { grantee: 'authenticated', privilege: 'SELECT' },
          { grantee: 'authenticated', privilege: 'UPDATE' },
          { grantee: 'backenly_user', privilege: 'UPDATE' },
        ],
      }),
    })
    expect(p.access).toEqual({ readers: ['anon', 'authenticated'], writers: ['authenticated'] })
    expect(p.steps.find(s => s.kind === 'expose_reads')!.sql.join('\n')).toMatch(/GRANT SELECT ON .* TO "anon", "authenticated"/)
    expect(p.steps.find(s => s.kind === 'open_writes')!.sql.join('\n')).toMatch(/GRANT INSERT, UPDATE, DELETE ON .* TO "authenticated"$/m)
  })

  it('binds its version to the exact SQL', () => {
    const a = plan()
    expect(plan().planVersion).toBe(a.planVersion)
    expect(plan({ spec: { ...SPEC, satellite: 'refunds' } }).planVersion).not.toBe(a.planVersion)
    const widened = ordersFacts({ grants: [...ordersFacts().grants, { grantee: 'anon', privilege: 'SELECT' }] })
    expect(plan({ facts: widened }).planVersion).not.toBe(a.planVersion)
    const retyped = ordersFacts()
    retyped.columns = retyped.columns.map(c => (c.name === 'refund_reason' ? { ...c, type: 'character varying(200)' } : c))
    expect(plan({ facts: retyped }).planVersion).not.toBe(a.planVersion)
    // planId names the proposal, not the version: it survives all of the above.
    expect(plan({ spec: { ...SPEC, satellite: 'refunds' } }).planId).toBe(a.planId)
  })

  it('does not invalidate its own consent when its own objects appear on the host', () => {
    const a = plan()
    const n = ladderNames({ ...SPEC, members: [...SPEC.members].sort() })
    const after = ordersFacts({
      triggers: [{ name: n.forward, definition: `CREATE TRIGGER ${n.forward} AFTER INSERT ...`, functionSource: '...' }],
      inboundForeignKeys: [{ name: n.fk, fromSchema: 'workspace_test', fromTable: 'order_refunds', columns: ['id'] }],
    })
    expect(basisFingerprint(after)).toBe(basisFingerprint(ordersFacts()))
    expect(plan({ facts: after }).planVersion).toBe(a.planVersion)
    // ...while somebody else's trigger does.
    const theirs = ordersFacts({ triggers: [{ name: 'audit_orders', definition: 'CREATE TRIGGER audit_orders ...', functionSource: '' }] })
    expect(plan({ facts: theirs }).planVersion).not.toBe(a.planVersion)
  })

  it('gives every rung a distinct idempotency key tied to the version', () => {
    const keys = plan().steps.map(s => s.idempotencyKey)
    expect(new Set(keys).size).toBe(keys.length)
    expect(plan({ spec: { ...SPEC, satellite: 'refunds' } }).steps[1].idempotencyKey).not.toBe(keys[1])
  })

  it('refuses rather than guesses', () => {
    expect(plan({ satelliteExists: true })).toMatchObject({ validity: 'invalid', steps: [] })
    expect(plan({ spec: { ...SPEC, members: ['refund_amount', 'nope'] } }).blockedReasons.join()).toMatch(/no column nope/)
    expect(plan({ spec: { ...SPEC, satellite: 'bad name' } }).validity).toBe('invalid')
    expect(plan({ spec: { ...SPEC, members: ['refund_amount', 'total'] } }).blockedReasons.join()).toMatch(/total is NOT NULL/)
    expect(plan({ facts: ordersFacts({ relkind: 'p' }) }).blockedReasons.join()).toMatch(/partitioned/)
  })

  it('plans numbered copies of a field and says honestly that it cannot run them yet', () => {
    const facts = ordersFacts()
    facts.columns.push(
      { name: 'coupon_1', attnum: 20, type: 'text', udt: 'text', notNull: false, default: null, generated: false, identity: false, hasColumnAcl: false },
      { name: 'coupon_2', attnum: 21, type: 'text', udt: 'text', notNull: false, default: null, generated: false, identity: false, hasColumnAcl: false },
    )
    const p = plan({ facts, spec: { host: 'orders', members: ['coupon_1', 'coupon_2'], satellite: 'order_coupons', label: 'coupon' } })
    expect(p.validity).toBe('blocked_by_capability')
    expect(p.blockedReasons.join()).toMatch(/unpivot/)
    expect(p.steps.length).toBeGreaterThan(0)
  })
})

describe('structural evolution stays deterministic', () => {
  it('never reaches a model', () => {
    // The engine restructures production tables. Like detection and repair,
    // it must be a closed vocabulary rendered from the catalog, never a model's
    // output: see __tests__/autonomy/autonomy-is-model-free.test.ts.
    const dir = path.resolve(__dirname, '..', '..', 'lib', 'structural-evolution')
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.ts'))
    expect(files.length).toBeGreaterThanOrEqual(12)
    for (const f of files) {
      const src = fs.readFileSync(path.join(dir, f), 'utf8')
      expect({ f, hit: /from '[^']*(openai|model-router|openai-service|lib\/ai\/)[^']*'/.exec(src)?.[0] ?? null }).toEqual({ f, hit: null })
    }
  })
})
