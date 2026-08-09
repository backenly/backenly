/**
 * FINDING REPAIR CONFORMANCE — the guard that makes a dead "Approve & fix"
 * button impossible to ship.
 *
 * ── The incident this encodes ───────────────────────────────────────────────
 *
 * The Autonomy queue showed a critical finding:
 *
 *   The live db API surface is failing: GET /db/profiles returned 502
 *   — Data plane unavailable                      [Approve & fix]
 *
 * Clicking it produced: "Backenly flagged this but has no automatic repair for
 * it yet." The button could never have worked. `contract_surface_broken` was
 * absent from the normalizer's canonical set, so `buildFixAction` returned null
 * for it — and the queue rendered its fix button unconditionally, because the
 * mapping lived in a prisma-importing module the client could not read.
 *
 * A second instance of the same class was live at the same time and had been
 * for longer: `schema_not_registered` is classified AUTO with the suggested
 * action `REGISTER_POSTGREST_SCHEMA` — an executor verb that never existed —
 * so any such finding that reached the approve route dead-ended too.
 *
 * The existing coverage test could not see either one, because it enumerated
 * finding types from a list hand-copied into the test file, and neither type
 * was in the copy.
 *
 * ── What is asserted, and why each one is load-bearing ──────────────────────
 *
 *   1. The type list comes from ALL_FINDING_TYPES (lib/core/types.ts), not from
 *      a copy here. A new type is covered the moment it is declared.
 *   2. Every type resolves to an executable action OR an honest manual hint.
 *   3. The classifier and the executor agree: anything rated auto/approval MUST
 *      have an action. This is the invariant schema_not_registered broke.
 *   4. Every action the mapping can emit is a verb the executor actually
 *      dispatches. This is the invariant REGISTER_POSTGREST_SCHEMA broke.
 *   5. The UI contract: a group is never marked actionable without a real fix,
 *      and never left non-actionable without a hint to show in the button's
 *      place.
 */

import { describe, test, expect } from '@jest/globals'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ALL_FINDING_TYPES, normalizeFindingType } from '@/lib/core/types'
import {
  buildFixAction,
  getManualRemediationHint,
  hasExecutableFix,
  isDataPlaneOutage,
} from '@/lib/core/fix-actions'
import { classifyFix } from '@/lib/core/fix-classifier'
import { groupFindings } from '@/lib/core/finding-groups'

/**
 * Representative details per type — the shape its detector really writes.
 *
 * Some repairs are legitimately details-dependent (`ai_action_pending` has
 * nothing to run without a recorded `executorAction`; `contract_surface_broken`
 * is repairable only in its data-plane shape), so a bare `{}` would under-report
 * what the mapping can do. Anything not listed gets the generic table fixture.
 */
const GENERIC_DETAILS: Record<string, unknown> = {
  tableName: 'posts',
  columnName: 'user_id',
  referencedTable: 'users',
  integration: 'stripe',
  host: 'smtp.example.com',
  port: 587,
  workflow: 'user_auth_flow',
}

const DETAILS_BY_TYPE: Partial<Record<string, Record<string, unknown>>> = {
  ai_action_pending: { executorAction: 'CREATE_INDEX', executorParams: { tableName: 'posts' } },
  contract_surface_broken: { surface: 'db', httpStatus: 502, detail: 'GET /db/profiles returned 502' },
  // The repair is DROP INDEX, so it needs the index NAME. The generic fixture
  // carries a column, and a column is not enough: a table normally has several
  // indexes and deriving one from the table would drop an arbitrary one.
  // detectUnusedIndexes always writes indexName, so this is its real shape.
  unused_index: {
    tableName: 'posts',
    indexName: 'idx_posts_legacy_slug',
    observedDays: 21,
    sizeBytes: 4 * 1024 * 1024,
  },
  // Same reason as unused_index: the repair is REINDEX on one index, and a
  // table name cannot name which.
  index_bloat: {
    tableName: 'posts',
    indexName: 'idx_posts_legacy_slug',
    leafDensityPct: 12.4,
    sizeBytes: 40 * 1024 * 1024,
  },
}

const detailsFor = (type: string): Record<string, unknown> =>
  DETAILS_BY_TYPE[type] ?? GENERIC_DETAILS

