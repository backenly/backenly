/**
 * ROUTE-MODULE RUNNER
 * ===================
 * Executes platform-generated Next.js *route-handler modules* that are stored
 * as AiFunction records.
 *
 * WHY THIS EXISTS
 * ---------------
 * Backenly stores two structurally different kinds of code in
 * `AiFunction.generatedCode`:
 *
 *   1. Sandbox bodies  — bare `ctx.db / ctx.http / ctx.log` code authored by
 *                         the NL function generator (executor.ts runs them).
 *   2. Route modules   — full Next.js handlers authored by
 *                         lib/ai/build-runtime/domain-business-logic.ts:
 *                           import { NextRequest, NextResponse } from 'next/server'
 *                           import { prisma } from '@/lib/db'
 *                           export async function GET(req: NextRequest) { ... }
 *
 * WHERE THE CODE RUNS
 * -------------------
 * Not here. This process holds every platform secret, and route modules are
 * free-form code (functions deploy_code stores what an agent wrote, the
 * generator what a model wrote). They used to run in a node:vm context in this
 * process, and node:vm is not a security mechanism: `Object.constructor('return
 * process')()` reached the real process, its environment and the platform's
 * database client. Each run, and each deploy-time validation, now happens in a
 * fresh runner process under its own uid (isolation/function-runner.cjs,
 * started by isolation/function-supervisor.cjs, reached through
 * isolation/client.ts). This file does what needs the project's material, and
 * hands the runner only the result:
 *
 *  - Static signature check (defence in depth only: the denylist matches
 *    spellings, not capabilities) and the withheld-variable check.
 *  - TypeScript to CommonJS with esbuild, here: parsing runs no code.
 *  - The caller's identity, from verified request material only: a token this
 *    project signed (checked here, with the project's secret, which never
 *    leaves this process) or this project's derived admin key.
 *  - The tokens the request carries that the project signed, so the runner's
 *    verifyToken and jsonwebtoken.verify answer for them without the secret;
 *    the admin key, only when the caller presented it.
 *  - The project's database login, its realtime stream and outbound HTTP
 *    (through the egress guard) are calls the runner makes back to here,
 *    answered for this project only.
 *  - 10s for the handler; the supervisor kills the process at the deadline,
 *    so a synchronous or microtask loop in a handler costs that one process,
 *    not this one's event loop.
 *  - Handler return value (a NextResponse) is normalised to { status, body }.
 *    A non-2xx status is still a SUCCESSFUL execution (the handler ran and
 *    answered) — only thrown errors / timeouts are failures.
 */

import * as nodeCrypto from 'crypto'
import * as jsonwebtoken from 'jsonwebtoken'
import { loadProjectFnAuth, ProjectFnAuth, TEST_RUN_USER_ID } from './project-fn-auth'
import { FUNCTION_DB_SESSION_SQL, SERVICE_DB_CLAIMS, functionDbClaims, functionSearchPath, type RlsAwarePrisma } from './rls-aware-db'
import { projectStreamLabel, sendToProjectStream } from './stream-notify'
import { functionDbConnection } from './function-db-role'
import type { RlsIdentity } from '@/lib/services/rls-session'
import { safeFetch } from '@/lib/security/outbound-guard'
import { resolveEndUserFromToken } from '@/server/lib/end-user-identity'
import { FORWARDABLE_FN_HEADERS } from './forward-headers'
import { withoutComments } from './integration-use'
import { encodeValue, endedForMemory, runIsolated, type CallHandlers, type IsolatedOutcome } from './isolation/client'

// esbuild is a native binary package — load it lazily through a non-bundled
// require so Next.js never tries to trace/bundle the binary into the server
// output. Because nothing can see this require, neither output tracing nor the
// runtime bundler ships esbuild: both images copy it in explicitly and fail
// their build if it cannot compile TypeScript (docker/web.Dockerfile,
// docker/runtime.Dockerfile, pinned by tests/unit/esbuild-ships-in-images.spec.ts).
let _esbuildTransformSync:
  | ((code: string, opts: any) => { code: string })
  | null = null
