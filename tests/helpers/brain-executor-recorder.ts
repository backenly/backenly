/**
 * Records every action the brain's tools hand to the executor, and runs it.
 *
 * The executor stays real: it writes to the test database, so a test reads back
 * tables rather than a stub's say-so. What the recorder adds is the list of
 * actions that reached it, so a test can also assert that a turn sent the
 * executor nothing (a held call, a CHAT answer) or sent it exactly one action.
 *
 * A suite opts in with the one line below, which jest hoists above its imports.
 * Without it the list stays empty and the executor is untouched.
 *
 *   jest.mock('@/lib/ai/minimal-executor', () => require('../helpers/brain-executor-recorder').recordingExecutor())
 */

import type { AIAction } from '@/lib/ai/minimal-executor'

export interface ExecutorCall {
  action: AIAction
  projectId: string
}

/** Every call since the process started; a turn reads the slice it made. */
export const executorCalls: ExecutorCall[] = []

export function recordingExecutor() {
  const actual = jest.requireActual<typeof import('@/lib/ai/minimal-executor')>('@/lib/ai/minimal-executor')
  return {
    ...actual,
    executeAction: (...args: Parameters<typeof actual.executeAction>) => {
      executorCalls.push({ action: args[0], projectId: args[1] })
      return actual.executeAction(...args)
    },
  }
}
