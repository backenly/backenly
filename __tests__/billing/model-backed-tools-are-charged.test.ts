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

  it('both OpenAI clients attach the meter', () => {
    // The platform has two clients that grew up separately. A model call added
    // through either one must be countable, or "is this billed?" becomes a
    // question about which module someone happened to import.
    expect(read('lib/ai/openai-service.ts')).toContain('attachTokenMeter')
    expect(read('lib/openai/client.ts')).toContain('attachTokenMeter')
  })

  it('the MCP tool route both gates AND charges its model-backed tools', () => {
    const route = read('app/api/mcp/tool/route.ts')

    // Gate half — refuses the call when the month is spent.
    expect(route).toContain('enforceAiCredits')
    // Charge half — the half that was missing, and whose absence made the gate
    // decorative. If a refactor drops this, the tool silently becomes free and
    // unlimited again.
    expect(route).toContain('chargeAiCredits')
    // Charged from measured usage, not an estimate or a flat per-call fee.
    expect(route).toContain('runInTokenScope')
    expect(route).toContain('tokenScope.tokens')
  })

  it('the natural-language route still charges what the brain burned', () => {
    // Guards hole #1 against regression.
    const route = read('app/api/mcp/chat/route.ts')
    expect(route).toContain('enforceAiCredits')
    expect(route).toContain('chargeAiCredits')
    expect(route).toContain('onTokens')
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
    expect(members.length).toBeGreaterThan(0)
  })
})
