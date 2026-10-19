/**
 * A HELD ACTION REPLAYS EXACTLY WHAT IT WAS HELD WITH, OR NOTHING
 * ===============================================================
 * Approval replays a held action (ai_action_pending) from its sealed copy
 * (lib/operational-memory/sealed-params.ts). The display copy beside it has its
 * secret-named values withheld, so it is never replayed in their place: a
 * sealed copy that cannot be opened (corrupt, or sealed under another
 * deployment's JWT_SECRET) runs nothing, and the owner is told to have the
 * change held again. A legacy row, from before the sealed copy, kept the raw
 * arguments and still replays them.
 */

import { randomBytes } from 'crypto'
import { buildFixAction, getManualRemediationHint } from '@/lib/core/fix-actions'
import { WITHHELD, redactSecretParams } from '@/lib/mcp/withhold-secrets'
import { sealParams } from '@/lib/operational-memory/sealed-params'

const saved = process.env.JWT_SECRET
const SECRET_A = randomBytes(32).toString('hex')
const SECRET_B = randomBytes(32).toString('hex')
beforeEach(() => {
  process.env.JWT_SECRET = SECRET_A
})
afterAll(() => {
  if (saved === undefined) delete process.env.JWT_SECRET
  else process.env.JWT_SECRET = saved
})

const PARAMS = { key: 'PAYMENT_PROVIDER_KEY', value: 'not-a-real-provider-value-0123456789' }

/** A held SET_ENV_VAR row as queuePendingActionFinding writes it today. */
const held = (sealed: unknown = sealParams(PARAMS)) => ({
  title: 'Set env var on PAYMENT_PROVIDER_KEY',
  executorAction: 'SET_ENV_VAR',
  executorParams: redactSecretParams(PARAMS),
  executorParamsSealed: sealed,
})

describe('approving a held action', () => {
  it('replays the exact arguments from the sealed copy', () => {
    const details = held()
    expect(details.executorParams.value).toBe(WITHHELD)
    expect(buildFixAction('ai_action_pending', details)).toEqual({
      action: 'SET_ENV_VAR',
      params: { ...PARAMS, confirmed: true },
    })
  })

  it('runs nothing when the sealed copy was sealed under another secret, and says to hold it again', () => {
    const details = held()
    process.env.JWT_SECRET = SECRET_B
    expect(buildFixAction('ai_action_pending', details)).toBeNull()
    expect(getManualRemediationHint('ai_action_pending', details)).toMatch(/could not be opened, so nothing was run/)
  })

  it('runs nothing when the sealed copy is corrupt', () => {
    const details = held('v1.garbage.garbage.garbage')
    expect(buildFixAction('ai_action_pending', details)).toBeNull()
    expect(getManualRemediationHint('ai_action_pending', details)).toMatch(/held again for your approval/)
  })

  it('never replays a display copy that carries withheld values', () => {
    const { executorParamsSealed: _sealed, ...withoutSealed } = held()
    expect(buildFixAction('ai_action_pending', withoutSealed)).toBeNull()
  })

  it('still replays a legacy row, which kept the raw arguments and no sealed copy', () => {
    const legacy = { title: 'Set env var', executorAction: 'SET_ENV_VAR', executorParams: PARAMS }
    expect(buildFixAction('ai_action_pending', legacy)).toEqual({
      action: 'SET_ENV_VAR',
      params: { ...PARAMS, confirmed: true },
    })
  })
})
