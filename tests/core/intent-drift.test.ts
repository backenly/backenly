/**
 * INTENT DRIFT — the check that was written, tested, and never run
 * -----------------------------------------------------------------
 * `checkIntentConformance` existed, had a pure unit-testable core, and was
 * reachable from exactly one MCP tool. It was never in the invariant catalogue,
 * so the per-minute loop never called it, the reaper could never withdraw its
 * findings, and the trust report never counted it.
 *
 * The failure it exists for is in its own docstring: a column requested as
 * `timestamp` was created as `integer` in May, and every probe stayed green for
 * two months, because a column that is `integer` looks perfectly healthy in the
 * catalog. Nothing distinguishes it from one that was always meant to be
 * `integer` — the information needed to notice was never missing from the
 * database, it was never written down.
 *
 * This reproduces exactly that case and follows it all the way to a finding.
 */

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals'
import { prisma } from '@/lib/db/prisma'
import {
  recordSchemaIntent,
  detectIntentDrift,
  checkIntentConformance,
} from '@/lib/autonomy/intent-conformance'
import { INVARIANTS, deriveTier } from '@/lib/autonomy/desired-state'
import { classifyFix } from '@/lib/core/fix-classifier'
import { buildFixAction, getManualRemediationHint, hasExecutableFix } from '@/lib/core/fix-actions'

let userId: string
let projectId: string
let schema: string
let findings: Awaited<ReturnType<typeof detectIntentDrift>>

const drift = (column: string) =>
  findings.find(f => (f.details as any).columnName === column)

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `intent-drift-${Date.now()}@example.test`, password: 'x', name: 'intent' },
  })
  userId = user.id
  const project = await prisma.project.create({ data: { name: 'intent-drift-test', userId } })
  projectId = project.id
  schema = `workspace_${projectId}`

  const raw = (sql: string) => prisma.$executeRawUnsafe(sql)
  await raw(`CREATE SCHEMA "${schema}"`)
  // Asked for a timestamp, got an integer. The catalog is perfectly happy.
  await raw(`CREATE TABLE "${schema}"."events" (
    id serial primary key, start_date integer, note text
  )`)
  await recordSchemaIntent(projectId, 'events', [
    { name: 'start_date', type: 'timestamp' },
    { name: 'note', type: 'text' },
  ], 'create_table')

  findings = await detectIntentDrift(projectId)
}, 60_000)

afterAll(async () => {
  await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
  await prisma.schemaIntent.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.project.delete({ where: { id: projectId } }).catch(() => {})
  await prisma.user.delete({ where: { id: userId } }).catch(() => {})
})

describe('the loop actually runs this check', () => {
  test('it is registered in the invariant catalogue', () => {
    // The whole defect: the mechanism existed and the catalogue did not know
    // about it, so the every-minute loop never called it.
    const inv = INVARIANTS.find(i => i.id === 'the_schema_is_what_was_asked_for')
    expect(inv).toBeDefined()
    expect(inv!.probe).toBe(detectIntentDrift)
  })
})

describe('a column that is the wrong kind of thing', () => {
  test('the catalog alone cannot see it', async () => {
    // Proof the fixture is the hard case rather than an obviously broken schema:
    // `integer` is a valid, healthy column type and every catalog-only probe in
    // the platform is satisfied by it.
    const rows = await prisma.$queryRawUnsafe<Array<{ data_type: string }>>(
      `SELECT data_type FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'events' AND column_name = 'start_date'`,
      schema,
    )
    expect(rows[0].data_type).toBe('integer')
  })

  test('the intent ledger sees it', () => {
    const f = drift('start_date')
    expect(f).toBeDefined()
    const d = f!.details as any
    expect(d.driftKind).toBe('type_drift')
    expect(d.requested).toContain('timestamp')
    expect(d.actual).toContain('integer')
  })

  test('a column that matches its request produces nothing', () => {
    expect(drift('note')).toBeUndefined()
  })

  test('a wrong TYPE is critical — it silently corrupts every read', () => {
    expect(drift('start_date')!.severity).toBe('critical')
  })
})

describe('routing', () => {
  test('never auto-applied: the remedy is a migration against live data', () => {
    const d = drift('start_date')!.details as any
    expect(drift('start_date')!.autoFixable).toBe(false)
    expect(classifyFix('intent_drift', d).decision).toBe('notify_only')
    expect(deriveTier('intent_drift', d)).toBe(3)
    expect(buildFixAction('intent_drift', d)).toBeNull()
    expect(hasExecutableFix('intent_drift', d)).toBe(false)
  })

  test('the risk note names what the migration actually does', () => {
    expect(classifyFix('intent_drift', {}).riskNote).toMatch(/rewrites the column/i)
  })

  test('the hint hands over the exact statement', () => {
    const d = drift('start_date')!.details as any
    expect(d.migration).toMatch(/^ALTER TABLE .* ALTER COLUMN "start_date" TYPE timestamp/)
    const hint = getManualRemediationHint('intent_drift', d)!
    expect(hint).toContain(d.migration)
    // And names the other possibility, because the ledger records the REQUEST
    // and a deliberate later change makes the ledger the stale side.
    expect(hint).toMatch(/deliberately different/i)
  })
})

describe('the ledger is never reconciled to reality', () => {
  test('re-running the check does not make the drift go away', async () => {
    // A ledger that self-heals to match the catalog agrees with it by
    // construction and can never detect anything — the same property as a
    // monitor that cannot fail.
    const before = await checkIntentConformance(projectId)
    const after = await checkIntentConformance(projectId)
    expect(after.findings.length).toBe(before.findings.length)
    expect(after.findings.length).toBeGreaterThan(0)
  }, 30_000)
})
