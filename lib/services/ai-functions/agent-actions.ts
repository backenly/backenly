/**
 * The Functions page's inspect, run and logs, as operations an agent can run.
 *
 * An agent could create, list, toggle and delete functions, but could not read
 * one, run it, or see why it failed, so testing what it had just built meant
 * sending the human to the dashboard. These use the same executor and log
 * table the dashboard does, with two differences an agent needs:
 *
 *   • Running a function that is switched off is refused, not silently
 *     switched on first as the dashboard's Run button does.
 *   • A failed run is NOT handed to the model-backed auto-fixer. The agent gets
 *     the error; its code does not change underneath it.
 */

import { prisma } from '@/lib/db/prisma'
import { canAccessProject, canWriteProject } from '@/lib/edition/guard'
import { executeAiFunction } from './executor'

export interface FunctionActor {
  userId?: string
  projectId: string
}

export interface FunctionActionResult {
  ok: boolean
  summary: string
  data?: unknown
  code?: string
}

const MAX_LOGS = 100
/** Larger bodies are clipped in the result; the function itself is unaffected. */
const MAX_RETURN_CHARS = 20_000

async function refused(actor: FunctionActor, write: boolean): Promise<FunctionActionResult | null> {
  const allowed = actor.userId
    ? await (write ? canWriteProject : canAccessProject)(actor.userId, actor.projectId)
    : false
  return allowed ? null : { ok: false, code: 'PROJECT_NOT_FOUND', summary: 'Project not found, or this key may not do that here.' }
}

/** A function by id, or by name as requested or as deployed (lowercase kebab-case). */
async function findFunction(projectId: string, args: { functionId?: unknown; name?: unknown }) {
  if (typeof args.functionId === 'string' && args.functionId) {
    return prisma.aiFunction.findFirst({ where: { id: args.functionId, projectId } })
  }
  if (typeof args.name === 'string' && args.name.trim()) {
    const raw = args.name.trim()
    const slug = raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    return prisma.aiFunction.findFirst({ where: { projectId, name: { in: [...new Set([raw, slug])] } } })
  }
  return undefined
}

const needsTarget: FunctionActionResult = {
  ok: false,
  code: 'INVALID_ARGUMENT',
  summary: 'Pass functionId or name. List them with functions { action: "list" }.',
}

const notFound = (args: { functionId?: unknown; name?: unknown }): FunctionActionResult => ({
  ok: false,
  code: 'NOT_FOUND',
  summary: `No function ${String(args.functionId ?? args.name)} in this project. List them with functions { action: "list" }.`,
})

/** "GET /api/v1/<id>/fn/<name>" → method and path, for HTTP functions. */
function httpEndpoint(triggerTable: string | null): { method: string; path: string } | null {
  const m = triggerTable?.match(/^(GET|POST|PUT|PATCH|DELETE)\s+(\S+)$/i)
  return m ? { method: m[1].toUpperCase(), path: m[2] } : null
}

export async function getFunction(
  actor: FunctionActor,
  args: { functionId?: unknown; name?: unknown },
): Promise<FunctionActionResult> {
  const denied = await refused(actor, false)
  if (denied) return denied
  const fn = await findFunction(actor.projectId, args)
  if (fn === undefined) return needsTarget
  if (!fn) return notFound(args)

  const endpoint = httpEndpoint(fn.triggerTable)
  return {
    ok: true,
    summary:
      `Function ${fn.name} (${fn.id}): ${fn.status}, trigger ${fn.triggerType}` +
      (endpoint ? ` ${endpoint.method} ${endpoint.path}` : fn.triggerTable ? ` (${fn.triggerTable})` : '') +
      `, ${fn.runCount} runs${fn.lastRun ? `, last ${fn.lastRun.toISOString()}` : ''}.` +
      (fn.lastError ? `\nLast error: ${fn.lastError.slice(0, 300)}` : '') +
      '\nThe code is in data.code.',
    data: {
      id: fn.id,
      name: fn.name,
      description: fn.description,
      status: fn.status,
      triggerType: fn.triggerType,
      triggerTable: fn.triggerTable,
      endpoint,
      runCount: fn.runCount,
      lastRun: fn.lastRun,
      lastError: fn.lastError,
      code: fn.generatedCode,
      updatedAt: fn.updatedAt,
    },
  }
}

