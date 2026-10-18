/**
 * AN APPROVAL REQUEST'S WORDS AND EXACT CALL, KEPT WHERE ITS PROJECT IS
 * =====================================================================
 * A call an agent parks for a human (lib/mcp/approvals.ts) is an
 * agent_approval_requests row, a platform row in the home region. It records
 * the agent's request in its own words, a description of the call's target,
 * which can name an end user's email, a file's path or a value the call was
 * given, and the call's exact arguments, which approval runs verbatim. For a
 * project kept in another region all three stay there: in the region's
 * public.regional_bodies (lib/data-plane/regional-bodies.ts, kind
 * approval_request), under the request's id. The row keeps what the platform
 * needs to list, poll, expire and decide the request: the tool, a message that
 * names only the tool, the tool and a keyed stand-in for the target, the
 * arguments' shape (lib/data-plane/residency.ts) and `keptInRegion`.
 *
 * A home project's rows keep all three, as they always have, and are read as
 * stored even when the arguments an agent sent carry a `keptInRegion` of their
 * own: only a regional project's row is read from its region.
 *
 * Every writer and reader of a request's words and call goes through here. The
 * surfaces that show a request read them from the region and, when the region
 * cannot be read, show the row as the platform has it, marked unreadable, and
 * such a card cannot be approved. An approval carries the digest of the request
 * as its card showed it (shownDigest) and runs only a call that still matches
 * it. It never falls back to the row, so a region it cannot read, or one
 * without the call, runs nothing.
 *
 * The region keeps them exactly as long as the request's row. The daily cleanup
 * that deletes approval requests past their retention deletes their records
 * first (lib/queue/worker.ts), and keeps a row whose region it cannot reach
 * until it can. Deleting the project deletes every record its region keeps
 * (lib/projects/delete.ts). A record whose row could not be written is removed
 * straight away, while its region can be reached (lib/mcp/approvals.ts
 * createApprovalRequest).
 */

import { createHmac, timingSafeEqual } from 'crypto'
import { regionalBodiesFor, type RegionalBodies } from '@/lib/data-plane/regional-bodies'
import { argumentShape } from '@/lib/data-plane/residency'

/** What a request records: what the approver reads, and the call approval runs. */
export interface ApprovalRequestBody {
  message: string
  target: string
  toolArgs: Record<string, unknown>
}

/** A request as its approver is shown it and as an approval runs it: from its row, or from its region. */
export interface ShownRequest {
  message: string
  target: string
  toolArgs: unknown
}

/**
 * Whether a row carries the mark this module writes in place of a regional
 * project's call: the call's shape and `keptInRegion`, which must never be run.
 * The mark alone does not make a row regional (withApprovalRequests,
 * requestAsKept): a home project's agent can send the same field.
 */
export function callKeptInRegion(toolArgs: unknown): boolean {
  return (
    !!toolArgs &&
    typeof toolArgs === 'object' &&
    !Array.isArray(toolArgs) &&
    (toolArgs as Record<string, unknown>).keptInRegion === true
  )
}

function keyFor(what: string): string {
  const key = process.env.ENV_VAR_ENCRYPTION_KEY || process.env.JWT_SECRET
  if (!key) throw new Error(`No key for ${what}: set ENV_VAR_ENCRYPTION_KEY or JWT_SECRET.`)
  return key
}

/** The stand-in a regional project's row keeps for a request's target. */
export function approvalTargetStandIn(projectId: string, target: string): string {
  const digest = createHmac('sha256', keyFor('approval request stand-ins'))
    .update(`backenly:approval-request-target:v1:${projectId}:${target}`)
    .digest('base64url')
  return `t_${digest.slice(0, 32)}`
}

/** JSON with every object's keys in order, so a request digests the same however its record was stored. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item === undefined ? null : item)).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const fields = value as Record<string, unknown>
    const keys = Object.keys(fields).filter((key) => fields[key] !== undefined).sort()
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(fields[key])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/**
 * The digest of a request as its approver is shown it: its tool, its words, its
 * target and its exact call, bound to its id. The Review Queue sends it back
 * with an approval, which runs only a request that still digests to it, so what
 * runs is what was on screen. Keyed, so the digest a member is given says
 * nothing about a value the call carries.
 */
export function shownDigest(requestId: string, tool: string, request: ShownRequest): string {
  return createHmac('sha256', keyFor('approval request digests'))
    .update(`backenly:approval-request-shown:v1:${requestId}:`)
    .update(canonicalJson({ tool, message: request.message, target: request.target, toolArgs: request.toolArgs }))
    .digest('hex')
}

