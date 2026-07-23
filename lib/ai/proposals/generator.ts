/**
 * PROPOSAL GENERATOR
 * ==================
 * Converts a free-text recommendation list (from the answer-engine or any
 * other "here's what I'd do" assistant response) into a structured Proposal
 * with per-item actionability tags.
 *
 * This is the keystone of the agentic flow: instead of saving a `string[]`
 * and re-parsing it next turn, we ask one LLM call to tag each item with the
 * concrete Backenly action it maps to. The applier then dispatches each
 * executable item through `executeAction` — no regex, no second-guessing.
 *
 * The LLM is constrained to a strict JSON schema so callers can rely on the
 * shape. On any parse failure we fall back to a safe "informational" tag so
 * the agent never silently drops items.
 */

import { getOpenAIClient, trackCompletionCost } from '../openai-service'
import { getModel } from '../model-router'
import {
  Proposal,
  ProposalActionKind,
  ProposalBlocker,
  ProposalItem,
} from './types'
import { defaultExpiry, newItemId, newProposalId } from './store'

export interface GenerateProposalInput {
  projectId: string
  /** The user message that prompted the recommendation list. */
  userMessage: string
  /** The assistant's free-text response (the list itself). */
  assistantAnswer: string
  /** Compact view of current project state so the LLM tags items correctly. */
  projectState?: {
    tables?: string[]
    apis?: string[]
    authEnabled?: boolean
    buckets?: string[]
    integrations?: string[]
  }
}

const VALID_KINDS = new Set<ProposalActionKind>([
  'create_table', 'alter_table', 'add_column', 'add_index', 'add_constraint', 'rename_column',
  'generate_api',
  'enable_auth', 'add_provider',
  'create_bucket', 'delete_bucket',
  'add_rls', 'set_permission',
  'create_trigger', 'enable_realtime',
  'fix_auth', 'fix_api', 'fix_table', 'fix_integration', 'fix_workflow',
  'generate_function', 'create_cron_job',
  'enable_integration',
  'informational', 'manual', 'infra',
])

const VALID_BLOCKERS = new Set<ProposalBlocker>([
  'needs_credential', 'needs_user_input', 'infra_only', 'already_handled', 'unsupported',
])

const SYSTEM_PROMPT = `You convert a Backend-as-a-Service assistant's free-text recommendation list into a structured proposal.

You will receive:
  - The user's original question
  - The assistant's response (a numbered/bulleted list of recommendations)
  - A compact snapshot of the current project state

Your job: for EACH recommendation in the list, emit one JSON item with:
  - title: short imperative phrase (≤80 chars), no markdown
  - description: one-sentence expansion (optional, ≤200 chars)
  - actionKind: one of the action kinds below
  - executable: true if Backenly can run this NOW without further input
  - blocker: if executable=false, one of (needs_credential, needs_user_input, infra_only, already_handled, unsupported)
  - blockerReason: short user-facing reason when executable=false
  - params: action-shaped JSON (when executable=true). Match the kind's expected fields.

Action kinds (use the exact id):

Database:
  create_table       params: { tableName, columns: [{name, type, nullable?, unique?, fkTo?}] }
  alter_table        params: { tableName, changes: [...] }
  add_column         params: { tableName, column: {name, type, nullable?, default?} }
  add_index          params: { tableName, columns: string[], unique?: bool }
  add_constraint     params: { tableName, kind: 'unique'|'check', ... }
  rename_column      params: { tableName, from, to }

APIs:
  generate_api       params: { tableName }

Auth:
  enable_auth        params: { provider?: 'email'|'jwt' }
  add_provider       params: { provider: 'google'|'github'|'discord'|'facebook' } — usually needs_credential

Storage:
  create_bucket      params: { bucketName, isPublic?: bool }
  delete_bucket      params: { bucketName }

RLS / permissions:
  add_rls            params: { tableName, policy: 'owner_read_write'|'public_read'|'custom', custom?: string }
  set_permission     params: { tableName, role, ops: ('read'|'write'|'delete')[] }

Realtime / triggers:
  create_trigger     params: { tableName, on: 'insert'|'update'|'delete', kind: 'webhook'|'notify' }
  enable_realtime    params: { tableName }

Fix verbs (use when the list item is "fix X / repair X"):
  fix_auth | fix_api | fix_table | fix_integration | fix_workflow

Functions / cron:
  generate_function  params: { name, description }
  create_cron_job    params: { name, schedule, action }

Integrations:
  enable_integration params: { name: 'stripe'|'resend'|'sendgrid'|'openai'|... }  — usually needs_credential

Non-executable kinds (executable=false, blocker required):
  informational  — Backenly already does this internally (e.g., bcrypt hashing, soft-delete filters via SDK)
  manual         — user must do this themselves (e.g., paste a key, configure CDN)
  infra          — outside Backenly (CORS, backups infra, request logging, rate limiting at HTTP layer)

RULES:
1. Map "rate limiting", "request logging", "health checks", "CORS", "backups", "monitoring" → infra (not executable).
2. Map "password hashing", "JWT issuance", "soft delete filtering on reads" → informational (Backenly handles internally).
3. Map "OAuth provider setup" (Google/GitHub/etc.) → add_provider with executable=false, blocker=needs_credential.
4. Map "enable auth" / "auth middleware" / "JWT verification on endpoints" → enable_auth, executable=true.
5. Map "add RLS to X" → add_rls, executable=true.
6. Map "add index on X" → add_index, executable=true.
7. Map "rate limiting on auth endpoints" specifically → infra (we don't have a programmatic rate-limiter yet).
8. If a recommendation references a table that doesn't exist in projectState.tables, mark executable=false with blocker=needs_user_input.
9. If unsure, prefer informational with executable=false over fabricating a destructive action.
10. Items must be DISTINCT — collapse near-duplicates from the source list.

Return JSON of shape:
{
  "title": "<one-line proposal title, e.g. Production readiness>",
  "summary": "<one short sentence describing the set>",
  "items": [
    { "title": "...", "description": "...", "actionKind": "...", "executable": true|false, "blocker": "...", "blockerReason": "...", "params": {...} }
  ]
}

Cap at 20 items. If the assistant message is not a list, return {"items": []}.`