export async function invokeFunction(
  actor: FunctionActor,
  args: { functionId?: unknown; name?: unknown; event?: unknown },
): Promise<FunctionActionResult> {
  if (args.event !== undefined && (args.event === null || typeof args.event !== 'object' || Array.isArray(args.event))) {
    return { ok: false, code: 'INVALID_ARGUMENT', summary: 'event must be an object: the JSON body (and query) the function receives.' }
  }
  const denied = await refused(actor, true)
  if (denied) return denied
  const fn = await findFunction(actor.projectId, args)
  if (fn === undefined) return needsTarget
  if (!fn) return notFound(args)
  if (fn.status === 'inactive' || fn.status === 'disabled') {
    return {
      ok: false,
      code: 'FUNCTION_INACTIVE',
      summary: `Function ${fn.name} is switched off, so it was not run. Turn it on with functions { action: "set_active", functionId: "${fn.id}", active: true } first.`,
    }
  }

  // The dashboard's Run: an owner-initiated test run, with the project's admin
  // identity so auth-gated handlers exercise their real logic.
  const result = await executeAiFunction(fn.id, actor.projectId, { type: 'manual', data: (args.event as Record<string, unknown>) ?? {} }, {
    testRun: true,
    serviceRole: true,
    selfHeal: false,
  })

  const returned = result.returnValue
  const body = returned && typeof returned === 'object' && 'body' in returned ? returned.body : returned
  const text = body === undefined ? '' : JSON.stringify(body)
  const clipped = text.length > MAX_RETURN_CHARS
  const httpStatus = result.httpStatus

  if (!result.success) {
    return {
      ok: false,
      code: result.errorCode ?? 'FUNCTION_FAILED',
      summary:
        `Function ${fn.name} failed after ${result.durationMs}ms: ${result.error ?? 'no error message'}. ` +
        'Its code was not changed. Recent runs are in functions { action: "logs" }.',
      data: { functionId: fn.id, success: false, error: result.error ?? null, logs: result.logs, durationMs: result.durationMs },
    }
  }
  return {
    ok: true,
    summary:
      `Ran ${fn.name} in ${result.durationMs}ms` +
      (httpStatus !== undefined ? `; the handler answered HTTP ${httpStatus}` : '') +
      `. Its return value is in data.result${clipped ? ' (clipped)' : ''}; ${result.logs.length} log line(s) in data.logs. ` +
      'This counts as one invocation against the plan.',
    data: {
      functionId: fn.id,
      success: true,
      httpStatus: httpStatus ?? null,
      result: clipped ? `${text.slice(0, MAX_RETURN_CHARS)}…` : body ?? null,
      clipped,
      logs: result.logs,
      durationMs: result.durationMs,
    },
  }
}

export async function listFunctionLogs(
  actor: FunctionActor,
  args: { functionId?: unknown; name?: unknown; limit?: unknown },
): Promise<FunctionActionResult> {
  const denied = await refused(actor, false)
  if (denied) return denied

  let functionId: string | undefined
  if (args.functionId !== undefined || args.name !== undefined) {
    const fn = await findFunction(actor.projectId, args)
    if (!fn) return notFound(args)
    functionId = fn.id
  }
  const take = typeof args.limit === 'number' && Number.isFinite(args.limit)
    ? Math.min(Math.max(Math.trunc(args.limit), 1), MAX_LOGS)
    : 25

  const logs = await prisma.aiFunctionLog.findMany({
    where: { projectId: actor.projectId, ...(functionId ? { functionId } : {}) },
    orderBy: { createdAt: 'desc' },
    take,
    include: { function: { select: { name: true } } },
  })
  const lines = logs.slice(0, 10).map((l) =>
    `• ${l.createdAt.toISOString()} ${l.function.name}: ${l.success ? 'ok' : 'FAILED'}, ${l.durationMs}ms, ${l.triggerType}` +
    (l.error ? `, ${l.error.slice(0, 100)}` : ''))
  return {
    ok: true,
    summary: logs.length
      ? `Function runs, newest first (kept 30 days):\n${lines.join('\n')}` + (logs.length > 10 ? `\n…${logs.length - 10} more in data.runs.` : '')
      : 'No function runs recorded yet. Run one with functions { action: "invoke" }.',
    data: {
      runs: logs.map((l) => ({
        id: l.id,
        functionId: l.functionId,
        function: l.function.name,
        success: l.success,
        error: l.error,
        logs: l.logs,
        durationMs: l.durationMs,
        triggerType: l.triggerType,
        createdAt: l.createdAt,
      })),
    },
  }
}
