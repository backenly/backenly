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
 * Route modules were once *first-party deterministic templates* from our own
 * repo. That premise no longer holds: functions deploy_code stores agent-written
 * modules verbatim and the generator stores model-written ones, so the code
 * here is free-form. They still run in an in-process vm — NOT the locked
 * ctx-only sandbox — because they need the real `prisma` client + `verifyToken`,
 * but every capability handed into that vm must now assume hostile code:
 * the static denylist, the curated require/process shims, and outbound HTTP
 * through the same egress guard as ctx.http (never the host's bare fetch).
 *
 * Security model:
 *  - Static signature check: must be a recognised route module (export GET/
 *    POST/PATCH/DELETE) AND must not contain eval/Function/child_process/
 *    dynamic-import/fs-write/worker_threads/process-control patterns. Fail
 *    closed otherwise. process.env IS readable — but only through a frozen
 *    shim (makeCuratedProcess) holding the project's own variables, never the
 *    real process object, and never a secret Backenly signs or checks with.
 *  - Curated module resolver: only next/server (shim), @/lib/db, @/lib/auth/jwt,
 *    crypto, bcryptjs, jsonwebtoken resolve. Everything else throws. Trusted
 *    work and admin checks go through helpers those modules export (asService,
 *    isAdminRequest), which use the project's material without handing it over.
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
import { makeRlsAwarePrisma, refusingPrisma, type RlsAwarePrisma } from './rls-aware-db'
import { functionDbClient, forgetFunctionDbClient } from './function-db-role'
import type { RlsIdentity } from '@/lib/services/rls-session'
import { safeFetch } from '@/lib/security/outbound-guard'
import { resolveEndUserFromToken } from '@/server/lib/end-user-identity'
import { FORWARDABLE_FN_HEADERS } from './forward-headers'
import { withoutComments } from './integration-use'

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
  // process.env is NOT blocked: a function reads the project's own variables
  // there. The vm receives a frozen env of those (see makeCuratedProcess) —
  // never the real one, and never a secret Backenly signs or checks with.
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
// The vm gets a frozen, PER-PROJECT env — never the real process object:
//
//   the project's own variables (Settings → Environment, ctx.env in a
//   described function), as process.env.KEY, which is how a route function
//   reads configuration: one set of variables for both kinds of function;
//   NODE_ENV, which is not a secret.
//
// JWT_SECRET, ADMIN_API_KEY and AI_EXECUTION_TOKEN used to hold the project's
// end-user signing secret and its derived admin key. Function code is
// free-form (deploy_code stores what an agent wrote), and any function could
// read and return them: the signing secret mints a session as any of the
// project's users. They now hold WITHHELD, a value made for this invocation
// that matches nothing:
//
//   - removed outright, a gate written `(header ?? '') === (env ?? '')`, or
//     `header == env`, would let every caller in once the variable was gone;
//     a random value no caller can send fails every such comparison closed;
//   - jsonwebtoken refuses to sign with it, and verifies with the project's
//     secret in its place, so code that checked a user's token with
//     `jwt.verify(token, process.env.JWT_SECRET)` keeps working without holding
//     the secret (makeJsonwebtokenShim).
//
// Admin endpoints check `isAdminRequest(request)` and token checks call
// `verifyToken(token)`, both from '@/lib/auth/jwt'; trusted SQL runs in
// `asService(fn)` from '@/lib/db'. Backenly's own variables are set after the
// project's, so a project variable cannot take one of these names.
export const WITHHELD_ENV_NAMES = ['JWT_SECRET', 'ADMIN_API_KEY', 'AI_EXECUTION_TOKEN'] as const

/** A value for one invocation that no caller can know, so no comparison with it succeeds. */
function makeWithheld(): string {
  return `withheld:${nodeCrypto.randomBytes(24).toString('hex')}`
}

function makeCuratedProcess(withheld: string, projectEnv: Record<string, string> = {}): { env: Record<string, string> } {
  const env: Record<string, string> = { ...projectEnv }
  for (const name of WITHHELD_ENV_NAMES) env[name] = withheld
  if (process.env.NODE_ENV !== undefined) env.NODE_ENV = process.env.NODE_ENV
  return Object.freeze({ env: Object.freeze(env) }) as { env: Record<string, string> }
}

// ─── Project-aware auth shims ────────────────────────────────────────────────
// Templates import verifyToken from '@/lib/auth/jwt'. Here it verifies against
// the PROJECT's secret only: real end-user tokens are signed with it. It used to
// fall back to the platform verifier for "legacy/internal tokens", which let a
// Backenly session token, signed with the platform's secret for a person using
// the console, pass as one of the project's end users.
function makeProjectVerifyToken(auth: ProjectFnAuth) {
  const realJwt: typeof jsonwebtoken = (jsonwebtoken as any).default ?? jsonwebtoken
  return function projectVerifyToken(token: string): any {
    if (!token || typeof token !== 'string' || !auth.jwtSecret) return null
    try {
      return realJwt.verify(token, auth.jwtSecret, { algorithms: ['HS256'] })
    } catch {
      return null
    }
  }
}

/**
 * `isAdminRequest(request)`: true when the request carries this project's admin
 * key (Settings → Functions shows it), in `x-admin-key` or as a bearer token.
 * Compared here, so the function never holds the key. A project without one,
 * or a request without one, is never an admin.
 */
function makeIsAdminRequest(auth: ProjectFnAuth) {
  return function isAdminRequest(request: any): boolean {
    if (!auth.adminKey) return false
    const headers = request?.headers
    const read = (name: string): string => {
      const v = typeof headers?.get === 'function' ? headers.get(name) : headers?.[name]
      return typeof v === 'string' ? v.trim() : ''
    }
    const presented = read('x-admin-key') || read('authorization').replace(/^Bearer\s+/i, '')
    return presented.length > 0 && safeEqual(presented, auth.adminKey)
  }
}

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
    const realJwt: typeof jsonwebtoken = (jsonwebtoken as any).default ?? jsonwebtoken
    payload = realJwt.verify(token, auth.jwtSecret, { algorithms: ['HS256'] }) as any
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

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return nodeCrypto.timingSafeEqual(ab, bb)
}