interface RawItem {
  title?: unknown
  description?: unknown
  actionKind?: unknown
  executable?: unknown
  blocker?: unknown
  blockerReason?: unknown
  params?: unknown
}

interface RawProposalShape {
  title?: unknown
  summary?: unknown
  items?: unknown
}

/** Convert an assistant list response into a typed Proposal.
 *  Returns null if the response isn't list-shaped, the LLM fails, or no
 *  items survive validation. */
export async function generateProposalFromAnswer(input: GenerateProposalInput): Promise<Proposal | null> {
  if (!input.assistantAnswer || input.assistantAnswer.length < 40) return null

  // Quick gate — bail if the answer doesn't look like a list at all so we
  // don't burn an LLM call on prose answers.
  if (!/\n\s*(?:[-*•]|\d+[.)])\s+\S/.test(input.assistantAnswer)) return null

  const openai = getOpenAIClient()
  const stateBlock = renderProjectState(input.projectState)

  const userBlock =
    `User question: ${JSON.stringify(input.userMessage.slice(0, 600))}\n\n` +
    `Assistant response (the list to convert):\n"""\n${input.assistantAnswer.slice(0, 4000)}\n"""\n\n` +
    `Project state:\n${stateBlock}`

  let raw: RawProposalShape
  try {
    const response = await openai.chat.completions.create({
      model: getModel('classify'),
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userBlock },
      ],
      temperature: 0.05,
      max_tokens: 1400,
      response_format: { type: 'json_object' },
    })
    trackCompletionCost(response, input.projectId, 'proposal-generator')
    raw = JSON.parse(response.choices[0]?.message?.content ?? '{}') as RawProposalShape
  } catch (err) {
    console.error('[ProposalGenerator] LLM call failed:', err)
    return null
  }

  const items = sanitiseItems(raw.items)
  if (items.length === 0) return null

  const proposal: Proposal = {
    id: newProposalId(),
    projectId: input.projectId,
    title: typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim().slice(0, 120) : 'Recommended updates',
    summary: typeof raw.summary === 'string' ? raw.summary.trim().slice(0, 240) : undefined,
    items,
    status: 'open',
    createdAt: new Date().toISOString(),
    expiresAt: defaultExpiry(),
    sourceUserMessage: input.userMessage.slice(0, 600),
    executableCount: items.filter(i => i.executable).length,
  }

  return proposal
}

function renderProjectState(state: GenerateProposalInput['projectState']): string {
  if (!state) return '(no state provided)'
  const lines: string[] = []
  lines.push(`tables: [${(state.tables ?? []).slice(0, 30).join(', ')}]`)
  lines.push(`apis: [${(state.apis ?? []).slice(0, 30).join(', ')}]`)
  lines.push(`authEnabled: ${state.authEnabled ?? false}`)
  lines.push(`buckets: [${(state.buckets ?? []).join(', ')}]`)
  lines.push(`integrations: [${(state.integrations ?? []).join(', ')}]`)
  return lines.join('\n')
}

function sanitiseItems(raw: unknown): ProposalItem[] {
  if (!Array.isArray(raw)) return []
  const out: ProposalItem[] = []
  raw.slice(0, 20).forEach((entry, idx) => {
    if (!entry || typeof entry !== 'object') return
    const r = entry as RawItem
    const title = typeof r.title === 'string' ? r.title.trim().slice(0, 120) : null
    if (!title) return

    const actionKind = (typeof r.actionKind === 'string' && VALID_KINDS.has(r.actionKind as ProposalActionKind))
      ? (r.actionKind as ProposalActionKind)
      : 'informational'

    const executableRaw = r.executable === true
    // Non-actionable kinds can never be executable — guards against the LLM
    // emitting an inconsistent combo like { actionKind: 'infra', executable: true }.
    const NON_EXECUTABLE_KINDS = new Set<ProposalActionKind>(['informational', 'manual', 'infra'])
    const executable = executableRaw && !NON_EXECUTABLE_KINDS.has(actionKind)

    let blocker: ProposalBlocker | undefined
    if (!executable) {
      const candidate = typeof r.blocker === 'string' ? r.blocker : undefined
      if (candidate && VALID_BLOCKERS.has(candidate as ProposalBlocker)) {
        blocker = candidate as ProposalBlocker
      } else {
        // Infer a sensible default based on actionKind so the user-facing
        // affordance can still explain why the agent isn't applying this.
        blocker =
          actionKind === 'infra' ? 'infra_only'
          : actionKind === 'manual' ? 'needs_user_input'
          : actionKind === 'informational' ? 'already_handled'
          : 'unsupported'
      }
    }

    const params = (r.params && typeof r.params === 'object') ? (r.params as Record<string, unknown>) : undefined

    out.push({
      id: newItemId(idx),
      title,
      description: typeof r.description === 'string' ? r.description.trim().slice(0, 400) : undefined,
      actionKind,
      executable,
      blocker,
      blockerReason: typeof r.blockerReason === 'string' ? r.blockerReason.trim().slice(0, 200) : undefined,
      params,
      status: 'pending',
    })
  })
  return out
}
