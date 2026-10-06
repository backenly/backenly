/**
 * THE ENGINE NEVER STRANDS A DECISION, AND NEVER SAYS WHAT DID NOT HAPPEN
 * ========================================================================
 *
 * The paths off the happy one, each against a real PostgreSQL and a real
 * extraction, each a way a change could otherwise end up stuck, approved by
 * the wrong door, or described falsely:
 *
 *   kept        a change kept after a stop is judged again from that decision,
 *               not forever by the pass that stopped it
 *   drift       a table changed after approval: resuming re-asks, in place, for
 *               the table as it is now, instead of a dead end through undo
 *   pause       a second pause is recorded; a pause landing mid-run stays the
 *               person's pause, not a stop put back in front of them
 *   memory      a decline holds however many rows came after it
 *   gone        a request for a table that was dropped is withdrawn
 *   cut off     a pass that died part-way never leaves a decision between
 *               proposing and asking
 *   one door    resuming is not a way to approve what nobody approved
 *   undo        claimed before anything is touched; refused, it leaves the
 *               change as it was and says so; stopped part-way, it says what
 *               was removed and offers only undo
 *   stale       "not now" from a stale tab declines nothing
 *   claim       an approval claim abandoned by a dead process lapses
 *
 * A primitive's method is replaced only to stage the one failure under test
 * (a process dying, a rollback stopping part-way); the database is never
 * mocked.
 */

import { prisma } from '@/lib/db'
import { closeMaintenanceLockPool } from '@/lib/autonomy/maintenance/single-flight'
import {
  ABANDONED_AFTER_MS,
  advance,
  approveRequest,
  isApprovalRefusal,
  listChanges,
  observe,
  pause,
  proposeChanges,
  recordDecline,
  resume,
  undo,
} from '@/lib/evolution-engine/engine'
import { decisionTrail, readMemory, remember, summarizeDecisions, priorsFor, RECENT_ASSESSMENTS } from '@/lib/evolution-engine/memory'
import { claimRequest, CLAIM_LEASE_MS } from '@/lib/evolution-engine/request'
import type { RollbackResult } from '@/lib/evolution-engine/primitive'
import { structuralExtraction } from '@/lib/structural-evolution/primitive'
import { readTableFacts } from '@/lib/structural-evolution/facts'
import { ladderNames } from '@/lib/structural-evolution/sql'
import { asService, buildProject, drain, dropProject, q, requestsOf, stateOf, type Fixture } from '../helpers/evolution-engine-fixture'

jest.setTimeout(300_000)

const originalMutations = process.env.ENABLE_EVOLUTION_MUTATIONS
const HOUR = 3_600_000
const CONCERN = 'orders:refund'

afterAll(async () => {
  if (originalMutations === undefined) delete process.env.ENABLE_EVOLUTION_MUTATIONS
  else process.env.ENABLE_EVOLUTION_MUTATIONS = originalMutations
  await closeMaintenanceLockPool()
})

afterEach(() => jest.restoreAllMocks())

const mutations = (on: boolean) => {
  if (on) process.env.ENABLE_EVOLUTION_MUTATIONS = 'true'
  else delete process.env.ENABLE_EVOLUTION_MUTATIONS
}

/** Propose, and return the waiting request. */
async function proposed(f: Fixture) {
  const pass = await proposeChanges(f.projectId)
  expect(pass.requested).toBe(1)
  const [req] = await requestsOf(f.projectId)
  return req
}

/** Approve the waiting request as the owner. */
async function approved(f: Fixture) {
  const req = await proposed(f)
  const r = await approveRequest({ projectId: f.projectId, findingId: req.id, planVersion: req.ev.planVersion, userId: f.ownerId })
  if (isApprovalRefusal(r)) throw new Error(r.error)
  return req
}

/** All the way to observing: approved, built, backfilled, verified, cut over. */
async function observing(f: Fixture): Promise<string> {
  mutations(true)
  const req = await approved(f)
  await drain(f.projectId)
  await advance({ projectId: f.projectId, decisionId: req.ev.decisionId })
  expect((await stateOf(f.projectId, req.ev.decisionId)).state).toBe('observing')
  return req.ev.decisionId
}

