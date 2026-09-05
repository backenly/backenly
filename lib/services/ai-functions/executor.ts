/**
 * AI FUNCTION EXECUTOR
 * ====================
 * Runs AI-generated function code in a sandboxed Worker Thread.
 *
 * Security model (replaces the insecure vm.runInNewContext() approach):
 *  - Each execution spawns a disposable Node.js Worker Thread
 *  - Worker Thread = separate V8 isolate — no shared module cache with parent
 *  - process.env is NOT forwarded to the worker
 *  - Static code analysis blocks forbidden patterns BEFORE execution
 *  - All DB / HTTP calls are proxied from the worker back to this module
 *  - Memory hard-limited to 64 MB per execution (resourceLimits)
 *  - Parent-side 10-second hard timeout kills the worker thread
 *
 * Context API available to generated functions:
 *  ctx.db.query(table, where?)        → Promise<rows[]>
 *  ctx.db.insert(table, data)         → Promise<row>
 *  ctx.db.update(table, where, data)  → Promise<rows[]>
 *  ctx.db.delete(table, where)        → Promise<void>
 *  ctx.http.get(url, headers?)        → Promise<any>
 *  ctx.http.post(url, body, headers?) → Promise<any>
 *  ctx.log(...args)                   → void
 */

import { Worker } from 'worker_threads'
import * as path from 'path'
import { prisma } from '@/lib/db'
import { buildIntegrationContext, IntegrationContext } from './integration-context'
import { getProviderSpec } from './integration-registry'
import { generateFixedFunctionCode } from './generator'
import { isRouteModuleFunction, executeRouteModuleFunction, validateRouteModule } from './route-module-runner'
import { enforceAiFunctionInvocation, trackAiFunctionInvocation } from '@/lib/entitlements/policy'
import { executeWithUserContext } from '@/lib/services/workspace-rls'
import { isReservedTestEmail } from '@/lib/services/end-user-auth-table'
// One cast table for the whole codebase. Duplicating it is how the MCP path and
// this one would drift, and a drifted cast table is invisible until 42804.
import { castTarget, coerceValue, columnTypes } from '@/lib/mcp/runtime-db'

export interface FunctionEvent {
  type: string
  table?: string
  data: Record<string, any>
  old?: Record<string, any>
}

export interface FunctionExecutionResult {
  success: boolean
  logs: string[]
  returnValue?: any
  /**
   * The HTTP status the function's own handler chose, for route modules.
   *
   * Distinct from `success`, which only says the handler ran without throwing.
   * A route module answering 404 is a successful execution AND a 404 — and the
   * caller needs the 404. Without this the invocation route had nothing but
   * `success` to go on and replied 200 to everything, burying the real status
   * inside the response body where no HTTP client, retry policy or monitor
   * looks.
   */
  httpStatus?: number
  error?: string
  errorCode?: 'PLAN_LIMIT_EXCEEDED' | 'NOT_FOUND'
  upgradeRequired?: boolean
  requiredPlan?: string
  durationMs: number
}

export interface FunctionCallerContext {
  endUserId?: string | null
  endUserRole?: string | null
  serviceRole?: boolean
  /**
   * Auth/signature headers from the real HTTP request (authorization,
   * x-user-token, x-admin-key, ...). Route-module functions receive these on
   * their handler request — without them every auth-gated generated endpoint
   * dead-ends in 401/403 no matter what the caller sends.
   */
  headers?: Record<string, string | undefined>
  /**
   * Owner-initiated dashboard test run. The route-module runner injects the
   * project's admin key and a short-lived project-scoped admin token so the
   * endpoint's real logic can be exercised. Never set on public paths.
   */
  testRun?: boolean
}

const EXECUTION_TIMEOUT_MS = 10_000
const SANDBOX_WORKER_PATH = path.resolve(
  process.cwd(),
  'lib/services/ai-functions/sandbox-worker.cjs'
)

// ─── Transient error detection ────────────────────────────────────────────────

function isTransientError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase()
  return (
    msg.includes('connection refused') ||
    msg.includes('connection reset') ||
    msg.includes('econnrefused') ||
    msg.includes('etimedout') ||
    msg.includes('epipe') ||
    msg.includes('socket hang up')
  )
}

