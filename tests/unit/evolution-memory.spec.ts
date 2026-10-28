/**
 * ARCHITECTURE MEMORY FOLDS — what the engine believes about its own past
 * =======================================================================
 *
 * Every decision the engine makes reads its history through these folds: the
 * current state of a change, whether it was declined or undone, what the next
 * analysis must hold back, the observation passes and snapshots behind a
 * verdict. They are pure, so they are pinned here without a database; the
 * write side is covered end to end in tests/integration/evolution-engine.spec.ts.
 */

import {
  latestAssessment,
  openDecision,
  passesOf,
  priorFor,
  priorsFor,
  snapshotsOf,
  summarizeDecisions,
  type EvolutionRecord,
  type MemoryEntry,
} from '@/lib/evolution-engine/memory'
import type { LifecycleState } from '@/lib/evolution-engine/lifecycle'

let clock = Date.parse('2026-09-01T00:00:00Z')

function entry(record: Partial<EvolutionRecord> & Pick<EvolutionRecord, 'event'>, opts: { milestone?: boolean; sentence?: string } = {}): MemoryEntry {
  clock += 60_000
  return {
    at: new Date(clock),
    milestone: !!opts.milestone,
    sentence: opts.sentence ?? '',
    userId: null,
    record: {
      v: 1,
      decisionId: 'd1',
      concernKey: 'orders:refund',
      proposalKey: 'evolution:orders:refund_amount+refund_reason',
      planId: 'p1',
      primitive: 'structural_extraction',
      subject: 'orders',
      ...record,
    },
  }
}

const to = (state: LifecycleState, extra: Partial<EvolutionRecord> = {}, opts: { milestone?: boolean; sentence?: string } = {}) =>
  entry({ event: 'transition', state, ...extra }, opts)

describe('summarizeDecisions', () => {
  it('follows a change to its latest state and keeps what consent binds to', () => {
    const [d] = summarizeDecisions([
      to('proposed', { payload: { spec: { host: 'orders' } } }),
      to('rehearsing'),
      to('rehearsed'),
      to('awaiting_approval', { planVersion: 'v1', payload: { findingId: 'f1' } }, { milestone: true, sentence: 'waiting' }),
      to('approved', {}, { milestone: true, sentence: 'You approved it.' }),
      to('expanding'),
    ])
    expect(d).toMatchObject({
      decisionId: 'd1',
      proposalKey: 'evolution:orders:refund_amount+refund_reason',
      state: 'expanding',
      planVersion: 'v1',
      findingId: 'f1',
      spec: { host: 'orders' },
      everApproved: true,
      headline: 'You approved it.',
      declined: false,
    })
  })

  it('records when "after" starts, and why a change stopped', () => {
    const [d] = summarizeDecisions([to('approved'), to('cutover'), to('observing'), to('blocked', { payload: { reason: 'consistency regressed' } })])
    expect(d.cutoverAt).toBeInstanceOf(Date)
    expect(d.stoppedBecause).toBe('consistency regressed')
    expect(d.state).toBe('blocked')
  })

  it('clears a stop when the change resumes', () => {
    const [d] = summarizeDecisions([
      to('approved'),
      entry({ event: 'withdrawn' }),
      to('blocked', { payload: { reason: 'you paused it' } }),
      to('approved'),
    ])
    expect(d.stoppedBecause).toBeUndefined()
    expect(d.withdrawn).toBe(false)
  })

  it('ignores assessments: they are not decisions', () => {
    const out = summarizeDecisions([entry({ event: 'assessed', decisionId: 'assessment:orders:refund', level: 'watching' })])
    expect(out).toEqual([])
  })

  it('keeps the latest outcome, and marks a regression', () => {
    const [d] = summarizeDecisions([
      to('observing'),
      entry({ event: 'outcome', payload: { benefit: { verdict: 'insufficient_evidence', summary: 'too little traffic' } } }),
      entry({ event: 'outcome', payload: { benefit: { verdict: 'regressed', summary: 'p95 doubled' } } }),
    ])
    expect(d.outcome).toMatchObject({ verdict: 'regressed', summary: 'p95 doubled' })
    expect(d.regressed).toBe(true)
  })

  it('a change never approved is marked so: it must not be reported as anyone\'s change', () => {
    const [d] = summarizeDecisions([to('proposed'), to('rehearsing'), to('blocked', { payload: { reason: 'rehearsal failed' } })])
    expect(d.everApproved).toBe(false)
  })
})

