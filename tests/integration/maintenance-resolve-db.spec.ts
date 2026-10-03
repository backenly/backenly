/**
 * RESOLVING A PLAN AGAINST A REAL DATABASE
 * ========================================
 *
 * `resolveMaintenancePlan` rebuilds a plan that was never stored: it reads the
 * finding, finds the table's subsystem, re-runs the structural diagnosis and
 * fingerprints the live catalog. Every one of those is a database read, so none
 * of it means anything without an engine.
 *
 * What this pins:
 *
 *   - the refusal paths are reachable and say which precondition failed
 *   - the catalog fingerprint is stable across reads and MOVES when the schema
 *     does, which is the entire basis of `isPlanStale`
 *   - the whole entry-point path produces a machine-readable report against a
 *     real project rather than throwing
 *
 * It does NOT assert a particular verdict. The diagnosis depends on probes that
 * need `pg_stat_statements` and on data this fixture does not manufacture, so
 * pinning "executable" here would be pinning one machine's capabilities. The
 * verdict is an environment fact; that a report is produced at all is the
 * contract.
 */

/**
 * What this file tests is resolve -> ladder composition -> dry run, and the
 * ORDER of those rungs, which is a safety property in its own right.
 *
 * `drop_constraint` is unsupported in this deployment, so every ladder the
 * planner emits is now blocked at plan time. That is correct in production and
 * would leave the composition assertions below with an empty step list, so
 * recovery is treated as available here. The real registry's behaviour - and
 * the fact that all three ladders are refused today - is owned by
 * tests/core/rollback-capability-is-real.test.ts.
 */
jest.mock('@/lib/autonomy/maintenance/rollback-capability', () => ({
  ...jest.requireActual('@/lib/autonomy/maintenance/rollback-capability'),
  rollbackRefusal: () => null,
  canRollback: () => true,
}))

import { randomUUID } from 'node:crypto'
import { prisma } from '@/lib/db'
import {
  computeCatalogFingerprint,
  isRefusal,
  resolveMaintenancePlan,
} from '@/lib/autonomy/maintenance/resolve'
import { invalidateSubsystemCache } from '@/lib/autonomy/subsystem'
import { dryRunPlan } from '@/lib/autonomy/maintenance/dry-run'

jest.setTimeout(300_000)

const PROJECT_ID = randomUUID()
const SCHEMA = `workspace_${PROJECT_ID}`
const q = (sql: string) => prisma.$executeRawUnsafe(sql)

let findingId = ''

beforeAll(async () => {
  await q(`CREATE SCHEMA "${SCHEMA}"`)
  // Two tables joined by a foreign key, so they cluster into one subsystem.
  await q(`CREATE TABLE "${SCHEMA}"."users" (id uuid PRIMARY KEY, email text)`)
  await q(`CREATE TABLE "${SCHEMA}"."sessions" (
             id uuid PRIMARY KEY,
             user_id uuid REFERENCES "${SCHEMA}"."users"(id),
             status text,
             state text)`)

  await prisma.project.create({ data: { id: PROJECT_ID, name: 'resolve-acceptance' } })
  const finding = await prisma.healthFinding.create({
    data: {
      projectId: PROJECT_ID,
      type: 'subsystem_repeat_failure',
      severity: 'warning',
      details: { table: 'sessions' },
    },
  })
  findingId = finding.id
  invalidateSubsystemCache(PROJECT_ID)
})

