/**
 * WHAT A PLATFORM ROW MAY QUOTE ABOUT A PROJECT'S WORK
 * ====================================================
 * The platform database is in the home region. A project kept in another
 * region keeps its customer data there (founders, 2026-10-16: residency is
 * fixed before any region opens), so the platform's records of its work keep
 * the names, kinds, counts and ids of what was done, never the text the work
 * carried:
 *   - the request, which can name an end user ("block alice@example.com");
 *   - the agent's reply and a tool's result summary, which can quote rows;
 *   - a tool's arguments, which can be the rows themselves (insert_data);
 *   - an error message, which PostgreSQL fills with the offending values
 *     ("Key (email)=(alice@example.com) already exists").
 *
 * A home project's records are unchanged: its data is in this database
 * already. This module only decides; each writer applies it to its own row.
 */

import { createHmac } from 'crypto'
import { isIP } from 'net'
import { HOME_REGION } from '@/lib/regions'
import { projectRegion } from '@/lib/data-plane/regional'
import { servedHere } from '@/lib/data-plane/serving'
import type { RecordedStatement } from '@/lib/execution/sql-recorder'

/**
 * Whether platform rows may quote a project's requests, replies, arguments,
 * results and errors: for a project kept in the home region only. A project
 * whose region cannot be read is quoted nowhere, so a lookup failure never
 * writes what residency keeps out.
 */
export async function quotesKeptHere(projectId: string): Promise<boolean> {
  try {
    return (await projectRegion(projectId)) === HOME_REGION
  } catch {
    return false
  }
}

/**
 * What a platform row says in place of a message it may not quote: there was
 * one, and it was not recorded. It is not kept anywhere else either.
 */
export const NOT_QUOTED = 'Not recorded: this project’s data stays in its own region.'

/** An error code (MIGRATION_FAILED): a name the platform chose, never a message about data. */
export const ERROR_CODE = /^[A-Z][A-Z0-9_]{1,63}$/

/**
 * An error message as a platform row about a project's work may keep it: in
 * full for a project kept in the home region; for one kept in another region
 * only when it is an error code, otherwise NOT_QUOTED. The full message stays
 * in the logs of the process that met it, which for a regional project's
 * background work run in its own region are that region's.
 */
export function quotedError(message: string, quote: boolean): string {
  return quote || ERROR_CODE.test(message) ? message : NOT_QUOTED
}

/**
 * Where a finding's details carry an executor's or PostgreSQL's own words: why
 * a repair failed, why the loop gave it back to a person, why the check that
 * would confirm it could not run, and why the state before it could not be read.
 */
const FINDING_ERROR_TEXTS: Array<{ path: [string] | [string, string]; what: string }> = [
  { path: ['fixError'], what: 'repair failed' },
  { path: ['escalation', 'reason'], what: 'repair escalated' },
  { path: ['appliedUnverified', 'verifierError'], what: 'repair check failed' },
  // A proposal run's message (lib/autonomy/ai-proposals.ts), when a row carrying it comes through here.
  { path: ['appliedUnverified', 'reason'], what: 'repair check failed' },
  { path: ['rollbackData', 'baselineError'], what: 'repair baseline failed' },
]

function textAt(details: Record<string, unknown>, [field, sub]: [string] | [string, string]): unknown {
  const value = details?.[field]
  return sub === undefined ? value : (value as Record<string, unknown> | null | undefined)?.[sub]
}

/**
 * A finding's details as the platform row may keep them. This row is in the
 * home region; for a project kept in another region each error text it carries
 * (FINDING_ERROR_TEXTS) is kept only when it is an error code, since PostgreSQL
 * can fill a message with the offending values. The full text goes to this
 * process's log only when this process serves the project's region, so it
 * stays there too.
 */
export async function findingDetailsKeptHere(
  projectId: string,
  type: string,
  details: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const texts = FINDING_ERROR_TEXTS.filter(({ path }) => typeof textAt(details, path) === 'string')
  if (texts.length === 0 || (await quotesKeptHere(projectId))) return details
  const logHere = await servedHere(projectId).catch(() => false)
  let kept = details
  for (const { path, what } of texts) {
    const message = textAt(details, path) as string
    const quoted = quotedError(message, false)
    if (quoted === message) continue
    if (logHere) console.warn(`[autonomy] ${type} ${what} on project ${projectId}: ${message}`)
    const [field, sub] = path
    kept = sub === undefined
      ? { ...kept, [field]: quoted }
      : { ...kept, [field]: { ...(kept[field] as Record<string, unknown>), [sub]: quoted } }
  }
  return kept
}

/** Argument names whose values are a project's structure, not its data. */
const STRUCTURE_KEYS = new Set([
  'table',
  'tableName',
  'targetTable',
  'column',
  'columnName',
  'bucket',
  'bucketName',
  'functionName',
  'triggerName',
])

/** A SQL identifier: what a table, column, bucket or function is named. */
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_-]{0,62}$/

/** An opaque id (uuid, cuid): letters, digits, `-` and `_` only, so never an email. */
const OPAQUE_ID = /^[A-Za-z0-9_-]{8,64}$/

/**
 * A tool's arguments as a platform row may keep them for a project kept in
 * another region: every argument's name; the value of a structural name (a
 * table, a column, a bucket, a function) when it is an identifier, of an id
 * when it is opaque, and of a number or a flag; for a list, its length;
 * anything else only as its kind. So `insert_data` keeps the table and how
 * many rows, never the rows.
 */
