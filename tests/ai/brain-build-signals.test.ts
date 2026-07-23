/**
 * BRAIN BUILD-SIGNALS REGRESSION SUITE
 * ====================================
 * Locks in the fix for the screenshot bug where a clear, first-turn app
 * description on a brand-new project —
 *
 *   "Users can post recipes with photos and ingredients, follow each other,
 *    and save their favorites."
 *
 * — was classified UNCLEAR and dead-ended in a canned, string-truncating
 * clarification ("…could you tell me a bit more about 'Users can post recipes
 * … and save '?"). On a fresh project the brain now uses this heuristic as a
 * safety net: a message that reads like a product description is handed to the
 * architect (which has its own contextual vagueness gate) instead of a
 * clarification.
 *
 * Pure — no DB, no network.
 */

import { looksLikeBuildDescription } from '../../lib/ai/brain/build-signals'

describe('looksLikeBuildDescription — routes real app descriptions to the architect', () => {
  const descriptions = [
    'Users can post recipes with photos and ingredients, follow each other, and save their favorites.',
    'A marketplace where sellers list products and buyers checkout with Stripe',
    'an app for tracking gym workouts and personal records',
    "I'm building a dating app where users match and message each other",
    'Users sign up, create projects, invite teammates, and assign tasks',
    'A blog platform with posts, comments, tags, and author profiles',
  ]

  it.each(descriptions)('treats a product description as buildable: %s', (msg) => {
    expect(looksLikeBuildDescription(msg)).toBe(true)
  })
})

describe('looksLikeBuildDescription — leaves genuinely-empty messages for clarification', () => {
  const nonDescriptions = [
    'hi',
    'help',
    'yo',
    'make it better',
    'set it up',
    'what can you do?',
    'how does this work?',
    'is auth on?',
    'can you help me',
    '',
    '   ',
  ]

  it.each(nonDescriptions)('does NOT treat a contentless message as buildable: %s', (msg) => {
    expect(looksLikeBuildDescription(msg)).toBe(false)
  })
})

describe('looksLikeBuildDescription — a long, imperative-free description still counts', () => {
  it('accepts declarative phrasing without a "build"/"create" verb', () => {
    // The exact failure mode: no imperative verb, just "users can …".
    expect(
      looksLikeBuildDescription('Users can post recipes with photos and ingredients, follow each other, and save their favorites.'),
    ).toBe(true)
  })

  it('accepts a longer question-shaped description (past the short-question guard)', () => {
    // A long message that happens to start with a question word but actually
    // describes an app should still reach the architect.
    expect(
      looksLikeBuildDescription('Can users of my app post recipes, follow each other, comment on posts, and save favorites for later?'),
    ).toBe(true)
  })
})
