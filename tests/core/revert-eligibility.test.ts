/**
 * REVERT ELIGIBILITY — the Undo button may never outrun the engine
 * -----------------------------------------------------------------
 * The autonomy page now draws an Undo button per auto-applied change. It draws
 * it from `revertEligibility`, and `revertAutoFix` gates on the same function,
 * so the button's precondition and the engine's precondition are one thing.
 *
 * This guard exists because the failure it prevents has already shipped in this
 * codebase once, in a different button: the dashboard drew an enabled "Fix now"
 * on hot-table findings that arrived with no column to index, and every click
 * returned an error. An Undo button that fails is strictly worse — pressing it
 * is how a user decides whether the loop can be trusted at all.
 *
 * Part 1 is pure: every shape of recorded fix maps to the right verdict.
 * Part 2 drives `revertAutoFix` against real HealthFinding rows and asserts the
 * engine agrees with the predicate on each one — including that it refuses an
 * un-revertible fix BEFORE asking a user to confirm re-exposing their data.
 */

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals'
import { prisma } from '@/lib/db/prisma'
import { revertEligibility, revertAutoFix } from '@/lib/core/auto-fix-engine'

describe('revertEligibility — pure verdicts', () => {
  test('a fix with no rollbackData is not revertible', () => {
    const e = revertEligibility('missing_fk_index', { tableName: 'orders' })
    expect(e.revertible).toBe(false)
    expect(e.requiresConfirmation).toBe(false)
    expect(e.reason).toMatch(/no rollback data/i)
  })

  test('a pre-contract fix (format 1) is not revertible, and says why', () => {
    const e = revertEligibility('missing_fk_index', {
      tableName: 'orders',
      rollbackData: { rollbackFormat: 1, snapshotId: 'snap-1', schemaTouching: true },
    })
    expect(e.revertible).toBe(false)
    // The specific hazard: its snapshot is POST-fix, so a revert would no-op
    // while reporting success. Saying so is the whole point of refusing.
    expect(e.reason).toMatch(/AFTER the fix/i)
  })

  test('a schema-touching fix whose snapshot capture failed is not revertible', () => {
    const e = revertEligibility('missing_fk_index', {
      tableName: 'orders',
      rollbackData: { rollbackFormat: 2, schemaTouching: true, snapshotId: null },
    })
    expect(e.revertible).toBe(false)
    expect(e.reason).toMatch(/no pre-fix snapshot/i)
  })

  test('a format-2 index fix is revertible with one click', () => {
    const e = revertEligibility('missing_fk_index', {
      tableName: 'orders',
      rollbackData: { rollbackFormat: 2, schemaTouching: true, snapshotId: 'snap-1' },
    })
    expect(e.revertible).toBe(true)
    expect(e.requiresConfirmation).toBe(false)
  })

  test('metadata-only fixes need no snapshot to be revertible', () => {
    const e = revertEligibility('missing_api_definition', {
      tableName: 'orders',
      rollbackData: { rollbackFormat: 2, schemaTouching: false, snapshotId: null },
    })
    expect(e.revertible).toBe(true)
  })

  // Undoing RLS re-exposes every user's rows to every other user. That is a
  // Tier-2 action arriving through a Tier-1 undo, so it can never be one click.
  test.each(['missing_rls', 'unprotected_user_data', 'rls_expression_invalid'])(
    '%s undo requires explicit confirmation',
    (type) => {
      const e = revertEligibility(type, {
        tableName: 'posts',
        rollbackData: { rollbackFormat: 2, schemaTouching: true, snapshotId: 'snap-1' },
      })
      expect(e.revertible).toBe(true)
      expect(e.requiresConfirmation).toBe(true)
    },
  )

  test('aliased dynamic types resolve to their base before the RLS check', () => {
    // The loop writes `${category}_${location}` types (missing_rls_posts). If
    // the confirmation gate read the raw type it would miss every one of them
    // and hand out silent one-click RLS removal.
    const e = revertEligibility('missing_rls_posts', {
      tableName: 'posts',
      rollbackData: { rollbackFormat: 2, schemaTouching: true, snapshotId: 'snap-1' },
    })
    expect(e.requiresConfirmation).toBe(true)
  })
})

// ── Part 2: the engine honours the same verdicts ─────────────────────────────

describe('revertAutoFix — engine agrees with the predicate', () => {
  let projectId: string
  let userId: string
  const findingIds: string[] = []

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: {
        email: `revert-test-${Date.now()}@example.test`,
        password: 'x',
        name: 'revert test',
      },
    })
    userId = user.id
    const project = await prisma.project.create({
      data: { name: 'revert-eligibility-test', userId },
    })
    projectId = project.id
  })

  afterAll(async () => {
    await prisma.healthFinding.deleteMany({ where: { projectId } }).catch(() => {})
    await prisma.project.delete({ where: { id: projectId } }).catch(() => {})
    await prisma.user.delete({ where: { id: userId } }).catch(() => {})
  })

  const seed = async (type: string, details: Record<string, unknown>) => {
    const f = await prisma.healthFinding.create({
      data: {
        projectId,
        type,
        severity: 'warning',
        details: details as any,
        status: 'auto_fixed',
        autoFixed: true,
        fixAppliedAt: new Date(),
      },
    })
    findingIds.push(f.id)
    return f.id
  }

  test('refuses a fix with no rollbackData', async () => {
    const id = await seed('missing_fk_index', { tableName: 'orders' })
    const res = await revertAutoFix(id, projectId)
    expect(res.success).toBe(false)
    expect(res.requiresConfirmation).toBeFalsy()
    expect(res.message).toMatch(/no rollback data/i)
  })

  test('refuses a legacy format-1 fix', async () => {
    const id = await seed('missing_fk_index', {
      tableName: 'orders',
      rollbackData: { rollbackFormat: 1, schemaTouching: true, snapshotId: 'gone' },
    })
    const res = await revertAutoFix(id, projectId)
    expect(res.success).toBe(false)
    expect(res.message).toMatch(/AFTER the fix/i)
  })

  // The ordering assertion. Before the shared predicate, an un-revertible RLS
  // fix asked the user to confirm re-exposing their data and THEN told them the
  // undo was impossible. Refusing first is the only honest order.
  test('an un-revertible RLS fix is refused, not offered for confirmation', async () => {
    const id = await seed('missing_rls', {
      tableName: 'posts',
      rollbackData: { rollbackFormat: 1, schemaTouching: true, snapshotId: 'gone' },
    })
    const res = await revertAutoFix(id, projectId)
    expect(res.success).toBe(false)
    expect(res.requiresConfirmation).toBeFalsy()
    expect(res.message).toMatch(/AFTER the fix/i)
  })

  test('a revertible RLS fix asks for confirmation before acting', async () => {
    const id = await seed('missing_rls', {
      tableName: 'posts',
      rollbackData: { rollbackFormat: 2, schemaTouching: true, snapshotId: 'snap-missing' },
    })
    const res = await revertAutoFix(id, projectId)
    expect(res.success).toBe(false)
    expect(res.requiresConfirmation).toBe(true)
    expect(res.message).toMatch(/removes row-level security/i)
  })

  test('a finding that is not auto_fixed cannot be reverted', async () => {
    const f = await prisma.healthFinding.create({
      data: {
        projectId,
        type: 'missing_fk_index',
        severity: 'warning',
        details: { tableName: 'orders' } as any,
        status: 'open',
      },
    })
    findingIds.push(f.id)
    const res = await revertAutoFix(f.id, projectId)
    expect(res.success).toBe(false)
    expect(res.message).toMatch(/not found or not in auto_fixed/i)
  })
})