// jsonwebtoken, as function code sees it.
//
// process.env.JWT_SECRET holds WITHHELD (makeCuratedProcess). Signing with it
// is refused: a function does not mint sessions for the project's users.
// Verifying with it checks the token against the project's own secret, so a
// function that verified a caller's token that way keeps working. Any other
// secret is the function's own business, as before.
//
// Templates that signed tokens with the project secret omitted the projectId
// claim, which the runtime requires; sign still adds it for a payload naming a
// userId, for tokens a function signs with a secret of its own.
export const SIGN_REFUSED =
  "Functions cannot sign the project's end-user sessions: Backenly no longer gives function code the project's signing secret. " +
  "Check a caller's token with verifyToken(token) from '@/lib/auth/jwt'."

function makeJsonwebtokenShim(projectId: string, auth: ProjectFnAuth, withheld: string) {
  const real: any = (jsonwebtoken as any).default ?? jsonwebtoken
  const sign = (payload: any, secret: any, ...rest: any[]) => {
    if (secret === withheld) throw new Error(SIGN_REFUSED)
    const needsProjectId =
      payload &&
      typeof payload === 'object' &&
      !Buffer.isBuffer(payload) &&
      payload.userId &&
      !payload.projectId
    return real.sign(needsProjectId ? { ...payload, projectId } : payload, secret, ...rest)
  }
  const verify = (token: any, secret: any, ...rest: any[]) =>
    real.verify(token, secret === withheld ? (auth.jwtSecret ?? withheld) : secret, ...rest)
  const shim: any = { ...real, sign, verify }
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

/** `asService(fn)`: run `fn`'s SQL in one transaction as the service role. */
export type AsService = <T>(fn: (db: RlsAwarePrisma) => Promise<T>) => Promise<T>

/** The line a run's logs carry for each asService block, so it can be seen afterwards. */
export const AS_SERVICE_NOTE =
  'Backenly: a block ran with asService, as the service role; row-level security did not apply to its SQL.'

function buildRequire(
  projectId: string,
  auth: ProjectFnAuth,
  db: { prisma: RlsAwarePrisma; asService: AsService },
  withheld: string,
): (id: string) => any {
  const nextServer = makeNextServerShim()
  const projectVerifyToken = makeProjectVerifyToken(auth)
  const isAdminRequest = makeIsAdminRequest(auth)
  const jwtShim = makeJsonwebtokenShim(projectId, auth, withheld)
  return (id: string) => {
    switch (id) {
      case 'next/server':
        return nextServer
      case '@/lib/db':
        return { prisma: db.prisma, asService: db.asService }
      case '@/lib/auth/jwt':
        return { verifyToken: projectVerifyToken, isAdminRequest }
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

/**
 * The database handle a function receives as `@/lib/db`: every raw query runs
 * with the caller's identity set (rls-aware-db.ts), on a connection that logs in
 * as the project's own function role (function-db-role.ts). Handing over the
 * bare client instead is what made generated reads of RLS-protected tables come
 * back empty, and what let function SQL read the platform's own tables.
 */
function scopedDb(projectId: string, identity: RlsIdentity): RlsAwarePrisma {
  return makeRlsAwarePrisma(identity, async (opts) => {
    if (opts?.refresh) await forgetFunctionDbClient(projectId)
    return functionDbClient(projectId)
  })
}

/**
 * Trusted work: `asService(async (db) => { … })` from '@/lib/db'.
 *
 * A function's SQL runs as its caller, so row-level security keeps a shopper to
 * their own rows. Some work a function does on the caller's behalf must reach
 * further: a checkout creates the order and takes the stock, and the shopper may
 * not update products. The only way to do that used to be the caller sending
 * the admin key, which no shopper has. QA's checkout answered "Your cart is
 * empty": its SELECT … FOR UPDATE on products was filtered by the products
 * UPDATE policy.
 *
 * asService runs the block in one transaction with the service-role identity,
 * so policies admit it and FOR UPDATE locks what it reads. It is the project's
 * own function login all the same (function-db-role.ts): nothing outside the
 * project's schema, ever. It is explicit in the code, a line in the run's logs
 * says it ran, and deploy_code says the function uses it.
 */
function makeAsService(projectId: string, logs: string[]): AsService {
  const serviceDb = scopedDb(projectId, { userId: null, isServiceRole: true })
  return async (fn) => {
    if (typeof fn !== 'function') throw new TypeError('asService takes a function: asService(async (db) => { ... })')
    logs.push(AS_SERVICE_NOTE)
    return serviceDb.$transaction(fn)
  }
}

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
  if (readsWithheldEnv(code)) return { valid: false, methods: [], error: WITHHELD_READ_REFUSED }

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
  const validationWithheld = makeWithheld()
  const sandbox: Record<string, any> = {
    module: { exports: moduleExports },
    exports: moduleExports,
    // Dummy auth material — evaluation only defines the handlers; nothing runs.
    require: buildRequire(
      '00000000-0000-4000-8000-000000000000',
      { jwtSecret: null, adminKey: null },
      {
        prisma: refusingPrisma('The database is not reachable while a function is being validated.'),
        asService: () => Promise.reject(new Error('The database is not reachable while a function is being validated.')),
      },
      validationWithheld,
    ),
    console: { log() {}, error() {}, warn() {}, info() {} },
    URL, URLSearchParams, TextEncoder, TextDecoder, Buffer,
    // Evaluation only defines the handlers, but TOP-LEVEL statements do run —
    // and they must not reach the network, let alone through the host's fetch.
    // A synchronous throw (not a rejected promise) so a fire-and-forget call
    // fails the evaluation instead of surfacing as an unhandled rejection.
    fetch: () => { throw new Error('fetch is not available while a function is being validated.') },
    setTimeout, clearTimeout,
    Promise, JSON, Math, Date, Error, Object, Array, String, Number, Boolean, RegExp,
    process: makeCuratedProcess(validationWithheld),
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


  const callerIdentity = await resolveCallerIdentity(projectId, headers, auth)

  // Outbound HTTP for module code: fetch's call shape, the egress guard's
  // rules. The host's bare fetch reaches everything this PROCESS can reach —
  // the cloud metadata service, the VPC, the loopback admin ports (PostgREST,
  // the runtime) — and module code is free-form, so it goes through the same
  // guard as ctx.http. The response is the guard's SafeResponse (ok/status/
  // headers.get/json/text/arrayBuffer), the same shape ctx.http returns.
  const guardedFetch = (input: any, init?: any) => {
    const url =
      typeof input === 'string' ? input
        : input instanceof URL ? input.toString()
          : typeof input?.url === 'string' ? input.url
            : String(input)
    const method = String(init?.method ?? (typeof input === 'object' && input?.method) ?? 'GET').toUpperCase()
    const outHeaders: Record<string, string> = {}
    const rawHeaders = init?.headers ?? (typeof input === 'object' ? input?.headers : undefined)
    if (rawHeaders) {
      if (typeof rawHeaders.forEach === 'function') {
        rawHeaders.forEach((v: unknown, k: unknown) => { outHeaders[String(k)] = String(v) })
      } else if (Array.isArray(rawHeaders)) {
        for (const [k, v] of rawHeaders) outHeaders[String(k)] = String(v)
      } else {
        for (const [k, v] of Object.entries(rawHeaders)) outHeaders[k] = String(v)
      }
    }
    let body: string | undefined
    const rawBody = init?.body
    if (rawBody !== undefined && rawBody !== null) {
      if (typeof rawBody === 'string') body = rawBody
      else if (Buffer.isBuffer(rawBody)) body = rawBody.toString('utf8')
      else if (rawBody instanceof URLSearchParams) body = rawBody.toString()
      else if (rawBody instanceof ArrayBuffer) body = Buffer.from(rawBody).toString('utf8')
      else if (ArrayBuffer.isView(rawBody)) body = Buffer.from(rawBody.buffer, rawBody.byteOffset, rawBody.byteLength).toString('utf8')
      else throw new TypeError('fetch body must be a string, Buffer, URLSearchParams or ArrayBuffer in function code — stringify JSON yourself')
    }
    const p = safeFetch(url, { method, headers: outHeaders, body, egressScope: 'function' })
    // A module that fires-and-forgets a blocked fetch must not take the process
    // down with an unhandled rejection; a caller that awaits still sees it.
    p.catch(() => {})
    return p
  }

  // 2. Run the module in a vm with a curated require + console capture.
  const { getDecryptedEnvMap } = await import('@/lib/services/projectEnvVars')
  const projectEnv = await getDecryptedEnvMap(projectId).catch(() => ({} as Record<string, string>))
  const logs: string[] = []
  const moduleExports: Record<string, any> = {}
  const withheld = makeWithheld()
  const sandbox: Record<string, any> = {
    module: { exports: moduleExports },
    exports: moduleExports,
    require: buildRequire(
      projectId,
      auth,
      { prisma: scopedDb(projectId, callerIdentity), asService: makeAsService(projectId, logs) },
      withheld,
    ),
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
    fetch: guardedFetch,
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
    process: makeCuratedProcess(withheld, projectEnv),
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
    const msg = err?.message || String(err)
    // The 10s race cannot tell a hung handler from slow infrastructure, so a
    // timeout stays a plain Error. Everything else thrown here came out of the
    // HANDLER itself, and the type says so: callers that must distinguish "the
    // function is broken" from "the machinery failed" check the class instead
    // of sniffing message text, which misread any handler error that happened
    // to mention "database" or "connect" as an infrastructure failure.
    if (msg === 'Route function timed out after 10s') throw new Error(msg)
    throw new RouteModuleHandlerError(msg)
  }

  // 5. Normalise the response.
  const status = typeof raw?.status === 'number' ? raw.status : 200
  const body = raw && raw.__backenlyResponse ? raw.body : (raw ?? null)
  const answerHeaders: Record<string, string> = raw && raw.__backenlyResponse && raw.headers ? raw.headers : {}
  return { logs, returnValue: { status, body }, headers: answerHeaders }
}

function stringify(v: any): string {
  if (typeof v === 'string') return v
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}
