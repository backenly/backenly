/**
 * NARRATION VOICE
 * ================
 * Premium, decision-driven copy for the agentic build stream.
 *
 * Rules every line in this file obeys:
 *   1. Never describe the operation — describe the *decision*.
 *        bad:  "Calling CREATE_TABLE for posts."
 *        good: "Posts table sits between users and comments — it owns the FKs."
 *   2. No "I think", no "let me", no apologies, no hedging.
 *   3. No GPT-isms. No "Sure!", no "Of course!", no "Here is".
 *   4. <= 110 chars. A line a staff engineer would say out loud, not a status dump.
 *   5. Domain-aware. Social → "social graph". Commerce → "cart and checkout".
 *
 * This file is the single source of truth for the agent's voice. Touching
 * these strings is a design decision, not a copy edit.
 */

import type { AgentEvent, NarrationTone, AgentActionVerb } from './stream-events'

export type AgentEmit = (event: AgentEvent) => void

/** Premium one-line domain framings shown in the foundation banner. */
const DOMAIN_HEADLINES: Record<string, string> = {
  social:        'Social platform. Foundation first — identity, content, social graph, then notifications.',
  ecommerce:     'Commerce backend. Foundation first — catalog, cart, checkout, then payments and fulfillment.',
  marketplace:   'Marketplace. Foundation first — listings and accounts, then orders, payouts, reviews.',
  saas:          'SaaS billing surface. Foundation first — tenants and plans, then metering, invoices, webhooks.',
  chat:          'Realtime chat. Foundation first — rooms and members, then messages, presence, push.',
  blog:          'Editorial backend. Foundation first — authors and posts, then comments, tags, search.',
  productivity:  'Productivity workspace. Foundation first — workspaces and members, then docs, sharing, search.',
  fintech:       'Financial surface. Foundation first — accounts and ledgers, then transactions and reconciliation.',
  booking:       'Booking platform. Foundation first — inventory and slots, then reservations, payments, reminders.',
  unknown:       'Backend committed. Foundation first — data, identity, APIs, then integrations and verification.',
}

const DEFAULT_ORDER = ['data', 'auth', 'APIs', 'storage', 'realtime', 'verify']

/** Phase weights — sum to 100. Used to compute the live progress percent. */
export const PHASE_WEIGHTS: Record<string, number> = {
  planning:   10,
  schema:     25,
  auth:       15,
  apis:       25,
  storage:    10,
  integration: 5,
  verify:     10,
}

export function foundationFor(domain: string): { domain: string; headline: string; order: string[] } {
  const key = (domain || 'unknown').toLowerCase()
  const matched = (Object.keys(DOMAIN_HEADLINES) as Array<keyof typeof DOMAIN_HEADLINES>).find(k =>
    key.includes(k),
  )
  return {
    domain: key,
    headline: DOMAIN_HEADLINES[matched ?? 'unknown'],
    order: DEFAULT_ORDER,
  }
}

/**
 * Emit a narration line. Keep call sites short — the *string* is the design.
 */
export function narrate(emit: AgentEmit, tone: NarrationTone, text: string, durationHintMs?: number) {
  try {
    emit({ type: 'narration', tone, text, durationHintMs })
  } catch { /* SSE closed — ignore */ }
}

/** Emit a "the agent is touching X" transparency event. */
export function agentAction(
  emit: AgentEmit,
  verb: AgentActionVerb,
  target: string,
  elapsedMs?: number,
) {
  try {
    emit({ type: 'agent_action', verb, target, elapsedMs })
  } catch { /* SSE closed — ignore */ }
}

/** Emit a progress tick for the live phase banner. */
export function progressTick(
  emit: AgentEmit,
  phase: 'planning' | 'building' | 'validating' | 'finalizing',
  label: string,
  percent: number,
) {
  try {
    emit({ type: 'progress', phase, label, percent: Math.max(0, Math.min(100, Math.round(percent))) })
  } catch { /* SSE closed — ignore */ }
}

// ── Premium copy banks ────────────────────────────────────────────────────────
// Each bank is a small ordered set. The pipeline cycles through them so a single
// run never repeats the same line twice — even when phases retry.

/** Lines shown the instant a build begins, before any plan exists. */
export const OPENING_LINES = [
  'Reading what you described — pulling out the entities, actions, and the surfaces they connect to.',
  'Scoping intent. Looking past the words for the shape this backend actually wants to be.',
  'Mapping the request to a model — who owns what, what flows where.',
] as const

/** Lines shown after the planner commits to an architecture. */
export const COMMIT_LINES = (domain: string) => [
  `${capitalize(domain)} shape detected. Building the foundation before anything decorative.`,
  `Architecture locked. Tables first — the rest hangs off the relations.`,
  `Plan committed. I'd rather build the smallest correct thing and grow it than bolt on later.`,
] as const

export const SCHEMA_OPEN = [
  'Sculpting the data model. Foreign keys are the spine — everything downstream rides on these.',
  'Tables first. Picking the relations that won\'t need to be reshuffled in a week.',
] as const

export const AUTH_OPEN = [
  'Wiring identity. JWTs scoped per project — your platform and your end users never share a token.',
  'Auth layer next. End-user sessions live inside the workspace, not the platform.',
] as const

export const API_OPEN = [
  'Generating the REST surface. Each table earns a typed handler — no hand-rolled endpoints to drift.',
  'APIs lifting off the schema. List, create, get, update, delete — and a sane filter contract.',
] as const

export const STORAGE_OPEN = [
  'Buckets next. Public or signed-URL, picked from how the assets are actually used.',
] as const

export const VERIFY_OPEN = [
  'Verifying. The build only counts if the proofs come back green.',
  'Running structural checks. Auth surface, RLS, foreign keys, missing indexes.',
] as const

export const SEAL_LINES = [
  'Sealed. The runtime is governed, locked, and snapshotted — every mutation is auditable.',
  'Done. Backend is live in the workspace — every endpoint is real, every table is real.',
] as const

export const RECOVER_LINES = [
  'Tightening a check that just failed — I\'d rather fix it now than ship it.',
  'Self-correcting. The verifier found something the planner missed.',
] as const

function capitalize(s: string): string {
  if (!s) return s
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/**
 * Pick a line from a bank without repeating consecutively for the same key.
 * Best-effort — used only to vary cosmetic strings between phases.
 */
const _lastIndexByKey = new Map<string, number>()
export function pickLine(key: string, bank: readonly string[]): string {
  if (bank.length === 0) return ''
  const prev = _lastIndexByKey.get(key)
  let idx = Math.floor(Math.random() * bank.length)
  if (bank.length > 1 && idx === prev) idx = (idx + 1) % bank.length
  _lastIndexByKey.set(key, idx)
  return bank[idx]
}