// ─── DB proxy handlers (executed in parent, called from worker) ───────────────

const _DB_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Cast a placeholder from the COLUMN's declared type, falling back to the
 * value's shape only when the catalog could not tell us the type.
 *
 * Why this is not optional, and why value-shape alone was never enough:
 * Prisma's $queryRawUnsafe binds every string parameter explicitly as `text`,
 * so PostgreSQL refuses the implicit text -> uuid/timestamp/numeric assignment
 * REGARDLESS of how well-formed the value is. A perfect crypto.randomUUID()
 * bound into a uuid column with a bare `$1` still raises 42804. That is what
 * made this the error firing in production every 15 minutes for six days:
 * `db.insert` built bare placeholders, so behavioural verification of the
 * profiles table had never once succeeded.
 *
 * Keying off the value (the old dbUuidCast) also silently did nothing for
 * timestamp, numeric and boolean columns, which meant an AI function could not
 * write to them at all. Reuses castTarget/coerceValue so there is ONE cast
 * table in the codebase rather than a second one drifting from it.
 */
function dbCast(dataType: string | undefined, val: any, idx: number): string {
  const target = castTarget(dataType)
  if (target) return `$${idx}::${target}`
  if (dataType === undefined && typeof val === 'string' && _DB_UUID_RE.test(val)) {
    return `$${idx}::uuid`
  }
  return `$${idx}`
}

function buildDbProxy(projectId: string, caller: FunctionCallerContext = {}) {
  const schemaName = `workspace_${projectId}`
  const serviceRole = caller.serviceRole ?? true
  const endUserId = caller.endUserId ?? ''
  const endUserRole = caller.endUserRole ?? 'user'

  return {
    async 'db.query'([table, where]: [string, Record<string, any> | undefined]) {
      const safeName = table.replace(/[^a-z0-9_]/gi, '')
      if (where && Object.keys(where).length > 0) {
        const keys = Object.keys(where).map(k => k.replace(/[^a-z0-9_]/gi, ''))
        const raw = Object.keys(where)
        const types = await columnTypes(schemaName, safeName)
        const conditions = keys.map((c, i) => `"${c}" = ${dbCast(types.get(c), where[raw[i]], i + 1)}`).join(' AND ')
        return executeWithUserContext<any>(
          endUserId,
          serviceRole,
          `SELECT * FROM "${schemaName}"."${safeName}" WHERE ${conditions} LIMIT 100`,
          keys.map((c, i) => coerceValue(types.get(c), where[raw[i]])),
          endUserRole
        )
      }
      return executeWithUserContext<any>(
        endUserId,
        serviceRole,
        `SELECT * FROM "${schemaName}"."${safeName}" LIMIT 100`,
        [],
        endUserRole
      )
    },

    async 'db.insert'([table, data]: [string, Record<string, any>]) {
      const safeName = table.replace(/[^a-z0-9_]/gi, '')
      const cols = Object.keys(data).filter(c => /^[a-z_][a-z0-9_]*$/i.test(c))
      if (cols.length === 0) throw new Error('No valid columns to insert')
      const colList = cols.map(c => `"${c}"`).join(', ')
      const types = await columnTypes(schemaName, safeName)
      const placeholders = cols.map((c, i) => dbCast(types.get(c), data[c], i + 1)).join(', ')
      const result = await executeWithUserContext<any>(
        endUserId,
        serviceRole,
        `INSERT INTO "${schemaName}"."${safeName}" (${colList}) VALUES (${placeholders}) RETURNING *`,
        cols.map(c => coerceValue(types.get(c), data[c])),
        endUserRole
      )
      return result[0]
    },

    async 'db.update'([table, where, data]: [string, Record<string, any>, Record<string, any>]) {
      const safeName = table.replace(/[^a-z0-9_]/gi, '')
      const setCols = Object.keys(data).filter(c => /^[a-z_][a-z0-9_]*$/i.test(c))
      const whereCols = Object.keys(where).filter(c => /^[a-z_][a-z0-9_]*$/i.test(c))
      if (setCols.length === 0) throw new Error('No valid columns to update')
      if (whereCols.length === 0) throw new Error('WHERE clause required for update')
      const types = await columnTypes(schemaName, safeName)
      const setClause = setCols.map((c, i) => `"${c}" = ${dbCast(types.get(c), data[c], i + 1)}`).join(', ')
      const whereClause = whereCols.map((c, i) => `"${c}" = ${dbCast(types.get(c), where[c], setCols.length + i + 1)}`).join(' AND ')
      return executeWithUserContext<any>(
        endUserId,
        serviceRole,
        `UPDATE "${schemaName}"."${safeName}" SET ${setClause} WHERE ${whereClause} RETURNING *`,
        [
          ...setCols.map(c => coerceValue(types.get(c), data[c])),
          ...whereCols.map(c => coerceValue(types.get(c), where[c])),
        ],
        endUserRole
      )
    },

    async 'db.delete'([table, where]: [string, Record<string, any>]) {
      const safeName = table.replace(/[^a-z0-9_]/gi, '')
      const cols = Object.keys(where).filter(c => /^[a-z_][a-z0-9_]*$/i.test(c))
      if (cols.length === 0) throw new Error('WHERE clause required for delete')
      const types = await columnTypes(schemaName, safeName)
      const conditions = cols.map((c, i) => `"${c}" = ${dbCast(types.get(c), where[c], i + 1)}`).join(' AND ')
      await executeWithUserContext<any>(
        endUserId,
        serviceRole,
        `DELETE FROM "${schemaName}"."${safeName}" WHERE ${conditions}`,
        cols.map(c => coerceValue(types.get(c), where[c])),
        endUserRole
      )
      return null
    },

    async 'http.get'([url, headers]: [string, Record<string, string> | undefined]) {
      const res = await fetch(url, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json', ...headers },
        signal: AbortSignal.timeout(8000),
      })
      const text = await res.text()
      try { return JSON.parse(text) } catch { return text }
    },

    async 'http.post'([url, body, headers]: [string, any, Record<string, string> | undefined]) {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(8000),
      })
      const text = await res.text()
      try { return JSON.parse(text) } catch { return text }
    },
  } as Record<string, (args: any) => Promise<any>>
}

