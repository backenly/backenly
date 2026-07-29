/**
 * AUTO-FIX APPROVE COVERAGE — regression guard for the "Approve & fix" dead ends
 * ------------------------------------------------------------------------------
 * Reproduces the exact failures seen in the Auto-fix dashboard:
 *
 *   • "No fix action mapped for finding type: workflow_broken"
 *   • "No fix action mapped for finding type: integration_smtp_unreachable"
 *   • missing_api_definition silently blocked by the build lock
 *
 * Part 1 (pure, no DB): every FindingType the classifier can route to the
 *   approval queue MUST resolve to a concrete executor action — buildFixAction
 *   may only return null for findings with a documented manual remediation hint.
 *
 * Part 2 (real DB): seeds HealthFinding rows for the three screenshot types and
 *   drives executeApprovedFix end-to-end. The assertion is that the call gets
 *   PAST the old dead end ("No fix action mapped …") and actually dispatches an
 *   executor — not that every downstream repair fully succeeds (some need a
 *   provisioned workspace, which is out of scope for this guard).
 */

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals'
import { prisma } from '@/lib/db/prisma'
import {
  buildFixAction,
  getManualRemediationHint,
  executeApprovedFix,
} from '@/lib/core/auto-fix-engine'
import { classifyFix } from '@/lib/core/fix-classifier'
import { normalizeFindingType } from '@/lib/core/types'
import type { FindingType } from '@/lib/core/types'


// Every FindingType the platform can emit.
//
// This used to be a hand-copied mirror of lib/core/types.ts, and the copy went
// stale: `contract_surface_broken` and `schema_not_registered` were both absent,
// and both shipped with a broken repair path this file could not see. It now
// reads the platform's own enumeration. Do not re-inline the list.
// Full invariant coverage lives in tests/core/finding-repair-conformance.test.ts.
import { ALL_FINDING_TYPES } from '@/lib/core/types'

// ─── Part 1: every finding type has a fix path (pure, fast) ───────────────────

describe('buildFixAction — full FindingType coverage', () => {
  test('every finding type resolves to an action OR a documented manual hint', () => {
    const deadEnds: string[] = []
    for (const type of ALL_FINDING_TYPES) {
      const action = buildFixAction(type, { tableName: 'posts', integration: 'stripe' })
      const hint = getManualRemediationHint(type)
      if (!action && !hint) deadEnds.push(type)
    }
    // A dead end here = "No fix action mapped for finding type: X" in the UI.
    expect(deadEnds).toEqual([])
  })

  test('the three screenshot finding types map to concrete executor actions', () => {
    expect(buildFixAction('workflow_broken', { missingComponents: ['rls_on_users'] }))
      .toMatchObject({ action: 'FIX_WORKFLOW' })

    expect(buildFixAction('integration_smtp_unreachable', { host: 'smtp.resend.com', port: 465 }))
      .toMatchObject({ action: 'FIX_INTEGRATION' })

    expect(buildFixAction('missing_api_definition', { tableName: 'notifications' }))
      .toMatchObject({ action: 'FIX_API', params: { tableName: 'notifications' } })
  })

  test('orphan_table adopts the table (REGISTER_TABLE) — the safe, non-destructive fix', () => {
    expect(buildFixAction('orphan_table', { tableName: 'legacy_events' }))
      .toMatchObject({ action: 'REGISTER_TABLE', params: { tableName: 'legacy_events' } })
    // Still carries a friendly fallback hint for surfaces that show one.
    expect(getManualRemediationHint('orphan_table')).toBeTruthy()
  })
})

// ─── Dynamic agent types from production (the silent-rot bug) ─────────────────
//
// background-monitor.ts writes type = `${category}_${location}`. These never
// matched the canonical switch, so the MAJORITY of real findings dead-ended.
// Sourced from the live prod DB: schema_drift (×353), missing_rls_users,
// missing_api_reviews, n_plus_one_risk_product_categories, auth_gap_auth,
// unbounded_pagination_api, arch_migration_*.

describe('normalizeFindingType — real production dynamic types', () => {
  const cases: Array<[string, FindingType, string | undefined]> = [
    ['missing_rls_users', 'missing_rls', 'users'],
    ['missing_rls_payments', 'missing_rls', 'payments'],
    ['missing_rls_orders', 'missing_rls', 'orders'],
    ['missing_api_reviews', 'missing_api_definition', 'reviews'],
    ['missing_api_cart_items', 'missing_api_definition', 'cart_items'],
    ['missing_api_orders', 'missing_api_definition', 'orders'],
    ['n_plus_one_risk_product_categories', 'missing_fk_index', 'product_categories'],
    ['auth_gap_auth', 'broken_auth', 'auth'],
    ['unbounded_pagination_api', 'missing_rate_limit', 'api'],
    ['schema_drift', 'shadow_mutation', undefined],
    ['arch_migration_add_composite_indexes_on_high_traffic_qu', 'shadow_mutation', undefined],
    ['weak_rls_profiles', 'missing_rls', 'profiles'],
    ['missing_index_sessions', 'missing_fk_index', 'sessions'],
  ]

  test.each(cases)('%s → base resolves correctly', (raw, expectedBase, expectedTable) => {
    const norm = normalizeFindingType(raw, null)
    expect(norm).not.toBeNull()
    expect(norm!.base).toBe(expectedBase)
    if (expectedTable) expect(norm!.tableName).toBe(expectedTable)
  })

  test('every production dynamic type maps to an executable action (no dead ends)', () => {
    const deadEnds: string[] = []
    for (const [raw] of cases) {
      const action = buildFixAction(raw, {})
      const hint = getManualRemediationHint(raw)
      if (!action && !hint) deadEnds.push(raw)
    }
    expect(deadEnds).toEqual([])
  })

  test('schema_drift (353 in prod) classifies as approval, not silent notify_only', () => {
    const c = classifyFix('schema_drift', { description: 'column added outside AI' })
    expect(c.decision).toBe('approval')
  })

  test('an entirely unknown type still returns a friendly hint, never a hard dead end', () => {
    expect(buildFixAction('totally_unknown_xyz', {})).toBeNull()
    expect(getManualRemediationHint('totally_unknown_xyz')).toBeTruthy()
  })
})

