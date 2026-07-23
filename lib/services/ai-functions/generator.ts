/**
 * AI FUNCTION GENERATOR
 * =====================
 * Converts natural language descriptions into safe, executable JavaScript.
 *
 * The user describes intent: "When a user signs up, assign a tier based on country"
 * This service generates the function body using the project's live schema + integrations.
 *
 * Generated code runs in a sandboxed vm context with access only to:
 *   ctx.db  — workspace database CRUD
 *   ctx.http — safe outbound HTTP
 *   ctx.log  — captured logging
 *   ctx.event — trigger event data
 *   ctx.require('package') — whitelisted npm packages
 */

import { getOpenAIClient } from '@/lib/ai/openai-service'
import { introspectSchema } from '@/lib/ai/minimal-executor'
import { prisma } from '@/lib/db'
import { getConnectedProviderIds } from './integration-context'
import { renderIntegrationDocs } from './integration-registry'

export interface GeneratedFunction {
  name: string
  code: string
}

const TRIGGER_DESCRIPTIONS: Record<string, string> = {
  on_signup: 'fires after a new end-user signs up (event.data = { id, email, name })',
  on_db_insert: 'fires after a row is inserted into the trigger table (event.data = the inserted row)',
  on_db_update: 'fires after a row is updated (event.data = new row, event.old = previous row)',
  on_db_delete: 'fires after a row is deleted (event.data = the deleted row)',
  manual: 'runs only when manually triggered from the dashboard (event.data = {})',
  cron: 'runs on a recurring schedule (event.data = { scheduledAt: ISO string, timestamp: ms })',
}

// ─── Web Research: Fetch current integration docs ───────────────────────────

// Known stable documentation URLs for each integration
const INTEGRATION_DOC_URLS: Record<string, string> = {
  stripe: 'https://stripe.com/docs/api/payment_intents/create',
  resend: 'https://resend.com/docs/api-reference/emails/send-email',
  sendgrid: 'https://docs.sendgrid.com/api-reference/mail-send/mail-send',
  openai: 'https://platform.openai.com/docs/api-reference/chat/create',
  twilio: 'https://www.twilio.com/docs/sms/api/message-resource',
  posthog: 'https://posthog.com/docs/api/capture-overview',
  mailchimp: 'https://mailchimp.com/developer/marketing/api/lists/',
  shopify: 'https://shopify.dev/docs/api/admin-rest/2024-01/resources/order',
}

// Detect which known integrations are mentioned in the description
function detectMentionedIntegrations(description: string): string[] {
  const lower = description.toLowerCase()
  return Object.keys(INTEGRATION_DOC_URLS).filter(name => lower.includes(name))
}

/**
 * Fetch current documentation for each integration mentioned in the description.
 * Returns a summary string to inject into the generation prompt.
 * Falls back gracefully if fetch fails — never throws.
 */
async function fetchIntegrationDocs(integrations: string[]): Promise<string> {
  if (integrations.length === 0) return ''

  const results = await Promise.allSettled(
    integrations.map(async (name) => {
      const url = INTEGRATION_DOC_URLS[name]
      if (!url) return null

      const res = await fetch(url, {
        headers: { 'Accept': 'text/html,application/xhtml+xml', 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(5000),
      })
      if (!res.ok) return null

      const html = await res.text()
      // Strip HTML tags and condense whitespace for a readable plaintext summary
      const text = html
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 3000)

      return `=== CURRENT ${name.toUpperCase()} API DOCS (fetched live) ===\n${text}`
    })
  )

  const docs = results
    .filter((r): r is PromiseFulfilledResult<string> => r.status === 'fulfilled' && r.value !== null)
    .map(r => r.value)

  if (docs.length === 0) return ''
  return `\nLIVE INTEGRATION DOCUMENTATION (use these current API shapes — ignore outdated training data):\n${docs.join('\n\n')}\n`
}

// ─── Package whitelist description for the prompt ───────────────────────────

