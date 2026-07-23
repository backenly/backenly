/**
 * PENDING DESTRUCTIVE STORE
 * =========================
 * When the agent loop's danger gate blocks a destructive tool call, the brain
 * persists exactly WHICH call was blocked (tool + args + human target). The
 * user's next affirmative message — the danger card's "Confirm — …" button, a
 * bare "yes"/"confirm", or re-stating the same destructive imperative — then
 * replays that stored call deterministically: no classifier, no LLM
 * re-derivation, no chance for a pending build plan to hijack the turn.
 *
 * This is the same structured resume the MCP Review Queue uses (approve →
 * replay with destructiveConfirmed=true). Before this store existed, the chat
 * door's confirmation was a stateless regex over the user's raw text, and the
 * model's own prose invented confirm phrases the regex rejected ("reply with
 * 'drop junk_test'") — producing an infinite ask-again loop.
 *
 * Storage: ProjectPreference (type='pending_destructive', key='active'). One
 * pending confirmation per project at a time — the danger gate replaces it,
 * a confirmed resume or any non-affirmative next message clears it.
 *
 * 15-minute TTL — long enough to read the card and decide, short enough that
 * a forgotten "yes" the next morning can never fire a stale drop.
 */

import { prisma } from '@/lib/db/prisma'

const PREF_TYPE = 'pending_destructive'
const PREF_KEY = 'active'
const TTL_MS = 15 * 60 * 1000

/**
 * A BARE affirmative ("yes", "confirm") carries no information about WHAT is
 * being approved — it only means "whatever you just asked me". That is safe
 * while the ask is still on screen and dangerous once it is not.
 *
 * Observed failure: a bare `confirm` sent over the stateless MCP door resumed a
 * destructive cast parked by an entirely different session, so the caller
 * approved one operation and executed another. MCP has no session identity to
 * bind to, and the store holds one pending item per PROJECT, so freshness is
 * the only signal available that the confirmer saw the thing they are
 * confirming.
 *
 * Past this window the pending call is not discarded — it simply requires a
 * confirmation that NAMES the target ("drop the followers table") or the danger
 * card's explicit phrase, both of which prove the confirmer knows what it is.
 */
const BARE_AFFIRMATIVE_TTL_MS = 2 * 60 * 1000

export interface PendingDestructiveCall {
  tool: string
  args: Record<string, unknown>
  /** Human description of what gets destroyed, e.g. "the `followers` table". */
  target: string
}

export interface PendingDestructive {
  /**
   * The exact blocked tool calls to replay on confirmation. EMPTY when the
   * model prose-asked for confirmation without attempting the tool (so the
   * gate never fired) — in that replay mode, confirmation re-runs
   * `originalMessage` through the brain with destructiveConfirmed=true,
   * exactly like the MCP Review Queue approval replay.
   */
  calls: PendingDestructiveCall[]
  /** The user message that triggered the block/ask. */
  originalMessage: string
  createdAt: string
  expiresAt: string
}

export async function savePendingDestructive(
  projectId: string,
  calls: PendingDestructiveCall[],
  originalMessage: string,
): Promise<void> {
  if (calls.length === 0 && !originalMessage.trim()) return
  const now = Date.now()
  const pending: PendingDestructive = {
    calls,
    originalMessage,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + TTL_MS).toISOString(),
  }
  await prisma.projectPreference.upsert({
    where: { projectId_type_key: { projectId, type: PREF_TYPE, key: PREF_KEY } },
    create: {
      projectId,
      type: PREF_TYPE,
      key: PREF_KEY,
      value: JSON.stringify(pending),
      confidence: 1,
    },
    update: { value: JSON.stringify(pending), confidence: 1, lastSeen: new Date() },
  })
}

export async function loadPendingDestructive(projectId: string): Promise<PendingDestructive | null> {
  const pref = await prisma.projectPreference.findUnique({
    where: { projectId_type_key: { projectId, type: PREF_TYPE, key: PREF_KEY } },
  }).catch(() => null)
  if (!pref) return null
  try {
    const pending = JSON.parse(pref.value) as PendingDestructive
    if (Date.parse(pending.expiresAt) < Date.now()) return null
    if (!Array.isArray(pending.calls)) return null
    if (pending.calls.length === 0 && !pending.originalMessage) return null
    return pending
  } catch {
    return null
  }
}

export async function clearPendingDestructive(projectId: string): Promise<void> {
  await prisma.projectPreference.deleteMany({
    where: { projectId, type: PREF_TYPE, key: PREF_KEY },
  }).catch(() => {})
}