// ─── Integration proxy handlers (parent-side, called from worker) ─────────────

/**
 * Parent-side handler map. Fully generic: every enumerable method on every
 * provider object becomes `integrations.<provider>.<method>`. Adding a provider
 * (or a method) in the registry needs ZERO changes here — that is the whole
 * point of the registry refactor.
 */
function buildIntegrationProxy(
  integrations: IntegrationContext
): Record<string, (args: any) => Promise<any>> {
  const h: Record<string, (args: any) => Promise<any>> = {}

  for (const provId of Object.keys(integrations)) {
    if (provId === 'isConnected') continue
    const api = (integrations as any)[provId]
    if (!api || typeof api !== 'object') continue
    for (const method of Object.keys(api)) {
      const fn = api[method]
      if (typeof fn !== 'function') continue
      h[`integrations.${provId}.${method}`] = (args: any[]) => fn(...(args ?? []))
    }
  }

  return h
}

/**
 * Method manifest for the worker: { providerId: [methodNames] }. The worker uses
 * this to build the ctx.integrations proxy generically, with no hardcoded list.
 */
function buildIntegrationManifest(
  integrations: IntegrationContext
): Record<string, string[]> {
  const manifest: Record<string, string[]> = {}
  for (const provId of Object.keys(integrations)) {
    if (provId === 'isConnected') continue
    const api = (integrations as any)[provId]
    if (!api || typeof api !== 'object') continue
    const methods = Object.keys(api).filter((k) => typeof api[k] === 'function')
    if (methods.length) manifest[provId] = methods
  }
  return manifest
}

function getConnectedFromContext(integrations: IntegrationContext): string[] {
  const names = new Set<string>()
  for (const provId of Object.keys(integrations)) {
    if (provId === 'isConnected') continue
    const api = (integrations as any)[provId]
    if (!api || typeof api !== 'object') continue
    names.add(provId.toLowerCase())
    const spec = getProviderSpec(provId)
    if (spec) for (const n of spec.connectedNames) names.add(n.toLowerCase())
  }
  return [...names]
}