const SAFE_PACKAGES_DESCRIPTION = `
ctx.require(packageName) — access whitelisted npm packages:
  const PDFDocument = ctx.require('pdfkit')   — generate PDF files
  const { parse } = ctx.require('csv-parse/sync') — parse CSV strings synchronously
  const dateFns = ctx.require('date-fns')     — date formatting and arithmetic
  const QRCode = ctx.require('qrcode')        — generate QR codes as data URLs
  const nodemailer = ctx.require('nodemailer') — send email via SMTP directly
  const archiver = ctx.require('archiver')    — create ZIP archives

  ONLY use ctx.require() for these exact package names. Any other name throws.
  ctx.require() returns the module synchronously — no await needed.`

// ─── Main generation function ────────────────────────────────────────────────

/**
 * Generate a safe JS function body from a natural language description.
 * Returns the code that goes INSIDE `async function handler(event, ctx) { ... }`
 */
export async function generateFunctionCode(
  description: string,
  triggerType: string,
  triggerTable: string | null,
  projectId: string
): Promise<GeneratedFunction> {
  const openai = getOpenAIClient()

  // Run schema introspection, integration lookup, and web research in parallel
  const [liveSchema, connectedProviderIds, liveDocs] = await Promise.all([
    introspectSchema(projectId),
    getConnectedProviderIds(projectId).catch(() => [] as string[]),
    fetchIntegrationDocs(detectMentionedIntegrations(description)),
  ])

  // Build integration context — registry-driven, so EVERY connected provider
  // (incl. Replicate/Runway/Stability/OneSignal) is documented with its real
  // ctx.integrations surface. No provider is ever "phantom".
  const registryDocs = renderIntegrationDocs(connectedProviderIds)
  const integrationContext = registryDocs
    ? `\n${registryDocs}`
    : `
No integrations connected yet. Use ctx.http.post/get for external API calls with manual headers,
and read secrets the user saved via ctx.env.<KEY> (never hard-code keys).
Users can connect Stripe, Resend, OpenAI, Replicate, Runway, Stability, OneSignal, Twilio etc. from the Integrations page.`

  const triggerContext = triggerType === 'on_db_insert' || triggerType === 'on_db_update' || triggerType === 'on_db_delete'
    ? `Trigger: ${triggerType} on table "${triggerTable}" — ${TRIGGER_DESCRIPTIONS[triggerType]}`
    : `Trigger: ${triggerType} — ${TRIGGER_DESCRIPTIONS[triggerType] || 'custom trigger'}`

  const systemPrompt = `You are a backend function generator for Backenly, an autonomous backend platform.

Generate a JavaScript async function BODY (not the function declaration — just the code that goes inside it).

The function receives two arguments:
  event — object with: { data: Record<string, any>, old?: Record<string, any>, type: string, table?: string }
  ctx   — execution context with these APIs:

ctx.db.query(table, where?)         → Promise<rows[]>       — query rows with optional WHERE filter
ctx.db.insert(table, data)          → Promise<row>          — insert a single row, returns inserted row
ctx.db.update(table, where, data)   → Promise<rows[]>       — update rows matching where
ctx.db.delete(table, where)         → Promise<void>         — delete rows matching where
ctx.http.get(url, headers?)         → Promise<any>          — GET request, returns parsed JSON
ctx.http.post(url, body, headers?)  → Promise<any>          — POST request, returns parsed JSON
ctx.log(...args)                    → void                  — captured log (shown in dashboard)
${SAFE_PACKAGES_DESCRIPTION}

CRITICAL RULES — VIOLATION CAUSES RUNTIME CRASH:
- NEVER write "import X from 'pkg'" — this crashes the sandbox with "Cannot use import statement outside a module"
- NEVER write "require('pkg')" — this is blocked and will fail
- NEVER write "import('pkg')" — dynamic imports are blocked
- For packages: use ctx.require('pdfkit'), ctx.require('date-fns'), etc. ONLY for the exact whitelisted names above
- For Stripe: ALWAYS use ctx.integrations.stripe.* (NEVER import or require stripe)
- For HTTP calls: use ctx.http.get() / ctx.http.post() (NEVER import axios, node-fetch, or fetch)
- ONLY use ctx.db, ctx.http, ctx.log, ctx.require, ctx.integrations — nothing else
- NO process, NO fs, NO eval, NO global, NO globalThis
- All ctx.db calls use the workspace schema automatically
- Function must be async-safe (await all async calls)
- Keep it concise (under 50 lines)
- Add ctx.log() calls to show what the function did
- Handle errors gracefully with try/catch where needed

${liveSchema}
${integrationContext}
${liveDocs}`

  const userPrompt = `${triggerContext}

User's description: "${description}"

Generate ONLY the function body code (no function declaration, no exports). Start directly with the code.`

  const response = await openai.chat.completions.create({
    model: 'gpt-4.1',
    max_tokens: 700,
    temperature: 0.2,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
  })

  const rawCode = response.choices[0]?.message?.content?.trim() || ''

  // Strip markdown code fences if present
  const code = rawCode
    .replace(/^```(?:javascript|js|typescript|ts)?\n?/i, '')
    .replace(/\n?```$/i, '')
    .trim()

  // Generate a short human-readable name from the description
  const nameResponse = await openai.chat.completions.create({
    model: 'gpt-4.1',
    max_tokens: 20,
    temperature: 0,
    messages: [
      {
        role: 'user',
        content: `Generate a short snake_case function name (3-5 words, no spaces) for: "${description}". Reply with ONLY the name, nothing else.`,
      },
    ],
  })

  const rawName = nameResponse.choices[0]?.message?.content?.trim() || 'custom_function'
  const name = rawName
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/__+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 50)

  return { name, code }
}