/** Every action verb `executeAction`'s dispatch switch actually handles. */
function executorActionVerbs(): Set<string> {
  const source = readFileSync(
    join(process.cwd(), 'lib', 'ai', 'minimal-executor.ts'),
    'utf8',
  )
  const verbs = new Set<string>()
  for (const m of source.matchAll(/case\s+'([A-Z][A-Z0-9_]+)'\s*:/g)) {
    verbs.add(m[1])
  }
  return verbs
}

// ─── 1 + 2: no dead ends, across the REAL type list ──────────────────────────

describe('every finding type has a repair path', () => {
  test('the enumeration is the one the platform declares, not a copy', () => {
    // If this ever drifts, the guard below is silently testing a subset — which
    // is exactly how contract_surface_broken shipped broken.
    expect(ALL_FINDING_TYPES.length).toBeGreaterThan(30)
    expect(ALL_FINDING_TYPES).toContain('contract_surface_broken')
    expect(ALL_FINDING_TYPES).toContain('schema_not_registered')
    for (const type of ALL_FINDING_TYPES) {
      expect(normalizeFindingType(type, null)?.base).toBe(type)
    }
  })

  test('every type resolves to an executable action OR a manual hint', () => {
    const deadEnds = ALL_FINDING_TYPES.filter((type) => {
      const details = detailsFor(type)
      return !buildFixAction(type, details) && !getManualRemediationHint(type, details)
    })
    // A dead end here reaches a user as a button that fails on click.
    expect(deadEnds).toEqual([])
  })
})

// ─── 3: the classifier and the executor must agree ───────────────────────────

describe('classifier ↔ executor agreement', () => {
  test('anything rated auto or approval has a concrete executor action', () => {
    const promisedButUnbuildable = ALL_FINDING_TYPES.filter((type) => {
      const details = detailsFor(type)
      const decision = classifyFix(type, details).decision
      if (decision === 'notify_only') return false
      return buildFixAction(type, details) === null
    })
    // `schema_not_registered` was in this list: rated AUTO, no mapping. The
    // loop reported "No fix action mapped" into a void and the finding sat
    // open forever with the customer's /db/* plane dead.
    expect(promisedButUnbuildable).toEqual([])
  })

  test('anything rated notify_only explains itself instead of going silent', () => {
    const silent = ALL_FINDING_TYPES.filter((type) => {
      const details = detailsFor(type)
      if (classifyFix(type, details).decision !== 'notify_only') return false
      return !getManualRemediationHint(type, details)
    })
    expect(silent).toEqual([])
  })
})

// ─── 4: no action verb may be fiction ────────────────────────────────────────

describe('emitted actions are real executor verbs', () => {
  const verbs = executorActionVerbs()

  test('the verb list was actually parsed', () => {
    expect(verbs.size).toBeGreaterThan(30)
    expect(verbs.has('SET_PERMISSION')).toBe(true)
  })

  test('every action buildFixAction can emit is dispatched by the executor', () => {
    const fictional: Array<[string, string]> = []
    for (const type of ALL_FINDING_TYPES) {
      const action = buildFixAction(type, detailsFor(type))
      if (action && !verbs.has(action.action)) fictional.push([type, action.action])
    }
    expect(fictional).toEqual([])
  })

  test('the new repair verbs are wired end to end', () => {
    expect(verbs.has('HEAL_DATA_PLANE')).toBe(true)
    expect(verbs.has('REGISTER_SCHEMA')).toBe(true)
  })
})

// ─── 5: the UI can never render a button that cannot fire ────────────────────

