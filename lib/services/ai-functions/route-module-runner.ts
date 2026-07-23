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
 *                         the NL function generator. Run in sandbox-worker.cjs.
 *   2. Route modules   — full Next.js handlers authored by
 *                         lib/ai/build-runtime/domain-business-logic.ts:
 *                           import { NextRequest, NextResponse } from 'next/server'
 *                           import { prisma } from '@/lib/db'
 *                           export async function GET(req: NextRequest) { ... }
 *
 * The Worker sandbox can only run #1. Before this runner existed, #2 was routed
 * into the sandbox too, where preprocessImports() rewrote its `import` lines to
 * `ctx.require(...)` and the blocklist then rejected the `require(` it had just
 * produced — so EVERY domain/schema endpoint (jobs, wallets, orders, admin,
 * *-schema, ...) failed on every invocation path with:
 *   "Blocked: code contains forbidden pattern '\brequire\s*\('"
 *
 * Route modules are *first-party deterministic templates* from our own repo
 * (never user/LLM free-form), use only parameterised SQL, and need the real
 * `prisma` client + `verifyToken`. They are therefore run with first-party
 * privilege in an in-process vm — NOT in the locked ctx-only sandbox — behind
 * a hardened static denylist as defence in depth.
 *
 * Security model:
 *  - Static signature check: must be a recognised route module (export GET/
 *    POST/PATCH/DELETE) AND must not contain eval/Function/child_process/
 *    dynamic-import/fs-write/worker_threads/process-control patterns. Fail
 *    closed otherwise. process.env IS readable — but only through a frozen
 *    allowlist shim (CURATED_ENV_KEYS), never the real process object.
 *  - Curated module resolver: only next/server (shim), @/lib/db, @/lib/auth/jwt,
 *    crypto, bcryptjs, jsonwebtoken resolve. Everything else throws.
 *  - 10s hard timeout via vm `timeout` + Promise.race backup.
 *  - Handler return value (a NextResponse) is normalised to { status, body }.
 *    A non-2xx status is still a SUCCESSFUL execution (the handler ran and
 *    answered) — only thrown errors / timeouts are failures. This stops
 *    auth-gated endpoints from showing a false red "Failed" when a manual
 *    test run legitimately returns 401.
 */

import * as vm from 'vm'
import * as nodeCrypto from 'crypto'
import { prisma } from '@/lib/db'
import { verifyToken } from '@/lib/auth/jwt'
import * as bcryptjs from 'bcryptjs'
import * as jsonwebtoken from 'jsonwebtoken'
import { loadProjectFnAuth, mintTestRunToken, ProjectFnAuth } from './project-fn-auth'
import { makeRlsAwarePrisma } from './rls-aware-db'
import type { RlsIdentity } from '@/lib/services/rls-session'
import { FORWARDABLE_FN_HEADERS } from './forward-headers'

// esbuild is a native binary package — load it lazily through a non-bundled
// require so Next.js never tries to trace/bundle the binary into the server
// output. It is a normal runtime dependency, always present in node_modules.
let _esbuildTransformSync:
  | ((code: string, opts: any) => { code: string })
  | null = null
function getEsbuildTransformSync() {
  if (_esbuildTransformSync) return _esbuildTransformSync
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const req = eval('require') as NodeRequire
  _esbuildTransformSync = req('esbuild').transformSync
  return _esbuildTransformSync!
}

const EXECUTION_TIMEOUT_MS = 10_000

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

// ─── Hardened denylist (defence in depth — these templates are first-party) ───

