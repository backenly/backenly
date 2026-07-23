/**
 * Internal test: prove isSeriousBuildRequest correctly rejects question-phrased
 * messages even when they contain domain keywords like "social media".
 *
 * Run: npx tsx scripts/test-question-guard.ts
 */
import { isSeriousBuildRequest } from '../lib/ai/build-runtime/domain-compiler'

type Case = {
  message: string
  expected: boolean
  why: string
}

const CASES: Case[] = [
  // ─── These MUST be rejected (returns false) ─────────────────────────────
  {
    message: 'does any other integration features needed for making the social media backend production grade??',
    expected: false,
    why: 'User\'s exact failing prompt at 23:14 — question about needs, not a build',
  },
  {
    message: 'is this production ready?',
    expected: false,
    why: 'Evaluation question',
  },
  {
    message: 'do I need stripe for my social media backend?',
    expected: false,
    why: 'Question about need, not build request — mentions stripe + social media',
  },
  {
    message: 'what else is needed for production?',
    expected: false,
    why: 'Needs-assessment question',
  },
  {
    message: 'any other features needed?',
    expected: false,
    why: 'Open-ended question',
  },
  {
    message: 'is auth required for ecommerce?',
    expected: false,
    why: 'Question — mentions ecommerce keyword',
  },

  // ─── These MUST still trigger build (returns true) ───────────────────────
  {
    message: 'Build a complete ecommerce backend with products, orders, and customers',
    expected: true,
    why: 'Direct build command with ecommerce + multi-entity',
  },
  {
    message: 'Create a social media platform with users, posts, and comments',
    expected: true,
    why: 'Direct build with social media keyword',
  },
  {
    message: 'Add wishlist and cart support to my store',
    expected: true,
    why: 'Additive entity request',
  },
  {
    message: 'Spin up a production-grade SaaS backend for our app',
    expected: true,
    why: 'Build + production-grade + saas',
  },
]

let pass = 0
let fail = 0
console.log('Testing isSeriousBuildRequest guard...\n')
for (const c of CASES) {
  const got = isSeriousBuildRequest(c.message)
  const ok = got === c.expected
  if (ok) pass++; else fail++
  const tag = ok ? '✓ PASS' : '✗ FAIL'
  console.log(`${tag}  expected=${c.expected}  got=${got}`)
  console.log(`       "${c.message.slice(0, 80)}${c.message.length > 80 ? '…' : ''}"`)
  console.log(`       why: ${c.why}\n`)
}
console.log(`Result: ${pass} pass / ${fail} fail`)
process.exit(fail === 0 ? 0 : 1)
