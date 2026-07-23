/**
 * RESUME ROUTING REGRESSION SUITE
 * ===============================
 * Locks in the fix for the Founder Outreach "continue" dead-loop.
 *
 * When the architect failed on the original build turn, no executable plan was
 * ever stored — so the user's "go ahead" / "continue" fell into the fragile
 * agent loop, which could not finish a 40-operation spec and just re-derived
 * partial work forever. The brain now walks back to the ORIGINAL build prompt
 * and re-runs the deterministic architect. These tests guard the two pure
 * pieces of that decision:
 *
 *   1. findOriginalBuildPrompt — recovers the real spec past bare confirmations.
 *   2. the re-architect GATE — fires for a from-scratch build, NEVER for a
 *      modification confirmation on an already-built project.
 *
 * All pure — no DB, no network.
 */

import { findOriginalBuildPrompt, CONFIRM_OR_RESUME_RE } from '../../lib/ai/brain/resume-routing'
import { isExplicitSpec } from '../../lib/ai/blueprints'

const FOUNDER_OUTREACH_SPEC = `Build the backend for a SaaS app called Founder Outreach OS.

Create these tables:

1. contacts
- user_id
- name
- status: not_contacted, email_sent, replied
- created_at
- updated_at

2. followups
- user_id
- contact_id
- title
- due_date
- created_at
- updated_at`

/** The exact decision the brain's CONFIRM branch makes before re-architecting. */
function shouldReArchitect(originalBuild: string | null, isFreshProject: boolean): boolean {
  return !!originalBuild && (isExplicitSpec(originalBuild) || (isFreshProject && originalBuild.length > 200))
}

describe('findOriginalBuildPrompt', () => {
  it('recovers the original spec when the latest turns are bare confirmations', () => {
    const history = [
      { role: 'user' as const, content: FOUNDER_OUTREACH_SPEC },
      { role: 'assistant' as const, content: 'Here is the plan… Reply "go ahead" to run this, or tell me what to change.' },
      { role: 'user' as const, content: 'go ahead' },
      { role: 'assistant' as const, content: 'I applied changes, then the AI model timed out… Say "continue".' },
      { role: 'user' as const, content: 'continue' },
    ]
    expect(findOriginalBuildPrompt(history)).toBe(FOUNDER_OUTREACH_SPEC)
  })

  it('skips every bare-confirmation phrasing', () => {
    for (const phrase of ['go ahead', 'continue', 'yes', 'yep', 'ok', 'okay', 'do it', 'finish it', 'resume', 'proceed', 'sure', 'keep going']) {
      expect(CONFIRM_OR_RESUME_RE.test(phrase)).toBe(true)
    }
  })

  it('does NOT treat a real build request as a confirmation', () => {
    expect(CONFIRM_OR_RESUME_RE.test('build me a marketplace with products and orders')).toBe(false)
    expect(CONFIRM_OR_RESUME_RE.test('yes, and also add a reviews table with ratings')).toBe(false)
  })

  it('returns null when there is no substantial user message to resume', () => {
    const history = [
      { role: 'user' as const, content: 'continue' },
      { role: 'assistant' as const, content: 'Say "continue" and I will finish.' },
      { role: 'user' as const, content: 'go ahead' },
    ]
    expect(findOriginalBuildPrompt(history)).toBeNull()
  })

  it('ignores short throwaway user messages', () => {
    const history = [
      { role: 'user' as const, content: 'thanks!' },
      { role: 'user' as const, content: 'ok cool' },
      { role: 'user' as const, content: 'continue' },
    ]
    expect(findOriginalBuildPrompt(history)).toBeNull()
  })
})

describe('re-architect gate — build vs. modification', () => {
  it('FIRES on the first "go ahead" of an explicit-spec build (fresh project)', () => {
    expect(shouldReArchitect(FOUNDER_OUTREACH_SPEC, /* fresh */ true)).toBe(true)
  })

  it('STILL fires on "continue" after a partial build (explicit spec, no longer fresh)', () => {
    // This is the loop-breaker: even once the agent loop half-built the project,
    // an explicit spec re-architects and finishes it idempotently.
    expect(shouldReArchitect(FOUNDER_OUTREACH_SPEC, /* fresh */ false)).toBe(true)
  })

  it('NEVER re-architects a modification confirmation on a built project', () => {
    // "add reviews to my marketplace" is >200 chars of prose but NOT an explicit
    // schema spec, and the project is already built — must fall to the agent loop.
    const modify =
      'Can you add a reviews table so buyers can rate sellers after an order, ' +
      'with a rating from 1 to 5, a comment, and a link back to the order and the ' +
      'product, and expose it through the usual REST API with owner permissions please'
    expect(modify.length).toBeGreaterThan(200)
    expect(isExplicitSpec(modify)).toBe(false)
    expect(shouldReArchitect(modify, /* fresh */ false)).toBe(false)
  })

  it('does not re-architect a short confirmation with no real spec behind it', () => {
    expect(shouldReArchitect(null, true)).toBe(false)
    expect(shouldReArchitect('add an index on email', false)).toBe(false)
  })
})
