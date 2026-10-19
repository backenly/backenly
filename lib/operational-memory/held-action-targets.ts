/**
 * A HELD ACTION'S TARGET AND ARGUMENTS, KEPT WHERE ITS PROJECT IS
 * ===============================================================
 * An action the executor's risk gate holds for the owner's approval is an
 * ai_action_pending health finding (queuePendingActionFinding), a platform row
 * in the home region. Its target can be an end user's email (BLOCK_USER) or a
 * file's path (DELETE_FILE), and its arguments are the caller's own values, a
 * secret among them (SET_ENV_VAR). For a project kept in another region they
 * stay there (founders: held-action targets move into the region): in the
 * region's public.regional_bodies (lib/data-plane/regional-bodies.ts, kind
 * held_action), under the finding's id, for as long as the finding is kept.
 * The row keeps what the platform needs to list, dedupe and approve: the action,
 * which is also its title, the shape of its arguments (lib/data-plane/
 * residency.ts), a keyed stand-in for its target, by which an identical held
 * action is still found again, and `keptInRegion`.
 *
 * A home project's rows keep the target, a display copy of the arguments and
 * their sealed copy (lib/operational-memory/sealed-params.ts), as they always
 * have. The region keeps the same for a regional one.
 *
 * Every writer and reader of a held action's target goes through here. The
 * surfaces that show it to the approver read it from the region and, when the
 * region cannot be read, show the row as the platform has it. Approval does
 * not fall back: it replays exactly the arguments the action was held with, so
 * a region it cannot read, or one without them, runs nothing.
 */

import { createHmac } from 'crypto'
import { HOME_REGION } from '@/lib/regions'
import { projectRegion } from '@/lib/data-plane/regional'
import { regionalBodiesFor } from '@/lib/data-plane/regional-bodies'
import { argumentShape } from '@/lib/data-plane/residency'
import { redactSecretParams } from '@/lib/mcp/withhold-secrets'
import { sealParams } from '@/lib/operational-memory/sealed-params'

/** What the region keeps for a held action, and what a home project's row keeps of it. */
interface HeldActionBody {
  title: string
  location?: string
  executorParams: Record<string, unknown>
  executorParamsSealed: string
}

/** An action held for approval, as its caller asked for it. */
export interface HeldAction {
  /** The action alone ("Block user"), the title a regional project's row keeps. */
  actionTitle: string
  /** The action and its target ("Block user on alice@example.com"). */
  title: string
  target?: string
  params: Record<string, unknown>
}

async function isRegional(projectId: string): Promise<boolean> {
  return (await projectRegion(projectId)) !== HOME_REGION
}

/** The stand-in a regional project's row keeps for a held action's target. */
export function heldTargetStandIn(projectId: string, target: string): string {
  const key = process.env.ENV_VAR_ENCRYPTION_KEY || process.env.JWT_SECRET
  if (!key) throw new Error('No key for held-action stand-ins: set ENV_VAR_ENCRYPTION_KEY or JWT_SECRET.')
  const digest = createHmac('sha256', key).update(`backenly:held-action-target:v1:${projectId}:${target}`).digest('base64url')
  return `t_${digest.slice(0, 32)}`
}

/**
 * What a row stores as a held action's target: the target at home, its
 * stand-in elsewhere. An identical held action is found again by it. Throws
 * when the project's region cannot be read.
 */
export async function storedHeldTarget(projectId: string, target: string | undefined): Promise<string | undefined> {
  if (!target) return target
  return (await isRegional(projectId)) ? heldTargetStandIn(projectId, target) : target
}

/**
 * The row's details for a held action, after keeping its target and arguments
 * in the project's region when the project is kept there. Called BEFORE the row
 * is written, with the id the row then takes, so a row never exists without
 * them.
 */