/** Bare affirmatives — "yes", "confirm", "do it", "go ahead", "proceed"… */
const AFFIRMATIVE_RE =
  /^\s*(yes|yep|yeah|ya|sure|ok(ay)?|confirm(ed)?|do\s+it|go\s+ahead|proceed|approve[d]?|please\s+(do|proceed)|i'?m\s+sure)\s*[.!]*\s*$/i

/**
 * Is this message a bare affirmative — approval with no stated target?
 * Exported so the caller can tell "you said yes too late" apart from "you
 * changed the subject", which need very different responses.
 */
export function isBareAffirmative(message: string): boolean {
  return AFFIRMATIVE_RE.test(message.trim())
}

/** The danger card's Confirm button sends "Confirm — <action>". */
const DANGER_CARD_RE = /^\s*confirm\s*[—–-]/i

const DESTRUCTIVE_VERB_RE =
  /\b(drop|delete|remove|wipe|truncate|destroy|revoke|rotate|disable|disconnect|block)\b/i

/**
 * Does this message confirm the pending destructive call(s)?
 *
 * Three ways to say yes, all observed in real usage:
 *   1. A bare affirmative ("yes", "confirm", "do it").
 *   2. The danger card's button phrase ("Confirm — drop the followers table").
 *   3. Re-stating the same destructive imperative against the same target
 *      ("Drop the junk_test table." → blocked → "Drop the junk_test table.").
 *      Repeating the exact command after being told what will be lost IS the
 *      confirmation — making the user find a magic phrase was the bug.
 *
 * A message that names a DIFFERENT target is not a confirmation — the caller
 * clears the pending state and routes it as a fresh request.
 *
 * Form (1) additionally requires the pending call to be FRESH. A bare "yes"
 * says nothing about what is being approved, so it may only resolve an ask the
 * confirmer can still see; anything older must be confirmed by name. Forms (2)
 * and (3) both state the target explicitly and are accepted for the full TTL.
 */
export function isDestructiveConfirmation(
  message: string,
  pending: PendingDestructive,
  now: number = Date.now(),
): boolean {
  const m = message.trim()
  if (!m) return false
  // Explicit forms name the action, so they are unambiguous at any age.
  if (DANGER_CARD_RE.test(m)) return true
  if (AFFIRMATIVE_RE.test(m)) return isFreshForBareAffirmative(pending, now)
  if (!DESTRUCTIVE_VERB_RE.test(m)) return false
  const lower = m.toLowerCase()
  if (pending.calls.length > 0) {
    return pending.calls.some((c) => targetTokens(c).some((t) => lower.includes(t)))
  }
  // Replay mode (no concrete calls): the re-stated imperative must share an
  // identifier with the original ask ("delete followers table" → "delete
  // followers table" / "drop followers"). A different target is a NEW request.
  return messageIdentifiers(pending.originalMessage).some((t) => lower.includes(t))
}

/**
 * Is this pending call recent enough that a bare "yes" can resolve it?
 * A malformed or missing createdAt is treated as NOT fresh — an unknown age
 * must never widen what a bare affirmative is allowed to execute.
 */
function isFreshForBareAffirmative(pending: PendingDestructive, now: number): boolean {
  const created = Date.parse(pending.createdAt)
  if (!Number.isFinite(created)) return false
  const age = now - created
  return age >= 0 && age <= BARE_AFFIRMATIVE_TTL_MS
}

/**
 * What the caller is about to approve, in one line.
 *
 * Exposed so the confirmation prompt and the post-execution summary can both
 * name the target. The stale-confirm incident was only detectable after the
 * fact because the response happened to mention the table it had touched; that
 * should be guaranteed, not luck.
 */
export function describePendingDestructive(pending: PendingDestructive): string {
  if (pending.calls.length > 0) {
    const targets = pending.calls.map((c) => c.target || c.tool).filter(Boolean)
    if (targets.length > 0) return targets.join(', ')
  }
  return pending.originalMessage.trim() || 'a destructive operation'
}

/** Named identifiers from the stored args — table/bucket/column/file names. */
function targetTokens(call: PendingDestructiveCall): string[] {
  const a = call.args
  return [a.tableName, a.bucketName, a.columnName, a.name, a.path, a.provider, a.email, a.key]
    .filter((v): v is string => typeof v === 'string' && v.length > 1)
    .map((v) => v.toLowerCase())
}

/** Generic English words that never identify a target. */
const IDENTIFIER_STOPWORDS = new Set([
  'the', 'and', 'all', 'its', 'that', 'this', 'from', 'with', 'please',
  'drop', 'delete', 'remove', 'wipe', 'truncate', 'destroy', 'revoke',
  'rotate', 'disable', 'disconnect', 'block',
  'table', 'tables', 'column', 'columns', 'bucket', 'buckets', 'file',
  'files', 'row', 'rows', 'data', 'key', 'keys', 'user', 'users',
])

/** Candidate target identifiers in a free-text destructive ask. */
function messageIdentifiers(message: string): string[] {
  const words = message.toLowerCase().match(/[a-z_][a-z0-9_]{2,}/g) ?? []
  return words.filter((w) => !IDENTIFIER_STOPWORDS.has(w))
}
