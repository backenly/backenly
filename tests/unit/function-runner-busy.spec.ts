/**
 * A RUN TURNED AWAY FOR CAPACITY IS A 503, NEVER THE FUNCTION'S FAILURE
 * ====================================================================
 *
 * The function supervisor runs BACKENLY_FN_MAX_CONCURRENCY runs at once and
 * lets BACKENLY_FN_MAX_QUEUE more wait up to BACKENLY_FN_QUEUE_WAIT_MS; past
 * that it refuses a run as busy. Pinned here, against a stand-in supervisor
 * (the real one needs root: function-isolation-root.spec.ts):
 *
 *  1. A busy refusal rejects with FunctionRunnerBusyError, which is still a
 *     FunctionRunnerUnavailableError, so every caller that leaves a function
 *     alone when functions cannot run leaves it alone when the server is busy.
 *  2. Any other refusal stays FunctionRunnerUnavailableError.
 *  3. The HTTP surfaces answer both 503, a busy one with Retry-After.
 *
 * What the executor and the row-event queue do with it, against a real
 * database: __tests__/usage/usage-meters.test.ts and
 * tests/integration/function-runs-queued.spec.ts.
 */

import {
  BUSY_RETRY_AFTER_SECONDS,
  FunctionRunnerBusyError,
  FunctionRunnerUnavailableError,
  runIsolated,
} from '@/lib/services/ai-functions/isolation/client'
import { runnerRefusal } from '@/lib/services/ai-functions/reply'
import { BUSY_REFUSAL, startStandInSupervisor, type StandInSupervisor } from '../helpers/stand-in-function-supervisor'

const describeUnix = process.platform === 'win32' ? describe.skip : describe

describeUnix('a run the function supervisor turns away', () => {
  let supervisor: StandInSupervisor

  beforeAll(async () => {
    supervisor = await startStandInSupervisor()
    supervisor.use()
  })

  afterAll(async () => {
    await supervisor?.close()
  })

  const job = { kind: 'sandbox-validate' as const, payload: { code: 'return 1' }, hardTimeoutMs: 5000 }

  it('rejects as busy when every slot is taken, with its own code and a time to try again', async () => {
    supervisor.answer(BUSY_REFUSAL)
    const failure = await runIsolated(job).then(() => null, (err) => err)
    expect(failure).toBeInstanceOf(FunctionRunnerBusyError)
    expect(failure).toBeInstanceOf(FunctionRunnerUnavailableError)
    expect(failure.code).toBe('FUNCTION_RUNNER_BUSY')
    expect(failure.retryAfterSeconds).toBe(BUSY_RETRY_AFTER_SECONDS)
    expect(failure.message).toContain('the queue for one (64) was full')
    expect(supervisor.headers[supervisor.headers.length - 1]).toEqual({ v: 1, op: 'run', timeoutMs: 5000 })
  })

  it('keeps any other refusal as functions being unavailable here, not busy', async () => {
    supervisor.answer({ type: 'refused', reason: 'a pool uid could read /app' })
    const failure = await runIsolated(job).then(() => null, (err) => err)
    expect(failure).toBeInstanceOf(FunctionRunnerUnavailableError)
    expect(failure).not.toBeInstanceOf(FunctionRunnerBusyError)
    expect(failure.code).toBe('FUNCTION_RUNNER_UNAVAILABLE')
    expect(failure.message).toContain('a pool uid could read /app')
  })
})

describe('the answer to a run the function runner turned away', () => {
  it('is 503 with Retry-After when the server was busy', () => {
    expect(runnerRefusal({ errorCode: 'RUNNER_BUSY', error: 'Too many functions', retryAfterSeconds: 5 })).toEqual({
      status: 503,
      code: 'FUNCTION_RUNNER_BUSY',
      error: 'Too many functions',
      retryAfter: 5,
    })
  })

  it('is 503 without Retry-After when functions cannot run here at all', () => {
    expect(runnerRefusal({ errorCode: 'RUNNER_UNAVAILABLE', error: 'Functions cannot run here' })).toEqual({
      status: 503,
      code: 'FUNCTION_RUNNER_UNAVAILABLE',
      error: 'Functions cannot run here',
    })
  })

  it('is nothing for a run that happened, or for any other refusal', () => {
    expect(runnerRefusal({})).toBeNull()
    expect(runnerRefusal({ errorCode: 'PLAN_LIMIT_EXCEEDED', error: 'over the plan' })).toBeNull()
    expect(runnerRefusal({ errorCode: 'NOT_FOUND' })).toBeNull()
  })
})