export async function keepHeldAction(projectId: string, findingId: string, held: HeldAction): Promise<Record<string, unknown>> {
  const params = held.params ?? {}
  const body: HeldActionBody = {
    title: held.title,
    location: held.target,
    // Display copy only: secret-named values are redacted because this is
    // served (health endpoint, trust report, Review Queue card,
    // get_autonomy_status, read-only MCP keys included). Approval replays from
    // the sealed copy, so nothing the agent sent is lost.
    executorParams: redactSecretParams(params),
    executorParamsSealed: sealParams(params),
  }
  if (!(await isRegional(projectId))) return { ...body }
  await (await regionalBodiesFor(projectId)).set('held_action', findingId, { payload: body })
  return {
    title: held.actionTitle,
    ...(held.target ? { location: heldTargetStandIn(projectId, held.target) } : {}),
    executorParamsShape: argumentShape(params),
    keptInRegion: true,
  }
}

function keptElsewhere(details: unknown): boolean {
  return (details as Record<string, unknown> | null | undefined)?.keptInRegion === true
}

/** A regional row's details with what its region keeps: the row a home project's would be. */
function withBody(details: Record<string, unknown>, payload: unknown): Record<string, unknown> | null {
  const body = payload as Partial<HeldActionBody> | null | undefined
  if (!body || typeof body.title !== 'string') return null
  const { keptInRegion: _kept, executorParamsShape: _shape, ...row } = details
  return {
    ...row,
    title: body.title,
    location: body.location,
    executorParams: body.executorParams,
    executorParamsSealed: body.executorParamsSealed,
  }
}

/**
 * Rows with their held actions' targets and arguments, read from the region
 * for a regional project, for the surfaces that show them to the approver. A
 * region that cannot be read leaves the rows as the platform has them: the
 * action, its arguments' shape and the target's stand-in.
 */
export async function withHeldActions<T extends { id: string; details: unknown }>(projectId: string, rows: T[]): Promise<T[]> {
  const held = rows.filter((row) => keptElsewhere(row.details))
  if (held.length === 0) return rows
  try {
    const bodies = await regionalBodiesFor(projectId)
    const kept = bodies.region ? await bodies.getMany('held_action', held.map((row) => row.id)) : new Map()
    return rows.map((row) => {
      const details = keptElsewhere(row.details) ? withBody(row.details as Record<string, unknown>, kept.get(row.id)?.payload) : null
      return details ? { ...row, details } : row
    })
  } catch (err) {
    console.warn(`[held-actions] the held actions of ${projectId} could not be read in its region: ${err instanceof Error ? err.message : String(err)}`)
    return rows
  }
}

/** A held action whose approval cannot read what the action was held with. */
export class HeldActionUnreadable extends Error {
  constructor(readonly regionUnreachable: boolean) {
    super(
      regionUnreachable
        ? 'This change’s target and arguments are kept in the project’s region, which could not be reached, so nothing was run. Approve it again once the region is reachable.'
        : 'This change’s target and arguments were not found in the project’s region, so it cannot be replayed and nothing was run. Dismiss it and ask your agent to make the change again.',
    )
    this.name = 'HeldActionUnreadable'
  }
}

/**
 * A held action's details with the target and arguments it was held with, for
 * the approval that replays them. Throws HeldActionUnreadable when they are kept
 * in a region that cannot be read or does not have them: an approval never runs
 * the action without them.
 */
export async function heldActionForReplay(
  projectId: string,
  findingId: string,
  details: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (!keptElsewhere(details)) return details
  let payload: unknown = null
  try {
    const bodies = await regionalBodiesFor(projectId)
    if (bodies.region) payload = (await bodies.get('held_action', findingId))?.payload
  } catch (err) {
    console.warn(`[held-actions] held action ${findingId} of ${projectId} could not be read in its region: ${err instanceof Error ? err.message : String(err)}`)
    throw new HeldActionUnreadable(true)
  }
  const replay = withBody(details, payload)
  if (!replay) throw new HeldActionUnreadable(false)
  return replay
}

/**
 * A held action's details as a record copied from its finding may keep them
 * for a project kept in another region (fix history): the action and its
 * arguments' shape, never its target, its arguments or their sealed copy,
 * whichever row it is copied from.
 */
export function heldActionRecord(details: Record<string, unknown>): Record<string, unknown> {
  const { title: _title, location: _location, executorParams, executorParamsSealed: _sealed, ...kept } = details
  return {
    ...kept,
    executorParamsShape: kept.executorParamsShape ?? argumentShape(executorParams as Record<string, unknown> | undefined),
  }
}
