/**
 * PHASE 4 — structural diagnosis
 * ==============================
 *
 * `subsystem_repeat_failure` says repairs across one area are not holding. This
 * says why, or says it could not tell. The verdict that matters most is the
 * third one:
 *
 *     structural_cause_identified
 *     no_structural_cause
 *     inconclusive
 *
 * `inconclusive` is a success state. It is the entire difference between a
 * diagnostic engine and an architecture fortune teller, and most of the tests
 * below exist to prove it is reachable rather than decorative.
 *
 * The single rule under test throughout:
 *
 *     a probe that did not run  ≠  a probe that ran and found absence
 *
 * `pg_stat_statements` missing, a table under 50 rows, `pg_policies`
 * unreadable — none of those are facts about the backend. They must never be
 * folded in as negative evidence, and `no_structural_cause` must never win
 * because the instruments were blind.
 */

import { PrismaClient } from '@prisma/client'

import { scenario } from '../lab/scenarios'
import { seedScenario, teardownScenario, type SeededProject } from '../lab/seed'
import { findSymptom } from '@/lib/autonomy/hypothesis/catalog'
import {
  diagnoseStructuralCause,
  indistinguishablePairs,
  STRUCTURAL_SYMPTOM,
} from '@/lib/autonomy/hypothesis/structural'
import {
  policyOverlap,
  constraintCoverage,
  columnCoVariation,
  writeStatementShapes,
  assessStructuralCoverage,
} from '@/lib/autonomy/hypothesis/structural-probes'

const prisma = new PrismaClient()
const seeded: SeededProject[] = []

async function seed(id: string): Promise<SeededProject> {
  const s = await seedScenario(prisma, scenario(id))
  seeded.push(s)
  return s
}

const q = (sql: string) => prisma.$executeRawUnsafe(sql)
const AUTH = ['password_resets', 'sessions', 'users', 'verification_tokens']

afterAll(async () => {
  for (const s of seeded) await teardownScenario(prisma, s)
  await prisma.$disconnect()
})

// ── The catalog itself ───────────────────────────────────────────────────────

describe('the hypothesis catalog is separable', () => {
  /**
   * Two hypotheses predicting identically on every test can be ranked by prior
   * and never separated by evidence. That is a catalog defect, invisible at
   * runtime — the engine reports whichever had the higher prior with a trail
   * that looks complete.
   */
  it('no two hypotheses have identical prediction signatures', () => {
    const symptom = findSymptom(STRUCTURAL_SYMPTOM)!
    expect(symptom).toBeDefined()
    expect(indistinguishablePairs(symptom)).toEqual([])
  })

  it('the guard actually detects a clash', () => {
    // Without this, the assertion above passes for a broken detector too.
    const symptom = findSymptom(STRUCTURAL_SYMPTOM)!
    const clone = {
      ...symptom,
      hypotheses: [
        symptom.hypotheses[0],
        { ...symptom.hypotheses[0], id: 'impostor' },
      ],
    }
    expect(indistinguishablePairs(clone as never)).toEqual([
      [symptom.hypotheses[0].id, 'impostor'],
    ])
  })

  it('every hypothesis makes at least one falsifiable prediction', () => {
    const symptom = findSymptom(STRUCTURAL_SYMPTOM)!
    for (const h of symptom.hypotheses) {
      expect(Object.keys(h.predicts).length).toBeGreaterThan(0)
    }
  })
})

// ── Individual probes ────────────────────────────────────────────────────────

describe('policy overlap decides policy_fragmentation', () => {
  it('reports overlapping when two policies cover one command', async () => {
    const s = await seed('content-community')
    await q(`CREATE POLICY "p_a" ON "${s.schema}"."posts" FOR SELECT USING (true)`)
    await q(`CREATE POLICY "p_b" ON "${s.schema}"."posts" FOR SELECT USING (true)`)

    const r = await policyOverlap({ projectId: s.projectId, membership: ['posts'] } as never)
    expect(r.outcome).toBe('overlapping')
  })

  it('reports single_per_command when they do not overlap', async () => {
    const s = await seed('content-community')
    await q(`CREATE POLICY "p_one" ON "${s.schema}"."posts" FOR SELECT USING (true)`)

    const r = await policyOverlap({ projectId: s.projectId, membership: ['posts'] } as never)
    expect(r.outcome).toBe('single_per_command')
  })
})

