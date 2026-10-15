/**
 * MODEL-BACKED TOOLS MUST BE BOTH GATED AND CHARGED
 * =================================================
 * Two production billing holes shipped, months apart, with the same shape: a
 * path that spends Backenly's model budget and never debits the user.
 *
 *   1. `backend_chat` ran a full multi-step brain loop on our key with no
 *      charge — `chargeAiCredits` had no callers at all.
 *   2. `generate_function` on /api/mcp/tool was gated on credits but never
 *      debited them. This one is the more dangerous shape, because it LOOKS
 *      billed: the 402 branch is right there in the source. But a meter that
 *      never moves never reaches the cap, so the gate was decorative and the
 *      tool was unlimited — bounded only by the 600 req/min default key rate
 *      limit, against unlimited monthly API requests on Pro.
 *
 * Neither was caught by a test, because there were no billing tests. Both are
 * invisible in review: the code reads correctly and every existing test passes.
 * The cost surfaces weeks later on an invoice nobody can attribute.
 *
 * This file asserts the contract that makes the class impossible:
 *   • the meter actually counts (behavioural, not source-grepped)
 *   • it counts through async depth, which is where a naive counter breaks
 *   • it stays silent outside a scope, so free paths remain free
 *   • a scope that throws still reports what it burned
 *   • both OpenAI client boundaries are wired to it
 *   • the route opens a scope and charges from it
 */

import {
  createTokenScope,
  runInTokenScope,
  recordTokens,
  meterCompletion,
  attachTokenMeter,
} from '@/lib/ai/token-meter'
import * as fs from 'fs'
import * as path from 'path'

const ROOT = path.resolve(__dirname, '..', '..')

/** Minimal stand-in for the shape `attachTokenMeter` wraps. */
function fakeClient(usage: { total_tokens: number } | undefined) {
  return {
    chat: {
      completions: {
        create: (..._args: any[]) => Promise.resolve({ usage, choices: [] }),
      },
    },
  }
}

describe('token meter — behaviour', () => {
  it('counts a completion issued inside a scope', async () => {
    const client = fakeClient({ total_tokens: 1234 })
    attachTokenMeter(client)

    const scope = createTokenScope()
    await runInTokenScope(scope, async () => {
      await client.chat.completions.create({ model: 'x' })
    })

    expect(scope.tokens).toBe(1234)
  })

  it('counts across async depth, not just the immediate frame', async () => {
    // The failure mode a naive implementation has: tokens spent three awaits
    // deep — exactly where the function generator's repair pass lives — are
    // lost, and the charge silently under-bills.
    const client = fakeClient({ total_tokens: 500 })
    attachTokenMeter(client)

    const scope = createTokenScope()
    await runInTokenScope(scope, async () => {
      await (async () => {
        await new Promise((r) => setTimeout(r, 1))
        await (async () => {
          await client.chat.completions.create({ model: 'x' })
        })()
      })()
    })

    expect(scope.tokens).toBe(500)
  })

  it('accumulates every completion in the scope, not just the last', async () => {
    const client = fakeClient({ total_tokens: 100 })
    attachTokenMeter(client)

    const scope = createTokenScope()
    await runInTokenScope(scope, async () => {
      await client.chat.completions.create({ model: 'x' })
      await client.chat.completions.create({ model: 'x' })
      await client.chat.completions.create({ model: 'x' })
    })

    expect(scope.tokens).toBe(300)
  })

  it('is silent outside a scope, so unmetered paths stay free', async () => {
    // The autonomy loop and the free dashboard assistant both run through
    // metered clients and must remain uncharged. If this ever fails, every
    // self-heal tick starts billing a user for a loop we promise is free.
    const client = fakeClient({ total_tokens: 9_999 })
    attachTokenMeter(client)

    const scope = createTokenScope()
    await client.chat.completions.create({ model: 'x' }) // no scope open
    expect(scope.tokens).toBe(0)
  })

  it('reports tokens burned by a run that threw', async () => {
    // A dispatch that spent 8k tokens and then failed is precisely the run
    // worth charging for. The route bills in `finally` and depends on this.
    const scope = createTokenScope()
    await expect(
      runInTokenScope(scope, async () => {
        recordTokens(800)
        throw new Error('dispatch blew up')
      }),
    ).rejects.toThrow('dispatch blew up')

    expect(scope.tokens).toBe(800)
  })

  it('ignores responses with no usage (streams) instead of throwing', async () => {
    const scope = createTokenScope()
    await runInTokenScope(scope, async () => {
      meterCompletion({ choices: [] })
      meterCompletion(null)
      meterCompletion(undefined)
      meterCompletion({ usage: { total_tokens: 'not-a-number' } })
    })
    expect(scope.tokens).toBe(0)
  })

  it('preserves the object the SDK returns rather than re-wrapping it', async () => {
    // The SDK's `create` returns an APIPromise carrying `.withResponse()`. An
    // `async` wrapper would strip those methods and break any caller using them.
    const extra = jest.fn()
    const client = {
      chat: {
        completions: {
          create: () => Object.assign(Promise.resolve({ usage: { total_tokens: 5 } }), {
            withResponse: extra,
          }),
        },
      },
    }
    attachTokenMeter(client)
    const returned: any = client.chat.completions.create()
    expect(typeof returned.withResponse).toBe('function')
    await returned
  })

  it('is idempotent — double-attaching does not double-count', async () => {
    // Both clients are module singletons that can be re-imported; a second
    // attach must not silently double every user's bill.
    const client = fakeClient({ total_tokens: 700 })
    attachTokenMeter(client)
    attachTokenMeter(client)

    const scope = createTokenScope()
    await runInTokenScope(scope, async () => {
      await client.chat.completions.create({ model: 'x' })
    })

    expect(scope.tokens).toBe(700)
  })
})

