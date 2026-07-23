/**
 * Reproduce the exact production failure: classifier called with the SAME
 * conversation history shape the screenshot user had — a prior assistant
 * turn that ends with "Say 'build the full backend' to add auth and APIs".
 *
 *   npx tsx scripts/brain-smoke-context.ts
 */
import 'dotenv/config'
import { classify } from '../lib/ai/brain/classifier'

const PRIOR_ASSISTANT_TURN =
  'Build Complete. Built: tasks table, tasks REST endpoints. Verified: API verification. Next: Table created and verified. Say "build the full backend" to add auth and APIs, or say "deploy" to expose this endpoint.'

const CASES: Array<{ name: string; message: string; history: Array<{ role: 'user'|'assistant'; content: string }>; expect: string }> = [
  {
    name: 'screenshot-bug-with-build-history',
    message: 'give me competitors or alternatives to backenly',
    history: [
      { role: 'user', content: 'build a tasks table' },
      { role: 'assistant', content: PRIOR_ASSISTANT_TURN },
    ],
    expect: 'CHAT',
  },
  {
    name: 'screenshot-bug-no-history',
    message: 'give me competitors or alternatives to backenly',
    history: [],
    expect: 'CHAT',
  },
  {
    name: 'real-build-after-build',
    message: 'now add a users table',
    history: [
      { role: 'user', content: 'build a tasks table' },
      { role: 'assistant', content: PRIOR_ASSISTANT_TURN },
    ],
    expect: 'BUILD',
  },
  {
    name: 'concept-after-build',
    message: 'what does RLS actually mean?',
    history: [
      { role: 'user', content: 'build a tasks table' },
      { role: 'assistant', content: PRIOR_ASSISTANT_TURN },
    ],
    expect: 'CHAT',
  },
  {
    name: 'comparison-after-build',
    message: 'how does this compare to supabase?',
    history: [
      { role: 'user', content: 'build a tasks table' },
      { role: 'assistant', content: PRIOR_ASSISTANT_TURN },
    ],
    expect: 'CHAT',
  },
  // ── Regression: the "No active proposal to apply" production bug ──────────
  {
    name: 'concrete-features-after-suggestion',
    message: 'yes add more APIs, OAuth, advanced triggers',
    history: [
      { role: 'user', content: 'is our social platform missing anything?' },
      { role: 'assistant', content: 'If you need more APIs, OAuth, advanced triggers, or want to review missing features (search, analytics, moderation), let me know!' },
    ],
    // Names concrete buildable things → must be BUILD/MODIFY, not APPLY_PROPOSAL.
    expect: 'BUILD',
  },
  {
    name: 'contentless-reference-implement-these',
    message: 'implement these 3 features',
    history: [
      { role: 'user', content: 'review missing features' },
      { role: 'assistant', content: 'Missing: 1) Search (full-text on posts/users/hashtags) 2) Analytics (engagement metrics) 3) Moderation (reports, bans, review queue). Want a plan?' },
    ],
    // Contentless reference → APPLY_PROPOSAL (now routes to the agent loop and
    // builds the 3 features from context — no longer a "no proposal" dead-end).
    expect: 'APPLY_PROPOSAL',
  },
]

async function main() {
  let pass = 0, fail = 0
  for (const c of CASES) {
    const r = await classify({ message: c.message, recentHistory: c.history })
    const ok = r.intent === c.expect
    if (ok) pass++; else fail++
    console.log(`[${ok ? 'PASS' : 'FAIL'}] ${c.name.padEnd(40)} expected=${c.expect.padEnd(12)} got=${r.intent.padEnd(12)} conf=${r.confidence.toFixed(2)}  ${ok ? '' : '← ' + r.reasoning}`)
  }
  console.log(`\n${pass}/${pass + fail} passed.`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch(e => { console.error(e); process.exit(2) })