function getEsbuildTransformSync() {
  if (_esbuildTransformSync) return _esbuildTransformSync
  const req = eval('require') as NodeRequire
  _esbuildTransformSync = req('esbuild').transformSync
  return _esbuildTransformSync!
}

const EXECUTION_TIMEOUT_MS = 10_000
const VALIDATION_TIMEOUT_MS = 3_000
/** The handler's 10s, plus the module's own evaluation and the process starting. */
const RUN_HARD_TIMEOUT_MS = 15_000
const VALIDATION_HARD_TIMEOUT_MS = 8_000
const TIMEOUT_MESSAGE = 'Route function timed out after 10s'

function compileModule(code: string): string {
  return getEsbuildTransformSync()(code, {
    loader: 'ts',
    format: 'cjs',
    target: 'node18',
    platform: 'node',
  }).code
}

// ─── Format detection ─────────────────────────────────────────────────────────

const ROUTE_EXPORT_RE = /export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE)\s*\(/
const NEXT_SERVER_IMPORT_RE = /from\s+['"]next\/server['"]/

/**
 * True when `code` is a Next.js route-handler module (the shape emitted by
 * domain-business-logic.ts) rather than a bare sandbox function body.
 */
export function isRouteModuleFunction(code: string | null | undefined): boolean {
  if (!code) return false
  return ROUTE_EXPORT_RE.test(code) || NEXT_SERVER_IMPORT_RE.test(code)
}

// ─── Denylist (defence in depth: the process boundary is the security boundary) ─

const HARD_BLOCKED: Array<[RegExp, string]> = [
  [/\bchild_process\b/, 'child_process is not permitted'],
  [/\bworker_threads\b/, 'worker_threads is not permitted'],
  // process.env is NOT blocked: a function reads the project's own variables
  // there. The runner gives it a frozen env of those (makeCuratedProcess in
  // isolation/function-runner.cjs), never a secret Backenly signs or checks with.
  [/\bprocess\s*\.\s*(exit|kill|binding|dlopen|mainModule|_getActiveHandles)\b/, 'process internals are not permitted'],
  [/\beval\s*\(/, 'eval() is not permitted'],
  [/\bnew\s+Function\s*\(/, 'new Function() is not permitted'],
  [/\bimport\s*\(/, 'dynamic import() is not permitted'],
  [/\bfs\s*\.\s*(writeFile|writeFileSync|unlink|unlinkSync|rm|rmSync|rmdir|mkdir|appendFile)/, 'filesystem writes are not permitted'],
  [/\b__proto__\b/, 'prototype access is not permitted'],
  [/\bconstructor\s*\.\s*constructor\b/, 'constructor escape is not permitted'],
]

function assertNotBlocked(code: string): void {
  for (const [re, why] of HARD_BLOCKED) {
    if (re.test(code)) {
      throw new Error(`Route module rejected by safety scan: ${why}`)
    }
  }
}

// ─── What process.env holds ──────────────────────────────────────────────────
// The runner's process.env for a route module (makeCuratedProcess in
// isolation/function-runner.cjs) is a frozen, PER-PROJECT env, never a process
// environment:
//
//   the project's own variables (Settings → Environment, ctx.env in a
//   described function), as process.env.KEY, which is how a route function
//   reads configuration: one set of variables for both kinds of function;
//   NODE_ENV, which is not a secret.
//
// JWT_SECRET, ADMIN_API_KEY and AI_EXECUTION_TOKEN never hold the project's
// end-user signing secret or its derived admin key: function code is
// free-form (deploy_code stores what an agent wrote), and whatever it can read
// it can return. They hold WITHHELD, a value made for this invocation that
// matches nothing:
//
//   - removed outright, a gate written `(header ?? '') === (env ?? '')`, or
//     `header == env`, would let every caller in once the variable was gone;
//     a random value no caller can send fails every such comparison closed;
//   - jsonwebtoken refuses to sign with it, and a verify with it checks the
//     token against the project's secret (which the app checked before the
//     run), so code that checked a user's token with
//     `jwt.verify(token, process.env.JWT_SECRET)` keeps working without holding
//     the secret.
//
// Admin endpoints check `isAdminRequest(request)` and token checks call
// `verifyToken(token)`, both from '@/lib/auth/jwt'; trusted SQL runs in
// `asService(fn)` from '@/lib/db'. Backenly's own variables are set after the
// project's, so a project variable cannot take one of these names.
export const WITHHELD_ENV_NAMES = ['JWT_SECRET', 'ADMIN_API_KEY', 'AI_EXECUTION_TOKEN'] as const

// ─── An owner's test run ─────────────────────────────────────────────────────
// The dashboard's Test, functions { action: "invoke" } and the generator's
// smoke test run a function for someone who may change the project
// (opts.testRun), and its admin and signed-in paths should answer them.
// Function code reads request.headers, so nothing on the request is a
// credential. The runner holds the fact that the run is an owner's test,
// which function code can neither read nor set:
//   - the function's SQL runs as the service role;
//   - until the run ends, isAdminRequest(request) answers true;
//   - where a user's token would be, the request carries OWNER_TEST_TOKEN, and
//     until the run ends every token check the function can make (verifyToken,
//     jsonwebtoken's verify and decode) reads it as the test user.
// The placeholder is not a secret: in any other run, and in this one once it
// has ended, it is nobody.

/** What an owner's test request carries in x-user-token. Only that run's token checks read it, as the test user. */
export const OWNER_TEST_TOKEN = 'owner-test-run'

/**
 * Who is this invocation acting as, for the purposes of RLS?
 *
 * Derived ONLY from verified request material — a token this project signed, or
 * this project's derived admin key. Never from the function body, and never
 * from an unverified claim in the payload.
 *
 * A token that names a project is an end user's session, and it is resolved by
 * the check every data door uses (server/lib/end-user-identity.ts), because it
 * may not have passed one: it can arrive in the request body or in a header
 * spelling the doors do not read, and the runtime's door serves a request whose
 * token is revoked as no user rather than refusing it. Revoked, or its user
 * blocked, it is no identity here either.
 *
 * The default is `anon` (no user id, not service role), which is the secure
 * one: own-rows policies match nothing. That is a visibly empty result rather
 * than someone else's data.
 */
async function resolveCallerIdentity(
  projectId: string,
  headers: Record<string, string | undefined>,
  auth: ProjectFnAuth,
): Promise<RlsIdentity> {
  // An owner-issued admin key is a server-side decision, so it may name
  // service_role. Compared with timingSafeEqual because it is a secret.
  const presentedAdminKey = headers['x-admin-key']
  if (auth.adminKey && presentedAdminKey && safeEqual(presentedAdminKey, auth.adminKey)) {
    return { userId: null, isServiceRole: true }
  }

  const raw = headers['x-user-token'] ?? headers['authorization']
  const token = raw?.replace(/^Bearer\s+/i, '').trim()
  if (!token || !auth.jwtSecret) return { userId: null, isServiceRole: false }

  let payload: any
  try {
    payload = realJwt().verify(token, auth.jwtSecret, { algorithms: ['HS256'] }) as any
  } catch {
    // An unverifiable token is not an identity. Falling back to service_role
    // here would turn a bad token into full table access.
    return { userId: null, isServiceRole: false }
  }

  if (typeof payload?.projectId === 'string') {
    // A status that cannot be read is no identity either.
    const endUser = await resolveEndUserFromToken(projectId, token).catch(() => null)
    if (!endUser || endUser === 'blocked') return { userId: null, isServiceRole: false }
    return { userId: endUser.userId, isServiceRole: false, userRole: endUser.role }
  }

  // A token without a project claim was not issued by end-user auth: only code
  // holding the project's secret, its own functions, signs one, and it is read
  // as it always was. Such tokens carry the id under a few historical names.
  // `sub` is the one the claim predicates read, so any of them maps onto it.
  const userId = payload?.sub ?? payload?.userId ?? payload?.user_id ?? payload?.id ?? null
  if (!userId) return { userId: null, isServiceRole: false }
  return {
    userId: String(userId),
    isServiceRole: false,
    userRole: typeof payload?.role === 'string' ? payload.role : undefined,
  }
}

function realJwt(): typeof jsonwebtoken {
  return (jsonwebtoken as any).default ?? jsonwebtoken
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return nodeCrypto.timingSafeEqual(ab, bb)
}

const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/
const MAX_TOKEN_CANDIDATES = 32

/**
 * The tokens this request carries that the project signed: in its headers
 * (as sent, or after `Bearer `), its cookies, and the top level of its body or
 * query. The runner's verifyToken and jsonwebtoken.verify accept these and no
 * others, which is what they would have answered with the secret in hand,
 * for every token a request can bring.
 */
function projectSignedTokens(headers: Record<string, string>, data: Record<string, unknown>, auth: ProjectFnAuth): string[] {
  if (!auth.jwtSecret) return []
  const candidates = new Set<string>()
  const offer = (value: unknown) => {
    if (typeof value !== 'string' || value.length > 8192) return
    const v = value.replace(/^Bearer\s+/i, '').trim()
    if (JWT_SHAPE.test(v)) candidates.add(v)
  }
  for (const value of Object.values(headers)) offer(value)
  for (const pair of (headers['cookie'] ?? '').split(';')) {
    const idx = pair.indexOf('=')
    if (idx <= 0) continue
    const raw = pair.slice(idx + 1).trim()
    offer(raw)
    try {
      offer(decodeURIComponent(raw))
    } catch {
      // not URI-encoded
    }
  }
  for (const value of Object.values(data)) offer(value)

  const verified: string[] = []
  for (const token of [...candidates].slice(0, MAX_TOKEN_CANDIDATES)) {
    try {
      const payload = realJwt().verify(token, auth.jwtSecret, { algorithms: ['HS256'] })
      if (payload && typeof payload === 'object') verified.push(token)
    } catch {
      // not this project's
    }
  }
  return verified
}

/** The project's admin key, when and only when the caller presented it. */
function presentedAdminKey(headers: Record<string, string>, auth: ProjectFnAuth): string | null {
  if (!auth.adminKey) return null
  const presented = (headers['x-admin-key'] ?? '').trim() || (headers['authorization'] ?? '').trim().replace(/^Bearer\s+/i, '')
  return presented.length > 0 && safeEqual(presented, auth.adminKey) ? auth.adminKey : null
}

// jsonwebtoken, as function code sees it (the runner's jsonwebtokenShim).
//
// process.env.JWT_SECRET holds WITHHELD. Signing with it is refused: a
// function does not mint sessions for the project's users. Verifying with it
// accepts a token the project signed, so a function that verified a caller's
// token that way keeps working. Any other secret is the function's own
// business, as before.
//
// Templates that signed tokens with the project secret omitted the projectId
// claim, which the runtime requires; sign still adds it for a payload naming a
// userId, for tokens a function signs with a secret of its own.
//
// In an owner's test run, verify (with any secret) and decode read
// OWNER_TEST_TOKEN as the test user, so a token check that passed the signed
// test token the placeholder replaces passes it too.
export const SIGN_REFUSED =
  "Functions cannot sign the project's end-user sessions: Backenly no longer gives function code the project's signing secret. " +
  "Check a caller's token with verifyToken(token) from '@/lib/auth/jwt'."

// ─── The database a function receives ───────────────────────────────────────

/** `asService(fn)`: run `fn`'s SQL in one transaction as the service role. */
export type AsService = <T>(fn: (db: RlsAwarePrisma) => Promise<T>) => Promise<T>

/** The line a run's logs carry for each asService block, so it can be seen afterwards. */
export const AS_SERVICE_NOTE =
  'Backenly: a block ran with asService, as the service role; row-level security did not apply to its SQL.'

// Trusted work: `asService(async (db) => { … })` from '@/lib/db'.
//
// A function's SQL runs as its caller, so row-level security keeps a shopper to
// their own rows. Some work a function does on the caller's behalf must reach
// further: a checkout creates the order and takes the stock, and the shopper may
// not update products. asService runs the block in one transaction with the
// service-role identity, so policies admit it and FOR UPDATE locks what it
// reads. It is the project's own function login all the same
// (function-db-role.ts): nothing outside the project's schema, ever. It is
// explicit in the code, a line in the run's logs says it ran, and deploy_code
// says the function uses it.

/** True when the code runs SQL with asService, for the deploy answer. */
export function usesAsService(code: string): boolean {
  return /\basService\s*\(/.test(withoutComments(code))
}

/**
 * Code that reads one of the variables Backenly no longer gives functions.
 * Dotted, bracketed with a literal name, or destructured from process.env.
 */
const WITHHELD_READ = [
  new RegExp(String.raw`\bprocess\s*\.\s*env\s*(?:\?\.|\.)\s*(${WITHHELD_ENV_NAMES.join('|')})\b`),
  new RegExp(String.raw`\bprocess\s*\.\s*env\s*(?:\?\.)?\s*\[\s*(['"\x60])(${WITHHELD_ENV_NAMES.join('|')})\1\s*\]`),
  new RegExp(String.raw`\{[^{}]*\b(${WITHHELD_ENV_NAMES.join('|')})\b[^{}]*\}\s*=\s*process\s*\.\s*env\b`),
]

export const WITHHELD_READ_REFUSED =
  "function code cannot read process.env.JWT_SECRET, ADMIN_API_KEY or AI_EXECUTION_TOKEN: Backenly does not give functions the project's signing secret or admin key. " +
  "Check an admin request with isAdminRequest(request) and a caller's token with verifyToken(token), both from '@/lib/auth/jwt', " +
  "and run SQL the caller may not run themselves inside asService(async (db) => { ... }) from '@/lib/db'"

/** The withheld variable the code reads, if any. */
export function readsWithheldEnv(code: string): string | null {
  const plain = withoutComments(code)
  for (const re of WITHHELD_READ) {
    const m = re.exec(plain)
    if (m) return WITHHELD_ENV_NAMES.find((name) => m[0].includes(name)) ?? null
  }
  return null
}

/** What the runner needs, in every run, to give function code the helpers above. */
function helperText() {
  return {
    text: { asServiceNote: AS_SERVICE_NOTE, signRefused: SIGN_REFUSED },
    withheldNames: [...WITHHELD_ENV_NAMES],
    ownerTest: { token: OWNER_TEST_TOKEN, userId: TEST_RUN_USER_ID },
    nodeEnv: process.env.NODE_ENV ?? null,
  }
}

// ─── Creation-time validation gate ───────────────────────────────────────────

export interface RouteModuleValidation {
  valid: boolean
  /** Exported HTTP methods found on the module (GET/POST/…). */
  methods: string[]
  error?: string
}

/**
 * Validate a route module WITHOUT invoking its handler: safety scan → esbuild
 * compile → module evaluation (in a runner process, never here) → exported-
 * handler check. This is the gate every generated/repaired route module must
 * pass BEFORE it is stored as an active function, so an agent can never persist
 * code that crashes on its first invocation. The handler is never called; the
 * module's top level runs in the runner with no database and no network.
 *
 * Throws FunctionRunnerUnavailableError when there is nowhere isolated to
 * evaluate it: that is not the code's fault, so it is not reported as invalid.
 */
export async function validateRouteModule(code: string, expectedMethod?: string | null): Promise<RouteModuleValidation> {
  try {
    assertNotBlocked(code)
  } catch (err: any) {
    return { valid: false, methods: [], error: err?.message || String(err) }
  }
  if (readsWithheldEnv(code)) return { valid: false, methods: [], error: WITHHELD_READ_REFUSED }

  let compiled: string
  try {
    compiled = compileModule(code)
  } catch (err: any) {
    return { valid: false, methods: [], error: `Compile error: ${err?.message || String(err)}` }
  }

  const outcome = await runIsolated({
    kind: 'route-validate',
    payload: { compiled, timeoutMs: VALIDATION_TIMEOUT_MS, ...helperText() },
    hardTimeoutMs: VALIDATION_HARD_TIMEOUT_MS,
  })
  const result = outcome.result
  if (!result) {
    return { valid: false, methods: [], error: `Evaluation error: ${endedWithoutAnswer(outcome, 'module')}` }
  }
  if (!result.ok) return { valid: false, methods: [], error: `Evaluation error: ${result.error}` }

  const reported = (result.value as { methods?: unknown } | null)?.methods
  const methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].filter((m) => Array.isArray(reported) && reported.includes(m))
  if (methods.length === 0) {
    return { valid: false, methods: [], error: 'Module exports no GET/POST/PUT/PATCH/DELETE handler' }
  }
  const want = expectedMethod?.toUpperCase()
  if (want && !methods.includes(want)) {
    return {
      valid: false,
      methods,
      error: `Module exports ${methods.join('/')} but the function is declared as ${want}`,
    }
  }
  return { valid: true, methods }
}

// ─── Public executor ──────────────────────────────────────────────────────────

/**
 * Thrown when the HANDLER itself failed — distinct from compile errors,
 * timeouts and machinery failures, which stay plain Errors. The smoke test
 * keys off this class to decide between "the function is broken" and "we
 * could not test it".
 */
export class RouteModuleHandlerError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RouteModuleHandlerError'
  }
}

export interface RouteModuleRunResult {
  logs: string[]
  returnValue: { status: number; body: any }
  /** The headers the handler set on its response (NextResponse.json's init.headers, content type included). */
  headers: Record<string, string>
}

export interface RouteModuleRunOptions {
  /**
   * Real request headers forwarded from the invocation surface (public /fn/
   * route, Express runtime, functions/invoke). Only the auth/signature subset
   * is passed through to the handler — see FORWARDABLE_FN_HEADERS.
   */
  headers?: Record<string, string | undefined>
  /**
   * True for an owner's test run (the dashboard's Test, functions invoke, the
   * generator's smoke test), so auth-gated endpoints are exercised instead of
   * dead-ending in 401/403: the function's SQL runs as the service role,
   * isAdminRequest answers true, and verifyToken reads OWNER_TEST_TOKEN as the
   * test user. The request carries no key or signed token. Never set on public
   * invocation paths.
   */
  testRun?: boolean
  /** Test hook: bypass the DB lookup for project auth material. */
  authMaterial?: ProjectFnAuth
}

/** How a run that never answered ended, in words for its error. */
function endedWithoutAnswer(outcome: IsolatedOutcome, what: string): string {
  if (outcome.killed === 'timeout') return `the ${what} did not finish in time`
  if (endedForMemory(outcome)) return `the ${what} used more memory than a function may`
  if (outcome.killed === 'output') return `the ${what} wrote more output than a function may`
  const how = outcome.signal ? `signal ${outcome.signal}` : `exit code ${outcome.exitCode}`
  return `the ${what}'s process ended before it answered (${how})`
}

/** The answers a route module's runner gets to its calls, all for `projectId`. */
function routeCallHandlers(projectId: string): CallHandlers {
  return {
    // Outbound HTTP for module code: fetch's call shape, the egress guard's
    // rules. The runner never gets a fetch of its own from us; it asks here.
    async fetch([url, init]) {
      const options = (init && typeof init === 'object' ? init : {}) as Record<string, unknown>
      const headers: Record<string, string> = {}
      if (options.headers && typeof options.headers === 'object') {
        for (const [k, v] of Object.entries(options.headers as Record<string, unknown>)) headers[String(k)] = String(v)
      }
      const res = await safeFetch(String(url), {
        method: typeof options.method === 'string' ? options.method : 'GET',
        headers,
        body: typeof options.body === 'string' ? options.body : undefined,
        egressScope: 'function',
      })
      return { status: res.status, headers: [...res.headers.entries()], body: Buffer.from(await res.arrayBuffer()) }
    },
    // The project's own function login, on the first query; `refresh` after a
    // refused login re-derives and re-asserts it (function-db-role.ts).
    async 'db.connection'([opts]) {
      const refresh = !!(opts && typeof opts === 'object' && (opts as { refresh?: unknown }).refresh)
      const { connectionString, schema } = await functionDbConnection(projectId, { refresh })
      return { connectionString, searchPath: functionSearchPath(schema) }
    },
    // An event the module sends on its project's own stream label
    // (stream-notify.ts).
    async 'stream.notify'([payload]) {
      await sendToProjectStream(projectId, String(payload ?? ''))
      return true
    },
  }
}

/**
 * Compile and execute a route-module AiFunction.
 *
 * `event.data` is treated as BOTH the request JSON body (for POST/PUT/PATCH)
 * and the query string (so `?key=value` style code works for GET).
 * Auth reaches the handler three ways, in priority order:
 *   1. forwarded real headers (opts.headers)
 *   2. legacy body fields (event.data.__authToken / .authorization / .token)
 *   3. an owner's test run (opts.testRun), which the runner itself knows: the
 *      request carries OWNER_TEST_TOKEN, never a key or a signed token
 */
export async function executeRouteModuleFunction(
  code: string,
  projectId: string,
  event: { type: string; data: Record<string, any> },
  triggerTableHint?: string | null,
  opts: RouteModuleRunOptions = {}
): Promise<RouteModuleRunResult> {
  assertNotBlocked(code)

  // Project auth material — resolved once per execution, used here only.
  // Fail-soft to nulls; gates then fail closed.
  const auth: ProjectFnAuth = opts.authMaterial ?? (await loadProjectFnAuth(projectId))

  // 1. Strip TypeScript → runnable CommonJS. esbuild generates the import/cjs
  //    interop helpers (__toESM etc.) so default + named imports both work.
  let compiled: string
  try {
    compiled = compileModule(code)
  } catch (err: any) {
    throw new Error(`Route module failed to compile: ${err?.message || String(err)}`)
  }

  // 2. The request, and who sent it. The headers are the only verified
  //    evidence of who is calling, and the caller's identity is what the
  //    function's database runs as.
  const data = (event.data && typeof event.data === 'object') ? event.data : {}
  // Headers, in priority order: forwarded real headers → legacy body token →
  // test-run injection. Later sources never overwrite earlier ones.
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  for (const name of FORWARDABLE_FN_HEADERS) {
    const v = opts.headers?.[name]
    if (typeof v === 'string' && v) headers[name] = v
  }
  const bodyToken = data.__authToken || data.authorization || data.token || ''
  if (bodyToken && !headers['x-user-token'] && !headers['authorization']) {
    const bearer = `Bearer ${String(bodyToken).replace(/^Bearer\s+/i, '')}`
    headers['x-user-token'] = bearer
    headers['authorization'] = bearer
  }

  // ── The two spellings of "here is my token" are made equivalent ─────────────
  //
  // Generated route modules auth-gate with
  //
  //     verifyToken(request.headers.get('x-user-token')?.replace(/^Bearer /,''))
  //
  // because that is the single line the generator's runtime contract shows them.
  // A client sending the far more idiomatic `Authorization: Bearer <token>` got
  // a 401 from `/fn/*`, while `/auth/*` on the same project accepted it.
  // Normalising here fixes every function already deployed, without
  // regenerating any of them. A function written against either header now
  // works with either header.
  if (headers['authorization'] && !headers['x-user-token']) {
    headers['x-user-token'] = headers['authorization']
  } else if (headers['x-user-token'] && !headers['authorization']) {
    headers['authorization'] = headers['x-user-token']
  }
  // An owner's test run: the request carries the placeholder where a user's
  // token would be, never the admin key or a token signed with the project's
  // secret, and its identity is the runner's to give.
  const testRun = opts.testRun === true
  if (testRun && !headers['x-user-token']) {
    headers['x-user-token'] = `Bearer ${OWNER_TEST_TOKEN}`
    if (!headers['authorization']) headers['authorization'] = headers['x-user-token']
  }

  const callerIdentity: RlsIdentity = testRun
    ? { userId: null, isServiceRole: true }
    : await resolveCallerIdentity(projectId, headers, auth)

  const { getDecryptedEnvMap } = await import('@/lib/services/projectEnvVars')
  const projectEnv = await getDecryptedEnvMap(projectId).catch(() => ({} as Record<string, string>))

  // 3. Run it, in a runner process of its own.
  const outcome = await runIsolated(
    {
      kind: 'route',
      payload: {
        projectId,
        compiled,
        hint: triggerTableHint ?? null,
        data: encodeValue(data),
        headers,
        env: projectEnv,
        testRun,
        verifiedTokens: projectSignedTokens(headers, data, auth),
        adminKey: presentedAdminKey(headers, auth),
        db: {
          sessionSql: FUNCTION_DB_SESSION_SQL,
          claims: functionDbClaims(callerIdentity),
          serviceClaims: [...SERVICE_DB_CLAIMS],
          streamLabel: projectStreamLabel(projectId),
        },
        timeoutMs: EXECUTION_TIMEOUT_MS,
        ...helperText(),
      },
      hardTimeoutMs: RUN_HARD_TIMEOUT_MS,
    },
    routeCallHandlers(projectId),
  )

  // 4. What it answered, or why it did not.
  const result = outcome.result
  if (!result) {
    if (outcome.killed === 'timeout') throw new Error(TIMEOUT_MESSAGE)
    throw new RouteModuleHandlerError(`The function did not answer: ${endedWithoutAnswer(outcome, 'run')}.`)
  }
  if (!result.ok) {
    // The 10s race cannot tell a hung handler from slow infrastructure, so a
    // timeout stays a plain Error. Everything else thrown by the handler came
    // out of the HANDLER itself, and the type says so: callers that must
    // distinguish "the function is broken" from "the machinery failed" check the
    // class instead of sniffing message text.
    switch (result.errorKind) {
      case 'evaluation':
        throw new Error(`Route module evaluation error: ${result.error}`)
      case 'exports':
        throw new Error('Route module exports no GET/POST/PUT/PATCH/DELETE handler')
      case 'timeout':
        throw new Error(TIMEOUT_MESSAGE)
      default:
        throw new RouteModuleHandlerError(result.error || 'Route function error')
    }
  }

  const answer = (result.value && typeof result.value === 'object' ? result.value : {}) as Record<string, unknown>
  const status = typeof answer.status === 'number' ? answer.status : 200
  const answerHeaders: Record<string, string> = {}
  if (answer.headers && typeof answer.headers === 'object' && !Array.isArray(answer.headers)) {
    for (const [k, v] of Object.entries(answer.headers as Record<string, unknown>)) {
      if (typeof v === 'string') answerHeaders[k] = v
    }
  }
  return { logs: result.logs, returnValue: { status, body: answer.body as any }, headers: answerHeaders }
}
