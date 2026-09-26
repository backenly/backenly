/**
 * The Functions page's inspect, run and logs, as operations an agent can run,
 * and deploying code the agent wrote itself (deployFunctionCode, below).
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

import { createHash } from 'crypto'
import { prisma } from '@/lib/db/prisma'
import { canAccessProject, canWriteProject } from '@/lib/edition/guard'
import { workspaceSchemaName } from '@/lib/security/workspace-schema'
import { executeAiFunction, validateSandboxFunction } from './executor'
import { isRouteModuleFunction, validateRouteModule } from './route-module-runner'

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

// ─── Deploy code the agent wrote ─────────────────────────────────────────────
//
// `functions { action: "create" }` hands a spec to Backenly's own model, which
// writes the code. An agent that has already written the code needs it stored
// exactly as written, with no model reading or rewriting it. This does that,
// through the same two runtime contracts the generator produces and the same
// gates the runtime would apply:
//
//   trigger "http"   a route module (`export async function POST(req)` …),
//                    checked by validateRouteModule, served at
//                    /api/v1/{projectId}/fn/{name}. Its SQL runs as the
//                    project's own database login (function-db-role.ts).
//   any other        a sandbox body using ctx.db / ctx.http / ctx.log /
//                    ctx.integrations / ctx.env, checked by the sandbox worker
//                    that will run it. ctx.db only reaches this project's
//                    workspace tables; keys stay server side.
//
// A function is replaced in place by name, as the generator does: there is no
// version history to roll back to, and the receipt says so.

/** Source larger than this is refused; generated functions are a few KB. */
export const MAX_FUNCTION_CODE_BYTES = 64 * 1024

const DEPLOY_TRIGGERS: Record<string, string> = {
  http: 'manual',
  manual: 'manual',
  on_signup: 'on_signup',
  on_insert: 'on_db_insert',
  on_update: 'on_db_update',
  on_delete: 'on_db_delete',
}
const TABLE_TRIGGERS = new Set(['on_insert', 'on_update', 'on_delete'])
const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']

/**
 * Credentials written into the source. Stored code is returned by
 * functions { action: "get" } and shown on the dashboard, so a key in it is a
 * key anyone with read access can copy. Only formats that are secret by
 * definition are listed: a PostHog `phc_` project key, for one, is public.
 */
