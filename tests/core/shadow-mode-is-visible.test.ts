/**
 * A BACKEND THAT REPAIRS NOTHING MUST NOT READ "AUTOPILOT"
 * =========================================================
 *
 * `ENABLE_AUTONOMY_LIVE_EXECUTION` defaults to false. With the reconciler on
 * and that flag unset, the loop evaluates every invariant, decides what it
 * would repair, writes an `AUTONOMY_SHADOW_DECISION` row that looks like
 * work, and applies nothing.
 *
 * Every surface rendered `labelFor(project.autonomyLevel)` — the dial the
 * owner ASKED for — so the page said "Autopilot" over a deployment
 * structurally incapable of applying a single fix. The only signal was a
 * server log line throttled to once an hour, which is not a place an owner
 * looks. `.env.example` describes the problem in its own words: shadow mode
 * "is indistinguishable from working autonomy on every dashboard surface".
 *
 * These tests pin the distinction at the one place all three surfaces read
 * from, and then pin that each surface actually reads it.
 */

import * as fs from 'fs'
import * as path from 'path'
import { resolveExecutionMode } from '@/lib/autonomy/execution-mode'

const ROOT = path.resolve(__dirname, '..', '..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

const ORIGINAL = {
  reconciler: process.env.ENABLE_AUTONOMY_RECONCILER,
  live: process.env.ENABLE_AUTONOMY_LIVE_EXECUTION,
}

afterEach(() => {
  process.env.ENABLE_AUTONOMY_RECONCILER = ORIGINAL.reconciler
  process.env.ENABLE_AUTONOMY_LIVE_EXECUTION = ORIGINAL.live
})

describe('the runtime mode is a fact, not an inference', () => {
  it('is shadow when the deployment has not enabled live execution', () => {
    process.env.ENABLE_AUTONOMY_RECONCILER = 'true'
    delete process.env.ENABLE_AUTONOMY_LIVE_EXECUTION

    const m = resolveExecutionMode('AGGRESSIVE')
    // The dial says AGGRESSIVE and the answer is still shadow. That gap is
    // the entire bug.
    expect(m.mode).toBe('shadow')
    expect(m.repairsAreApplied).toBe(false)
    expect(m.reason).toBe('deployment_flag_off')
    // Names the lever, because on a self-hosted install the owner and the
    // operator are usually the same person reading two different docs.
    expect(m.explanation).toContain('ENABLE_AUTONOMY_LIVE_EXECUTION')
  })

  it('is live only when the flag AND the dial both permit acting', () => {
    process.env.ENABLE_AUTONOMY_RECONCILER = 'true'
    process.env.ENABLE_AUTONOMY_LIVE_EXECUTION = 'true'

    const m = resolveExecutionMode('AGGRESSIVE')
    expect(m.mode).toBe('live')
    expect(m.repairsAreApplied).toBe(true)
  })

  it('tells the three reasons apart, because an owner acts differently on each', () => {
    process.env.ENABLE_AUTONOMY_RECONCILER = 'true'
    process.env.ENABLE_AUTONOMY_LIVE_EXECUTION = 'true'
    // The owner's own choice. Working as intended, not a misconfiguration.
    expect(resolveExecutionMode('OFF').reason).toBe('project_dial_off')

    delete process.env.ENABLE_AUTONOMY_RECONCILER
    // Autonomy disabled outright.
    expect(resolveExecutionMode('AGGRESSIVE').reason).toBe('loop_off')
    // Not "nothing is watching": the observer and the contract sweep still run
    // and report with the reconciler off. What stops is every repair.
    expect(resolveExecutionMode('AGGRESSIVE').explanation).toMatch(/repairs nothing/)
  })

  it('mirrors the reconciler dispatch, flag before dial', () => {
    // If these two ever disagree, the dashboard becomes wrong again. The
    // reconciler checks the flag and the level in one condition; this asserts
    // the ordering that makes `deployment_flag_off` win over a dial that is
    // also off, so a self-hoster is told the actionable cause.
    process.env.ENABLE_AUTONOMY_RECONCILER = 'true'
    delete process.env.ENABLE_AUTONOMY_LIVE_EXECUTION
    expect(resolveExecutionMode('OFF').reason).toBe('deployment_flag_off')

    const reconciler = read('lib/autonomy/reconciler.ts')
    expect(reconciler).toContain("level === 'OFF' || !FLAGS.ENABLE_AUTONOMY_LIVE_EXECUTION")
  })
})

describe('every surface reads the mode rather than the dial', () => {
  it('the trust report carries it, computed not inferred', () => {
    const src = read('lib/autonomy/trust-report.ts')
    expect(src).toContain('executionMode: resolveExecutionMode(level)')
    // `shadowPreview` is derived from the last shadow audit row, so it says
    // nothing on a project that has never ticked. It may stay; it may not be
    // what the surfaces trust.
    expect(src).toContain('shadowPreview')
  })

  it('the Autonomy page shows shadow over the dial, and says why', () => {
    const src = read('components/AutonomyGuardrailsSettings.tsx')
    // The badge.
    expect(src).toMatch(/shadow\s*\n?\s*\?\s*\{ label: 'Shadow'/)
    // And the body, because a badge is a label and this is the most important
    // fact on the page when it is true.
    expect(src).toContain('Watching, not repairing')
    expect(src).toContain('executionMode.explanation')
  })

  it('an agent asking over MCP is told before it is told the dial', () => {
    const src = read('lib/ai/brain/tools.ts')
    expect(src).toContain('NOT REPAIRING.')
    // Hoisted out of the nested report so structured-data readers cannot miss
    // it behind `level`.
    expect(src).toContain('executionMode: report.executionMode')
  })
})
