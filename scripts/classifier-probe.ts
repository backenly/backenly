// Cheap classifier probe — calls the brain's classifier prompt directly
// against OpenAI for 5 carefully-chosen prompts. No DB. No mutations.
// Cost: 5 × ~120 output tokens on gpt-4o-mini ≈ a fraction of a cent.

import 'dotenv/config'
import OpenAI from 'openai'
import { classifierPrompt } from '../lib/ai/brain/prompts.ts'

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

const cases = [
  {
    label: '1. CAPABILITY QUESTION (the canonical screenshot bug)',
    history: [],
    user: 'give me list of competitors of backenly',
    expect: 'CHAT',
    note: 'must NEVER trigger BUILD',
  },
  {
    label: '2. STATE-OF-PROJECT QUESTION',
    history: [],
    user: 'what tables do i have right now?',
    expect: 'QUESTION',
    note: 'should read backend state, not build',
  },
  {
    label: '3. "CHECK X" — your specific worry',
    history: [
      { role: 'assistant', content: 'I created a posts table and generated REST APIs.' },
    ],
    user: 'now check if storage is set up properly',
    expect: 'QUESTION or FIX',
    note: 'must NOT silently build a bucket',
  },
  {
    label: '4. FOLLOW-UP REFERENTIAL ("do those")',
    history: [
      { role: 'user', content: 'i want a blog backend' },
      { role: 'assistant', content: 'I suggest: posts table, comments table, likes table, and OAuth sign-in. Want me to implement these?' },
    ],
    user: 'yes implement all 4',
    expect: 'APPLY_PROPOSAL or BUILD',
    note: 'must resume and actually build the referenced items',
  },
  {
    label: '5. CLEAR BUILD (sanity check that BUILD still works)',
    history: [],
    user: 'create a posts table with title and body columns',
    expect: 'BUILD',
    note: 'control case',
  },
]

async function classify(prompt, history) {
  const messages = [{ role: 'system', content: classifierPrompt() }]
  for (const turn of history) messages.push(turn)
  messages.push({ role: 'user', content: prompt })

  const completion = await openai.chat.completions.create({
    model: process.env.OPENAI_MODEL_FAST || 'gpt-4o-mini',
    messages,
    temperature: 0,
    max_tokens: 120,
    response_format: { type: 'json_object' },
  })
  const raw = completion.choices[0]?.message?.content ?? '{}'
  try {
    return { ok: true, parsed: JSON.parse(raw), tokens: completion.usage?.total_tokens ?? 0 }
  } catch {
    return { ok: false, raw, tokens: completion.usage?.total_tokens ?? 0 }
  }
}

async function main() {
  let totalTokens = 0
  for (const c of cases) {
    const res = await classify(c.user, c.history)
    totalTokens += res.tokens
    console.log('────────────────────────────────────────────────────────')
    console.log(c.label)
    console.log('  prompt :', JSON.stringify(c.user))
    console.log('  expect :', c.expect, '—', c.note)
    if (res.ok) {
      const ok = c.expect.includes(res.parsed.intent)
      console.log('  GOT    :', res.parsed.intent, `conf=${res.parsed.confidence}`)
      console.log('  reason :', res.parsed.reasoning)
      console.log('  RESULT :', ok ? '✅ PASS' : '❌ FAIL')
    } else {
      console.log('  RESULT : ❌ UNPARSEABLE — ' + res.raw)
    }
  }
  console.log('────────────────────────────────────────────────────────')
  console.log('Total tokens used:', totalTokens, '(≈', (totalTokens * 0.0000006).toFixed(5), 'USD on gpt-4o-mini)')
}

main().catch(e => { console.error(e); process.exit(1) })
