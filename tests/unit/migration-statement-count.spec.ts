/**
 * Applying a migration counts the statements it was given (production QA,
 * 2026-11-09).
 *
 * Applying a branch's migration said "Applied 22 statement(s)", and the branch's
 * merge then said 16 statements would reach production: the first counted the
 * steps a statement expands into (a CREATE TABLE and its CHECKs, a composite
 * UNIQUE).
 */
import { countStatements, fullyAppliedStatements, runPlan } from '@/lib/mcp/apply-migration'
import { parseMigration } from '@/lib/mcp/migration-parser'

describe('applying a migration counts the statements it was given', () => {
  const sql = [
    'CREATE TABLE coupons (code text NOT NULL, shop text, percent integer CHECK (percent > 0), UNIQUE (code, shop))',
    'ALTER TABLE coupons ADD COLUMN note text',
  ].join(';\n')

  it('says how many statements, and the steps they made when those differ', async () => {
    const planned = parseMigration(sql)
    expect(planned.length).toBeGreaterThan(2)
    const done = await runPlan(planned, [], async (step) => ({ ok: true, summary: step.tool }))
    expect(done.ok).toBe(true)
    expect(done.summary.startsWith(`Applied 2 statements (${planned.length} steps): `)).toBe(true)
    // The same count a branch records and its merge then says.
    expect(fullyAppliedStatements(planned, done.applied)).toHaveLength(2)
    expect(countStatements(planned.map((p) => p.source))).toBe(2)
  })

  it('says one statement plainly', async () => {
    const planned = parseMigration('ALTER TABLE coupons ADD COLUMN expires_at timestamptz')
    const done = await runPlan(planned, [], async () => ({ ok: true, summary: 'added' }))
    expect(done.summary).toBe('Applied 1 statement: added')
  })
})
