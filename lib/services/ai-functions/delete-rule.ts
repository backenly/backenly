/**
 * When deleting a function waits for a person.
 *
 * Every delete used to wait for an approval, even of a switched-off debug
 * function, so agents left their own clutter behind (production QA,
 * 2026-11-09). A delete is a governed change that keeps the function's code
 * (lib/changes/resources/functions.ts), and restoring that change brings the
 * function back. So a function nothing calls is deleted at once: one that is
 * switched off, or that has not run in the last IDLE_DAYS days. One that ran in
 * that time still waits for a person, because deleting it breaks whatever
 * calls it.
 *
 * Both doors ask this, the MCP tool route and the brain's gate, so they can
 * never disagree about a delete.
 */

import { prisma } from '@/lib/db/prisma'
import { resolveFunctionByName } from './names'

/** How long a function must have gone without running before an agent may delete it unasked. */
export const IDLE_DAYS = 7

/**
 * Whether deleting the function a call names waits for a person. A call that
 * names no function, or one that does not exist or is ambiguous, does not: it
 * deletes nothing, and the delete answers why.
 */
export async function deleteWaitsForPerson(
  projectId: string,
  args: { functionId?: unknown; name?: unknown },
  now: Date = new Date(),
): Promise<boolean> {
  let fn: { status: string; lastRun: Date | null } | null = null
  if (typeof args.functionId === 'string' && args.functionId) {
    fn = await prisma.aiFunction.findFirst({ where: { id: args.functionId, projectId }, select: { status: true, lastRun: true } })
  } else if (typeof args.name === 'string' && args.name.trim()) {
    const found = await resolveFunctionByName(projectId, args.name)
    fn = found && 'fn' in found ? found.fn : null
  }
  if (!fn || fn.status !== 'active' || !fn.lastRun) return false
  return now.getTime() - fn.lastRun.getTime() < IDLE_DAYS * 24 * 60 * 60 * 1000
}