describe('what memory holds back', () => {
  it('a declined change is held, per concern', () => {
    const ds = summarizeDecisions([to('awaiting_approval'), entry({ event: 'declined' })])
    expect(priorFor(ds, 'orders:refund')).toMatchObject({ kind: 'declined' })
    expect(openDecision(ds, 'orders:refund')).toBeNull()
  })

  it('an undone change is remembered as reversed, and as regressed only if it was', () => {
    const plain = summarizeDecisions([to('stable'), to('rolling_back'), to('rolled_back')])
    expect(priorFor(plain, 'orders:refund')).toMatchObject({ kind: 'reversed', regressed: false })
    const bad = summarizeDecisions([to('observing'), to('blocked', { payload: { verdict: 'regressed' } }), to('rolling_back'), to('rolled_back')])
    expect(priorFor(bad, 'orders:refund')).toMatchObject({ kind: 'reversed', regressed: true })
  })

  it('a change in effect holds back a duplicate, and stays the open decision', () => {
    const ds = summarizeDecisions([to('approved'), to('expanding'), to('backfilling')])
    expect(priorFor(ds, 'orders:refund')).toMatchObject({ kind: 'in_effect' })
    expect(openDecision(ds, 'orders:refund')?.state).toBe('backfilling')
  })

  it('the LATEST decision about a concern decides', () => {
    const ds = summarizeDecisions([
      to('rolled_back', { decisionId: 'old' }),
      to('awaiting_approval', { decisionId: 'new' }),
    ])
    expect(priorFor(ds, 'orders:refund')).toEqual({ kind: 'none' })
    expect(openDecision(ds, 'orders:refund')?.decisionId).toBe('new')
  })

  it('is keyed by concern, so other concerns are untouched', () => {
    const ds = summarizeDecisions([to('awaiting_approval'), entry({ event: 'declined' })])
    expect(priorsFor(ds)).toEqual({ 'orders:refund': expect.objectContaining({ kind: 'declined' }) })
    expect(priorFor(ds, 'orders:coupon')).toEqual({ kind: 'none' })
  })
})

describe('the evidence behind a verdict', () => {
  it('reads observation passes and snapshots back in order', () => {
    const trail = [
      to('observing'),
      entry({ event: 'measured', payload: { snapshot: { v: 1, phase: 'S1', at: 'x', data: {}, unavailable: [] } } }),
      entry({ event: 'observed', payload: { signals: [{ name: 'consistency', status: 'ok', detail: 'match' }] } }),
      entry({ event: 'observed', payload: { signals: [{ name: 'consistency', status: 'regressed', detail: 'missing' }] } }),
      entry({ event: 'measured', payload: { snapshot: { v: 2, phase: 'S2' } } }), // unknown version: ignored
    ]
    expect(passesOf(trail).map(p => p.signals[0].status)).toEqual(['ok', 'regressed'])
    expect(snapshotsOf(trail).map(s => s.phase)).toEqual(['S1'])
  })

  it('finds the latest assessment of a concern', () => {
    const all = [
      entry({ event: 'assessed', concernKey: 'orders:refund', level: 'watching' }, { sentence: 'first' }),
      entry({ event: 'assessed', concernKey: 'orders:coupon', level: 'watching' }, { sentence: 'other' }),
      entry({ event: 'assessed', concernKey: 'orders:refund', level: 'executable_proposal' }, { sentence: 'second' }),
    ]
    expect(latestAssessment(all, 'orders:refund')?.sentence).toBe('second')
    expect(latestAssessment(all, 'users:billing')).toBeNull()
  })
})
