/**
 * NOTHING A FUNCTION RUN WRITES CAN THROW IN THE APP
 * =================================================
 *
 * Every line a run writes reaches this process inside a stream event handler
 * (the supervisor's socket, or a development runner's stdout), and the run's
 * code can write any line it likes once it escapes its vm context. A result
 * line nested 200,000 deep overflowed the stack in the decoder there, outside
 * any try, and took the whole server down with it: the runtime serving /fn has
 * no uncaughtException handler. Pinned here:
 *
 *  1. The decoder refuses nesting past its limit with a RangeError, instead of
 *     taking the stack.
 *  2. A forged line that cannot be read fails that run, as the function's
 *     failure, and this process carries on: from a stand-in supervisor, and
 *     from a real runner process whose code writes the line itself.
 */

import { decodeValue, encodeValue, runIsolated } from '@/lib/services/ai-functions/isolation/client'
import { startStandInSupervisor, type StandInSupervisor } from '../helpers/stand-in-function-supervisor'

const DEEP = 200_000
const deepJson = '['.repeat(DEEP) + ']'.repeat(DEEP)
const forgedResult = `{"t":"result","ok":true,"value":${deepJson},"logs":[]}`

describe('decoding what a run sent', () => {
  it('refuses nesting past its limit, without taking the stack', () => {
    expect(() => decodeValue(JSON.parse(deepJson))).toThrow(/nested too deeply/)
    const ok = JSON.parse('['.repeat(900) + '1' + ']'.repeat(900))
    expect(() => decodeValue(ok)).not.toThrow()
  })

  it('counts depth through every tagged form, not only arrays', () => {
    let value: unknown = 1
    for (let i = 0; i < 1100; i++) value = { $bkn: 's', v: [value] }
    expect(() => decodeValue(value)).toThrow(/nested too deeply/)
  })
})

const describeUnix = process.platform === 'win32' ? describe.skip : describe

describeUnix('a forged line from a run', () => {
  it("from the supervisor fails that run, as the function's failure, and nothing else", async () => {
    const supervisor: StandInSupervisor = await startStandInSupervisor({
      lines: [`c${forgedResult}`, `s${JSON.stringify({ type: 'exit', code: 0, signal: null, killed: null, stderr: '' })}`],
    })
    supervisor.use()
    try {
      const outcome = await runIsolated({ kind: 'sandbox-validate', payload: { code: 'return 1' }, hardTimeoutMs: 5000 })
      expect(outcome.result).toMatchObject({ ok: false, errorKind: 'protocol' })
      expect(outcome.result?.error).toMatch(/could not be read.*nested too deeply/)
    } finally {
      await supervisor.close()
    }
  })

  it('written by the function code itself fails that run, and this process carries on', async () => {
    const outcome = await runIsolated({
      kind: 'sandbox',
      payload: {
        code: `
          const p = Object.constructor('return this')()['proc' + 'ess']
          p.stdout.write(${JSON.stringify(forgedResult + '\n')})
          await new Promise((r) => setTimeout(r, 1000))
          return 'the real answer'
        `,
        event: encodeValue({ type: 'manual', data: {} }),
        connectedIntegrations: [],
        envVars: {},
        integrationManifest: {},
        timeoutMs: 9500,
      },
      hardTimeoutMs: 12_000,
    })
    expect(outcome.result).toMatchObject({ ok: false, errorKind: 'protocol' })
    expect(outcome.result?.error).toMatch(/nested too deeply/)
  })
})
