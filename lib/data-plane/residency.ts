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
 * A finding's details as the platform row may keep them. This row is in the
 * home region; for a project kept in another region a failed repair's message
 * is kept only when it is an error code (lib/data-plane/residency.ts), since
 * PostgreSQL can fill a message with the offending values. The full message
 * goes to this process's log only when this process serves the project's
 * region, so it stays there too.
 */
export async function findingDetailsKeptHere(
  projectId: string,
  type: string,
  details: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const message = details?.fixError
  if (typeof message !== 'string' || (await quotesKeptHere(projectId))) return details
  const kept = quotedError(message, false)
  if (kept !== message && (await servedHere(projectId).catch(() => false))) {
    console.warn(`[autonomy] ${type} repair failed on project ${projectId}: ${message}`)
  }
  return { ...details, fixError: kept }
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