// ─── Worker-based execution ───────────────────────────────────────────────────

function runInWorker(
  code: string,
  event: FunctionEvent,
  projectId: string,
  integrationProxy: Record<string, (args: any) => Promise<any>> = {},
  connectedIntegrations: string[] = [],
  envVars: Record<string, string> = {},
  caller: FunctionCallerContext = {},
  integrationManifest: Record<string, string[]> = {}
): Promise<{ logs: string[]; returnValue?: any }> {
  return new Promise((resolve, reject) => {
    // Spawn a disposable Worker Thread with strict memory limits
    // env: {} means the worker receives NO environment variables
    const worker = new Worker(SANDBOX_WORKER_PATH, {
      env: {}, // no process.env forwarded
      resourceLimits: {
        maxOldGenerationSizeMb: 64,
        maxYoungGenerationSizeMb: 16,
        codeRangeSizeMb: 8,
      },
    })

    const dbProxy = buildDbProxy(projectId, caller)
    const allHandlers = { ...dbProxy, ...integrationProxy }
    const logs: string[] = []
    const runId = `r${Date.now()}`

    // Hard timeout: kill the worker after EXECUTION_TIMEOUT_MS
    const hardKillTimer = setTimeout(() => {
      worker.terminate().catch(() => {})
      reject(new Error('Function timed out after 10s'))
    }, EXECUTION_TIMEOUT_MS)

    worker.on('message', async (msg: any) => {
      if (msg.type === 'log') {
        logs.push(msg.line)
        return
      }

      if (msg.type === 'call') {
        // Proxy DB/HTTP/integration call from worker to parent — execute here and send result back
        const handler = allHandlers[msg.method]
        if (!handler) {
          worker.postMessage({ type: 'result', callId: msg.callId, error: `Unknown method: ${msg.method}` })
          return
        }
        try {
          const result = await handler(msg.args)
          worker.postMessage({ type: 'result', callId: msg.callId, result: result ?? null })
        } catch (err: any) {
          worker.postMessage({ type: 'result', callId: msg.callId, error: err.message })
        }
        return
      }

      if (msg.type === 'done') {
        clearTimeout(hardKillTimer)
        worker.terminate().catch(() => {})
        resolve({ logs, returnValue: msg.result })
        return
      }

      if (msg.type === 'error') {
        clearTimeout(hardKillTimer)
        worker.terminate().catch(() => {})
        reject(new Error(msg.error))
        return
      }
    })

    worker.on('error', (err) => {
      clearTimeout(hardKillTimer)
      reject(err)
    })

    worker.on('exit', (code) => {
      clearTimeout(hardKillTimer)
      if (code !== 0) {
        reject(new Error(`Sandbox worker exited with code ${code}`))
      }
    })

    // Start execution — pass connectedIntegrations so worker can build ctx.integrations,
    // and decrypted envVars so worker can expose ctx.env (frozen).
    worker.postMessage({ type: 'run', id: runId, code, event, connectedIntegrations, envVars, integrationManifest })
  })
}

// ─── Auto-Fix ─────────────────────────────────────────────────────────────────

async function autoFixAiFunction(
  functionId: string,
  projectId: string,
  errorMessage: string,
  originalCode: string,
  description: string,
  triggerType: string,
  triggerTable: string | null
): Promise<void> {
  try {
    console.log(`[AutoFix] Attempting fix for function ${functionId}: ${errorMessage}`)

    const fixedCode = await generateFixedFunctionCode(
      originalCode,
      errorMessage,
      description,
      triggerType,
      triggerTable,
      projectId
    )

    if (!fixedCode || fixedCode === originalCode) {
      await prisma.aiFunction.update({
        where: { id: functionId },
        data: { lastError: `AUTO-FIX-FAILED: Could not generate a fix for: ${errorMessage}`, status: 'error' },
      })
      return
    }

    await prisma.aiFunction.update({
      where: { id: functionId },
      data: { generatedCode: fixedCode, status: 'active', lastError: null },
    })

    console.log(`[AutoFix] Successfully fixed function ${functionId}`)
  } catch (err: any) {
    console.warn(`[AutoFix] Fix failed for function ${functionId}:`, err?.message)
    await prisma.aiFunction.update({
      where: { id: functionId },
      data: { lastError: `AUTO-FIX-FAILED: ${err?.message || 'unknown error'}`, status: 'error' },
    }).catch(() => {})
  }
}

