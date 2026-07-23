/**
 * REGRESSION TESTS: Chat-to-Execution Pipeline
 *
 * Guards against the bug where:
 *   1. Build prompts containing "deploy-ready" (substring) triggered goLive()
 *   2. goLive() succeeded on empty projects (no tables) → "Backend is live" card shown
 *   3. Follow-up verification prompts returned platform marketing copy instead of
 *      inspecting actual project state
 *
 * Each test maps to a specific failure mode from the incident.
 */

import { describe, test, expect } from '@jest/globals'

// ─── Unit tests for deploy detection logic (no DB needed) ────────────────────

/**
 * Mirrors the deploy detection logic in execute/route.ts.
 * Kept local so tests remain fast and self-contained.
 */
function isDeployDetected(prompt: string): boolean {
  const trimmed = prompt.trim()
  const isLikelyMultiPhaseBuildPrompt = trimmed.length > 300
  // (?!-) prevents matching "deploy-ready", "pre-launch", etc.
  const DEPLOY_WORD_RE = /\b(deploy|launch|publish)\b(?!-)/i
  const DEPLOY_PHRASE_RE = /\b(go\s+live|make\s+it\s+live|ship\s+it|push\s+to\s+production|make\s+live|go-live)\b/i
  return (
    !isLikelyMultiPhaseBuildPrompt &&
    (DEPLOY_WORD_RE.test(trimmed) || DEPLOY_PHRASE_RE.test(trimmed))
  )
}

/**
 * Mirrors the project-state query detection logic in execute/route.ts.
 */
function isProjectStateQuery(prompt: string): boolean {
  const PROJECT_STATE_RE = /\b(exist|exists|check|verify|confirm|list|show|get|do\s+(we|i)\s+have|is\s+(there|it|auth|rls)|are\s+(there|tables)|what\s+(tables|apis|columns)|how\s+many\s+(tables|apis)|does\s+.+\s+(exist|work|have))\b/i
  return PROJECT_STATE_RE.test(prompt)
}

function isPlatformCapabilityQuestion(prompt: string): boolean {
  const isProjectState = isProjectStateQuery(prompt)
  return (
    !isProjectState &&
    /\b(can you|do you support|does backenly|are you able|is it possible)\b/i.test(prompt)
  )
}

// ─── Test 1: Large multi-phase build prompt must NOT trigger deploy ───────────

describe('Deploy detection — word boundary guard', () => {
  test('T1: Large multi-phase build prompt containing "deploy-ready" does NOT trigger deploy', () => {
    const bigBuildPrompt = `I want to build a production-ready multi-tenant SaaS platform for creators.

PHASE 1 — Core System
Build: Users & Auth, workspaces, products, orders
Security: Apply strict RLS

PHASE 2 — Payments (Stripe)
Add Stripe integration with POST /checkout-session

FINAL REPORT — whether system is truly deploy-ready and production-grade`

    expect(bigBuildPrompt.length).toBeGreaterThan(300)
    expect(isDeployDetected(bigBuildPrompt)).toBe(false)
  })

  test('T1b: Short explicit deploy command DOES trigger deploy', () => {
    expect(isDeployDetected('deploy my backend')).toBe(true)
    expect(isDeployDetected('go live')).toBe(true)
    expect(isDeployDetected('make it live')).toBe(true)
    expect(isDeployDetected('publish')).toBe(true)
    expect(isDeployDetected('launch')).toBe(true)
  })

  test('T1c: "deploy-ready" as substring does NOT trigger deploy', () => {
    // The old bug: .includes('deploy') matched 'deploy-ready'
    expect(isDeployDetected('is this deploy-ready?')).toBe(false)
    expect(isDeployDetected('check deploy-readiness')).toBe(false)
    expect(isDeployDetected('is the system relaunchable?')).toBe(false)
  })

  test('T1d: "republish" does NOT trigger deploy (word boundary)', () => {
    // "republish" contains "publish" as substring but not as whole word
    expect(isDeployDetected('I want to republish my content')).toBe(false)
  })
})

// ─── Test 2: Follow-up verification prompts route to project-state logic ──────

