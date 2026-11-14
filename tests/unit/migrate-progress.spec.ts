/**
 * Moving a project in: what the move screen promises, held to the code.
 *
 *   - Nothing is offered until the release publishes it (NEXT_PUBLIC_MIGRATION).
 *   - The ledger never shows more rows on Backenly than the source has, steps
 *     in the importer's batches of 500, and calls a table matched only once
 *     both counts are equal.
 *   - Matched tables only ever go up, and the move ends with every table
 *     matched and the access rules waiting for a person.
 */
import { migrationPublished } from '@/components/migrate/flag'
import { DEMO_PLANS, durationOf, progressAt, rowsTotal, type MovePlan } from '@/components/migrate/plan'

const PLANS: MovePlan[] = Object.values(DEMO_PLANS)

describe('moving a project in is offered only once published', () => {
  it('is off by default and for any value but "published"', () => {
    expect(migrationPublished(undefined)).toBe(false)
    expect(migrationPublished('')).toBe(false)
    expect(migrationPublished('true')).toBe(false)
    expect(migrationPublished('published')).toBe(true)
  })
})

describe.each(PLANS.map((plan) => [plan.source, plan] as const))('the %s move', (_source, plan) => {
  const duration = durationOf(plan)
  const times = Array.from({ length: 121 }, (_, i) => (duration * i) / 120)

  it('starts with nothing copied and every table waiting', () => {
    const p = progressAt(plan, 0)
    expect(p.reading).toBe(true)
    expect(p.finished).toBe(false)
    expect(p.fraction).toBe(0)
    expect(p.tables.every((row) => row.phase === 'waiting' && row.done === 0)).toBe(true)
  })

  it('never shows more on Backenly than the source has, and steps in batches of 500', () => {
    for (const t of times) {
      const p = progressAt(plan, t)
      p.tables.forEach((row, i) => {
        expect(row.total).toBe(plan.tables[i].rows)
        expect(row.done).toBeGreaterThanOrEqual(0)
        expect(row.done).toBeLessThanOrEqual(row.total)
        if (row.phase === 'copying') expect(row.done % 500).toBe(0)
        if (row.phase === 'matched' || row.phase === 'checking') expect(row.done).toBe(row.total)
      })
      expect(p.fraction).toBeGreaterThanOrEqual(0)
      expect(p.fraction).toBeLessThanOrEqual(1)
    }
  })

  it('only ever adds matched tables', () => {
    let last = 0
    for (const t of times) {
      const matched = progressAt(plan, t).matchedTables
      expect(matched).toBeGreaterThanOrEqual(last)
      last = matched
    }
  })

  it('ends with every table matched and the access rules waiting for review', () => {
    const p = progressAt(plan, duration)
    expect(p.finished).toBe(true)
    expect(p.fraction).toBe(1)
    expect(p.matchedTables).toBe(plan.tables.length)
    expect(p.tables.reduce((sum, row) => sum + row.done, 0)).toBe(rowsTotal(plan))
    if (plan.rules) expect(p.rules?.phase).toBe('review')
    if (plan.users !== undefined) expect(p.users?.done).toBe(plan.users)
    if (plan.files) expect(p.files?.done).toBe(plan.files.count)
  })
})