/**
 * Route-module self-heal. Unlike the NL auto-fixer above (which rewrites code
 * into ctx.* sandbox bodies and would corrupt a route module), this fixer
 * regenerates the module with the route-module contract prompt and only saves
 * code that passes the compile/evaluate/export validation gate. Exported so
 * the workspace observer can heal stale errored functions on its scan loop.
 */
export async function autoFixRouteModuleFunction(
  functionId: string,
  projectId: string,
  errorMessage: string,
  originalCode: string,
  description: string,
  triggerTableHint: string | null
): Promise<boolean> {
  try {
    console.log(`[AutoFix:RouteModule] Attempting fix for function ${functionId}: ${errorMessage}`)
    const method = triggerTableHint?.match(/^\s*(GET|POST|PUT|PATCH|DELETE)\b/i)?.[1]?.toUpperCase() || 'POST'
    const { generateFixedRouteModule } = await import('@/lib/ai/function-generator')
    const fixedCode = await generateFixedRouteModule(originalCode, errorMessage, description, method, projectId)

    if (!fixedCode) {
      await prisma.aiFunction.update({
        where: { id: functionId },
        data: { lastError: `AUTO-FIX-FAILED: Could not generate a validated fix for: ${errorMessage}`, status: 'error' },
      })
      return false
    }

    await prisma.aiFunction.update({
      where: { id: functionId },
      data: { generatedCode: fixedCode, status: 'active', lastError: null },
    })
    console.log(`[AutoFix:RouteModule] Successfully fixed function ${functionId}`)
    return true
  } catch (err: any) {
    console.warn(`[AutoFix:RouteModule] Fix failed for function ${functionId}:`, err?.message)
    await prisma.aiFunction.update({
      where: { id: functionId },
      data: { lastError: `AUTO-FIX-FAILED: ${err?.message || 'unknown error'}`, status: 'error' },
    }).catch(() => {})
    return false
  }
}

// ─── Errored-function healer (called from the workspace observer scan) ───────

/**
 * Error messages that were caused by BUGS IN THE RUNNER's invocation contract
 * (missing second handler arg, missing req.nextUrl / req.cookies shims), all
 * fixed since. A stored route module that still passes validation and whose
 * lastError matches one of these crashed because of US, not because of its
 * own code — restore it instead of burning an LLM regeneration on it.
 */
const RUNNER_CONTRACT_BUG_RE =
  /Cannot destructure property 'params' of|\(reading 'searchParams'\)|\(reading 'nextUrl'\)/

export interface FunctionHealResult {
  scanned: number
  restored: number
  regenerated: number
  failed: number
}

/**
 * Self-heal functions stuck in status='error'. A function's lastError only
 * clears on its next successful run — but broken functions stop being called,
 * so without this loop they stay red forever even after the cause is fixed.
 *
 * Per errored function:
 *  - Route module whose code passes validation + error matches a known
 *    (since-fixed) runner-contract bug → restore to active, clear the error.
 *    Zero side effects, zero LLM cost. If the error was real it will re-flag
 *    on the next invocation and take the regeneration path below.
 *  - Otherwise (and not already AUTO-FIX-marked) → regenerate through the
 *    matching fixer (route-module-aware or NL sandbox), which only saves
 *    validated code. Bounded by maxLlmFixes per scan to cap AI spend.
 */
