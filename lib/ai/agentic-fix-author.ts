/**
 * AGENTIC FIX AUTHOR — Bounded Agency Surface B
 * ==============================================
 * Called from `agentic-fix-loop.ts` when the curated `mapCheckToFixes`
 * registry returns no candidates for a failing behavioral check. The author
 * is allowed to *propose* one fix using the existing executor vocabulary —
 * never raw SQL, never a novel action type.
 *
 * Hard contract:
 *   - The proposed FixCandidate's `action` must be one of the safe-to-author
 *     AIAction values listed in `AUTHORED_ACTION_WHITELIST`.
 *   - Destructive actions (DROP_TABLE, TRUNCATE_TABLE, REMOVE_*) are never
 *     authorable — the agent cannot escalate to data destruction.
 *   - Output is validated by Zod; invalid → returns `[]`.
 *   - Every authored fix carries `requiresApproval = true` when the action
 *     mutates state, so the existing approval gate still runs.
 *   - Routed through `executeAction → mutate.ts` governance kernel.
 *
 * Bounds:
 *   - Model:   gpt-4o (AUTONOMY_FIX_MODEL to override)
 *   - Budget:  ≤ MAX_AUTHORED_FIXES_PER_BUILD novel fixes per build run
 *   - Timeout: 12s (non-critical; loop continues if author times out)
 *
 * Gated by ENABLE_AGENTIC_FIX_AUTHOR. When the flag is off this module is
 * never called.
 */

import { z } from 'zod'
import { getOpenAIClient, trackCompletionCost } from './openai-service'
import { withTimeout } from './with-timeout'
import type { BehavioralCheck } from './behavioral-verifier'
import type { FixCandidate } from './behavioral-check-to-fixes'
import type { AIAction } from './minimal-executor'

// ── Constants ────────────────────────────────────────────────────────────────

// Self-healing runs on the strong model (founder decision 2026-07-18): fix
// authoring is the one reasoning step where a wrong answer wastes a healing
// window, and volume is tiny (≤5/build), so the cost delta is negligible.
// AUTONOMY_FIX_MODEL overrides for rollback without a deploy.
const AUTHOR_MODEL = process.env.AUTONOMY_FIX_MODEL || 'gpt-4o'
const AUTHOR_TIMEOUT_MS = 12_000
const AUTHOR_TEMPERATURE = 0.15
export const MAX_AUTHORED_FIXES_PER_BUILD = 5
const MAX_REASON_LEN = 220

/**
 * Actions the fix author is allowed to emit. Curated to:
 *   - Exclude all destructive operations (DROP/TRUNCATE/REMOVE/BLOCK)
 *   - Exclude billing/auth credential mutations (those need user input)
 *   - Exclude cross-tenant operations (CREATE_STAGING, PROMOTE_STAGING)
 *
 * Anything outside this list → reject + fall through. The deterministic
 * fix-loop still gets to report the failure to the user.
 */
const AUTHORED_ACTION_WHITELIST: AIAction['action'][] = [
  // Schema repair
  'ADD_COLUMN',
  'CREATE_INDEX',
  'ADD_CONSTRAINT',
  'CREATE_JUNCTION_TABLE',
  // API repair
  'GENERATE_API',
  // Auth / RLS
  'ENABLE_AUTH',
  'SET_PERMISSION',
  // Realtime
  'ENABLE_REALTIME',
  'CREATE_TRIGGER',
  // Self-repair (these route to FIX_* handlers which are themselves safe)
  'FIX_AUTH',
  'FIX_API',
  'FIX_TABLE',
  'FIX_REALTIME',
  'FIX_STORAGE',
  'FIX_INTEGRATION',
  // Health checks
  'GENERATE_HEALTH_CHECK',
]

// ── Output schema ────────────────────────────────────────────────────────────

const ProposedFixSchema = z.object({
  action: z.enum(AUTHORED_ACTION_WHITELIST as [AIAction['action'], ...AIAction['action'][]]),
  /** Free-form params — shape varies by action. Validated downstream by the executor. */
  params: z.record(z.unknown()).default({}),
  reason: z.string().min(8).max(MAX_REASON_LEN),
})

const ProposedFixResponseSchema = z.object({
  /** `null` when the author has no safe proposal. */
  fix: ProposedFixSchema.nullable(),
  /** Optional context — shown in the audit log when fix is null. */
  noFixReason: z.string().max(MAX_REASON_LEN).optional(),
})

export type AuthoredFixProposal = z.infer<typeof ProposedFixSchema>

// ── Public entry ─────────────────────────────────────────────────────────────

export interface AuthorFixArgs {
  /** The failing check the registry could not fix. */
  check: BehavioralCheck
  /** Project context the author can read (table names, etc.). */
  projectId: string
  /** Schema summary string for grounding (table names + key columns). */
  schemaContext?: string
  /** Counter used to enforce the per-build authored-fix cap. */
  authoredSoFar: number
  /** Optional abort signal for evals/tests. */
  signal?: AbortSignal
}

export interface AuthorFixResult {
  candidate: FixCandidate | null
  /** Why the author declined or fell back. */
  reason: string
  /** Token + duration telemetry for cost tracking. */
  telemetry: {
    model: string
    durationMs: number
    promptTokens?: number
    completionTokens?: number
  }
}

let _seq = 0
const nextId = () => `agent-fix-${Date.now()}-${++_seq}`

/**
 * Propose a single fix for a failing check the curated registry could not
 * handle. Always resolves; never throws.
 */