describe('the billing contract is wired at every boundary', () => {
  const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8')

  it('has one model boundary left, the AI gateway', () => {
    // There used to be two OpenAI clients that grew up separately, and a model
    // call through either had to be countable. Both are gone: every call goes
    // through lib/ai/llm, so "is this billed?" has one place to answer it.
    expect(fs.existsSync(path.join(ROOT, 'lib/ai/openai-service.ts'))).toBe(false)
    expect(fs.existsSync(path.join(ROOT, 'lib/openai/client.ts'))).toBe(false)
  })

  it('the AI gateway reports every call that ran into the meter', () => {
    // The brain's answer_question runs through the gateway, and the MCP tool
    // route charges it from this meter. tests/unit/llm-gateway.spec.ts shows
    // the behaviour; this pins the boundary that carries it.
    expect(read('lib/ai/llm/index.ts')).toContain('recordTokens(')
  })

  it('the MCP tool route both gates AND charges its model-backed tools', () => {
    const route = read('app/api/mcp/tool/route.ts')

    // Gate half — refuses the call when the month is spent.
    expect(route).toContain('enforceAiCredits')
    // Charge half — the half that was missing, and whose absence made the gate
    // decorative. If a refactor drops this, the tool silently becomes free and
    // unlimited again. The route closes the turn, which charges and then stops
    // the turn's credit holds counting.
    expect(route).toContain('closeCreditTurn')
    // Charged from measured usage, not an estimate or a flat per-call fee.
    expect(route).toContain('runInTokenScope')
    expect(route).toContain('tokenScope.tokens')
  })

  it('the MCP tool route gates and charges every tool’s model calls, not a listed few', () => {
    // The charge used to apply only to MODEL_BACKED_TOOLS, so functions.schedule
    // and integrations.connect spent the model budget ungated and uncharged
    // (FN-12, FN-19, INT-15). The scope names who pays, so each model call holds
    // credits, and the charge is whatever the scope measured.
    // tests/integration/model-spend-on-every-tool.spec.ts shows the behaviour.
    const route = read('app/api/mcp/tool/route.ts')
    expect(route).toContain('createTokenScope({ projectId: auth.projectId })')
    expect(route).not.toMatch(/metered\s*\?/)
    expect(route).toContain('closeCreditTurn(await creditAccountOf(auth.projectId), tokenScope, tokenScope.tokens)')
  })

  it('a typed call is never handed to a model for a different action unless its caller opts in', () => {
    // A failed typed call used to be "replanned": a model picked another
    // action from the error and the executor ran it, uncharged.
    expect(read('lib/ai/brain/tools.ts')).toContain('ctx.allowReplan ?? false')
  })

  it('the natural-language route still charges what the brain burned', () => {
    // Guards hole #1 against regression.
    const route = read('app/api/mcp/chat/route.ts')
    expect(route).toContain('enforceAiCredits')
    expect(route).toContain('closeCreditTurn')
    expect(route).toContain('onTokens')
  })

  it('closing a turn charges it before it stops the turn’s holds counting', () => {
    // Both routes charge through closeCreditTurn. If it stopped charging, every
    // model-backed path would be free again; if it released before charging,
    // a finished call would be counted nowhere for a moment.
    const holds = read('lib/entitlements/credit-holds.ts')
    const body = holds.slice(holds.indexOf('export async function closeCreditTurn('))
    expect(body.indexOf('await chargeAiCredits(')).toBeGreaterThan(-1)
    expect(body.indexOf('await chargeAiCredits(')).toBeLessThan(body.indexOf('aiCreditHold'))
  })

  it('names a non-empty model-backed set (guards against a vacuous pass)', () => {
    // Without this, deleting the set would make every assertion above pass by
    // describing a contract that governs nothing — the most dangerous way for a
    // billing guard to fail.
    const route = read('app/api/mcp/tool/route.ts')
    const match = route.match(/MODEL_BACKED_TOOLS = new Set\(\[([^\]]*)\]\)/)
    expect(match).not.toBeNull()
    const members = [...match![1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1])
    expect(members).toContain('generate_function')
    expect(members).toContain('create_cron_job')
    expect(members.length).toBeGreaterThan(0)
  })
})
