/**
 * Brain Smoke Test — runs the LLM classifier directly against the prompts
 * from the screenshot bug + a few other intent cases. No auth, no DB writes.
 * Prints the classification result for each case.
 *
 *   npx tsx scripts/brain-smoke.ts
 */
import 'dotenv/config'
import { classify } from '../lib/ai/brain/classifier'

const CASES: Array<{ name: string; message: string; expect: string }> = [
  {
    name: 'screenshot-bug-1',
    message: 'give compatetors or alternatives to backenly like the agentic AI for backend engineering tasks',
    expect: 'CHAT',
  },
  {
    name: 'screenshot-bug-2',
    message: 'no im asking give compatetors or alternatives to backenly like the agentic AI for backend engineering tasks',
    expect: 'CHAT',
  },
  {
    name: 'capability-question',
    message: 'is backenly an agentic ai?',
    expect: 'CHAT',
  },
  {
    name: 'concept-question',
    message: 'explain how RLS works',
    expect: 'CHAT',
  },
  {
    name: 'project-question',
    message: 'what tables do i have?',
    expect: 'QUESTION',
  },
  {
    name: 'simple-build',
    message: 'add a posts table with title and body',
    expect: 'BUILD',
  },
  {
    name: 'multi-build',
    message: 'build a blog with posts, comments, users, and likes',
    expect: 'BUILD',
  },
  {
    name: 'modify',
    message: 'add a published boolean to posts',
    expect: 'MODIFY',
  },
  {
    name: 'destructive',
    message: 'drop the posts table',
    expect: 'DESTRUCTIVE',
  },
  {
    name: 'fix',
    message: 'the users API is broken',
    expect: 'FIX',
  },
  {
    name: 'ambiguous',
    message: 'set this up better',
    expect: 'UNCLEAR',
  },
  {
    name: 'confirm',
    message: 'yes go ahead',
    expect: 'CONFIRM',
  },
]

async function main() {
  let pass = 0
  let fail = 0
  for (const c of CASES) {
    const r = await classify({
      message: c.message,
      recentHistory: [],
      hasPendingPlan: c.name === 'confirm',
    })
    const ok = r.intent === c.expect
    if (ok) pass++; else fail++
    const status = ok ? 'PASS' : 'FAIL'
    console.log(`[${status}] ${c.name.padEnd(20)} expected=${c.expect.padEnd(12)} got=${r.intent.padEnd(12)} conf=${r.confidence.toFixed(2)}  ${ok ? '' : '←  ' + r.reasoning}`)
  }
  console.log(`\n${pass}/${pass + fail} cases passed.`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch(err => {
  console.error('Smoke run threw:', err)
  process.exit(2)
})
