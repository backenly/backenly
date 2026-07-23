// Brain wiring probe — confirms the new tools are registered and the
// classifier puts the new BUILD prompts on the agent loop (not CHAT/UNCLEAR).
// Cost: 5 classifier calls (~$0.002 on gpt-4o-mini). No DB writes.

import 'dotenv/config'
import OpenAI from 'openai'
import { classifierPrompt } from '../lib/ai/brain/prompts'
import { BRAIN_TOOLS, type ToolName } from '../lib/ai/brain/tools'
import { TOOL_CAPABILITIES } from '../lib/ai/brain/capabilities'

// Sanity check 1: every new tool is present in the OpenAI tool array.
const expected: ToolName[] = [
  'enable_vector_search',
  'create_cron_job',
  'set_rate_limit',
  'generate_aggregate_api',
  'enable_teams',
  'enable_push_notifications',
  'send_push',
  'rotate_webhook_secret',
  'list_webhook_deliveries',
  'replay_webhook_delivery',
]
const registered = new Set(BRAIN_TOOLS.map(t => t.function.name))
let allRegistered = true
for (const name of expected) {
  const ok = registered.has(name)
  console.log(`  tool registered: ${name.padEnd(28)} ${ok ? 'YES' : 'NO'}`)
  if (!ok) allRegistered = false
}

// Sanity check 2: every new tool appears in the capability manifest the
// system prompt renders to the agent.
const capabilityToolNames = new Set(TOOL_CAPABILITIES.map(c => c.tool))
let allInManifest = true
for (const name of expected) {
  const ok = capabilityToolNames.has(name)
  console.log(`  capability entry: ${name.padEnd(28)} ${ok ? 'YES' : 'NO'}`)
  if (!ok) allInManifest = false
}

if (!allRegistered || !allInManifest) {
  console.error('\n❌ Wiring incomplete. Aborting before classifier probe.')
  process.exit(1)
}

console.log('\n✅ All four new tools are wired in BRAIN_TOOLS + capability manifest.\n')

// Sanity check 3: prompts that should hit the new tools must classify as
// BUILD or MODIFY (the agent-loop path) — NOT CHAT, NOT UNCLEAR.
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

const cases = [
  {
    label: 'NEW #1 vector search ("build a chatbot")',
    prompt: 'i want to build a chatbot that answers questions from my knowledge base documents',
    expect: ['BUILD'],
  },
  {
    label: 'NEW #2 cron job',
    prompt: 'send a daily summary email to every user at 9am with their unread notifications',
    expect: ['BUILD'],
  },
  {
    label: 'NEW #3 rate limit (modify existing)',
    prompt: 'limit the products api to 60 requests per minute',
    expect: ['MODIFY', 'BUILD'],
  },
  {
    label: 'NEW #4 dashboard stats',
    prompt: 'give me a stats endpoint with totals i can show on the dashboard',
    expect: ['BUILD'],
  },
  {
    label: 'CONTROL: capability question must STILL be CHAT, not BUILD',
    prompt: 'can backenly do semantic search?',
    expect: ['CHAT'],
  },
  {
    label: 'NEW #5 team multi-tenancy',
    prompt: 'set up multi-tenancy so users belong to a workspace / company with invites and roles',
    expect: ['BUILD'],
  },
  {
    label: 'NEW #6 push notifications',
    prompt: 'i want to send push notifications to my mobile users',
    expect: ['BUILD'],
  },
  {
    label: 'NEW #7 webhook delivery diagnosis',
    prompt: 'why are my stripe webhook events being missed? show me the delivery log',
    expect: ['QUESTION', 'FIX'],
  },
  {
    label: 'NEW #8 secret rotation',
    prompt: 'rotate the signing secret on the new-order webhook',
    expect: ['MODIFY', 'BUILD'],
  },
  {
    label: 'NEW #9 org-scoped RLS (uses enable_teams + add_rls org_members)',
    prompt: 'scope the projects table so users only see rows from their own organization',
    expect: ['BUILD', 'MODIFY'],
  },
  {
    label: 'NEW #10 replay failed webhook',
    prompt: 'retry that failed delivery from stripe',
    expect: ['BUILD', 'MODIFY', 'FIX'],
  },
]

async function classify(message: string) {
  const completion = await openai.chat.completions.create({
    model: process.env.OPENAI_MODEL_FAST || 'gpt-4o-mini',
    messages: [
      { role: 'system', content: classifierPrompt() },
      { role: 'user', content: message },
    ],
    temperature: 0,
    max_tokens: 120,
    response_format: { type: 'json_object' },
  })
  const raw = completion.choices[0]?.message?.content ?? '{}'
  return { parsed: JSON.parse(raw), tokens: completion.usage?.total_tokens ?? 0 }
}

async function main() {
  let total = 0
  for (const c of cases) {
    const res = await classify(c.prompt)
    total += res.tokens
    const ok = c.expect.includes(res.parsed.intent)
    console.log('────────────────────────────────────────────────────────')
    console.log(c.label)
    console.log('  prompt :', JSON.stringify(c.prompt))
    console.log('  expect :', c.expect.join(' or '))
    console.log('  got    :', res.parsed.intent, `(conf=${res.parsed.confidence})`)
    console.log('  reason :', res.parsed.reasoning)
    console.log('  result :', ok ? '✅ PASS' : '❌ FAIL')
  }
  console.log('────────────────────────────────────────────────────────')
  console.log('Tokens:', total, '(≈', (total * 0.0000006).toFixed(5), 'USD)')
}
main().catch(e => { console.error(e); process.exit(1) })