const LITERAL_CREDENTIALS: Array<[RegExp, string]> = [
  [/\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/, 'a Stripe secret key'],
  [/\bwhsec_[A-Za-z0-9]{16,}/, 'a Stripe webhook signing secret'],
  [/\bsk-ant-[A-Za-z0-9_-]{20,}/, 'an Anthropic API key'],
  [/\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/, 'an OpenAI API key'],
  [/\bre_[A-Za-z0-9]{8,}_[A-Za-z0-9]{12,}/, 'a Resend API key'],
  [/\bphx_[A-Za-z0-9]{20,}/, 'a PostHog personal API key'],
  [/\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/, 'a SendGrid API key'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'a private key'],
  [/\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s:'"`/@]+:[^\s@'"`]+@/i, 'a database URL with a password'],
  [/\bgh[pousr]_[A-Za-z0-9]{36}\b/, 'a GitHub token'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'an AWS access key id'],
  [/\b(?:mcp|bkn)_live_[A-Za-z0-9]{16,}/, 'a Backenly API key'],
]

function literalCredential(code: string): string | null {
  for (const [re, what] of LITERAL_CREDENTIALS) if (re.test(code)) return what
  return null
}

const invalid = (summary: string): FunctionActionResult => ({ ok: false, code: 'INVALID_ARGUMENT', summary })

export async function deployFunctionCode(
  actor: FunctionActor,
  args: {
    name?: unknown
    code?: unknown
    trigger?: unknown
    table?: unknown
    method?: unknown
    description?: unknown
    functionId?: unknown
    projectId?: unknown
  },
): Promise<FunctionActionResult> {
  // The project is the one the key is bound to. A different one named in the
  // arguments is refused rather than ignored, so the call cannot look as though
  // it went somewhere it did not.
  if (args.projectId !== undefined && args.projectId !== actor.projectId) {
    return {
      ok: false,
      code: 'PROJECT_MISMATCH',
      summary: 'This connection deploys to its own project only. Leave projectId out, or connect with a key for the other project.',
    }
  }

  const rawName = typeof args.name === 'string' ? args.name.trim() : ''
  const name = rawName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60)
  if (!name) return invalid('name is required: a short name such as "send-welcome-email". It becomes a URL path segment.')

  const trigger = typeof args.trigger === 'string' ? args.trigger.trim().toLowerCase() : ''
  if (!(trigger in DEPLOY_TRIGGERS)) {
    return invalid(`trigger is required, one of: ${Object.keys(DEPLOY_TRIGGERS).join(', ')}. "http" takes a route module; the others take a sandbox function body.`)
  }

  if (typeof args.code !== 'string' || !args.code.trim()) return invalid('code is required: the complete source to deploy.')
  const code = args.code
  const bytes = Buffer.byteLength(code, 'utf8')
  if (bytes > MAX_FUNCTION_CODE_BYTES) {
    return {
      ok: false,
      code: 'CODE_TOO_LARGE',
      summary: `The code is ${bytes} bytes; the limit is ${MAX_FUNCTION_CODE_BYTES}. Split it into smaller functions.`,
      data: { bytes, limit: MAX_FUNCTION_CODE_BYTES },
    }
  }

  const credential = literalCredential(code)
  if (credential) {
    return {
      ok: false,
      code: 'SECRET_IN_CODE',
      summary:
        `The code contains what looks like ${credential}, so it was not deployed: stored code is readable by anyone who can read this project. ` +
        'Store provider keys with integrations { action: "connect" } and read them as ctx.integrations.<provider>, and other values with ' +
        'connect { action: "set_env" } and read them as ctx.env.KEY. Both are available to sandbox (non-http) functions.',
    }
  }

  let table: string | null = null
  if (TABLE_TRIGGERS.has(trigger)) {
    table = typeof args.table === 'string' ? args.table.trim() : ''
    if (!/^[a-z_][a-z0-9_]{0,62}$/i.test(table)) {
      return invalid(`trigger "${trigger}" needs table: the table whose rows fire it.`)
    }
  }

  let method: string | null = null
  const isHttp = trigger === 'http'
  if (isHttp) {
    if (!isRouteModuleFunction(code)) {
      return {
        ok: false,
        code: 'INVALID_CODE',
        summary:
          'An http function is a route module: `import { NextResponse } from \'next/server\'` and `export async function POST(req) { … }` ' +
          '(or GET/PUT/PATCH/DELETE). For a sandbox body using ctx.db and ctx.integrations, use trigger "manual" or an event trigger.',
      }
    }
    const requested = typeof args.method === 'string' ? args.method.trim().toUpperCase() : ''
    if (requested && !HTTP_METHODS.includes(requested)) return invalid(`method must be one of ${HTTP_METHODS.join(', ')}.`)
    const check = validateRouteModule(code, requested || null)
    if (!check.valid) {
      return {
        ok: false,
        code: 'INVALID_CODE',
        summary: `The route module was not deployed: ${check.error}.`,
        data: { error: check.error, methods: check.methods },
      }
    }
    if (!requested && check.methods.length > 1) {
      return invalid(`The module exports ${check.methods.join(', ')}; pass method to say which one the endpoint serves.`)
    }
    method = requested || check.methods[0]
  } else {
    if (isRouteModuleFunction(code)) {
      return {
        ok: false,
        code: 'INVALID_CODE',
        summary:
          `A "${trigger}" function is a sandbox body, not a route module: plain statements that use ctx.db, ctx.http, ctx.log, ` +
          'ctx.integrations and ctx.env, receive `event`, and may return a value. Deploy a route module with trigger "http".',
      }
    }
    const check = await validateSandboxFunction(code)
    if (!check.valid) {
      return { ok: false, code: 'INVALID_CODE', summary: `The function was not deployed: ${check.error}`, data: { error: check.error } }
    }
  }

  const denied = await refused(actor, true)
  if (denied) return denied

  if (table) {
    const found = await prisma.$queryRaw<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM information_schema.tables
      WHERE table_schema = ${workspaceSchemaName(actor.projectId)} AND table_name = ${table}`
    if (!found[0]?.n) {
      return { ok: false, code: 'TABLE_NOT_FOUND', summary: `There is no table ${table} in this project, so a ${trigger} function on it would never run.` }
    }
  }

  let existing: Awaited<ReturnType<typeof findFunction>>
  if (args.functionId !== undefined) {
    existing = await findFunction(actor.projectId, { functionId: args.functionId })
    if (!existing) return notFound({ functionId: args.functionId })
    if (existing.name !== name) {
      return invalid(`Function ${args.functionId} is named ${existing.name}; pass that name. Renaming is not supported.`)
    }
  } else {
    existing = await findFunction(actor.projectId, { name })
  }

  const endpoint = method ? `/api/v1/${actor.projectId}/fn/${name}` : null
  const fields = {
    description: typeof args.description === 'string' && args.description.trim()
      ? args.description.trim().slice(0, 500)
      : existing?.description || 'Deployed from agent-written code.',
    generatedCode: code,
    triggerType: DEPLOY_TRIGGERS[trigger],
    triggerTable: method ? `${method} ${endpoint}` : table,
    lastError: null,
  }
  // A function someone switched off stays off: deploying new code is not a
  // decision to start running it.
  const keptOff = existing?.status === 'inactive' || existing?.status === 'disabled'
  const fn = existing
    ? await prisma.aiFunction.update({ where: { id: existing.id }, data: { ...fields, ...(keptOff ? {} : { status: 'active' }) } })
    : await prisma.aiFunction.create({ data: { projectId: actor.projectId, name, status: 'active', ...fields } })

  const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')
  const renamed = rawName !== name
  return {
    ok: true,
    summary:
      `${existing ? 'Replaced the code of' : 'Deployed'} ${name} (${fn.id}), trigger ${trigger}` +
      (endpoint ? `, ${method} ${endpoint}` : table ? ` on ${table}` : '') +
      (renamed ? `. Deployed as "${name}", not "${rawName}": names are lowercase kebab-case because they are URL path segments` : '') +
      (keptOff ? '. It stays switched off; turn it on with functions { action: "set_active", active: true }' : '') +
      (existing ? '. The previous code is not kept, so there is nothing to roll back to' : '') +
      `. Run it with functions { action: "invoke", functionId: "${fn.id}" } and read its runs with { action: "logs" }.`,
    data: {
      functionId: fn.id,
      name,
      ...(renamed ? { requestedName: rawName } : {}),
      created: !existing,
      trigger,
      triggerType: fn.triggerType,
      triggerTable: fn.triggerTable,
      endpoint: endpoint ? { method, path: endpoint } : null,
      status: fn.status,
      codeSha256: sha(code),
      codeBytes: bytes,
      previousCodeSha256: existing ? sha(existing.generatedCode) : null,
      deployedAt: fn.updatedAt,
    },
  }
}