// ─── Auto-Fix: Regenerate broken function code with error context ─────────────

/**
 * Regenerate a function's code given the runtime error it produced.
 * Used by the auto-fix system when a function fails at execution time.
 */
export async function generateFixedFunctionCode(
  originalCode: string,
  errorMessage: string,
  description: string,
  triggerType: string,
  triggerTable: string | null,
  projectId: string
): Promise<string> {
  const openai = getOpenAIClient()

  const [liveSchema, connectedProviderIds] = await Promise.all([
    introspectSchema(projectId),
    getConnectedProviderIds(projectId).catch(() => [] as string[]),
  ])

  const registryDocs = renderIntegrationDocs(connectedProviderIds)
  const integrationLine = registryDocs || 'No integrations connected.'

  const triggerContext = triggerType === 'on_db_insert' || triggerType === 'on_db_update' || triggerType === 'on_db_delete'
    ? `Trigger: ${triggerType} on table "${triggerTable}"`
    : `Trigger: ${triggerType}`

  const systemPrompt = `You are a backend function debugger for Backenly. Fix the broken JavaScript function body below.

AVAILABLE APIs (same as before):
ctx.db.query(table, where?) / ctx.db.insert(table, data) / ctx.db.update(table, where, data) / ctx.db.delete(table, where)
ctx.http.get(url, headers?) / ctx.http.post(url, body, headers?)
ctx.log(...args)
ctx.integrations.* — see the connected-integration surface below (only those methods exist)
ctx.require('pdfkit' | 'csv-parse/sync' | 'date-fns' | 'qrcode' | 'nodemailer' | 'archiver')

CRITICAL: NEVER write import or require() statements — they crash the sandbox.
For packages: use ctx.require('pdfkit'|'csv-parse/sync'|'date-fns'|'qrcode'|'nodemailer'|'archiver') ONLY.
For Stripe: use ctx.integrations.stripe.* — NEVER import stripe.
For HTTP: use ctx.http.get() / ctx.http.post() — NEVER import axios or fetch.

${liveSchema}
${integrationLine}
${triggerContext}`

  const userPrompt = `The function failed with this error:
ERROR: ${errorMessage}

Original function purpose: "${description}"

BROKEN CODE:
\`\`\`
${originalCode}
\`\`\`

Fix the code to resolve the error. Return ONLY the fixed function body (no function declaration, no markdown). Start directly with the code.`

  const response = await openai.chat.completions.create({
    model: 'gpt-4.1',
    max_tokens: 700,
    temperature: 0.1,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
  })

  const rawCode = response.choices[0]?.message?.content?.trim() || originalCode
  return rawCode
    .replace(/^```(?:javascript|js|typescript|ts)?\n?/i, '')
    .replace(/\n?```$/i, '')
    .trim()
}