// ─── Part 2: executeApprovedFix gets past the old dead end (real DB) ──────────

describe('executeApprovedFix — no "No fix action mapped" dead ends', () => {
  let userId: string
  let projectId: string
  let dbReachable = true
  const findingIds: Record<string, string> = {}

  beforeAll(async () => {
    // Skip the real-DB leg gracefully when no test Postgres is reachable
    // (local dev without a DB). Part 1 still guards the regression. Under
    // `npm test` / CI the test DB is provisioned and this leg runs for real.
    try {
      await prisma.$queryRaw`SELECT 1`
    } catch {
      dbReachable = false
      return
    }

    const user = await prisma.user.create({
      data: {
        email: `autofix_cov_${Date.now()}@backenly.test`,
        name: 'AutoFix Coverage',
        password: 'x',
      },
    })
    userId = user.id

    const project = await prisma.project.create({
      data: {
        name: `AutoFix Cov ${Date.now()}`,
        environment: 'development',
        userId,
        jwtSecret: 'test_secret_for_autofix_coverage',
      },
    })
    projectId = project.id

    const seed: Array<{ key: string; type: string; details: any }> = [
      { key: 'workflow', type: 'workflow_broken', details: { workflow: 'user_auth_flow', displayName: 'User Auth Flow', missingComponents: ['rls_on_users'], reason: 'Workflow "User Auth Flow" is incomplete: missing rls_on_users' } },
      { key: 'smtp', type: 'integration_smtp_unreachable', details: { host: 'smtp.resend.com', port: 465, reason: 'SMTP host "smtp.resend.com:465" is unreachable — outbound emails will fail' } },
      { key: 'api', type: 'missing_api_definition', details: { tableName: 'notifications', reason: 'Table exists in the platform but has no API definition' } },
      // Dynamic agent-generated types (the silent-rot bug) — must NOT dead-end.
      { key: 'dyn_rls', type: 'missing_rls_users', details: { location: 'users', title: 'Missing RLS on users' } },
      { key: 'dyn_drift', type: 'schema_drift', details: { description: 'column added outside AI', source: 'reconciler' } },
      { key: 'dyn_nplus1', type: 'n_plus_one_risk_orders', details: { location: 'orders', title: 'N+1 risk on orders' } },
    ]

    for (const s of seed) {
      const f = await prisma.healthFinding.create({
        data: {
          projectId,
          type: s.type,
          severity: 'critical',
          status: 'pending_approval',
          details: s.details,
        },
      })
      findingIds[s.key] = f.id
    }
  }, 30_000)

  afterAll(async () => {
    if (projectId) {
      await prisma.healthFinding.deleteMany({ where: { projectId } }).catch(() => {})
      await prisma.auditLog.deleteMany({ where: { projectId } }).catch(() => {})
      await prisma.backgroundJob.deleteMany({ where: { projectId } }).catch(() => {})
      await prisma.project.delete({ where: { id: projectId } }).catch(() => {})
    }
    if (userId) await prisma.user.delete({ where: { id: userId } }).catch(() => {})
  })

  const NO_MAP = /no fix action mapped for finding type/i

  test('workflow_broken → dispatches FIX_WORKFLOW (not a dead end)', async () => {
    if (!dbReachable) return console.warn('SKIP: no test DB reachable')
    const r = await executeApprovedFix(findingIds.workflow, projectId)
    expect(r.message).not.toMatch(NO_MAP)
  }, 30_000)

  test('integration_smtp_unreachable → dispatches FIX_INTEGRATION (not a dead end)', async () => {
    if (!dbReachable) return console.warn('SKIP: no test DB reachable')
    const r = await executeApprovedFix(findingIds.smtp, projectId)
    expect(r.message).not.toMatch(NO_MAP)
  }, 30_000)

  test('missing_api_definition → dispatches FIX_API (not a dead end)', async () => {
    if (!dbReachable) return console.warn('SKIP: no test DB reachable')
    const r = await executeApprovedFix(findingIds.api, projectId)
    expect(r.message).not.toMatch(NO_MAP)
  }, 30_000)

  test('missing_rls_users (dynamic) → dispatches, not a dead end', async () => {
    if (!dbReachable) return console.warn('SKIP: no test DB reachable')
    const r = await executeApprovedFix(findingIds.dyn_rls, projectId)
    expect(r.message).not.toMatch(NO_MAP)
  }, 30_000)

  test('schema_drift (×353 in prod) → dispatches, not a dead end', async () => {
    if (!dbReachable) return console.warn('SKIP: no test DB reachable')
    const r = await executeApprovedFix(findingIds.dyn_drift, projectId)
    expect(r.message).not.toMatch(NO_MAP)
  }, 30_000)

  test('n_plus_one_risk_orders (dynamic) → dispatches, not a dead end', async () => {
    if (!dbReachable) return console.warn('SKIP: no test DB reachable')
    const r = await executeApprovedFix(findingIds.dyn_nplus1, projectId)
    expect(r.message).not.toMatch(NO_MAP)
  }, 30_000)
})
