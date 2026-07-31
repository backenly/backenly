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

/**
 * BOTH halves of the repair surface, because it is split across two files and
 * this guard was reading only one of them.
 *
 * `buildFixAction` — the map from a finding to the action that repairs it, i.e.
 * the entire hot path — was moved out of auto-fix-engine.ts into fix-actions.ts
 * so the Autonomy queue could ask "does a repair exist?" without importing
 * Prisma. This test kept pointing at the old file. What it found there was the
 * residual `_fixPlanToAiAction` mapping, so the count assertion below went red
 * (4, not >5) and — far worse — the model-backed-action assertions were passing
 * against a file that no longer contains the repair vocabulary at all. A
 * GENERATE_FUNCTION added to `buildFixAction` would not have tripped a thing.
 */
const REPAIR_SURFACE = [
  path.join(ROOT, 'lib/core/auto-fix-engine.ts'),
  path.join(ROOT, 'lib/core/fix-actions.ts'),
]

/**
 * The one repair that can spend tokens. `provision_runtime` maps to
 * GENERATE_FUNCTION as "the closest existing action" while a proper executor
 * verb is missing — see the comment at the mapping site. It provisions new
 * runtime rather than repairing drift, so it is not on the hot path, but it is
 * the seam through which a model could enter repair.
 */
const KNOWN_MODEL_BACKED_ACTIONS = ['GENERATE_FUNCTION']

describe('autonomy repair actions stay deterministic', () => {
  const source = REPAIR_SURFACE.map(f => fs.readFileSync(f, 'utf8')).join('\n')
  const emitted = [...source.matchAll(/action:\s*'([A-Z_]+)'/g)].map(m => m[1])

  it('reads a meaningful set of actions (guards against a regex that matches nothing)', () => {
    // Without this, a refactor that renamed the field would make every
    // assertion below pass vacuously — the most dangerous way for a guard to
    // fail. It is also what caught the file split above: the count fell to 4
    // when `buildFixAction` moved and this test did not follow it.
    expect(emitted.length).toBeGreaterThan(5)
    expect(emitted).toContain('SET_PERMISSION')
  })

  it('pins the repair map to the file it actually lives in', () => {
    // The count assertion alone cannot tell "the surface shrank" from "the
    // surface moved". Naming the entry point keeps this guard anchored to the
    // hot path rather than to whichever file still happens to hold an
    // `action:` literal.
    const map = fs.readFileSync(path.join(ROOT, 'lib/core/fix-actions.ts'), 'utf8')
    expect(map).toContain('export function buildFixAction')
    expect([...map.matchAll(/action:\s*'([A-Z_]+)'/g)].length).toBeGreaterThan(10)
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
      // Both compile to SQL / a supervised process restart, no model involved:
      // REGISTER_SCHEMA re-adds the workspace schema to PostgREST's exposed list
      // (lib/postgrest/registration.ts), HEAL_DATA_PLANE restarts a wedged
      // PostgREST after re-verifying the outage (lib/postgrest/supervisor.ts).
      'REGISTER_SCHEMA', 'HEAL_DATA_PLANE',
    ])
    const unknown = [...new Set(emitted)].filter(
      a => !DETERMINISTIC.has(a) && !KNOWN_MODEL_BACKED_ACTIONS.includes(a),
    )
    expect(unknown).toEqual([])
  })
})