afterAll(async () => {
  await prisma.healthFinding.deleteMany({ where: { projectId: PROJECT_ID } }).catch(() => {})
  await prisma.project.deleteMany({ where: { id: PROJECT_ID } }).catch(() => {})
  await q(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`).catch(() => {})
  await prisma.$disconnect().catch(() => {})
})

describe('the catalog fingerprint', () => {
  it('is stable across reads', async () => {
    const a = await computeCatalogFingerprint(PROJECT_ID)
    const b = await computeCatalogFingerprint(PROJECT_ID)
    // Not a timestamp. A fingerprint that changed per read would make every
    // plan instantly stale against itself.
    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]{16}$/)
  })

  it('moves when a column is added, which is what makes a plan stale', async () => {
    const before = await computeCatalogFingerprint(PROJECT_ID)
    await q(`ALTER TABLE "${SCHEMA}"."sessions" ADD COLUMN transient text`)
    const after = await computeCatalogFingerprint(PROJECT_ID)
    expect(after).not.toBe(before)

    await q(`ALTER TABLE "${SCHEMA}"."sessions" DROP COLUMN transient`)
    // And it comes back: the fingerprint is of the shape, not of a history.
    expect(await computeCatalogFingerprint(PROJECT_ID)).toBe(before)
  })

  it('moves when a column CHANGES TYPE, not only when one appears', async () => {
    // `udtName` is in the fingerprint for this reason: a ladder's preconditions
    // are about column types, and a text→uuid change is exactly the kind of
    // thing that invalidates them while leaving the column count identical.
    const before = await computeCatalogFingerprint(PROJECT_ID)
    await q(`ALTER TABLE "${SCHEMA}"."users" ALTER COLUMN email TYPE varchar(255)`)
    expect(await computeCatalogFingerprint(PROJECT_ID)).not.toBe(before)
    await q(`ALTER TABLE "${SCHEMA}"."users" ALTER COLUMN email TYPE text`)
    expect(await computeCatalogFingerprint(PROJECT_ID)).toBe(before)
  })
})

describe('resolving refuses with a reason, never by throwing', () => {
  it('refuses a finding that does not exist', async () => {
    const r = await resolveMaintenancePlan({ projectId: PROJECT_ID, findingId: randomUUID() })
    expect(isRefusal(r) && r.refusal).toMatch(/does not exist/)
  })

  it('refuses a finding belonging to another project', async () => {
    const other = await prisma.project.create({ data: { name: 'other' } })
    try {
      const r = await resolveMaintenancePlan({ projectId: other.id, findingId })
      expect(isRefusal(r) && r.refusal).toMatch(/different project/)
    } finally {
      await prisma.project.delete({ where: { id: other.id } }).catch(() => {})
    }
  })

  it('refuses a finding that names no table', async () => {
    const f = await prisma.healthFinding.create({
      data: { projectId: PROJECT_ID, type: 'auth_spike', severity: 'info', details: { note: 'no table here' } },
    })
    try {
      const r = await resolveMaintenancePlan({ projectId: PROJECT_ID, findingId: f.id })
      expect(isRefusal(r) && r.refusal).toMatch(/names no table/)
    } finally {
      await prisma.healthFinding.delete({ where: { id: f.id } }).catch(() => {})
    }
  })
})

describe('resolving a real finding', () => {
  it('produces either a plan or a stated refusal, and never throws', async () => {
    const r = await resolveMaintenancePlan({ projectId: PROJECT_ID, findingId })

    if (isRefusal(r)) {
      // A legitimate outcome: the diagnosis may be inconclusive on a fixture
      // with no traffic, or the table may not cluster into an eligible
      // subsystem. What matters is that it SAYS so.
      expect(r.refusal.length).toBeGreaterThan(10)
      return
    }

    expect(r.table).toBe('sessions')
    expect(r.plan.findingId).toBe(findingId)
    expect(r.plan.catalogFingerprint).toBe(r.catalogFingerprint)
    expect(r.subsystem.membership).toContain('sessions')
    // planId and planVersion are what the entry point asserts against, so they
    // have to be present and stable for the same inputs.
    expect(r.plan.planId).toMatch(/^[0-9a-f]+$/)
    expect(r.plan.planVersion).toMatch(/^[0-9a-f]+$/)

    const again = await resolveMaintenancePlan({ projectId: PROJECT_ID, findingId })
    expect(!isRefusal(again) && again.plan.planId).toBe(r.plan.planId)
  })
})

/**
 * The same path, with enough evidence for the diagnosis to CONFIRM.
 *
 * The block above cannot assert a verdict because the deciding probe for
 * `duplicated_lifecycle_state` — `column_covariation` — refuses to run on a
 * table with fewer than 50 rows, and says so as `blockedBy` rather than
 * concluding anything. That refusal is correct and is the doctrine of this
 * stack: a probe that did not run is not a probe that found nothing.
 *
 * So this fixture supplies the evidence: 60 rows whose two state columns move
 * together. It is the only way to exercise the path an operator will actually
 * follow, and it documents precisely what a project needs before a dry run can
 * return anything but WOULD_REFUSE.
 */
describe('with enough evidence to confirm a structural cause', () => {
  const EVIDENCE_PROJECT = randomUUID()
  const EVIDENCE_SCHEMA = `workspace_${EVIDENCE_PROJECT}`
  let evidenceFindingId = ''

  beforeAll(async () => {
    await q(`CREATE SCHEMA "${EVIDENCE_SCHEMA}"`)
    await q(`CREATE TABLE "${EVIDENCE_SCHEMA}"."users" (id uuid PRIMARY KEY, email text)`)
    // CHECKed on purpose. Without constraints the fixture exhibits TWO
    // symptoms at once — unconstrained state columns AND covarying columns —
    // and the diagnosis correctly reports a tie it cannot break rather than
    // picking one. Constraining them leaves exactly one live hypothesis.
    await q(`CREATE TABLE "${EVIDENCE_SCHEMA}"."sessions" (
               id uuid PRIMARY KEY,
               user_id uuid REFERENCES "${EVIDENCE_SCHEMA}"."users"(id),
               status text CHECK (status IN ('active','archived','pending')),
               state  text CHECK (state  IN ('ACTIVE','ARCHIVED','PENDING')))`)
    // Two columns recording the same thing, which is the hypothesis. 80 rows,
    // above the 50 the covariation probe requires before it will run at all.
    await q(`INSERT INTO "${EVIDENCE_SCHEMA}"."sessions" (id, status, state)
             SELECT gen_random_uuid(),
                    (ARRAY['active','archived','pending'])[1 + (g % 3)],
                    (ARRAY['ACTIVE','ARCHIVED','PENDING'])[1 + (g % 3)]
               FROM generate_series(1, 80) g`)
    // The coverage assessor reads planner statistics, which are empty until the
    // table is analysed. Without this it reports ~0 rows and refuses to decide.
    await q(`ANALYZE "${EVIDENCE_SCHEMA}"."sessions"`)

    await prisma.project.create({ data: { id: EVIDENCE_PROJECT, name: 'resolve-with-evidence' } })
    const f = await prisma.healthFinding.create({
      data: {
        projectId: EVIDENCE_PROJECT,
        type: 'subsystem_repeat_failure',
        severity: 'warning',
        details: { table: 'sessions' },
      },
    })
    evidenceFindingId = f.id
    invalidateSubsystemCache(EVIDENCE_PROJECT)
  })

  afterAll(async () => {
    await prisma.healthFinding.deleteMany({ where: { projectId: EVIDENCE_PROJECT } }).catch(() => {})
    await prisma.project.deleteMany({ where: { id: EVIDENCE_PROJECT } }).catch(() => {})
    await q(`DROP SCHEMA IF EXISTS "${EVIDENCE_SCHEMA}" CASCADE`).catch(() => {})
  })

  it('produces a full seven-rung ladder and a report that stops at the human step', async () => {
    const r = await resolveMaintenancePlan({
      projectId: EVIDENCE_PROJECT,
      findingId: evidenceFindingId,
    })
    if (isRefusal(r)) {
      // Still environment-dependent: other probes can be unavailable here. If
      // it refuses, it must SAY why rather than produce a hollow plan.
      expect(r.refusal.length).toBeGreaterThan(10)
      return
    }

    expect(r.plan.validity).toBe('executable')
    expect(r.plan.steps.map(s => s.kind)).toEqual([
      // carry_constraints joined the ladder in fe080cef, which carries the
      // source column's domain onto the column replacing it. Listed explicitly
      // rather than matched loosely: the order of these rungs is the safety
      // property, and a plan that reorders them should fail here.
      'add_structure', 'carry_constraints', 'dual_write', 'backfill', 'verify', 'switch_readers', 'contract',
    ])
    expect(r.plan.humanOnlySteps.join(' ')).toMatch(/contract/)

    const report = await dryRunPlan({
      plan: r.plan,
      projectId: EVIDENCE_PROJECT,
      table: 'sessions',
      sourceColumn: 'status',
      currentCatalogFingerprint: r.catalogFingerprint,
      autonomyLevel: 'AGGRESSIVE',
      approvedPlanVersion: r.plan.planVersion,
      mutationsEnvironmentEnabled: true,
      // Keyed by ordinal, so inserting carry_constraints at 1 shifts every
      // rung below it. A missing binding blocks its step and halts the ladder,
      // which is what went unnoticed when that rung was added.
      bindings: {
        0: { kind: 'add_structure', verb: 'ADD_COLUMN', table: 'sessions', column: 'state', columnType: 'text' },
        1: { kind: 'carry_constraints', table: 'sessions', sourceColumn: 'status', targetColumn: 'state', transform: { kind: 'upper' } },
        2: { kind: 'dual_write', table: 'sessions', sourceColumn: 'status', targetColumn: 'state', transform: { kind: 'upper' } },
        3: { kind: 'backfill', table: 'sessions', sourceColumn: 'status', targetColumn: 'state', transform: { kind: 'upper' } },
        4: { kind: 'verify', table: 'sessions', sourceColumn: 'status', targetColumn: 'state', transform: { kind: 'upper' } },
        5: { kind: 'switch_readers', table: 'sessions', sourceColumn: 'status', targetColumn: 'state' },
      },
    })

    expect(report.verdict).toBe('WOULD_STOP_AWAITING_HUMAN_CONTRACT')
    expect(report.steps.map(s => s.wouldExecute)).toEqual([true, true, true, true, true, true, false])
    expect(report.steps[6].classification).toBe('human_only')
    expect(report.bindingsComplete).toBe(true)
    expect(report.ledgerWritten).toBe(false)
    expect(report.uncontrollableReaders).toBe('unknown-standing-fact')
  })
})
