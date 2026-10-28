/**
 * WHAT A FUNCTION RUN LEAVES BEHIND, AND WHERE
 * ============================================
 * A run records what the function logged and the error it raised, and a
 * function's row keeps its last error: customer data, all of it (a function
 * logs the rows it handles, and an error quotes them). For a project in the
 * home region it stays on the platform rows (ai_function_logs,
 * ai_functions.lastError), as it always has. For a project in another region
 * it is kept in that region (lib/data-plane/regional-bodies.ts): the platform
 * rows keep whether a run succeeded, how long it took and what triggered it,
 * and a function's last error reads ERROR_KEPT_IN_REGION.
 *
 * Readers show the region's text to whoever asks (withRunBodies,
 * withLastErrors); it is not copied back to the platform rows.
 */

import crypto from 'crypto'
import { prisma } from '@/lib/db/prisma'
import { regionalBodiesFor } from '@/lib/data-plane/regional-bodies'

/** A regional function's last error on the platform row: the text is in the region. */
export const ERROR_KEPT_IN_REGION = 'The error is kept in the project’s region.'

export interface FunctionRun {
  functionId: string
  projectId: string
  success: boolean
  logs: string[]
  error: string | null | undefined
  durationMs: number
  triggerType: string
}

/**
 * Record one run where the project's data is kept. Never throws: recording a
 * run must not fail the run.
 */
export async function recordFunctionRun(run: FunctionRun): Promise<void> {
  try {
    const bodies = await regionalBodiesFor(run.projectId)
    const id = crypto.randomUUID()
    const error = run.error ?? null
    if (bodies.region) await bodies.set('function_run', id, { payload: run.logs, error })
    await prisma.aiFunctionLog.create({
      data: {
        id,
        functionId: run.functionId,
        projectId: run.projectId,
        success: run.success,
        logs: bodies.region ? [] : run.logs,
        error: bodies.region ? null : error,
        durationMs: run.durationMs,
        triggerType: run.triggerType,
      },
    })
  } catch {
    // Non-fatal — log persistence must never block execution
  }
}

/**
 * What a function's row records as its last error. For a regional project the
 * text goes to the region and the row says the platform's own prefix, if any,
 * then ERROR_KEPT_IN_REGION: the prefix (AUTO-FIX-FAILED, SMOKE_TEST_FAILED)
 * is what the self-heal guards read, and it carries none of the customer's
 * data. A cleared error is cleared in both places.
 */
export async function rowLastError(
  projectId: string,
  functionId: string,
  error: string | null,
  platformPrefix = '',
): Promise<string | null> {
  const bodies = await regionalBodiesFor(projectId)
  if (!bodies.region) return error
  try {
    if (error === null) await bodies.remove('function_error', [functionId])
    else await bodies.set('function_error', functionId, { error })
  } catch (err: any) {
    // The text is lost rather than kept somewhere it does not belong.
    console.warn(`[Functions] the last error of ${functionId} could not be kept in ${bodies.region}: ${err?.message}`)
  }
  return error === null ? null : platformPrefix + ERROR_KEPT_IN_REGION
}

/** Whether a project's run text is kept in its region rather than on the platform rows. */
export async function runTextKeptInRegion(projectId: string): Promise<boolean> {
  return (await regionalBodiesFor(projectId)).region !== null
}

/**
 * A project's runs with their logs and errors, read from its region when kept
 * there. A region that cannot be read leaves the runs as the platform rows
 * have them: whether each succeeded, when and how fast.
 */
export async function withRunBodies<T extends { id: string; logs: string[]; error: string | null }>(
  projectId: string,
  runs: T[],
): Promise<T[]> {
  const bodies = await regionalBodiesFor(projectId)
  if (!bodies.region || runs.length === 0) return runs
  try {
    const held = await bodies.getMany('function_run', runs.map((run) => run.id))
    return runs.map((run) => {
      const body = held.get(run.id)
      return body ? { ...run, logs: Array.isArray(body.payload) ? (body.payload as string[]) : run.logs, error: body.error } : run
    })
  } catch (err: any) {
    console.warn(`[Functions] run logs of ${projectId} could not be read in ${bodies.region}: ${err?.message}`)
    return runs
  }
}

/**
 * A project's functions with their last errors, read from its region when kept
 * there. A region that cannot be read leaves ERROR_KEPT_IN_REGION, which says
 * where the text is.
 */
export async function withLastErrors<T extends { id: string; lastError: string | null }>(
  projectId: string,
  functions: T[],
): Promise<T[]> {
  const keptHere = (fn: T) => fn.lastError?.endsWith(ERROR_KEPT_IN_REGION) ?? false
  const kept = functions.filter(keptHere)
  if (kept.length === 0) return functions
  const bodies = await regionalBodiesFor(projectId)
  if (!bodies.region) return functions
  try {
    const held = await bodies.getMany('function_error', kept.map((fn) => fn.id))
    return functions.map((fn) => {
      const error = held.get(fn.id)?.error
      return keptHere(fn) && error ? { ...fn, lastError: error } : fn
    })
  } catch (err: any) {
    console.warn(`[Functions] last errors of ${projectId} could not be read in ${bodies.region}: ${err?.message}`)
    return functions
  }
}

/** Delete runs and their regional bodies together. */
export async function deleteFunctionRuns(projectId: string, functionId?: string): Promise<number> {
  const where = { projectId, ...(functionId ? { functionId } : {}) }
  const bodies = await regionalBodiesFor(projectId)
  if (bodies.region) {
    const ids = (await prisma.aiFunctionLog.findMany({ where, select: { id: true } })).map((row) => row.id)
    await bodies.remove('function_run', ids)
  }
  const { count } = await prisma.aiFunctionLog.deleteMany({ where })
  return count
}
