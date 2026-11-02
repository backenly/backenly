/**
 * The investigator's attempt accounting (lib/autonomy/escalation-diagnosis.ts):
 * an attempt is a call that ran. A throttle used to count as one, so three
 * throttles in about seventy minutes stopped a finding from ever being
 * investigated although nothing had run, and Opus 4.6 on Bedrock starts at
 * five requests a minute.
 *
 * Pure functions over a finding's bookkeeping, and the investigator against a
 * scripted provider with the in-memory spend ledger, so no database; the pass
 * that writes the bookkeeping is run against Postgres in
 * tests/integration/escalation-investigation.spec.ts.
 */

import Anthropic from '@anthropic-ai/sdk'
import { setProviderForTests, setRetryDelayForTests } from '@/lib/ai/llm'
import { AiError } from '@/lib/ai/llm/errors'
import { scriptedMessage, scriptedProvider } from '@/lib/ai/llm/providers/scripted'
import { memorySpendLedger, setSpendLedgerForTests } from '@/lib/ai/llm/spend'
import { isDue, nextInvestigationState, type InvestigationState } from '@/lib/autonomy/escalation-diagnosis'
import { investigateFinding, type InvestigationInput, type InvestigationProgress } from '@/lib/autonomy/investigator'

const FP = 'evidence-fingerprint'
const NOW = Date.parse('2026-11-02T12:00:00Z')
const MINUTE = 60_000
const HOUR = 60 * MINUTE

const throttled = () => new AiError('rate_limited', 'Too many requests', { consumption: 'none', retryable: true, provider: 'bedrock', status: 429 })
const overloaded = () => new AiError('unavailable', 'Overloaded', { consumption: 'none', retryable: true, provider: 'bedrock', status: 529 })
const noBudget = () => new AiError('spend_limit', 'budget used', { consumption: 'none' })
const timedOut = () => new AiError('timeout', 'slow', { consumption: 'unknown', provider: 'bedrock' })

const waitOf = (state: InvestigationState, from = NOW) => Date.parse(state.nextAt!) - from
const due = (state: InvestigationState, at: number) => isDue({ investigation: state }, FP, at)

describe('an attempt is a call that ran', () => {
  it('does not count a throttle on the first call; it waits ten minutes and stops the tick', () => {
    const { state, stopTick } = nextInvestigationState(undefined, FP, throttled(), NOW)
    expect(state).toMatchObject({ fingerprint: FP, attempts: 0, lastError: 'rate_limited', lastCounted: false })
    expect(waitOf(state)).toBe(10 * MINUTE)
    expect(stopTick).toBe(true)
  })

  it('never lets throttles use up a finding, however many there are', () => {
    let state: InvestigationState | undefined
    let now = NOW
    for (let i = 0; i < 10; i++) {
      expect(state === undefined || due(state, now)).toBe(true)
      state = nextInvestigationState(state, FP, throttled(), now).state
      expect(due(state, now)).toBe(false)
      now = Date.parse(state.nextAt!)
    }
    expect(state!.attempts).toBe(0)
    expect(due(state!, now)).toBe(true)
  })

  it('treats an overload the provider refused before inference like a throttle', () => {
    const { state, stopTick } = nextInvestigationState({ fingerprint: FP, attempts: 1 }, FP, overloaded(), NOW)
    expect(state).toMatchObject({ attempts: 1, lastError: 'unavailable', lastCounted: false })
    expect(waitOf(state)).toBe(10 * MINUTE)
    expect(stopTick).toBe(true)
  })

  it('waits an hour, uncounted, while no model can be called at all', () => {
    const { state, stopTick } = nextInvestigationState({ fingerprint: FP, attempts: 2 }, FP, noBudget(), NOW)
    expect(state).toMatchObject({ attempts: 2, lastError: 'spend_limit', lastCounted: false })
    expect(waitOf(state)).toBe(HOUR)
    expect(stopTick).toBe(true)
  })

  it('counts a call that may have run, backs off by its number, and lets the tick go on', () => {
    const first = nextInvestigationState(undefined, FP, timedOut(), NOW)
    expect(first).toMatchObject({ state: { attempts: 1, lastError: 'timeout', lastCounted: true }, stopTick: false })
    expect(waitOf(first.state)).toBe(10 * MINUTE)
    const second = nextInvestigationState(first.state, FP, timedOut(), NOW)
    expect(waitOf(second.state)).toBe(HOUR)
    const third = nextInvestigationState(second.state, FP, timedOut(), NOW)
    expect(third.state.attempts).toBe(3)
    expect(waitOf(third.state)).toBe(6 * HOUR)
    expect(due(third.state, NOW + 7 * HOUR)).toBe(false)
  })

  it('counts an error of its own', () => {
    const { state, stopTick } = nextInvestigationState(undefined, FP, new Error('catalog read failed'), NOW)
    expect(state).toMatchObject({ attempts: 1, lastError: 'error', lastCounted: true })
    expect(stopTick).toBe(false)
  })

  it('counts a throttle after earlier calls of the investigation ran, and still stops the tick', () => {
    // Those calls were paid for. Not counting them would repeat that spend
    // every ten minutes for as long as the throttling lasted.
    const { state, stopTick } = nextInvestigationState({ fingerprint: FP, attempts: 1 }, FP, throttled(), NOW, 2)
    expect(state).toMatchObject({ attempts: 2, lastError: 'rate_limited', lastCounted: true })
    expect(waitOf(state)).toBe(HOUR)
    expect(stopTick).toBe(true)
  })

  it('keeps the earlier answers the next attempt is briefed with', () => {
    const history = [{ at: '2026-11-01T00:00:00Z', verdict: 'uncertain', rootCause: 'not settled' }]
    expect(nextInvestigationState({ fingerprint: FP, attempts: 1, history }, FP, throttled(), NOW).state.history).toEqual(history)
  })
})