export async function healErroredAiFunctions(
  projectId: string,
  maxLlmFixes = 3
): Promise<FunctionHealResult> {
  const result: FunctionHealResult = { scanned: 0, restored: 0, regenerated: 0, failed: 0 }
  const errored = await prisma.aiFunction.findMany({
    where: { projectId, status: 'error', lastError: { not: null } },
    orderBy: { updatedAt: 'asc' },
    take: 20,
  })
  result.scanned = errored.length
  let llmBudget = maxLlmFixes

  for (const fn of errored) {
    const lastError = fn.lastError ?? ''
    try {
      if (isRouteModuleFunction(fn.generatedCode)) {
        const check = validateRouteModule(fn.generatedCode)
        if (check.valid && RUNNER_CONTRACT_BUG_RE.test(lastError)) {
          await prisma.aiFunction.update({
            where: { id: fn.id },
            data: { status: 'active', lastError: null },
          })
          await prisma.auditLog.create({
            data: {
              projectId,
              action: 'AI_FUNCTION_SELF_HEALED',
              type: 'autonomy',
              details: JSON.stringify({
                functionId: fn.id,
                name: fn.name,
                reason: 'runner-contract bug (fixed platform-side); stored code re-validated clean',
                clearedError: lastError,
              }),
              timestamp: new Date(),
            },
          }).catch(() => {})
          result.restored++
          continue
        }
        if (!lastError.startsWith('AUTO-FIX') && llmBudget > 0) {
          llmBudget--
          const ok = await autoFixRouteModuleFunction(
            fn.id, projectId, lastError || check.error || 'unknown error',
            fn.generatedCode, fn.description, fn.triggerTable
          )
          if (ok) result.regenerated++
          else result.failed++
        }
        continue
      }

      // Sandbox function — reuse the NL auto-fixer (validated by re-parse in
      // the generator path; runtime re-verification happens on next fire).
      if (!lastError.startsWith('AUTO-FIX') && llmBudget > 0) {
        llmBudget--
        await autoFixAiFunction(
          fn.id, projectId, lastError, fn.generatedCode,
          fn.description, fn.triggerType, fn.triggerTable
        )
        const after = await prisma.aiFunction.findUnique({ where: { id: fn.id }, select: { status: true } })
        if (after?.status === 'active') result.regenerated++
        else result.failed++
      }
    } catch {
      result.failed++
    }
  }
  return result
}

// ─── Main Executor ────────────────────────────────────────────────────────────