describe('constraint coverage decides missing_constraint', () => {
  it('reports unconstrained state columns', async () => {
    const s = await seed('auth-heavy') // users.email_status is plain text
    const r = await constraintCoverage({ projectId: s.projectId, membership: AUTH } as never)
    expect(r.outcome).toBe('state_columns_unconstrained')
    expect(r.detail).toContain('email_status')
  })

  it('reports constrained once a CHECK exists', async () => {
    const s = await seed('auth-heavy')
    await q(
      // The probe asks whether a CHECK exists, not what it asserts. A value
      // list would be violated by the lab's generated rows, and the point here
      // is the presence of a constraint.
      `ALTER TABLE "${s.schema}"."users"
         ADD CONSTRAINT "ck_email_status" CHECK (email_status IS NOT NULL)`,
    )
    const r = await constraintCoverage({ projectId: s.projectId, membership: AUTH } as never)
    expect(r.outcome).toBe('constrained')
  })
})

describe('column co-variation decides duplicated_lifecycle, above threshold', () => {
  /**
   * The row-count gate is load-bearing, not cautious. At five rows "every value
   * of a maps to one b" is unremarkable; at fifty it is evidence. Returning
   * `independent` on a small table would be a confident negative drawn from
   * nothing.
   */
  it('THROWS insufficient sample below the threshold', async () => {
    const s = await seed('auth-heavy')
    await q(`CREATE TABLE "${s.schema}"."tiny" (
      id uuid PRIMARY KEY, status text, state text
    )`)
    await q(`INSERT INTO "${s.schema}"."tiny" (id, status, state)
             SELECT gen_random_uuid(), 'a', 'x' FROM generate_series(1, 5)`)
    await q(`ANALYZE "${s.schema}"."tiny"`)

    await expect(
      columnCoVariation({ projectId: s.projectId, membership: ['tiny'] } as never),
    ).rejects.toThrow(/insufficient sample/)
  })

  it('reports co_varying when two state columns move together', async () => {
    const s = await seed('auth-heavy')
    await q(`CREATE TABLE "${s.schema}"."orders2" (
      id uuid PRIMARY KEY, status text, stage text
    )`)
    // status determines stage: one state machine written twice.
    await q(`INSERT INTO "${s.schema}"."orders2" (id, status, stage)
             SELECT gen_random_uuid(),
                    (ARRAY['new','paid','shipped'])[1 + (i % 3)],
                    (ARRAY['s1','s2','s3'])[1 + (i % 3)]
               FROM generate_series(1, 90) AS i`)
    await q(`ANALYZE "${s.schema}"."orders2"`)

    const r = await columnCoVariation({ projectId: s.projectId, membership: ['orders2'] } as never)
    expect(r.outcome).toBe('co_varying')
  })

  it('reports independent when they vary freely', async () => {
    const s = await seed('auth-heavy')
    await q(`CREATE TABLE "${s.schema}"."orders3" (
      id uuid PRIMARY KEY, status text, stage text
    )`)
    await q(`INSERT INTO "${s.schema}"."orders3" (id, status, stage)
             SELECT gen_random_uuid(),
                    (ARRAY['new','paid','shipped'])[1 + (i % 3)],
                    (ARRAY['s1','s2','s3','s4'])[1 + (i % 4)]
               FROM generate_series(1, 90) AS i`)
    await q(`ANALYZE "${s.schema}"."orders3"`)

    const r = await columnCoVariation({ projectId: s.projectId, membership: ['orders3'] } as never)
    expect(r.outcome).toBe('independent')
  })
})

// ── Coverage is a separate fact ──────────────────────────────────────────────

describe('coverage is reported independently of the verdict', () => {
  it('names what the instruments could and could not see', async () => {
    const s = await seed('auth-heavy')
    const cov = await assessStructuralCoverage({
      projectId: s.projectId,
      membership: AUTH,
    } as never)

    expect(cov.policiesReadable).toBe(true)
    expect(cov.constraintCatalogReadable).toBe(true)
    expect(typeof cov.statementTelemetryAvailable).toBe('boolean')
    expect(cov.largestSampleRows).toBeGreaterThan(0)
    expect(cov.sampleSufficient).toBe(true)
  })

  it('flags an insufficient sample without claiming anything about the schema', async () => {
    const s = await seed('auth-heavy')
    await q(`CREATE TABLE "${s.schema}"."empty_area" (id uuid PRIMARY KEY, status text)`)
    await q(`ANALYZE "${s.schema}"."empty_area"`)

    const cov = await assessStructuralCoverage({
      projectId: s.projectId,
      membership: ['empty_area'],
    } as never)
    expect(cov.sampleSufficient).toBe(false)
    expect(cov.notes.join(' ')).toMatch(/below 50/)
  })
})