const HARD_BLOCKED: Array<[RegExp, string]> = [
  [/\bchild_process\b/, 'child_process is not permitted'],
  [/\bworker_threads\b/, 'worker_threads is not permitted'],
  // process.env is NOT blocked: the first-party templates legitimately read a
  // small set of vars (ADMIN_API_KEY, JWT_SECRET, ...). The vm receives a
  // frozen allowlist-only env (see makeCuratedProcess) — never the real one.
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

// ─── Curated process shim ─────────────────────────────────────────────────────
// The generated templates read a small set of env vars (admin gate, JWT
// signing, webhook signature, prod/dev branch). The vm gets a frozen,
// PER-PROJECT env — never the real process object:
//
//   JWT_SECRET         → the PROJECT's resolved jwtSecret. End-user tokens are
//                        signed with it, so templates that sign (impersonate)
//                        or verify now speak the project's own auth dialect.
//   ADMIN_API_KEY /
//   AI_EXECUTION_TOKEN → the derived per-project admin key. Previously these
//                        exposed Backenly's PLATFORM secrets, which (a) leaked
//                        infra credentials into generated-code space and
//                        (b) made every admin endpoint uncallable by the
//                        developer, who can never know a platform secret.
//
// When project auth material is unavailable the values are empty strings —
// auth gates then fail closed (403), never open. The rest of process.env
// (DATABASE_URL, SMTP creds, Paddle keys, ...) stays unreachable.
function makeCuratedProcess(auth: ProjectFnAuth): { env: Record<string, string> } {
  const env: Record<string, string> = {
    ADMIN_API_KEY: auth.adminKey ?? '',
    AI_EXECUTION_TOKEN: auth.adminKey ?? '',
    JWT_SECRET: auth.jwtSecret ?? '',
  }
  for (const key of ['NODE_ENV', 'STRIPE_WEBHOOK_SECRET', 'PAYMENT_WEBHOOK_SECRET']) {
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }
  return Object.freeze({ env: Object.freeze(env) }) as { env: Record<string, string> }
}

// ─── Project-aware auth shims ────────────────────────────────────────────────
// Templates import verifyToken from '@/lib/auth/jwt' — which verifies against
// the PLATFORM JWT_SECRET. Real end-user tokens are signed with the project's
// jwtSecret, so every user-gated endpoint 401'd for every real user. The shim
// verifies against the project secret first, then falls back to the platform
// verifier for legacy/internal tokens. Fixes all stored functions at once.
function makeProjectVerifyToken(auth: ProjectFnAuth) {
  const realJwt: typeof jsonwebtoken = (jsonwebtoken as any).default ?? jsonwebtoken
  return function projectVerifyToken(token: string): any {
    if (!token || typeof token !== 'string') return null
    if (auth.jwtSecret) {
      try {
        return realJwt.verify(token, auth.jwtSecret, { algorithms: ['HS256'] })
      } catch {
        /* fall through to platform verifier */
      }
    }
    return verifyToken(token)
  }
}

/**
 * Who is this invocation acting as, for the purposes of RLS?
 *
 * Derived ONLY from verified request material — a token this project signed, or
 * this project's derived admin key. Never from the function body, and never
 * from an unverified claim in the payload.
 *
 * The default is `anon` (no user id, not service role), which is the secure
 * one: own-rows policies match nothing. That is a visibly empty result rather
 * than someone else's data.
 */
function resolveCallerIdentity(
  headers: Record<string, string | undefined>,
  auth: ProjectFnAuth,
): RlsIdentity {
  // An owner-issued admin key is a server-side decision, so it may name
  // service_role. Compared with timingSafeEqual because it is a secret.
  const presentedAdminKey = headers['x-admin-key']
  if (auth.adminKey && presentedAdminKey && safeEqual(presentedAdminKey, auth.adminKey)) {
    return { userId: null, isServiceRole: true }
  }

  const raw = headers['x-user-token'] ?? headers['authorization']
  const token = raw?.replace(/^Bearer\s+/i, '').trim()
  if (!token || !auth.jwtSecret) return { userId: null, isServiceRole: false }

  try {
    const realJwt: typeof jsonwebtoken = (jsonwebtoken as any).default ?? jsonwebtoken
    const payload = realJwt.verify(token, auth.jwtSecret, { algorithms: ['HS256'] }) as any
    // End-user tokens carry the id under a few historical names. `sub` is the
    // one the claim predicates read, so any of them maps onto it.
    const userId = payload?.sub ?? payload?.userId ?? payload?.user_id ?? payload?.id ?? null
    if (!userId) return { userId: null, isServiceRole: false }
    return {
      userId: String(userId),
      isServiceRole: false,
      userRole: typeof payload?.role === 'string' ? payload.role : undefined,
    }
  } catch {
    // An unverifiable token is not an identity. Falling back to service_role
    // here would turn a bad token into full table access.
    return { userId: null, isServiceRole: false }
  }
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return nodeCrypto.timingSafeEqual(ab, bb)
}

// Templates that SIGN tokens (admin-impersonate) omitted the projectId claim,
// so the issued token was rejected by v1ApiMiddleware (which requires
// payload.projectId === projectId). Wrap jsonwebtoken.sign to inject the claim
// for stored functions that predate the template fix.
function makeJsonwebtokenShim(projectId: string) {
  const real: any = (jsonwebtoken as any).default ?? jsonwebtoken
  const sign = (payload: any, secret: any, opts?: any) => {
    const needsProjectId =
      payload &&
      typeof payload === 'object' &&
      !Buffer.isBuffer(payload) &&
      payload.userId &&
      !payload.projectId
    return real.sign(needsProjectId ? { ...payload, projectId } : payload, secret, opts)
  }
  const shim: any = { ...real, sign }
  shim.default = shim // CJS/ESM interop — `import jwt from 'jsonwebtoken'` gets the shim too
  return shim
}

// ─── next/server shim ─────────────────────────────────────────────────────────
// The generated code only ever uses NextResponse.json(body, { status }) and
// the NextRequest accessors req.headers.get / req.json / req.url. We provide
// faithful, dependency-free shims so execution is deterministic and does not
// require booting the Next.js runtime inside the Express server process.

interface ShimResponse {
  __backenlyResponse: true
  status: number
  body: any
  headers: Record<string, string>
}

function makeNextServerShim() {
  const NextResponse = {
    json(body: any, init?: { status?: number; headers?: Record<string, string> }): ShimResponse {
      return {
        __backenlyResponse: true,
        status: init?.status ?? 200,
        body,
        headers: { 'content-type': 'application/json', ...(init?.headers || {}) },
      }
    },
  }
  // NextRequest is only used as a type in the generated code; a value export
  // keeps `import { NextRequest } from 'next/server'` from being undefined.
  class NextRequest {}
  return { NextResponse, NextRequest }
}

class RunnerRequest {
  url: string
  method: string
  /**
   * Real URL instance, so `req.nextUrl.searchParams.get('x')` and
   * `req.nextUrl.pathname` behave exactly like NextRequest. Generated code
   * alternates between `new URL(req.url)` and `req.nextUrl` — both must work,
   * or half the generated GET endpoints crash on their first invocation.
   */
  nextUrl: URL
  private _headers: Map<string, string>
  private _body: any
  constructor(opts: { url: string; headers: Record<string, string>; body: any; method?: string }) {
    this.url = opts.url
    this.method = (opts.method || 'GET').toUpperCase()
    this.nextUrl = new URL(opts.url)
    this._headers = new Map(
      Object.entries(opts.headers || {}).map(([k, v]) => [k.toLowerCase(), String(v)])
    )
    this._body = opts.body
  }
  get headers() {
    const m = this._headers
    return {
      get: (name: string) => m.get(String(name).toLowerCase()) ?? null,
      has: (name: string) => m.has(String(name).toLowerCase()),
      forEach: (cb: (value: string, key: string) => void) => m.forEach((v, k) => cb(v, k)),
      entries: () => m.entries(),
    }
  }
  /** NextRequest-compatible cookie accessor: `req.cookies.get('x')?.value`. */
  get cookies() {
    const parsed = new Map<string, string>()
    const raw = this._headers.get('cookie') || ''
    for (const pair of raw.split(';')) {
      const idx = pair.indexOf('=')
      if (idx > 0) {
        const name = pair.slice(0, idx).trim()
        if (name) parsed.set(name, decodeURIComponent(pair.slice(idx + 1).trim()))
      }
    }
    return {
      get: (name: string) => (parsed.has(name) ? { name, value: parsed.get(name)! } : undefined),
      has: (name: string) => parsed.has(name),
      getAll: () => [...parsed.entries()].map(([name, value]) => ({ name, value })),
    }
  }
  async json() {
    return this._body ?? {}
  }
  async text() {
    return typeof this._body === 'string' ? this._body : JSON.stringify(this._body ?? {})
  }
  async formData() {
    // Generated handlers occasionally probe formData on JSON invocations —
    // return an empty-compatible Map-backed shim instead of crashing.
    const entries = Object.entries(this._body && typeof this._body === 'object' ? this._body : {})
    return {
      get: (name: string) => entries.find(([k]) => k === name)?.[1] ?? null,
      has: (name: string) => entries.some(([k]) => k === name),
      entries: () => entries[Symbol.iterator](),
    }
  }
}

// ─── Curated module resolver ──────────────────────────────────────────────────

function buildRequire(
  projectId: string,
  auth: ProjectFnAuth,
  identity: RlsIdentity = { userId: null, isServiceRole: false },
): (id: string) => any {
  const nextServer = makeNextServerShim()
  const projectVerifyToken = makeProjectVerifyToken(auth)
  const jwtShim = makeJsonwebtokenShim(projectId)
  // Every raw query this function issues runs with the caller's identity set on
  // the connection. Handing over the bare client instead is what made every
  // generated read of an RLS-protected table return an empty list and every
  // write fail 42501 — see lib/services/ai-functions/rls-aware-db.ts.
  const scopedPrisma = makeRlsAwarePrisma(identity)
  return (id: string) => {
    switch (id) {
      case 'next/server':
        return nextServer
      case '@/lib/db':
        return { prisma: scopedPrisma }
      case '@/lib/auth/jwt':
        return { verifyToken: projectVerifyToken }
      case 'crypto':
      case 'node:crypto':
        return nodeCrypto
      case 'bcryptjs':
        return (bcryptjs as any).default ?? bcryptjs
      case 'jsonwebtoken':
        return jwtShim
      default:
        throw new Error(
          `Module "${id}" is not available to route functions. ` +
          `Allowed: next/server, @/lib/db, @/lib/auth/jwt, crypto, bcryptjs, jsonwebtoken.`
        )
    }
  }
}

// ─── Method resolution ────────────────────────────────────────────────────────

const METHOD_RE = /^\s*(GET|POST|PUT|PATCH|DELETE)\b/i

/**
 * Pick which exported handler to call. Prefer the method declared on the
 * function's triggerTable (e.g. "GET /api/v1/<pid>/fn/<name>"); otherwise fall
 * back to the single exported handler.
 */
function resolveMethod(
  exportsObj: Record<string, any>,
  triggerTableHint?: string | null
): { method: string; handler: (req: any, ctx?: any) => any } | null {
  const available = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].filter(
    m => typeof exportsObj[m] === 'function'
  )
  if (available.length === 0) return null

  const hinted = triggerTableHint?.match(METHOD_RE)?.[1]?.toUpperCase()
  const chosen = (hinted && available.includes(hinted) ? hinted : available[0])
  return { method: chosen, handler: exportsObj[chosen] }
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
 * compile → vm module evaluation → exported-handler check. This is the gate
 * every generated/repaired route module must pass BEFORE it is stored as an
 * active function, so an agent can never persist code that crashes on its
 * first invocation. Zero side effects: the handler is never called, no DB or
 * network is touched (module top-level only defines functions).
 */
export function validateRouteModule(code: string, expectedMethod?: string | null): RouteModuleValidation {
  try {
    assertNotBlocked(code)
  } catch (err: any) {
    return { valid: false, methods: [], error: err?.message || String(err) }
  }

  let compiled: string
  try {
    compiled = getEsbuildTransformSync()(code, {
      loader: 'ts',
      format: 'cjs',
      target: 'node18',
      platform: 'node',
    }).code
  } catch (err: any) {
    return { valid: false, methods: [], error: `Compile error: ${err?.message || String(err)}` }
  }

  const moduleExports: Record<string, any> = {}
  const sandbox: Record<string, any> = {
    module: { exports: moduleExports },
    exports: moduleExports,
    // Dummy auth material — evaluation only defines the handlers; nothing runs.
    require: buildRequire('00000000-0000-4000-8000-000000000000', { jwtSecret: null, adminKey: null }),
    console: { log() {}, error() {}, warn() {}, info() {} },
    URL, URLSearchParams, TextEncoder, TextDecoder, Buffer,
    fetch, setTimeout, clearTimeout,
    Promise, JSON, Math, Date, Error, Object, Array, String, Number, Boolean, RegExp,
    process: makeCuratedProcess({ jwtSecret: null, adminKey: null }),
    global: undefined,
    globalThis: undefined,
  }
  vm.createContext(sandbox)
  try {
    new vm.Script(compiled, { filename: 'route-function-validate.js' }).runInContext(sandbox, {
      timeout: 3_000,
    })
  } catch (err: any) {
    return { valid: false, methods: [], error: `Evaluation error: ${err?.message || String(err)}` }
  }

  const finalExports = sandbox.module.exports || moduleExports
  const methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].filter(
    m => typeof finalExports[m] === 'function'
  )
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

export interface RouteModuleRunResult {
  logs: string[]
  returnValue: { status: number; body: any }
}

export interface RouteModuleRunOptions {
  /**
   * Real request headers forwarded from the invocation surface (public /fn/
   * route, Express runtime, functions/invoke). Only the auth/signature subset
   * is passed through to the handler — see FORWARDABLE_FN_HEADERS.
   */
  headers?: Record<string, string | undefined>
  /**
   * True for owner-initiated dashboard test runs. Injects the project's
   * admin key (x-admin-key) and a short-lived project-scoped admin end-user
   * token, so auth-gated endpoints can actually be exercised instead of
   * dead-ending in 401/403. Never set on public invocation paths.
   */
  testRun?: boolean
  /** Test hook: bypass the DB lookup for project auth material. */
  authMaterial?: ProjectFnAuth
}


/**
 * Compile and execute a route-module AiFunction.
 *
 * `event.data` is treated as BOTH the request JSON body (for POST/PUT/PATCH)
 * and the query string (so `?key=value` style code works for GET).
 * Auth reaches the handler three ways, in priority order:
 *   1. forwarded real headers (opts.headers)
 *   2. legacy body fields (event.data.__authToken / .authorization / .token)
 *   3. test-run injection (opts.testRun) — project admin key + minted token
 */
export async function executeRouteModuleFunction(
  code: string,
  projectId: string,
  event: { type: string; data: Record<string, any> },
  triggerTableHint?: string | null,
  opts: RouteModuleRunOptions = {}
): Promise<RouteModuleRunResult> {
  assertNotBlocked(code)

  // Project auth material — resolved once per execution. Fail-soft to nulls;
  // the curated env then holds empty secrets and gates fail closed.
  const auth: ProjectFnAuth = opts.authMaterial ?? (await loadProjectFnAuth(projectId))

  // 1. Strip TypeScript → runnable CommonJS. esbuild generates the import/cjs
  //    interop helpers (__toESM etc.) so default + named imports both work.
  let compiled: string
  try {
    compiled = getEsbuildTransformSync()(code, {
      loader: 'ts',
      format: 'cjs',
      target: 'node18',
      platform: 'node',
    }).code
  } catch (err: any) {
    throw new Error(`Route module failed to compile: ${err?.message || String(err)}`)
  }

  // ── Caller identity, resolved BEFORE the sandbox is built ─────────────────
  //
  // The curated `require` hands the function its database handle, and that
  // handle carries the caller's RLS identity. So the headers have to be
  // assembled first — they are the only verified evidence of who is calling.
  //
  // This block used to run after the module had already been compiled and
  // given a bare Prisma client, which is why generated functions queried with
  // no identity at all and got empty results back from every RLS policy.
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
  // So a client sending the far more idiomatic `Authorization: Bearer <token>`
  // got a 401 from `/fn/*` — while `/auth/*` on the same project accepted it.
  // One backend, two contradictory answers to "how do I authenticate", and the
  // one that worked was the non-obvious one.
  //
  // Normalising here rather than in the prompt fixes EVERY function already
  // deployed, without regenerating any of them — the same reason the
  // jsonwebtoken and verifyToken shims exist above. A function written against
  // either header now works with either header.
  if (headers['authorization'] && !headers['x-user-token']) {
    headers['x-user-token'] = headers['authorization']
  } else if (headers['x-user-token'] && !headers['authorization']) {
    headers['authorization'] = headers['x-user-token']
  }
  if (opts.testRun) {
    if (auth.adminKey && !headers['x-admin-key']) {
      headers['x-admin-key'] = auth.adminKey
    }
    if (auth.jwtSecret && !headers['x-user-token']) {
      const bearer = `Bearer ${mintTestRunToken(projectId, auth.jwtSecret)}`
      headers['x-user-token'] = bearer
      if (!headers['authorization']) headers['authorization'] = bearer
    }
  }


  const callerIdentity = resolveCallerIdentity(headers, auth)

  // 2. Run the module in a vm with a curated require + console capture.
  const logs: string[] = []
  const moduleExports: Record<string, any> = {}
  const sandbox: Record<string, any> = {
    module: { exports: moduleExports },
    exports: moduleExports,
    require: buildRequire(projectId, auth, callerIdentity),
    console: {
      log: (...a: any[]) => logs.push(a.map(stringify).join(' ')),
      error: (...a: any[]) => logs.push(a.map(stringify).join(' ')),
      warn: (...a: any[]) => logs.push(a.map(stringify).join(' ')),
      info: (...a: any[]) => logs.push(a.map(stringify).join(' ')),
    },
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    Buffer,
    fetch,
    setTimeout,
    clearTimeout,
    Promise,
    JSON,
    Math,
    Date,
    Error,
    Object,
    Array,
    String,
    Number,
    Boolean,
    RegExp,
    process: makeCuratedProcess(auth),
    global: undefined,
    globalThis: undefined,
  }
  vm.createContext(sandbox)

  try {
    new vm.Script(compiled, { filename: 'route-function.js' }).runInContext(sandbox, {
      timeout: EXECUTION_TIMEOUT_MS,
    })
  } catch (err: any) {
    throw new Error(`Route module evaluation error: ${err?.message || String(err)}`)
  }

  // esbuild cjs output puts exports on module.exports
  const finalExports = sandbox.module.exports || moduleExports
  const resolved = resolveMethod(finalExports, triggerTableHint)
  if (!resolved) {
    throw new Error('Route module exports no GET/POST/PUT/PATCH/DELETE handler')
  }

  // 3. Build the request from the event payload.
  const query = new URLSearchParams()
  for (const [k, v] of Object.entries(data)) {
    if (k.startsWith('__') || k === 'authorization' || k === 'token') continue
    if (v != null && typeof v !== 'object') query.set(k, String(v))
  }
  const qs = query.toString()

  const reqObj = new RunnerRequest({
    url: `https://app.backenly.com/api/v1/${projectId}/fn${qs ? `?${qs}` : ''}`,
    headers,
    body: data,
    method: resolved.method,
  })

  // 4. Invoke with a hard timeout backstop.
  // Next.js route handlers are called as (request, { params }). Generated
  // functions frequently destructure the second arg (`const { projectId } =
  // params`), so we MUST supply it — passing only the request made every such
  // function crash with "Cannot destructure property 'params' of 'undefined'".
  // params carries projectId (the only dynamic segment on /fn routes) plus any
  // query values, matching what Next would provide.
  const routeCtx = { params: { projectId, ...Object.fromEntries(new URLSearchParams(qs)) } }
  let raw: any
  try {
    raw = await Promise.race([
      Promise.resolve(resolved.handler(reqObj, routeCtx)),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Route function timed out after 10s')), EXECUTION_TIMEOUT_MS)
      ),
    ])
  } catch (err: any) {
    throw new Error(err?.message || String(err))
  }

  // 5. Normalise the response.
  const status = typeof raw?.status === 'number' ? raw.status : 200
  const body = raw && raw.__backenlyResponse ? raw.body : (raw ?? null)
  return { logs, returnValue: { status, body } }
}

function stringify(v: any): string {
  if (typeof v === 'string') return v
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}