export async function executeAiFunction(
  functionId: string,
  projectId: string,
  event: FunctionEvent,
  caller: FunctionCallerContext = {}
): Promise<FunctionExecutionResult> {
  const startMs = Date.now()

  const fn = await prisma.aiFunction.findFirst({ where: { id: functionId, projectId } })
  if (!fn) return { success: false, logs: [], error: 'Function not found', errorCode: 'NOT_FOUND', durationMs: 0 }
  // Only a DELIBERATE disable refuses execution. `status: 'error'` records how
  // the last run went, and this used to treat it as a deployment state — so one
  // throw made the function permanently uncallable, and the only thing that
  // clears 'error' is a successful run. See the longer note in
  // server/routes/dynamic.ts.
  if (fn.status === 'disabled' || fn.status === 'deleted') {
    return { success: false, logs: [], error: 'Function is disabled', errorCode: 'NOT_FOUND', durationMs: 0 }
  }

  // ── Plan-driven quota ────────────────────────────────────────────────────
  // Every invocation — manual, trigger-fired, or signup — counts against the
  // project owner's monthly AI Function quota. Enforced once here so route,
  // trigger, and SDK paths all share the same accounting.
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { userId: true },
  })
  if (project?.userId) {
    const decision = await enforceAiFunctionInvocation(project.userId)
    if (decision !== true) {
      // A quota block must still leave a trace: trigger-fired functions
      // (on_signup/on_insert/...) swallow errors, so without a log row the
      // block is invisible everywhere. Do NOT flip status/lastError — the
      // function itself is fine; the plan is the constraint.
      await persistExecutionLog(functionId, projectId, false, [], decision.message, 0, event.type)
      return {
        success: false,
        logs: [],
        error: decision.message,
        errorCode: decision.code,
        upgradeRequired: decision.upgradeRequired,
        requiredPlan: decision.requiredPlan,
        durationMs: 0,
      }
    }
    trackAiFunctionInvocation(project.userId).catch(() => {})
  }

  // ─── Route-module path ──────────────────────────────────────────────────────
  // Platform-generated Next.js endpoint handlers (jobs/wallets/orders/admin/
  // *-schema/...) are a different code shape than NL sandbox bodies and CANNOT
  // run in the Worker sandbox. They run in-process via the route-module runner.
  // A non-2xx HTTP status is still a SUCCESSFUL execution — the handler ran and
  // answered (e.g. a 401 from an auth-gated endpoint on a no-token test run is
  // correct behaviour, not a failure). Only thrown errors / timeouts fail.
  if (isRouteModuleFunction(fn.generatedCode)) {
    try {
      const { logs, returnValue } = await executeRouteModuleFunction(
        fn.generatedCode,
        projectId,
        event,
        fn.triggerTable,
        { headers: caller.headers, testRun: caller.testRun }
      )
      const durationMs = Date.now() - startMs
      await persistExecutionLog(functionId, projectId, true, logs, undefined, durationMs, event.type)
      prisma.aiFunction.update({
        where: { id: functionId },
        data: { runCount: { increment: 1 }, lastRun: new Date(), lastError: null, status: 'active' },
      }).catch(() => {})
      // `httpStatus` is the status the HANDLER chose. It is surfaced separately
      // from `success` because the two answer different questions: `success`
      // means the function ran without throwing, `httpStatus` means what it
      // decided to answer. The invocation route needs the second one — see the
      // note in server/routes/dynamic.ts about every function replying 200.
      return { success: true, logs, returnValue, httpStatus: returnValue?.status, durationMs }
    } catch (err: any) {
      const durationMs = Date.now() - startMs
      const errorMsg = err?.message || 'Route function error'
      await persistExecutionLog(functionId, projectId, false, [], errorMsg, durationMs, event.type)
      prisma.aiFunction.update({
        where: { id: functionId },
        data: { runCount: { increment: 1 }, lastRun: new Date(), lastError: errorMsg, status: 'error' },
      }).catch(() => {})
      // Self-heal: regenerate through the route-module-aware fixer (the NL
      // auto-fixer would rewrite the module into a ctx.* sandbox body and
      // corrupt it — never use it here). Guarded so a failed fix can't loop.
      const prevError = fn.lastError ?? ''
      if (!prevError.startsWith('AUTO-FIX')) {
        autoFixRouteModuleFunction(
          functionId, projectId, errorMsg, fn.generatedCode, fn.description, fn.triggerTable
        ).catch(() => {})
      }
      return { success: false, logs: [], error: errorMsg, durationMs }
    }
  }

  // Load integration context + per-project env vars in parallel — workers are
  // short-lived so no caching needed. `ctx.env` is the canonical secret store
  // for anything that isn't a first-class typed integration.
  const { getDecryptedEnvMap } = await import('@/lib/services/projectEnvVars')
  const [integrations, envVars] = await Promise.all([
    buildIntegrationContext(projectId).catch(() => ({ isConnected: () => false } as IntegrationContext)),
    getDecryptedEnvMap(projectId).catch(() => ({} as Record<string, string>)),
  ])
  const integrationProxy = buildIntegrationProxy(integrations)
  const connectedIntegrations = getConnectedFromContext(integrations)
  const integrationManifest = buildIntegrationManifest(integrations)

  const MAX_RETRIES = 2
  let lastError: Error | null = null

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      await new Promise(r => setTimeout(r, Math.pow(2, attempt - 1) * 500))
      console.log(`[AiFn] Retry ${attempt}/${MAX_RETRIES} for function ${functionId}`)
    }

    try {
      const { logs, returnValue } = await runInWorker(
        fn.generatedCode,
        event,
        projectId,
        integrationProxy,
        connectedIntegrations,
        envVars,
        caller,
        integrationManifest,
      )
      const durationMs = Date.now() - startMs

      // Persist execution log
      await persistExecutionLog(functionId, projectId, true, logs, undefined, durationMs, event.type)

      prisma.aiFunction.update({
        where: { id: functionId },
        data: { runCount: { increment: 1 }, lastRun: new Date(), lastError: null, status: 'active' },
      }).catch(() => {})

      return { success: true, logs, returnValue, durationMs }
    } catch (err: any) {
      lastError = err instanceof Error ? err : new Error(String(err))
      if (attempt < MAX_RETRIES && isTransientError(err)) continue
      break
    }
  }

  const durationMs = Date.now() - startMs
  const errorMsg = lastError?.message || 'Unknown error'
  const logs: string[] = []

  // Persist error log
  await persistExecutionLog(functionId, projectId, false, logs, errorMsg, durationMs, event.type)

  prisma.aiFunction.update({
    where: { id: functionId },
    data: { runCount: { increment: 1 }, lastRun: new Date(), lastError: errorMsg, status: 'error' },
  }).catch(() => {})

  const previousError = fn.lastError ?? ''
  if (!previousError.startsWith('AUTO-FIX')) {
    autoFixAiFunction(
      functionId, projectId, errorMsg, fn.generatedCode,
      fn.description, fn.triggerType, fn.triggerTable
    ).catch(() => {})
  }

  return { success: false, logs, error: errorMsg, durationMs }
}

