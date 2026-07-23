/**
 * Cross-turn referential resolution
 * =================================
 * Regression coverage for the bug where messages like "start implementing all
 * these updates" failed to bind to the prior assistant turn and produced the
 * "Nothing changed — I could not identify what to build" response.
 *
 * Verifies:
 *   - `isCrossTurnReferential` only flags genuine cross-turn references.
 *   - `classifyBuildSubBehavior` routes those phrases to CONTINUATION.
 *   - `extractContinuationContext` recovers the prior AI list from history.
 *   - The intent-tracker resolves the same phrases to a concrete plan.
 *   - The list-extractor produces stable item arrays from a recommendation
 *     response.
 */

import { describe, it, expect } from '@jest/globals'
import {
  classifyBuildSubBehavior,
  extractContinuationContext,
  isCrossTurnReferential,
} from '../../lib/ai/build-mode-router'
import { resolveIntent, isContextDependent } from '../../lib/ai/intent-tracker'
import { extractListItems } from '../../lib/ai/list-extractor'

// Sample assistant message similar to the production-readiness response that
// triggered the bug. Bulleted items are the actionable suggestions we expect
// to recover when the user says "start implementing all these updates".
const PRIOR_AI_LIST = `To make your project production-grade, here are the recommended updates:

1. **Critical Issues (Blocking Deployment)**
- Auth Flow Failing: signup returns HTTP 500 — debug user creation logic
- JWT issuance and verification need behavioral checks

2. **Security & Data Integrity**
- Password Storage: ensure users.password_hash uses bcrypt or argon2
- Soft Deletes: filter deleted_at on all read paths
- Input Validation: validate all incoming data

3. **API & Integration**
- Auth Middleware: enforce JWT on all protected endpoints
- Rate Limiting: throttle signup, login, comments
- Error Handling: standardize { error: { code, message } }`

describe('isCrossTurnReferential', () => {
  it.each([
    'start implementing all these updates',
    'implementing all these updates',
    'apply all of those fixes',
    'do all those recommendations',
    'implement these',
    'do everything you suggested',
    'apply everything you recommended',
    'tackle all of the improvements',
    "let's implement all those changes",
  ])('matches referential phrase: %s', (msg) => {
    expect(isCrossTurnReferential(msg)).toBe(true)
  })

  it.each([
    'add a users table',
    'add all the users',
    'create the comments column',
    'enable JWT authentication',
    'build a marketplace platform',
    'add stripe checkout to orders',
    'hi',
    'thanks',
  ])('does not match concrete/neutral phrase: %s', (msg) => {
    expect(isCrossTurnReferential(msg)).toBe(false)
  })
})

describe('classifyBuildSubBehavior — cross-turn referential routing', () => {
  it('routes "start implementing all these updates" to CONTINUATION', async () => {
    const result = await classifyBuildSubBehavior('start implementing all these updates', '')
    expect(result.subBehavior).toBe('CONTINUATION')
  })

  it('routes "do everything you suggested" to CONTINUATION', async () => {
    const result = await classifyBuildSubBehavior('do everything you suggested', '')
    expect(result.subBehavior).toBe('CONTINUATION')
  })

  it('still routes concrete build to EXECUTION (no regression)', async () => {
    const result = await classifyBuildSubBehavior('add a users table with email and password', '')
    expect(result.subBehavior).not.toBe('CONTINUATION')
  })
})

describe('extractContinuationContext — referential follow-up', () => {
  it('recovers prior AI list when user says "start implementing all these updates"', async () => {
    const history = [
      { role: 'user', content: 'for making this project production grade did any updates needed??' },
      { role: 'assistant', content: PRIOR_AI_LIST },
    ]
    const ctx = await extractContinuationContext(
      'test-project',
      history,
      'start implementing all these updates',
    )
    expect(ctx).not.toBeNull()
    // Should contain at least one of the recovered list items so the build
    // runtime sees concrete work instead of the bare reference phrase.
    expect(ctx).toMatch(/Auth Flow Failing|Password Storage|Rate Limiting/)
  })

  it('recovers prior AI list when user says "implement those fixes"', async () => {
    const history = [
      { role: 'assistant', content: PRIOR_AI_LIST },
    ]
    const ctx = await extractContinuationContext('test-project', history, 'implement those fixes')
    expect(ctx).not.toBeNull()
  })
})

describe('resolveIntent — referential_list resolution', () => {
  it('returns referential_list for "start implementing all these updates"', () => {
    const result = resolveIntent({
      message: 'start implementing all these updates',
      sessionState: null,
      conversationHistory: [
        { role: 'assistant', content: PRIOR_AI_LIST },
      ],
    })
    expect(result.wasResolved).toBe(true)
    expect(result.resolutionType).toBe('referential_list')
    expect(result.resolvedGoal).toContain('Auth Flow Failing')
  })

  it('still resolves "fix that" as retry_last_failed (no regression)', () => {
    const result = resolveIntent({
      message: 'fix that',
      sessionState: null,
      conversationHistory: [],
      lastFailedComponents: ['users_table'],
    })
    expect(result.resolutionType).toBe('retry_last_failed')
  })

  it('passes through unresolved when no history and no prior list', () => {
    const result = resolveIntent({
      message: 'create a posts table',
      sessionState: null,
      conversationHistory: [],
    })
    expect(result.wasResolved).toBe(false)
  })
})

describe('isContextDependent — referential phrases flagged for resolution', () => {
  it('flags "start implementing all these updates" as context-dependent', () => {
    expect(isContextDependent('start implementing all these updates')).toBe(true)
  })

  it('does not flag concrete builds', () => {
    expect(isContextDependent('create a posts table with title and body')).toBe(false)
  })
})

describe('extractListItems — sticky-store hydration', () => {
  it('extracts ≥3 substantive bullet items from a recommendation response', () => {
    const items = extractListItems(PRIOR_AI_LIST)
    expect(items.length).toBeGreaterThanOrEqual(3)
    // Item text should not retain markdown emphasis.
    expect(items.every(i => !i.includes('**'))).toBe(true)
  })

  it('returns [] for a short prose answer (no list)', () => {
    const items = extractListItems('Auth is enabled with JWT. You have 3 tables.')
    expect(items).toEqual([])
  })
})