/** Whether `given` is the digest of the request as it is kept now. */
export function matchesShown(given: string | undefined, requestId: string, tool: string, request: ShownRequest): boolean {
  if (typeof given !== 'string') return false
  const expected = Buffer.from(shownDigest(requestId, tool, request))
  const actual = Buffer.from(given)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

/** What a regional project's row says in place of the agent's request: the tool, and nothing the agent wrote. */
function messageKeptInRegion(tool: string): string {
  return `An agent asked to run ${tool}. Its request and exact call are kept in the project’s region.`
}

/**
 * A request that could not be kept in its project's region. No row was
 * written, so nothing is waiting for approval and nothing ran.
 */
export class ApprovalRequestNotKept extends Error {
  constructor() {
    super('This request could not be kept in the project’s region, so it was not queued for approval and nothing was run. Try again.')
    this.name = 'ApprovalRequestNotKept'
  }
}

function why(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * What a request's row stores, after keeping the request in the project's
 * region when the project is kept there. Called BEFORE the row is written,
 * with the id the row then takes, so a row never exists without its record.
 * Throws ApprovalRequestNotKept when the region cannot be read or written, and
 * the caller then writes no row.
 */
export async function keepApprovalRequest(
  projectId: string,
  requestId: string,
  tool: string,
  request: ApprovalRequestBody,
): Promise<ApprovalRequestBody> {
  let bodies: RegionalBodies
  try {
    bodies = await regionalBodiesFor(projectId)
  } catch (err) {
    console.warn(`[approvals] the region of ${projectId} could not be read to keep a request: ${why(err)}`)
    throw new ApprovalRequestNotKept()
  }
  // A home project after all: an earlier lookup of its region failed and this
  // one did not. Its row keeps the request, as every home project's does.
  if (!bodies.region) return request

  const stored: ApprovalRequestBody = {
    message: messageKeptInRegion(tool),
    target: `${tool} target ${approvalTargetStandIn(projectId, request.target)}`,
    toolArgs: { keptInRegion: true, shape: argumentShape(request.toolArgs) },
  }
  try {
    await bodies.set('approval_request', requestId, { payload: request })
  } catch (err) {
    console.warn(`[approvals] a request of ${projectId} could not be kept in its region: ${why(err)}`)
    throw new ApprovalRequestNotKept()
  }
  return stored
}

/**
 * Delete what the regions keep for requests whose rows are being deleted, and
 * return the ids of those it could not, because their project's region could
 * not be reached: those rows must stay until it can be, or their records would
 * outlive every row that names them. A home project's rows keep their requests
 * themselves, so for them there is nothing to delete.
 */
export async function forgetApprovalRequests(rows: Array<{ id: string; projectId: string }>): Promise<string[]> {
  const byProject = new Map<string, string[]>()
  for (const row of rows) byProject.set(row.projectId, [...(byProject.get(row.projectId) ?? []), row.id])
  const unreached: string[] = []
  for (const [projectId, ids] of byProject) {
    try {
      await (await regionalBodiesFor(projectId)).remove('approval_request', ids)
    } catch (err) {
      console.warn(`[approvals] ${ids.length} request record(s) of ${projectId} could not be deleted in its region: ${why(err)}`)
      unreached.push(...ids)
    }
  }
  return unreached
}

/** A request's record as the region keeps it, or null when what is there is not one. */
function bodyOf(payload: unknown): ApprovalRequestBody | null {
  if (!payload || typeof payload !== 'object') return null
  const { message, target, toolArgs } = payload as Partial<ApprovalRequestBody>
  if (typeof message !== 'string' || typeof target !== 'string') return null
  if (!toolArgs || typeof toolArgs !== 'object' || Array.isArray(toolArgs)) return null
  return { message, target, toolArgs }
}

/** A regional row with what its region keeps: the row a home project's would be. */
function withBody<T extends object>(row: T, body: ApprovalRequestBody): T {
  return {
    ...row,
    ...('message' in row ? { message: body.message } : {}),
    ...('target' in row ? { target: body.target } : {}),
    ...('toolArgs' in row ? { toolArgs: body.toolArgs } : {}),
  }
}

/**
 * Requests as the surfaces that show them read them: a regional project's
 * words, targets and calls read back from its region, and each row with whether
 * it could be. A row its region could not answer for, because the region could
 * not be read or no longer has its record, is left as the platform has it (the
 * tool, a message naming it, the target's stand-in and the call's shape) with
 * `readable: false`, and a card made from it cannot be approved. Never throws.
 */
export async function withApprovalRequests<T extends { id: string; toolArgs: unknown }>(
  projectId: string,
  rows: T[],
): Promise<Array<T & { readable: boolean }>> {
  const asStored = (row: T) => ({ ...row, readable: true })
  const marked = rows.filter((row) => callKeptInRegion(row.toolArgs))
  if (marked.length === 0) return rows.map(asStored)
  let found = new Map<string, { payload: unknown }>()
  try {
    const bodies = await regionalBodiesFor(projectId)
    // A home project's rows are its requests, whatever its agents' arguments say.
    if (!bodies.region) return rows.map(asStored)
    found = await bodies.getMany('approval_request', marked.map((row) => row.id))
  } catch (err) {
    console.warn(`[approvals] the requests of ${projectId} could not be read in its region: ${why(err)}`)
  }
  return rows.map((row) => {
    if (!callKeptInRegion(row.toolArgs)) return asStored(row)
    const body = bodyOf(found.get(row.id)?.payload)
    return body ? { ...withBody(row, body), readable: true } : { ...row, readable: false }
  })
}

/** Why a call kept in a project's region cannot be run. */
export type CallUnreadable = 'unreachable' | 'missing'

/**
 * A request as an approval would run it: its row, or for a regional project's
 * row, the record its region keeps, with `keptInRegion`; or why that record
 * cannot be read: the region could not be reached, or it has no record of the
 * request that names a call. There is no fallback to the row, whose shape of
 * the call is not the call.
 */
export async function requestAsKept(
  projectId: string,
  row: { id: string; message: string; target: string; toolArgs: unknown },
): Promise<{ request: ShownRequest; keptInRegion: boolean } | { unreadable: CallUnreadable }> {
  const asStored = { request: { message: row.message, target: row.target, toolArgs: row.toolArgs }, keptInRegion: false }
  if (!callKeptInRegion(row.toolArgs)) return asStored
  let payload: unknown = null
  try {
    const bodies = await regionalBodiesFor(projectId)
    // A home project's row is its request, whatever its agent's arguments say.
    if (!bodies.region) return asStored
    payload = (await bodies.get('approval_request', row.id))?.payload
  } catch (err) {
    console.warn(`[approvals] request ${row.id} of ${projectId} could not be read in its region: ${why(err)}`)
    return { unreadable: 'unreachable' }
  }
  const body = bodyOf(payload)
  return body ? { request: body, keptInRegion: true } : { unreadable: 'missing' }
}