describe('a finding throttles used up before throttles stopped counting', () => {
  // Written by the old rule: three throttles, the last waiting until 12:10.
  const exhausted = (over: Partial<InvestigationState> = {}): InvestigationState => ({
    fingerprint: FP,
    attempts: 3,
    nextAt: '2026-11-02T12:10:00Z',
    lastError: 'rate_limited',
    ...over,
  })

  it('is investigated again once its wait has passed', () => {
    expect(due(exhausted(), NOW)).toBe(false)
    expect(due(exhausted(), NOW + 10 * MINUTE)).toBe(true)
  })

  it('stays given up when the failure that used it up may have run', () => {
    for (const lastError of ['unavailable', 'timeout', 'output_invalid', 'refused', 'error']) {
      expect(due(exhausted({ lastError }), NOW + 24 * HOUR)).toBe(false)
    }
    expect(due({ fingerprint: FP, attempts: 3 }, NOW)).toBe(false)
  })

  it('is kept trying by its next throttle and given up by its next attempt that fails', () => {
    const then = NOW + 10 * MINUTE
    const throttledAgain = nextInvestigationState(exhausted(), FP, throttled(), then).state
    expect(throttledAgain).toMatchObject({ attempts: 3, lastCounted: false })
    expect(due(throttledAgain, then + 10 * MINUTE)).toBe(true)

    const failed = nextInvestigationState(exhausted(), FP, timedOut(), then).state
    expect(failed).toMatchObject({ attempts: 4, lastCounted: true })
    expect(due(failed, then + 24 * HOUR)).toBe(false)
  })

  it('is not re-armed by a throttle that came after part of the investigation ran', () => {
    const counted = nextInvestigationState({ fingerprint: FP, attempts: 2 }, FP, throttled(), NOW, 1).state
    expect(counted).toMatchObject({ attempts: 3, lastError: 'rate_limited', lastCounted: true })
    expect(due(counted, NOW + 24 * HOUR)).toBe(false)
  })

  it('still yields to a diagnosis of the same evidence', () => {
    expect(isDue({ investigation: exhausted(), diagnosis: { fingerprint: FP } }, FP, NOW + HOUR)).toBe(false)
  })
})

describe('how far the investigation got before the provider refused it', () => {
  const input: InvestigationInput = {
    projectId: 'p1',
    finding: { type: 'missing_fk', severity: 'warning', status: 'pending_approval', detectedAt: new Date(NOW), summary: 'orders.customer_id has no FK', details: { tableName: 'orders' } },
    deterministic: null,
    catalog: [{ name: 'orders', columns: ['id', 'customer_id'] }],
    recentActivity: [],
    priorAttempts: [],
  }
  const throttle = () => new Anthropic.RateLimitError(429, { type: 'error' }, 'Too many requests', new Headers())
  const askForColumns = scriptedMessage({ toolUse: [{ id: 't1', name: 'list_columns', input: { table: 'orders' } }] })

  /** The failure, accounted the way the escalation pass accounts it. */
  async function investigate(steps: Parameters<typeof scriptedProvider>[0]) {
    setProviderForTests(scriptedProvider(steps))
    const progress: InvestigationProgress = { modelCalls: 0 }
    const err = await investigateFinding(input, async () => ({ outcome: 'x' }), [], progress).catch((e) => e)
    return { err, progress, ...nextInvestigationState(undefined, FP, err, NOW, progress.modelCalls) }
  }

  beforeEach(() => {
    jest.spyOn(console, 'error').mockImplementation(() => {})
    setSpendLedgerForTests(memorySpendLedger())
    setRetryDelayForTests(() => 0)
  })
  afterEach(() => {
    jest.restoreAllMocks()
    setProviderForTests(null)
    setSpendLedgerForTests(null)
    setRetryDelayForTests(null)
  })

  it('spends no attempt when the first call was throttled', async () => {
    const r = await investigate([throttle(), throttle(), throttle()])
    expect(r.err).toMatchObject({ kind: 'rate_limited', consumption: 'none' })
    expect(r.progress.modelCalls).toBe(0)
    expect(r.state).toMatchObject({ attempts: 0, lastCounted: false })
  })

  it('spends one when a later call was throttled after an earlier one ran', async () => {
    const r = await investigate([askForColumns, throttle(), throttle(), throttle()])
    expect(r.err).toMatchObject({ kind: 'rate_limited', consumption: 'none' })
    expect(r.progress.modelCalls).toBe(1)
    expect(r.state).toMatchObject({ attempts: 1, lastCounted: true })
    expect(r.stopTick).toBe(true)
  })
})
