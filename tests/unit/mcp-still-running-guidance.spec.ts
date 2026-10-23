/**
 * A change still running when backend_chat's cap fired is not "nothing applied".
 *
 * The route reports such a change as `stillRunning`: the brain left it to
 * finish, so it may take effect (#247). Both MCP transports add a line of
 * guidance to a failed result from its fields, and that line used to read
 * `partial: false` as "Nothing was applied." and `retryable: false` as "change
 * the request", which sends an agent to resend a change that may be landing.
 * The remote endpoint's rule and the stdio package's copy must say the same.
 */

import { failureGuidance as remoteGuidance } from '@/lib/mcp/protocol/shared'
import { failureGuidance as stdioGuidance } from '../../packages/mcp-server/src/result'

const atTheCap = {
  ok: false,
  error: 'Brain run exceeded 90000ms. Nothing had finished, but Creating table posts was still running and was left to finish.',
  code: 'BRAIN_TIMEOUT',
  retryable: false,
  partial: false,
  verified: false,
  stillRunning: ['Creating table posts'],
  toolsRun: [],
}

describe.each([
  ['remote endpoint', remoteGuidance],
  ['stdio package', stdioGuidance],
])('failure guidance from the %s', (_transport, guidance) => {
  it('names a change still running as one that may take effect, not as nothing applied', () => {
    const text = guidance(atTheCap)!
    expect(text).toMatch(/STILL RUNNING when it stopped, and left to finish, so it may take effect: Creating table posts\./)
    expect(text).toMatch(/Check with read_backend_state before asking for it again\./)
    expect(text).not.toMatch(/Nothing was applied/)
    expect(text).not.toMatch(/change the request/)
  })

  it('still lists what landed first when a change is running too', () => {
    const text = guidance({ ...atTheCap, partial: true, applied: ['Creating table users'] })!
    expect(text).toMatch(/^ALREADY APPLIED, do not repeat: Creating table users\. .*STILL RUNNING .*Creating table posts/)
  })

  it('says nothing was applied when nothing was running either', () => {
    const text = guidance({ ...atTheCap, stillRunning: undefined, retryable: true, retryAfterMs: 5000 })!
    expect(text).toBe('Nothing was applied. This is transient: the same request is worth retrying after 5s.')
  })
})