describe('finding groups carry honest repairability', () => {
  const asFinding = (id: string, type: string, details: Record<string, unknown>) => ({
    id,
    type,
    severity: 'critical',
    details,
    status: 'pending_approval',
    detectedAt: new Date().toISOString(),
  })

  test('actionable is true only when a member really has a fix', () => {
    for (const type of ALL_FINDING_TYPES) {
      const details = detailsFor(type)
      const [group] = groupFindings([asFinding('f1', type, details)])
      expect(group.actionable).toBe(hasExecutableFix(type, details))
      expect(group.fixableCount).toBe(hasExecutableFix(type, details) ? 1 : 0)
    }
  })

  test('a non-actionable group always carries a hint to show instead', () => {
    const naked = ALL_FINDING_TYPES
      .map((type) => groupFindings([asFinding('f1', type, detailsFor(type))])[0])
      .filter((g) => !g.actionable && !g.manualHint)
    expect(naked).toEqual([])
  })

  test('fixableCount reflects the fixable members, not the member count', () => {
    // A repairable gated action alongside one that recorded no executorAction.
    const groups = groupFindings([
      asFinding('a', 'ai_action_pending', { executorAction: 'CREATE_INDEX', executorParams: {} }),
      asFinding('b', 'ai_action_pending', {}),
    ])
    const total = groups.reduce((n, g) => n + g.fixableCount, 0)
    const members = groups.reduce((n, g) => n + g.members.length, 0)
    expect(members).toBe(2)
    expect(total).toBe(1)
  })
})

// ─── The reported incident, as a regression test ─────────────────────────────

describe('the reported incident: GET /db/profiles returned 502', () => {
  const incident = {
    surface: 'db',
    httpStatus: 502,
    detail: 'GET /db/profiles returned 502 — Data plane unavailable',
  }

  test('is recognised as a data-plane outage', () => {
    expect(isDataPlaneOutage(incident)).toBe(true)
  })

  test('maps to the data-plane heal instead of dead-ending', () => {
    expect(buildFixAction('contract_surface_broken', incident))
      .toMatchObject({ action: 'HEAL_DATA_PLANE' })
  })

  test('is healed autonomously rather than queued for a human', () => {
    expect(classifyFix('contract_surface_broken', incident).decision).toBe('auto')
  })

  test('no longer answers with the generic no-repair string', () => {
    const hint = getManualRemediationHint('contract_surface_broken', incident)
    expect(hint).not.toMatch(/no automatic repair for it yet/i)
  })

  test('renders an enabled fix button', () => {
    const [g] = groupFindings([{
      id: 'f1',
      type: 'contract_surface_broken',
      severity: 'critical',
      details: incident,
      status: 'pending_approval',
      detectedAt: new Date().toISOString(),
    }])
    expect(g.actionable).toBe(true)
    expect(g.fixableCount).toBe(1)
  })
})

describe('surfaces with no executable repair stay honest', () => {
  // A 404 on /db/x is a missing API definition, not a downed data plane.
  // Restarting PostgREST for it would be a guess dressed up as a repair.
  test('a non-upstream db failure is not treated as an outage', () => {
    expect(isDataPlaneOutage({ surface: 'db', httpStatus: 404 })).toBe(false)
    expect(buildFixAction('contract_surface_broken', { surface: 'db', httpStatus: 404 })).toBeNull()
  })

  test('a probe that threw before any response IS an outage', () => {
    expect(isDataPlaneOutage({ surface: 'db', httpStatus: null })).toBe(true)
  })

  test.each(['auth', 'storage', 'functions', 'healthz'])(
    '%s failures get a surface-specific hint and no fix button',
    (surface) => {
      const details = { surface, httpStatus: 502 }
      expect(buildFixAction('contract_surface_broken', details)).toBeNull()
      const hint = getManualRemediationHint('contract_surface_broken', details)
      expect(hint).toBeTruthy()
      expect(hint).not.toMatch(/no automatic repair for it yet/i)

      const [g] = groupFindings([{
        id: 'f1', type: 'contract_surface_broken', severity: 'warning',
        details, status: 'pending_approval', detectedAt: new Date().toISOString(),
      }])
      expect(g.actionable).toBe(false)
      expect(g.manualHint).toBeTruthy()
    },
  )
})

// ─── schema_not_registered — the second dead end ─────────────────────────────

describe('schema_not_registered reaches a real repair', () => {
  test('maps to REGISTER_SCHEMA', () => {
    expect(buildFixAction('schema_not_registered', { schema: 'workspace_abc', tableCount: 4 }))
      .toMatchObject({ action: 'REGISTER_SCHEMA' })
  })

  test('stays classified auto, and now has the action that rating implied', () => {
    const c = classifyFix('schema_not_registered', { schema: 'workspace_abc' })
    expect(c.decision).toBe('auto')
    expect(c.suggestedAction).toBe('REGISTER_SCHEMA')
  })
})
