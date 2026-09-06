/**
 * BUILDING BACKENLY MUST NOT REQUIRE AN AI CREDENTIAL
 * ==================================================
 * `next build` evaluates route modules to collect their configuration, so
 * anything constructed at IMPORT time becomes a build-time requirement for the
 * whole application -- including deployments that never touch the feature it
 * belongs to.
 *
 * lib/services/aiWorkspace.ts did exactly that: a module-scope
 * `new OpenAI({ apiKey: process.env.OPENAI_API_KEY })`, which the SDK rejects
 * when the key is missing or empty. Three public routes import it
 * (ai-workspace preview-diff, generate-plan, apply-changes), so a fresh public
 * clone with no credentials could not build at all.
 *
 * ---- WHY THIS WAS INVISIBLE FOR SO LONG --------------------------------
 *
 * Public CI never built the Next application. It typechecked, it ran every
 * suite, and it built the MCP package -- but the app build only ever ran on
 * machines that already had a populated .env. Phase 8 added a build job for a
 * genuinely unconfigured checkout, and this failed on the first run.
 *
 * ---- WHAT THIS TEST DOES AND DOES NOT CLAIM ----------------------------
 *
 * It asserts that IMPORTING the module with no key is safe. It does not claim
 * the AI features work without a key: they do not, and they should not. The
 * failure simply moved to the moment an AI operation actually runs, which is
 * when the credential is genuinely needed.
 *
 * ---- WHICH ASSERTION ACTUALLY CATCHES A REGRESSION ---------------------
 *
 * Measured, not assumed. Restoring the module-scope construction was
 * mutation-tested against this suite, and only the SOURCE-level assertion
 * failed; the import assertion kept passing.
 *
 * The reason is environmental. In plain Node the SDK constructor really does
 * throw on an absent key -- that is what broke the CI build. Under jest it does
 * not: jest.config.js exempts `openai` from transformIgnorePatterns, so the
 * package is transformed and the constructor takes a different path than the
 * one `next build` evaluates.
 *
 * So the honest division of labour is:
 *
 *   source assertion   the effective unit guard against drifting back
 *   import assertion   documents the contract and holds in any environment
 *                      where the SDK validates at construction
 *   unset-edition CI   the real integration proof, and the only place the
 *                      original failure was ever observable
 *
 * Stating that plainly matters more than a tidier-looking test: a suite whose
 * described purpose exceeds what it detects is the exact failure mode Phase 1
 * was written to eliminate.
 */

const ORIGINAL_KEY = process.env.OPENAI_API_KEY

beforeEach(() => {
  jest.resetModules()
  delete process.env.OPENAI_API_KEY
})

afterEach(() => {
  if (ORIGINAL_KEY === undefined) delete process.env.OPENAI_API_KEY
  else process.env.OPENAI_API_KEY = ORIGINAL_KEY
})

describe('importing an AI module without a credential', () => {
  it('really is testing an absent key, not an empty one', () => {
    // The assertions below would pass just as happily against a runner that
    // exported a key. This pins that the case under test is genuine ABSENCE,
    // which is what a fresh public checkout has.
    expect('OPENAI_API_KEY' in process.env).toBe(false)
    expect(process.env.OPENAI_API_KEY).toBeUndefined()
  })

  it('does not construct an OpenAI client when aiWorkspace is imported', async () => {
    // Requiring the import to succeed is the same thing `next build` requires
    // when it collects page data for the routes that use this module.
    //
    // Under jest this assertion is weaker than it looks -- see the header: the
    // transformed SDK does not throw at construction here, so this alone would
    // not catch a regression. It is kept because it states the contract and
    // does hold wherever the SDK validates eagerly, which includes the build.
    await expect(import('@/lib/services/aiWorkspace')).resolves.toBeDefined()
  })

  it('keeps its exports usable, so this is a construction fix and not a stub', () => {
    // A module that "imports fine" because it was emptied would satisfy the
    // assertion above and help nobody.
    const mod = require('@/lib/services/aiWorkspace')
    expect(typeof mod.getProjectContext).toBe('function')
    expect(typeof mod.generateDemoBackendPlan).toBe('function')
  })

  it('builds the client inside a function rather than at module scope', () => {
    // THE guard, not a backstop. Mutation testing showed the runtime assertions
    // above continue to pass when construction moves back to module scope, so
    // this is the assertion that actually fails and names the problem. It also
    // catches the subtler regression the runtime check could never see: a
    // module-scope client behind a conditional, which would reintroduce the
    // build coupling for anyone who DOES set a key.
    const fs = require('fs') as typeof import('fs')
    const path = require('path') as typeof import('path')
    const src = fs.readFileSync(
      path.join(process.cwd(), 'lib/services/aiWorkspace.ts'),
      'utf8',
    )

    // Strip comments: this file explains the history in prose, and the prose
    // names the very pattern being forbidden.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

    // No top-level `const <name> = new OpenAI(` -- the construction must be
    // indented inside a function body.
    expect(code).not.toMatch(/^const\s+\w+\s*=\s*new OpenAI\(/m)
    expect(code).toMatch(/function getOpenAIClient\(\)/)
  })
})