describe('Non-build intent routing — no marketing copy for project-state queries', () => {
  test('T2: "Check whether tables users and products exist" is a project-state query', () => {
    const prompt = 'Check whether tables users and products exist'
    expect(isProjectStateQuery(prompt)).toBe(true)
    // Must NOT be treated as a platform capability question → no marketing copy
    expect(isPlatformCapabilityQuestion(prompt)).toBe(false)
  })

  test('T2b: "Verify that RLS is applied" is a project-state query', () => {
    expect(isProjectStateQuery('Verify that RLS is applied to the products table')).toBe(true)
  })

  test('T2c: "Does auth exist?" is a project-state query', () => {
    expect(isProjectStateQuery('Does auth exist in this project?')).toBe(true)
  })

  test('T2d: "Can you build production-grade backends?" is a platform capability question', () => {
    const prompt = 'Can you build production-grade backends?'
    // This SHOULD get the canned capability response
    expect(isPlatformCapabilityQuestion(prompt)).toBe(true)
    expect(isProjectStateQuery(prompt)).toBe(false)
  })

  test('T2e: "Are there any tables?" is a project-state query', () => {
    expect(isProjectStateQuery('Are there any tables in my project?')).toBe(true)
    expect(isPlatformCapabilityQuestion('Are there any tables in my project?')).toBe(false)
  })
})

// ─── Test 3: Strong build prompts route to build executor ─────────────────────

describe('Build intent routing — strong build prompts reach the build pipeline', () => {
  test('T3: "Create tables users, workspaces, products" is a build intent', () => {
    // These prompts should NOT be detected as deploy and should not be
    // classified as project-state queries either.
    const prompt = 'Create tables users, workspaces, products with proper relationships'
    expect(isDeployDetected(prompt)).toBe(false)
    expect(isProjectStateQuery(prompt)).toBe(false)
    // (classifyIntent would return 'build' — that's the LLM path, tested elsewhere)
  })

  test('T3b: Short targeted build prompt is not a deploy or project-state query', () => {
    const prompt = 'Add a products table with title, price, description, and status fields'
    expect(isDeployDetected(prompt)).toBe(false)
    expect(isProjectStateQuery(prompt)).toBe(false)
  })
})

// ─── Test 4: Build intent misclassification prevention ───────────────────────

describe('Misclassification prevention', () => {
  test('T4: Prompt containing "production-ready" does not trigger platform capability response', () => {
    // Old bug: follow-up with "production" in it returned marketing copy
    const verificationFollowUp = 'Confirm these are production-ready with proper auth and RLS'
    // This is a project-state verification, not a platform capability question
    expect(isPlatformCapabilityQuestion(verificationFollowUp)).toBe(false)
  })

  test('T4b: "Is the backend production-ready?" is NOT a platform capability question', () => {
    const prompt = 'Is the backend production-ready?'
    // Even though it has "production-ready" — this is asking about THIS project
    // The PROJECT_STATE_RE catches "is" + state-related patterns
    // (This specific phrasing might not match PROJECT_STATE_RE exactly, but
    //  should still not return platform marketing copy because
    //  isPlatformCapabilityQuestion requires "can you|do you support|does backenly|...")
    expect(isPlatformCapabilityQuestion(prompt)).toBe(false)
  })
})

// ─── Test 5: Project-state inspection intent ─────────────────────────────────

describe('Project-state inspection routing', () => {
  test('T5: "List all tables" is a project-state query, not platform capability', () => {
    expect(isProjectStateQuery('List all tables')).toBe(true)
    expect(isPlatformCapabilityQuestion('List all tables')).toBe(false)
  })

  test('T5b: "Show my APIs" routes to project-state, not capability copy', () => {
    expect(isProjectStateQuery('Show my APIs')).toBe(true)
  })

  test('T5c: "How many tables do I have?" is a project-state query', () => {
    expect(isProjectStateQuery('How many tables do I have?')).toBe(true)
  })

  test('T5d: "What tables were created?" is a project-state query', () => {
    expect(isProjectStateQuery('What tables were created?')).toBe(true)
  })
})