/** A write that bypasses the triggers: the one way the two shapes can part. */
async function behindTheTriggers(sql: string, ...p: unknown[]): Promise<void> {
  await prisma.$transaction(async tx => {
    await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`)
    await tx.$executeRawUnsafe(sql, ...p)
  })
}

const transitions = async (f: Fixture, decisionId: string) =>
  (await decisionTrail(f.projectId, decisionId)).filter(e => e.record.event === 'transition').map(e => e.record.state)

const milestones = async (f: Fixture, decisionId: string) =>
  (await decisionTrail(f.projectId, decisionId)).filter(e => e.milestone).map(e => e.sentence)

const priorOf = async (f: Fixture) => priorsFor(summarizeDecisions(await readMemory(f.projectId)))[CONCERN]

// ── Kept after a stop ────────────────────────────────────────────────────────

describe('a change kept after a stop', () => {
  let f: Fixture
  beforeAll(async () => {
    f = await buildProject('kept')
  }, 120_000)
  afterAll(async () => dropProject(f), 60_000)

  it('is watched again from when it was kept, and can still reach stable', async () => {
    const decisionId = await observing(f)
    const { cutoverAt } = await stateOf(f.projectId, decisionId)
    const sat = `"${f.schema}"."order_refunds"`
    const [row] = await asService<{ k: string; r: string }>(`SELECT order_id::text AS k, refund_reason AS r FROM ${sat} ORDER BY order_id LIMIT 1`)

    await behindTheTriggers(`UPDATE ${sat} SET refund_reason = 'tampered' WHERE order_id = $1::uuid`, row.k)
    expect((await observe({ projectId: f.projectId, decisionId, now: new Date(cutoverAt!.getTime() + HOUR) })).verdict).toBe('regressed')
    await behindTheTriggers(`UPDATE ${sat} SET refund_reason = $1 WHERE order_id = $2::uuid`, row.r, row.k)

    const kept = await resume({ projectId: f.projectId, decisionId, userId: f.ownerId })
    expect(kept).toMatchObject({ ok: true, state: 'observing' })
    const s = await stateOf(f.projectId, decisionId)
    expect(s.cutoverAt).toEqual(cutoverAt)
    expect(s.observingSince!.getTime()).toBeGreaterThan(cutoverAt!.getTime())
    expect((await requestsOf(f.projectId))[0].status).not.toBe('pending_approval')

    // The pass that stopped it no longer judges it; clean passes over a new
    // window do, and the change becomes stable.
    const since = s.observingSince!.getTime()
    for (const h of [1, 9, 17]) {
      expect((await observe({ projectId: f.projectId, decisionId, now: new Date(since + h * HOUR) })).verdict).toBe('continue')
    }
    const done = await observe({ projectId: f.projectId, decisionId, now: new Date(since + 25 * HOUR) })
    expect(done.verdict).toBe('stable')
    expect(done.benefit!.verdict).not.toBe('regressed')
  })
})

// ── Drift after approval ─────────────────────────────────────────────────────

describe('a table that changes after its change was approved', () => {
  let f: Fixture
  beforeAll(async () => {
    f = await buildProject('drift')
  }, 120_000)
  afterAll(async () => dropProject(f), 60_000)

  it('is asked about again, in place, for the table as it is now — not sent through undo', async () => {
    mutations(false)
    const req = await approved(f)
    const decisionId = req.ev.decisionId
    expect((await stateOf(f.projectId, decisionId)).state).toBe('approved')

    await q(`CREATE INDEX orders_status_idx ON "${f.schema}"."orders" (status)`)
    mutations(true)
    expect((await advance({ projectId: f.projectId, decisionId })).state).toBe('blocked')

    const r = await resume({ projectId: f.projectId, decisionId, userId: f.ownerId })
    expect(r).toMatchObject({ ok: true, state: 'awaiting_approval' })
    expect(r.ok && r.message).toMatch(/approve the updated version in your queue/)

    // The same decision and the same row, asking for approval again.
    const rows = await requestsOf(f.projectId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: req.id, status: 'pending_approval' })
    expect(rows[0].ev).toMatchObject({ ask: 'approve', decisionId })
    expect(rows[0].ev.rehearsal.planVersion).toBe(rows[0].ev.planVersion)
    // Nothing was undone, so nothing is held against the concern.
    expect(await priorOf(f)).toBeUndefined()

    const again = await approveRequest({ projectId: f.projectId, findingId: req.id, planVersion: rows[0].ev.planVersion, userId: f.ownerId })
    expect(again.ok).toBe(true)
    expect(['backfilling', 'observing']).toContain((await stateOf(f.projectId, decisionId)).state)
  })
})

// ── Pausing ──────────────────────────────────────────────────────────────────

describe('pausing', () => {
  let f: Fixture
  beforeAll(async () => {
    f = await buildProject('pause')
  }, 120_000)
  afterAll(async () => dropProject(f), 60_000)

  it('is recorded every time, not only the first', async () => {
    mutations(true)
    const req = await approved(f)
    const decisionId = req.ev.decisionId
    expect((await stateOf(f.projectId, decisionId)).state).toBe('backfilling')

    expect((await pause({ projectId: f.projectId, decisionId, userId: f.ownerId })).ok).toBe(true)
    expect((await resume({ projectId: f.projectId, decisionId, userId: f.ownerId })).ok).toBe(true)
    expect((await stateOf(f.projectId, decisionId)).state).toBe('backfilling')
    expect((await pause({ projectId: f.projectId, decisionId, userId: f.ownerId })).ok).toBe(true)

    const trail = await decisionTrail(f.projectId, decisionId)
    expect(trail.filter(e => e.record.event === 'withdrawn')).toHaveLength(2)
    expect((await milestones(f, decisionId)).filter(m => /^You paused/.test(m))).toHaveLength(2)
    expect((await stateOf(f.projectId, decisionId)).withdrawn).toBe(true)
  })
})

describe('a pause that lands while the change is running', () => {
  let f: Fixture
  beforeAll(async () => {
    f = await buildProject('midrun')
  }, 120_000)
  afterAll(async () => dropProject(f), 60_000)

  it('stays the person\'s pause: no stop to decide on, and nothing walked over it', async () => {
    mutations(false)
    const req = await approved(f)
    const decisionId = req.ev.decisionId
    mutations(true)
    const execute = structuralExtraction.execute
    jest.spyOn(structuralExtraction, 'execute').mockImplementationOnce(async (...args) => {
      await pause({ projectId: f.projectId, decisionId, userId: f.ownerId })
      return execute(...args)
    })

    const r = await advance({ projectId: f.projectId, decisionId })
    expect(r.state).toBe('blocked')
    expect(await transitions(f, decisionId)).toEqual(['proposed', 'rehearsing', 'rehearsed', 'awaiting_approval', 'approved', 'blocked'])
    // The row still says approved: the person paused it, they are not asked why.
    const [row] = await requestsOf(f.projectId)
    expect(row.status).toBe('approved')
    expect(row.ev.ask).toBe('approve')
  })
})

// ── Memory ───────────────────────────────────────────────────────────────────

describe('memory', () => {
  let f: Fixture
  beforeAll(async () => {
    f = await buildProject('memory')
  }, 120_000)
  afterAll(async () => dropProject(f), 60_000)

  it('keeps a decline however many rows came after it', async () => {
    mutations(false)
    const req = await proposed(f)
    await prisma.healthFinding.update({ where: { id: req.id }, data: { status: 'dismissed' } })
    await recordDecline(f.projectId, req.id, f.ownerId)
    expect(await priorOf(f)).toMatchObject({ kind: 'declined' })

    // Far more than one page of newer rows: another change's observation
    // passes, and assessments.
    const later = (event: string, i: number) => ({
      projectId: f.projectId,
      action: 'ARCHITECTURE_EVOLUTION_TRACE',
      type: 'architecture',
      details: '{}',
      timestamp: new Date(Date.now() + 1_000 + i),
      metadata: {
        evolution: {
          v: 1, decisionId: event === 'assessed' ? 'assessment:elsewhere:x' : 'another-change', concernKey: 'elsewhere:x',
          proposalKey: 'x', planId: 'x', primitive: structuralExtraction.id, subject: 'elsewhere', event,
        },
      },
    })
    await prisma.auditLog.createMany({ data: Array.from({ length: 1_200 }, (_, i) => later('observed', i)) })
    await prisma.auditLog.createMany({ data: Array.from({ length: RECENT_ASSESSMENTS + 50 }, (_, i) => later('assessed', 2_000 + i)) })

    expect(await priorOf(f)).toMatchObject({ kind: 'declined' })
    const pass = await proposeChanges(f.projectId)
    expect(pass.requested).toBe(0)
    expect((await requestsOf(f.projectId)).filter(r => r.status === 'pending_approval')).toHaveLength(0)
  })

  it('throws when it cannot be read, rather than remembering nothing', async () => {
    jest.spyOn(prisma.auditLog, 'findMany').mockRejectedValueOnce(new Error('connection reset'))
    await expect(readMemory(f.projectId)).rejects.toThrow('connection reset')
  })
})

// ── A table that is gone ─────────────────────────────────────────────────────

describe('a request for a table that was dropped', () => {
  let f: Fixture
  beforeAll(async () => {
    f = await buildProject('gone')
  }, 120_000)
  afterAll(async () => dropProject(f), 60_000)

  it('is withdrawn from the queue, not left there to be refused forever', async () => {
    mutations(false)
    const req = await proposed(f)
    await q(`DROP TABLE "${f.schema}"."orders" CASCADE`)
    await proposeChanges(f.projectId)
    const [row] = await requestsOf(f.projectId)
    expect(row.status).toBe('resolved')
    expect((await stateOf(f.projectId, req.ev.decisionId)).state).toBe('blocked')
    expect((await milestones(f, req.ev.decisionId)).pop()).toMatch(/withdrew its request .*no plan can be built any more/)
  })
})

// ── A pass cut off part-way ──────────────────────────────────────────────────

describe('a proposal pass cut off part-way', () => {
  let f: Fixture
  beforeEach(async () => {
    mutations(false)
    f = await buildProject('cutoff')
  }, 120_000)
  afterEach(async () => dropProject(f), 60_000)

  it('leaves the decision stopped, and a later pass asks again', async () => {
    jest.spyOn(structuralExtraction, 'rehearse').mockImplementationOnce(() => {
      throw new Error('the process died')
    })
    await expect(proposeChanges(f.projectId)).rejects.toThrow('the process died')
    const [d] = summarizeDecisions(await readMemory(f.projectId)).filter(x => x.concernKey === CONCERN)
    expect(d.state).toBe('blocked')
    expect(await requestsOf(f.projectId)).toHaveLength(0)

    const later = await proposeChanges(f.projectId, { now: new Date(Date.now() + 25 * HOUR) })
    expect(later.refreshed).toBe(1)
    expect((await requestsOf(f.projectId))[0].status).toBe('pending_approval')
    expect((await stateOf(f.projectId, d.decisionId)).state).toBe('awaiting_approval')
  })

  it('picks up a decision abandoned between proposing and asking', async () => {
    // What a process that died mid-rehearsal leaves behind.
    const record = (state: 'proposed' | 'rehearsing', attempt: number) => ({
      v: 1 as const,
      decisionId: 'abandoned-decision',
      concernKey: CONCERN,
      proposalKey: 'orders:refund',
      planId: 'abandoned',
      primitive: structuralExtraction.id,
      subject: 'orders',
      event: 'transition' as const,
      state,
      attempt,
    })
    await remember({ projectId: f.projectId, record: record('proposed', 1), milestone: false, sentence: 'proposed' })
    await remember({ projectId: f.projectId, record: record('rehearsing', 1), milestone: false, sentence: 'rehearsing' })

    // Still being worked on, as far as anyone can tell: left alone.
    expect((await proposeChanges(f.projectId)).requested + (await proposeChanges(f.projectId)).refreshed).toBe(0)
    const pass = await proposeChanges(f.projectId, { now: new Date(Date.now() + ABANDONED_AFTER_MS + HOUR) })
    expect(pass.refreshed).toBe(1)
    expect((await stateOf(f.projectId, 'abandoned-decision')).state).toBe('awaiting_approval')
    expect((await requestsOf(f.projectId))[0].ev.decisionId).toBe('abandoned-decision')
  })
})

// ── One door for consent ─────────────────────────────────────────────────────

describe('resuming a change nobody approved', () => {
  let f: Fixture
  beforeAll(async () => {
    f = await buildProject('nodoor')
  }, 120_000)
  afterAll(async () => dropProject(f), 60_000)

  it('is refused, and runs nothing', async () => {
    mutations(true)
    jest.spyOn(structuralExtraction, 'rehearse').mockResolvedValueOnce({
      passed: false,
      authorization: 'unavailable',
      authorizationDetail: '',
      detail: 'a planted failure',
      report: null,
    })
    expect((await proposeChanges(f.projectId)).rehearsalFailed).toBe(1)
    const [d] = summarizeDecisions(await readMemory(f.projectId)).filter(x => x.concernKey === CONCERN)
    expect(d).toMatchObject({ state: 'blocked', everApproved: false })

    const r = await resume({ projectId: f.projectId, decisionId: d.decisionId, userId: f.ownerId })
    expect(r).toMatchObject({ ok: false, status: 409 })
    expect(!r.ok && r.error).toMatch(/never approved/)
    expect(await readTableFacts(f.schema, 'order_refunds')).toBeNull()
    expect(await prisma.maintenanceApproval.count({ where: { projectId: f.projectId } })).toBe(0)
  })
})

// ── Undo ─────────────────────────────────────────────────────────────────────

describe('undo', () => {
  let f: Fixture
  let decisionId = ''
  beforeAll(async () => {
    f = await buildProject('undo')
    decisionId = await observing(f)
  }, 180_000)
  afterAll(async () => dropProject(f), 60_000)

  it('refused while something is built on the new table: nothing removed, and it says so', async () => {
    const view = `"${f.schema}"."refund_report"`
    await q(`CREATE VIEW ${view} AS SELECT * FROM "${f.schema}"."order_refunds"`)
    const before = await stateOf(f.projectId, decisionId)
    try {
      const r = await undo({ projectId: f.projectId, decisionId, userId: f.ownerId })
      expect(r).toMatchObject({ ok: false, status: 409 })
      expect(!r.ok && r.error).toMatch(/^Not undone, and nothing was removed: the view .*refund_report depends on order_refunds/)

      // Exactly where it was: still observed, on the same watch, fully open.
      const s = await stateOf(f.projectId, decisionId)
      expect(s.state).toBe('observing')
      expect(s.observingSince).toEqual(before.observingSince)
      const n = ladderNames({ host: 'orders', satellite: 'order_refunds', members: [], label: 'refund' })
      const sat = (await readTableFacts(f.schema, 'order_refunds'))!
      expect(sat.triggers.map(t => t.name)).toContain(n.reverse)
      expect(sat.policies).toHaveLength(5)
      expect((await readTableFacts(f.schema, 'orders'))!.triggers.map(t => t.name)).toContain(n.forward)
      expect((await milestones(f, decisionId)).pop()).toMatch(/did not undo .*Nothing was removed; it is as it was\.$/)
    } finally {
      await q(`DROP VIEW IF EXISTS ${view}`)
    }
  })

  it('is claimed before anything is touched: a pass landing mid-undo is not a regression', async () => {
    const rollback = structuralExtraction.rollback
    let seen: string | null = null
    jest.spyOn(structuralExtraction, 'rollback').mockImplementationOnce(async (...args) => {
      const r = await rollback(...args)
      seen = (await observe({ projectId: f.projectId, decisionId, now: new Date() })).reason
      return r
    })
    const r = await undo({ projectId: f.projectId, decisionId, userId: f.ownerId })
    expect(r.ok).toBe(true)
    expect(seen).toBe('not being observed')
    const s = await stateOf(f.projectId, decisionId)
    expect(s).toMatchObject({ state: 'rolled_back', regressed: false })
    expect(await priorOf(f)).toMatchObject({ kind: 'reversed', regressed: false })
    expect((await milestones(f, decisionId)).join('\n')).not.toMatch(/removed outside Backenly|saw a problem/)
  })
})

describe('an undo that stops part-way', () => {
  let f: Fixture
  let decisionId = ''
  beforeAll(async () => {
    f = await buildProject('partial')
    decisionId = await observing(f)
  }, 180_000)
  afterAll(async () => dropProject(f), 60_000)

  it('says what was removed, and offers only undo', async () => {
    const partial: RollbackResult = {
      status: 'failed',
      reason: 'cannot drop table order_refunds because other objects depend on it',
      actions: [
        { action: 'close_writes', outcome: 'done', detail: 'writes to order_refunds closed; 1 role grant(s) revoked' },
        { action: 'revoke_reads', outcome: 'done', detail: 'reads of order_refunds closed; 1 role grant(s) revoked' },
        { action: 'drop_satellite', outcome: 'failed', detail: 'cannot drop table order_refunds because other objects depend on it' },
      ],
    }
    jest.spyOn(structuralExtraction, 'rollback').mockResolvedValueOnce(partial)
    const r = await undo({ projectId: f.projectId, decisionId, userId: f.ownerId })
    expect(r).toMatchObject({ ok: false, status: 409 })
    expect(!r.ok && r.error).toMatch(/^Undone only part-way/)

    const s = await stateOf(f.projectId, decisionId)
    expect(s).toMatchObject({ state: 'blocked', undoIncomplete: true })
    const said = (await milestones(f, decisionId)).pop()!
    expect(said).toMatch(/could not finish undoing/)
    expect(said).toMatch(/It had already done this: writes to order_refunds closed.*; reads of order_refunds closed/)
    expect(said).not.toMatch(/Nothing was removed/)

    const again = await resume({ projectId: f.projectId, decisionId, userId: f.ownerId })
    expect(!again.ok && again.error).toMatch(/already undone/)
    const [view] = await listChanges(f.projectId)
    expect(view.actions).toEqual({ undo: true, pause: false, resume: false })
    expect((await requestsOf(f.projectId)).filter(x => x.status === 'pending_approval')).toHaveLength(0)

    // Undo again, for real, finishes it.
    expect((await undo({ projectId: f.projectId, decisionId, userId: f.ownerId })).ok).toBe(true)
    expect(await stateOf(f.projectId, decisionId)).toMatchObject({ state: 'rolled_back', undoIncomplete: false })
  })
})

// ── Stale tabs and dead processes ────────────────────────────────────────────

describe('"not now" from a stale tab', () => {
  let f: Fixture
  beforeAll(async () => {
    f = await buildProject('stale')
  }, 120_000)
  afterAll(async () => dropProject(f), 60_000)

  it('declines nothing once the change was approved', async () => {
    mutations(false)
    const req = await approved(f)
    await recordDecline(f.projectId, req.id, f.ownerId)
    expect((await stateOf(f.projectId, req.ev.decisionId)).declined).toBe(false)
    expect(await priorOf(f)).toBeUndefined()
  })
})

describe('an approval claim', () => {
  let f: Fixture
  beforeAll(async () => {
    f = await buildProject('claim')
  }, 120_000)
  afterAll(async () => dropProject(f), 60_000)

  it('is held by one attempt, and lapses when that attempt died', async () => {
    mutations(false)
    const req = await proposed(f)
    expect(await claimRequest(f.projectId, req.id)).toBe(true)
    expect(await claimRequest(f.projectId, req.id)).toBe(false)
    const refused = await approveRequest({ projectId: f.projectId, findingId: req.id, planVersion: req.ev.planVersion, userId: f.ownerId })
    expect(isApprovalRefusal(refused) && refused.status).toBe(409)

    // The process holding it died: its claim ages past the lease. The queue
    // lists waiting rows only, so the next pass puts it back there…
    const age = () =>
      q(
        `UPDATE health_findings SET details = jsonb_set(details, '{evolution,claimedAt}', to_jsonb($1::text)) WHERE id = $2`,
        new Date(Date.now() - CLAIM_LEASE_MS - 60_000).toISOString(),
        req.id,
      )
    await age()
    expect((await requestsOf(f.projectId))[0].status).toBe('approving')
    await proposeChanges(f.projectId)
    expect((await requestsOf(f.projectId))[0].status).toBe('pending_approval')

    // …and an approval arriving before that pass takes the dead claim over.
    expect(await claimRequest(f.projectId, req.id)).toBe(true)
    await age()
    const r = await approveRequest({ projectId: f.projectId, findingId: req.id, planVersion: req.ev.planVersion, userId: f.ownerId })
    expect(r.ok).toBe(true)
    expect((await requestsOf(f.projectId))[0].status).toBe('approved')
    expect((await stateOf(f.projectId, req.ev.decisionId)).state).toBe('approved')
  })
})