// ─── Execution Log Persistence (for GAP 9 — function logs UI) ────────────────

async function persistExecutionLog(
  functionId: string,
  projectId: string,
  success: boolean,
  logs: string[],
  error: string | undefined,
  durationMs: number,
  triggerType: string
): Promise<void> {
  try {
    await prisma.aiFunctionLog.create({
      data: {
        functionId,
        projectId,
        success,
        logs,
        error: error ?? null,
        durationMs,
        triggerType,
      },
    })
  } catch {
    // Non-fatal — log persistence must never block execution
  }
}

// ─── Batch Fire Helpers ───────────────────────────────────────────────────────

export async function fireAiFunctions(
  projectId: string,
  event: FunctionEvent
): Promise<void> {
  try {
    const triggerType = `on_db_${event.type}`
    const functions = await prisma.aiFunction.findMany({
      where: { projectId, status: 'active', triggerType, triggerTable: event.table },
      select: { id: true },
    })
    if (functions.length === 0) return
    await Promise.allSettled(functions.map(fn => executeAiFunction(fn.id, projectId, event)))
  } catch (err: any) {
    console.warn('[AiFunctions] fireAiFunctions failed (non-fatal):', err?.message)
  }
}

/**
 * Run a project's `on_signup` handlers for a newly created end user.
 *
 * ── Synthetic accounts are excluded, and that is load-bearing ────────────────
 *
 * The contract sweep signs up a throwaway `…@*.internal` user every minute to
 * check that signup/signin/logout still answer their contract, then deletes it
 * in a `finally` the moment the round-trip returns. These handlers are dispatched
 * fire-and-forget by both signup routes, so they were still running against that
 * user when it was purged — and lost the race roughly half the time. The live
 * symptom was `insert or update on "profiles" violates foreign key constraint
 * "fk_profiles_user"` in the Postgres log, intermittently, indefinitely.
 *
 * Awaiting the handlers before the purge would be the wrong repair. The probe
 * exists to verify the auth SURFACE, not to execute the developer's business
 * automations. Running those against a user with a two-second lifetime writes
 * half-finished rows into their tables and bills every run against their
 * function invocation quota — 2,735 invocations on one live project, not one of
 * which could ever have completed.
 *
 * The filter lives HERE rather than at the call sites because there are two
 * signup routes (`server/routes/auth.ts` serves production, the Next.js
 * `app/api/v1/.../signup/route.ts` the other path) and a guard written at one
 * call site silently leaves the other firing.
 */
export async function fireAiFunctionsOnSignup(
  projectId: string,
  user: Record<string, any>
): Promise<void> {
  try {
    if (typeof user?.email === 'string' && isReservedTestEmail(user.email)) return

    const functions = await prisma.aiFunction.findMany({
      where: { projectId, status: 'active', triggerType: 'on_signup' },
      select: { id: true },
    })
    if (functions.length === 0) return
    const event: FunctionEvent = { type: 'signup', data: user }
    await Promise.allSettled(functions.map(fn => executeAiFunction(fn.id, projectId, event)))
  } catch (err: any) {
    console.warn('[AiFunctions] fireAiFunctionsOnSignup failed (non-fatal):', err?.message)
  }
}
