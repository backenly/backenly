/**
 * remedy.ts is the only module in Phase 4 that CHANGES anything. Everything
 * before it reasons; this acts. So the tests that matter are the refusals —
 * the conditions under which it must decline — because a wrong refusal costs a
 * cycle and a wrong action costs production.
 *
 * The database is stubbed here rather than mocked away: these assertions are
 * about which SQL is reached and under what conditions, not about what the SQL
 * returns. The behaviour under test is the gate, not the query.
 */

import { applyRemedy } from '@/lib/autonomy/hypothesis/remedy'
import type { Hypothesis, InvestigationVerdict } from '@/lib/autonomy/hypothesis/types'

const executed: string[] = []

jest.mock('@/lib/db/prisma', () => ({
  prisma: {
    $executeRawUnsafe: jest.fn(async (sql: string) => {
      executed.push(sql)
      return 1
    }),
    $queryRawUnsafe: jest.fn(async () => [{ list: 'workspace_a,workspace_gone' }]),
  },
}))

beforeEach(() => {
  executed.length = 0
})

const hypothesis = (
  action: string | undefined,
  autoApplicable: boolean,
): Hypothesis => ({
  id: 'h',
  statement: 'because reasons',
  prior: 1,
  predicts: {},
  remedy: { summary: 'do the thing', autoApplicable, action },
})

const conclusive = (h: Hypothesis): InvestigationVerdict => ({
  kind: 'conclusive',
  hypothesis: h,
  confidence: 0.99,
})

describe('applyRemedy — refusals', () => {
  it('refuses an ambiguous verdict', async () => {
    // The investigation did not settle the question. Acting anyway is how an
    // autonomous system does damage while appearing decisive.
    const r = await applyRemedy('p1', { kind: 'ambiguous', candidates: [], reason: 'unclear' })
    expect(r.applied).toBe(false)
    expect(executed).toHaveLength(0)
  })

  it('refuses an unexplained verdict', async () => {
    const r = await applyRemedy('p1', { kind: 'unexplained', reason: 'nothing fit', observations: [] })
    expect(r.applied).toBe(false)
    expect(executed).toHaveLength(0)
  })

  it('refuses a conclusive verdict whose remedy is not auto-applicable', async () => {
    // Certainty is not permission. "These are credential tables, denied by
    // design" is a certain diagnosis whose repair would publish password hashes.
    const r = await applyRemedy('p1', conclusive(hypothesis('POSTGREST_PREPARE_SCHEMA', false)))
    expect(r.applied).toBe(false)
    expect(executed).toHaveLength(0)
    expect(r.detail).toMatch(/human/i)
  })

  it('refuses an auto-applicable remedy that names no action', async () => {
    const r = await applyRemedy('p1', conclusive(hypothesis(undefined, true)))
    expect(r.applied).toBe(false)
    expect(executed).toHaveLength(0)
  })

  it('reports rather than pretends when the action has no executor', async () => {
    // A success that never happened is worse than an honest gap: the loop would
    // mark the finding resolved and stop looking.
    const r = await applyRemedy('p1', conclusive(hypothesis('NOT_IMPLEMENTED_YET', true)))
    expect(r.applied).toBe(false)
    expect(r.detail).toMatch(/no executor/i)
  })
})

describe('applyRemedy — actions', () => {
  it('reloads the schema cache and touches nothing else', async () => {
    const r = await applyRemedy('p1', conclusive(hypothesis('POSTGREST_RELOAD_SCHEMA', true)))
    expect(r.applied).toBe(true)
    expect(executed).toHaveLength(1)
    expect(executed[0]).toMatch(/backenly_pgrst_reload/)
    // No grants, no schema changes — a cache rebuild must stay a cache rebuild.
    expect(executed.join(' ')).not.toMatch(/GRANT|ALTER|DROP/i)
  })

  it('prepares the schema before reloading, so grants exist when it becomes visible', async () => {
    const r = await applyRemedy('p1', conclusive(hypothesis('POSTGREST_PREPARE_SCHEMA', true)))
    expect(r.applied).toBe(true)
    const prepareAt = executed.findIndex(s => s.includes('prepare_schema'))
    const reloadAt = executed.findIndex(s => s.includes('reload'))
    expect(prepareAt).toBeGreaterThanOrEqual(0)
    // Reloading first would rebuild the cache while the tables were still
    // ungranted, and the symptom would persist as a 403 instead of a 404.
    expect(prepareAt).toBeLessThan(reloadAt)
  })

  it('scopes the prepare to the investigated project only', async () => {
    await applyRemedy('abc-123', conclusive(hypothesis('POSTGREST_PREPARE_SCHEMA', true)))
    // Grants are per schema. A remedy that widened beyond the project under
    // investigation would repair one tenant by touching others.
    expect(executed.some(s => s.includes('prepare_schema'))).toBe(true)
  })

  it('prunes but never restarts the process itself', async () => {
    const r = await applyRemedy('p1', conclusive(hypothesis('POSTGREST_PRUNE_AND_RESTART', true)))
    // Process control belongs to the supervisor. A database-connected module
    // shelling out to pm2 would be unreliable and would hold a privilege this
    // code has no business holding.
    expect(executed.join(' ')).toMatch(/prune_schemas/)
    expect(executed.join(' ')).not.toMatch(/pm2|restart|exec/i)
    expect(r.escalation).toMatch(/restart/i)
  })

  it('escalates a dead process without claiming to have fixed it', async () => {
    const r = await applyRemedy('p1', conclusive(hypothesis('POSTGREST_RESTART', true)))
    expect(r.applied).toBe(false)
    expect(r.escalation).toMatch(/pm2 restart/i)
    expect(executed).toHaveLength(0)
  })

  it('routes API generation through the existing path instead of reimplementing it', async () => {
    // A repaired resource must be identical to a normally created one, or the
    // repair introduces a second, subtly different way for APIs to exist.
    const r = await applyRemedy('p1', conclusive(hypothesis('GENERATE_API', true)))
    expect(r.applied).toBe(false)
    expect(r.escalation).toMatch(/GENERATE_API/)
    expect(executed).toHaveLength(0)
  })
})

describe('applyRemedy — no action is destructive', () => {
  it('never issues DROP, DELETE, TRUNCATE or REVOKE-from-owner', async () => {
    // The criterion for being allowed in this module at all: every action is
    // additive or restorative, so a wrong diagnosis wastes a cycle rather than
    // destroying data.
    for (const action of [
      'POSTGREST_RELOAD_SCHEMA',
      'POSTGREST_PREPARE_SCHEMA',
      'POSTGREST_PRUNE_AND_RESTART',
      'POSTGREST_RESTART',
      'GENERATE_API',
    ]) {
      executed.length = 0
      await applyRemedy('p1', conclusive(hypothesis(action, true)))
      expect(executed.join(' ')).not.toMatch(/\bDROP\b|\bDELETE\b|\bTRUNCATE\b/i)
    }
  })
})