export async function authorFixForCheck(args: AuthorFixArgs): Promise<AuthorFixResult> {
  const startedAt = Date.now()

  if (args.authoredSoFar >= MAX_AUTHORED_FIXES_PER_BUILD) {
    return {
      candidate: null,
      reason: `author cap (${MAX_AUTHORED_FIXES_PER_BUILD}) reached for this build`,
      telemetry: { model: AUTHOR_MODEL, durationMs: 0 },
    }
  }

  let raw: string
  let promptTokens: number | undefined
  let completionTokens: number | undefined

  try {
    const client = getOpenAIClient()
    const completion = await withTimeout(
      client.chat.completions.create({
        model: AUTHOR_MODEL,
        temperature: AUTHOR_TEMPERATURE,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: buildUserPrompt(args) },
        ],
      }, { signal: args.signal }),
      AUTHOR_TIMEOUT_MS,
      'fix-author',
    )

    trackCompletionCost(completion, args.projectId, 'fix-author')
    promptTokens = completion.usage?.prompt_tokens
    completionTokens = completion.usage?.completion_tokens
    raw = completion.choices[0]?.message?.content ?? ''
    if (!raw) {
      return done(null, 'author returned empty response', startedAt, promptTokens, completionTokens)
    }
  } catch (err: any) {
    const reason = err?.message?.includes('timed out')
      ? 'author timed out'
      : `author call failed: ${err?.message ?? String(err)}`
    return done(null, reason, startedAt)
  }

  // ── Parse + validate ──────────────────────────────────────────────────────
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return done(null, 'author returned invalid JSON', startedAt, promptTokens, completionTokens)
  }

  const result = ProposedFixResponseSchema.safeParse(parsed)
  if (!result.success) {
    const issues = result.error.issues.slice(0, 2).map(i => `${i.path.join('.')}: ${i.message}`).join('; ')
    return done(null, `author output failed schema validation: ${issues}`, startedAt, promptTokens, completionTokens)
  }

  if (!result.data.fix) {
    return done(null, result.data.noFixReason ?? 'author declined to propose a fix', startedAt, promptTokens, completionTokens)
  }

  // ── Build a FixCandidate routable through the existing executor ──────────
  const fix = result.data.fix
  const candidate: FixCandidate = {
    id: nextId(),
    action: fix.action,
    params: fix.params as Record<string, unknown>,
    reason: fix.reason,
    sourceCheckId: args.check.id,
    // Author-proposed fixes always require explicit approval before they run,
    // EXCEPT for the FIX_* self-repair family which is already gated by the
    // executor and behaves like a curated repair.
    requiresApproval: !fix.action.startsWith('FIX_'),
  }

  return {
    candidate,
    reason: 'authored',
    telemetry: {
      model: AUTHOR_MODEL,
      durationMs: Date.now() - startedAt,
      promptTokens,
      completionTokens,
    },
  }
}

// ── Prompt construction ──────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are the Fix Author inside an AI Backend-as-a-Service platform.

A behavioral check on a generated backend has FAILED, and the curated fix
registry has no entry for it. You may propose ONE fix using only the
executor's existing action vocabulary. You may also decline if no safe fix
applies.

You are NEVER allowed to:
  - Write raw SQL
  - Propose actions outside the whitelist
  - Propose destructive actions (DROP/TRUNCATE/REMOVE/BLOCK)
  - Propose fixes that require credentials the user hasn't provided
  - Propose fixes whose blast radius extends beyond the failing check

Allowed actions (whitelist):
  ADD_COLUMN, CREATE_INDEX, ADD_CONSTRAINT, CREATE_JUNCTION_TABLE,
  GENERATE_API, ENABLE_AUTH, SET_PERMISSION, ENABLE_REALTIME,
  CREATE_TRIGGER, FIX_AUTH, FIX_API, FIX_TABLE, FIX_REALTIME,
  FIX_STORAGE, FIX_INTEGRATION, GENERATE_HEALTH_CHECK

Output JSON only:

{
  "fix": {
    "action": "<one of the whitelist>",
    "params": { ... action-specific params ... },
    "reason": "<≤220 chars — why this fix addresses the observed failure>"
  }
}

OR, when no safe fix applies:

{ "fix": null, "noFixReason": "<≤220 chars — what makes this not authorable>" }

Rules:
  - Default to { fix: null } when uncertain. A wrong fix is worse than no fix.
  - The reason must explicitly tie the action to the observed failure.
  - Keep params minimal and concrete.`

function buildUserPrompt(args: AuthorFixArgs): string {
  const lines: string[] = []
  lines.push(`### Failed behavioral check`)
  lines.push(`id: ${args.check.id}`)
  lines.push(`name: ${args.check.name}`)
  if (args.check.error) {
    lines.push(`error: ${truncate(args.check.error, 400)}`)
  }
  if (args.check.details?.length) {
    lines.push(`details:`)
    for (const d of args.check.details.slice(0, 8)) {
      lines.push(`  - ${truncate(d, 200)}`)
    }
  }

  if (args.schemaContext) {
    lines.push('')
    lines.push(`### Workspace schema (read-only context)`)
    lines.push(truncate(args.schemaContext, 1200))
  }

  lines.push('')
  lines.push(`Authored fixes so far on this build: ${args.authoredSoFar} / ${MAX_AUTHORED_FIXES_PER_BUILD}`)
  lines.push('')
  lines.push('Return the JSON decision now.')
  return lines.join('\n')
}

function truncate(s: string, max: number): string {
  if (!s) return ''
  return s.length <= max ? s : s.slice(0, max - 1) + '…'
}

function done(
  candidate: FixCandidate | null,
  reason: string,
  startedAt: number,
  promptTokens?: number,
  completionTokens?: number,
): AuthorFixResult {
  return {
    candidate,
    reason,
    telemetry: {
      model: AUTHOR_MODEL,
      durationMs: Date.now() - startedAt,
      promptTokens,
      completionTokens,
    },
  }
}