export function argumentShape(args: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const shape: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(args ?? {})) {
    if (Array.isArray(value)) shape[key] = { count: value.length }
    else if (typeof value === 'string' && STRUCTURE_KEYS.has(key) && IDENTIFIER.test(value)) shape[key] = value
    else if (typeof value === 'string' && /(?:^id|Id)$/.test(key) && OPAQUE_ID.test(value)) shape[key] = value
    else if (typeof value === 'number' || typeof value === 'boolean' || value === null) shape[key] = value
    else shape[key] = `[${typeof value}]`
  }
  return shape
}

/**
 * What a repair's records keep of it. A repair is recorded on its finding
 * (rollbackData, or appliedUnverified when its check could not run) and on its
 * audit row, and each record keeps:
 *   - for a project kept in the home region, the call, its result and the
 *     statements it ran, as they were;
 *   - for a project kept in another region, the action's name, its arguments'
 *     shape, the statements' text and whether it succeeded.
 * An action held for approval keeps the same as a project kept in another
 * region, in every region: its arguments are its caller's own values, a secret
 * among them (SET_ENV_VAR), which its finding keeps sealed or in the project's
 * region; the statements replaying it bind them (BLOCK_USER binds the end
 * user's email); and its result can carry a value its approver is shown once
 * (ROTATE_KEY answers with the new key).
 * Undo reads none of these: it restores the pre-fix snapshot and preMetadata
 * (revertAutoFix in lib/core/auto-fix-engine.ts).
 */
export interface RepairRecordKeeping {
  /** quotesKeptHere for the repair's project. */
  quote: boolean
  /** The repair replays an action held for approval (an `ai_action_pending` finding). */
  held: boolean
}

/** A repair's call as its records keep it: in full, or its action and its arguments' shape. */
export function recordedFixAction<A extends { action: string; params?: Record<string, unknown> | null }>(
  fixAction: A,
  { quote, held }: RepairRecordKeeping,
): A | { action: A['action']; params: Record<string, unknown> } {
  return quote && !held ? fixAction : { action: fixAction.action, params: argumentShape(fixAction.params) }
}

/** The statements a repair ran as its records keep them: with their bound values, or their text only. */
export function recordedStatements(
  statements: readonly RecordedStatement[],
  { quote, held }: RepairRecordKeeping,
): RecordedStatement[] {
  return quote && !held ? [...statements] : statements.map(({ sql }) => ({ sql }))
}

/**
 * A repair's result as its records keep it: the executor's message and data,
 * which can quote rows, for a project kept in the home region; for a project
 * kept in another region or an action held for approval, only whether it
 * succeeded.
 */
export function recordedFixResult(
  result: { success: boolean; message?: string; data?: unknown },
  { quote, held }: RepairRecordKeeping,
): Record<string, unknown> {
  return quote && !held ? { message: result.message, data: result.data } : { success: result.success }
}

/**
 * A repair's result message as its audit row keeps it: for an action held for
 * approval, only that the action ran, by the platform's own name for it;
 * otherwise the executor's message. Either is then kept as quotedError keeps an
 * executor's words for the project's region.
 */
export function recordedResultMessage(message: string, action: string, { quote, held }: RepairRecordKeeping): string {
  return quotedError(held ? `Ran ${action}` : message, quote)
}

/**
 * The network an end user's address belongs to, not the address: the first
 * three octets of an IPv4 address (a /24) and the first three groups of an
 * IPv6 one (a /48). Enough to see that requests come from one network, which
 * is what an abuse signal needs; not enough to name the device. Anything that
 * is not an address is dropped.
 */
export function addressNetwork(ip: string | null | undefined): string | null {
  const address = (ip ?? '').trim().replace(/^::ffff:(?=\d+\.)/i, '')
  if (isIP(address) === 4) return address.split('.').slice(0, 3).join('.') + '.0/24'
  if (isIP(address) === 6) {
    const [head, tail = ''] = address.toLowerCase().split('::')
    const left = head ? head.split(':') : []
    const right = tail ? tail.split(':') : []
    const groups = [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right]
    return groups.slice(0, 3).map((group) => group.replace(/^0+(?=.)/, '')).join(':') + '::/48'
  }
  return null
}

/** A request path without its query string, which can carry a filter's values (`?email=eq.alice@…`). */
export function pathWithoutQuery(path: string): string {
  return path.split(/[?#]/, 1)[0]
}

/**
 * A stable stand-in for an end user's id in the platform's records of a
 * project kept in another region: the same for that user in that project every
 * time, so counting distinct users still works, and of no use outside it.
 * Keyed like the function database logins (lib/services/ai-functions/
 * function-db-role.ts), with a secret every region's tasks receive, so every
 * region computes the same value. Throws when no key is set: an unkeyed hash
 * of a guessable id would protect nothing.
 */
export function endUserPseudonym(projectId: string, endUserId: string): string {
  const key = process.env.ENV_VAR_ENCRYPTION_KEY || process.env.JWT_SECRET
  if (!key) throw new Error('No key for end-user pseudonyms: neither ENV_VAR_ENCRYPTION_KEY nor JWT_SECRET is set')
  return createHmac('sha256', key).update(`backenly:end-user-pseudonym:v1:${projectId}:${endUserId}`).digest('base64url')
}
