/**
 * AUTONOMY MUST NOT SPEND TOKENS
 * ==============================
 * The self-healing loop is Backenly's differentiator and it is given away free
 * on every tier. That is only sustainable because the loop is deterministic:
 * probes find drift, the fix engine maps each finding to a typed action, and
 * `executeAction` compiles it to SQL.
 *
 * Measured on production 2026-07-26 over 24h:
 *
 *   AUTONOMY_TICK          145
 *   AUTONOMY_LIVE_RUN       48
 *   AGENT_AUTO_FIXED         3     <- real repairs applied
 *   rows written to ai_usage 0     <- zero tokens spent
 *
 * Nothing enforces that except habit. A model call added to a fix path would
 * turn a free, always-on loop into a per-project per-minute bill, silently: the
 * loop would still work, tests would still pass, and the cost would surface
 * weeks later on an invoice nobody could attribute.
 *
 * THE RULE: a model may EXPLAIN an escalation to a human (escalation-diagnosis
 * writes prose onto a finding someone will read). A model may never DETECT or
 * REPAIR.
 *
 * WHY THIS IS NOT A MODULE-GRAPH TEST
 * -----------------------------------
 * The obvious implementation — crawl imports from the loop and ban any module
 * that can reach OpenAI — was tried and deleted. `desired-state` imports one
 * detector from `workspace-observer`, which transitively pulls in most of the
 * orchestration tree. Making it pass needs ~14 allowlist entries for modules the
 * repair path never executes, and an allowlist that long guards nothing: the
 * next real violation would be waved through as "just one more". Static
 * reachability cannot express "A never calls the model function in B", which is
 * the property that actually matters.
 *
 * So this asserts the thing that IS statically decidable and IS load-bearing:
 * the set of actions the fix engine can emit. Every repair action must compile
 * to SQL. Exactly one model-backed action exists, and it is pinned by name.
 */

import * as fs from 'fs'
import * as path from 'path'

const ROOT = path.resolve(__dirname, '..', '..')
const FIX_ENGINE = path.join(ROOT, 'lib/core/auto-fix-engine.ts')

/**
 * The one repair that can spend tokens. `provision_runtime` maps to
 * GENERATE_FUNCTION as "the closest existing action" while a proper executor
 * verb is missing — see the comment at the mapping site. It provisions new
 * runtime rather than repairing drift, so it is not on the hot path, but it is
 * the seam through which a model could enter repair.
 */
const KNOWN_MODEL_BACKED_ACTIONS = ['GENERATE_FUNCTION']

describe('autonomy repair actions stay deterministic', () => {
  const source = fs.readFileSync(FIX_ENGINE, 'utf8')
  const emitted = [...source.matchAll(/action:\s*'([A-Z_]+)'/g)].map(m => m[1])

  it('reads a meaningful set of actions (guards against a regex that matches nothing)', () => {
    // Without this, a refactor that renamed the field would make every
    // assertion below pass vacuously — the most dangerous way for a guard to
    // fail.
    expect(emitted.length).toBeGreaterThan(5)
    expect(emitted).toContain('SET_PERMISSION')
  })

  it('emits exactly one model-backed action, and it is the known one', () => {
    const modelBacked = [...new Set(emitted)].filter(a => KNOWN_MODEL_BACKED_ACTIONS.includes(a))
    expect(modelBacked).toEqual(KNOWN_MODEL_BACKED_ACTIONS)
  })

  it('does not emit GENERATE_FUNCTION from more than one site', () => {
    // A second call site means a second way for repair to reach a model. If this
    // fails, the question is not "should I bump the count" — it is whether that
    // repair belongs behind the escalation boundary where a human reads it.
    expect(emitted.filter(a => a === 'GENERATE_FUNCTION')).toHaveLength(1)
  })

  it('every other emitted action is one that compiles to SQL', () => {
    // The deterministic vocabulary. Adding a genuinely SQL-backed verb here is
    // routine; adding one that calls a model is the regression this catches.
    const DETERMINISTIC = new Set([
      'SET_PERMISSION', 'FIX_API', 'ADD_CONSTRAINT', 'CREATE_INDEX', 'SET_RATE_LIMIT',
      'FIX_REALTIME', 'FIX_AUTH', 'FIX_INTEGRATION', 'FIX_WORKFLOW', 'FIX_DEPLOY',
      'REGISTER_TABLE', 'ADOPT_EXTERNAL_SCHEMA', 'GENERATE_API',
    ])
    const unknown = [...new Set(emitted)].filter(
      a => !DETERMINISTIC.has(a) && !KNOWN_MODEL_BACKED_ACTIONS.includes(a),
    )
    expect(unknown).toEqual([])
  })
})