// ── End-to-end verdicts ──────────────────────────────────────────────────────

describe('diagnoseStructuralCause', () => {
  it('identifies policy fragmentation', async () => {
    const s = await seed('content-community')
    await q(`CREATE POLICY "d_a" ON "${s.schema}"."posts" FOR SELECT USING (true)`)
    await q(`CREATE POLICY "d_b" ON "${s.schema}"."posts" FOR SELECT USING (true)`)
    await q(
      `ALTER TABLE "${s.schema}"."posts"
         ADD CONSTRAINT "ck_posts_body" CHECK (length(body) >= 0)`,
    )

    const d = await diagnoseStructuralCause(s.projectId, ['posts', 'comments'])
    expect(d.kind).toBe('structural_cause_identified')
    expect(d.hypothesis?.id).toBe('policy_fragmentation')
    // Coverage travels with the verdict, never folded into it.
    expect(d.coverage).toBeDefined()
    expect(d.trail.length).toBeGreaterThan(1)
  })

  it('identifies a missing constraint', async () => {
    const s = await seed('auth-heavy')
    const d = await diagnoseStructuralCause(s.projectId, AUTH)

    expect(d.kind).toBe('structural_cause_identified')
    expect(d.hypothesis?.id).toBe('missing_constraint_permits_invalid_state')
  })

  /**
   * The anti-garbage-bucket rule, and the most important test here.
   *
   * `no_structural_cause` predicts the negative on every test, so it survives
   * untouched when the instruments were blind. If a deciding probe did not run,
   * the answer is `inconclusive` — not a clean bill of health for a subsystem
   * nobody examined.
   */
  it('returns inconclusive, not no_structural_cause, when a deciding probe could not run', async () => {
    const s = await seed('auth-heavy')

    // An area where nothing structural is supported: both state columns are
    // constrained and no policies overlap. The table carries TWO state columns
    // so the co-variation probe has a question to ask, and is EMPTY so it
    // cannot answer it — which is the condition under test.
    await q(`CREATE TABLE "${s.schema}"."blank_a" (
      id uuid PRIMARY KEY,
      status text CONSTRAINT "ck_ba_status" CHECK (status IS NOT NULL),
      state text CONSTRAINT "ck_ba_state" CHECK (state IS NOT NULL)
    )`)
    await q(`ANALYZE "${s.schema}"."blank_a"`)

    const d = await diagnoseStructuralCause(s.projectId, ['blank_a'])

    expect(d.kind).toBe('inconclusive')
    expect(d.kind).not.toBe('no_structural_cause')
    expect(d.blockedBy.map(b => b.test)).toContain('column_covariation')
    expect(d.reason).toMatch(/did not run|could not run/)
  })

  it('never reports split_brain_writers as an identified cause', async () => {
    const s = await seed('auth-heavy')
    const d = await diagnoseStructuralCause(s.projectId, AUTH)
    expect(d.hypothesis?.id).not.toBe('split_brain_writers')
  })

  it('carries coverage notes when statement telemetry is unavailable', async () => {
    const s = await seed('auth-heavy')
    const d = await diagnoseStructuralCause(s.projectId, AUTH)
    if (!d.coverage.statementTelemetryAvailable) {
      expect(d.coverage.notes.join(' ')).toMatch(/pg_stat_statements/)
    }
    // Either way the verdict must not silently depend on it.
    expect(['structural_cause_identified', 'no_structural_cause', 'inconclusive']).toContain(d.kind)
  })

  it('always returns one of exactly three verdict kinds', async () => {
    const s = await seed('messy-legacy')
    const d = await diagnoseStructuralCause(s.projectId, ['users', 'orders'])
    expect(['structural_cause_identified', 'no_structural_cause', 'inconclusive']).toContain(d.kind)
  })
})
