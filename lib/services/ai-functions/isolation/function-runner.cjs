/**
 * FUNCTION RUNNER: one invocation of customer function code, in a process of its own
 * ===================================================================================
 *
 * Function code used to run in a node:vm context inside the web and runtime
 * processes, and in a worker thread of them. Those processes hold every platform
 * secret (DATABASE_URL, JWT_SECRET, the encryption keys, the Stripe key) and the
 * platform's database client, and node:vm is not a security mechanism: one line
 * such as `Object.constructor('return process')()` reaches the real process.
 *
 * So this file runs in a fresh process started for one invocation and then
 * thrown away. In production the root function supervisor
 * (function-supervisor.cjs) starts it under a uid no other running process
 * shares, with an environment holding nothing secret, in a private working
 * directory, under a heap limit, a wall-clock kill and an RSS watchdog. THAT
 * process and uid boundary is the security boundary. node:vm is kept here only
 * to give function code the shape it was written against (route modules call
 * `export async function GET(request)`, sandbox bodies use `ctx` and `event`);
 * nothing here assumes the vm holds. Escaping it reaches this process, which
 * holds only what this one invocation was given.
 *
 * What an invocation is given, and nothing else:
 *   - the code (route modules arrive compiled to CommonJS by the app),
 *   - the request, and the tokens in it the app already verified with the
 *     project's signing secret, which never comes here,
 *   - for route modules, the claims the app resolved for the caller; the
 *     project's own database login is asked for on the first query,
 *   - the project's own variables (process.env in a route module, ctx.env in a
 *     sandbox body).
 * Outbound HTTP, a sandbox body's ctx.db, ctx.integrations (whose keys stay in
 * the app) and the project's realtime stream are calls back to the app, which
 * answers them for this invocation's project only.
 *
 * Protocol, newline-delimited JSON on stdin and stdout:
 *   app -> runner  first line         { v: 1, kind, ...invocation }
 *   runner -> app  { t: 'call', id, method, args }
 *   app -> runner  { t: 'reply', id, ok, value | error }
 *   runner -> app  { t: 'result', ok, value | error, errorKind, logs }
 * Values that JSON cannot carry (undefined, BigInt, Date, bytes, Map, Set,
 * non-finite numbers) are tagged by encode() and restored by decode(); the
 * app's copy of the codec is lib/services/ai-functions/isolation/client.ts.
 * Everything else this process prints goes to stderr, which the supervisor
 * keeps the end of for the run's diagnostics.
 *
 * This is the only module in the repository that imports node:vm
 * (tests/unit/function-isolation-vm-imports.spec.ts fails the build otherwise).
 */

'use strict'

const vm = require('vm')
const fs = require('fs')
const nodeCrypto = require('crypto')
const readline = require('readline')

// ─── Wire codec ──────────────────────────────────────────────────────────────

const TAG = '$bkn'
const MAX_DEPTH = 1000

function encode(value) {
  return encodeAt(value, new Set(), 0)
}

function encodeAt(value, stack, depth) {
  if (depth > MAX_DEPTH) throw new RangeError('Value is nested too deeply to send')
  if (value === null) return null
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value
    case 'number':
      if (Number.isFinite(value)) return value
      return { [TAG]: 'f', v: Number.isNaN(value) ? 'NaN' : value > 0 ? 'Infinity' : '-Infinity' }
    case 'bigint':
      return { [TAG]: 'n', v: value.toString() }
    case 'undefined':
    case 'function':
    case 'symbol':
      return { [TAG]: 'u' }
    default:
      break
  }
  if (value instanceof Date) {
    const time = value.getTime()
    return { [TAG]: 'd', v: Number.isNaN(time) ? null : value.toISOString() }
  }
  if (Buffer.isBuffer(value) || ArrayBuffer.isView(value)) {
    return { [TAG]: 'b', v: Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('base64') }
  }
  if (value instanceof ArrayBuffer) return { [TAG]: 'b', v: Buffer.from(value).toString('base64') }
  if (stack.has(value)) throw new TypeError('Converting circular structure to JSON')
  stack.add(value)
  try {
    if (Array.isArray(value)) return value.map((item) => encodeAt(item, stack, depth + 1))
    if (value instanceof Map) {
      return { [TAG]: 'm', v: [...value].map(([k, v]) => [encodeAt(k, stack, depth + 1), encodeAt(v, stack, depth + 1)]) }
    }
    if (value instanceof Set) return { [TAG]: 's', v: [...value].map((item) => encodeAt(item, stack, depth + 1)) }
    if (typeof value.toJSON === 'function') return encodeAt(value.toJSON(), stack, depth + 1)
    const out = {}
    for (const key of Object.keys(value)) {
      const item = value[key]
      // As JSON: a property holding a function or a symbol is not sent.
      if (typeof item === 'function' || typeof item === 'symbol') continue
      out[key] = encodeAt(item, stack, depth + 1)
    }
    return Object.prototype.hasOwnProperty.call(out, TAG) ? { [TAG]: 'o', v: out } : out
  } finally {
    stack.delete(value)
  }
}

function decode(value) {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(decode)
  if (Object.prototype.hasOwnProperty.call(value, TAG) && typeof value[TAG] === 'string') {
    const v = value.v
    switch (value[TAG]) {
      case 'u':
        return undefined
      case 'f':
        return v === 'NaN' ? NaN : v === 'Infinity' ? Infinity : v === '-Infinity' ? -Infinity : NaN
      case 'n':
        if (typeof v !== 'string' || !/^-?\d{1,4096}$/.test(v)) throw new TypeError('Malformed BigInt on the wire')
        return BigInt(v)
      case 'd':
        return v === null ? new Date(NaN) : new Date(String(v))
      case 'b':
        return Buffer.from(typeof v === 'string' ? v : '', 'base64')
      case 'm':
        return new Map((Array.isArray(v) ? v : []).map((pair) => [decode(pair && pair[0]), decode(pair && pair[1])]))
      case 's':
        return new Set((Array.isArray(v) ? v : []).map(decode))
      case 'o':
        return decodePlain(v && typeof v === 'object' ? v : {})
      default:
        break
    }
  }
  return decodePlain(value)
}

/** A plain object from the wire. `__proto__` is defined as data, never set as a prototype. */
function decodePlain(value) {
  const out = {}
  for (const key of Object.keys(value)) {
    const item = decode(value[key])
    if (key === '__proto__') Object.defineProperty(out, key, { value: item, enumerable: true, writable: true, configurable: true })
    else out[key] = item
  }
  return out
}

// ─── Protocol ────────────────────────────────────────────────────────────────

let finished = false
let callSeq = 0
const pendingCalls = new Map()
/** Calls and queries still running, so work started without await can finish after the answer. */
let inflight = 0

function writeLine(message, done) {
  process.stdout.write(JSON.stringify(message) + '\n', done)
}

/** Set once nothing more will arrive on stdin: no call can be answered from then on. */
let inputClosed = false

function call(method, args) {
  if (inputClosed) return Promise.reject(new Error('Nothing is answering this run any more'))
  let encoded
  try {
    encoded = encode(args)
  } catch (err) {
    return Promise.reject(err)
  }
  const id = ++callSeq
  inflight++
  return new Promise((resolve, reject) => {
    pendingCalls.set(id, {
      resolve: (v) => { inflight--; resolve(v) },
      reject: (e) => { inflight--; reject(e) },
    })
    writeLine({ t: 'call', id, method, args: encoded })
  })
}

function onReply(line) {
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  if (!msg || msg.t !== 'reply') return
  const pending = pendingCalls.get(msg.id)
  if (!pending) return
  pendingCalls.delete(msg.id)
  if (msg.ok) {
    try {
      pending.resolve(decode(msg.value))
    } catch (err) {
      pending.reject(err)
    }
  } else {
    pending.reject(new Error(String(msg.error || 'The call failed')))
  }
}

function track(promise) {
  inflight++
  return promise.then(
    (v) => { inflight--; return v },
    (e) => { inflight--; throw e },
  )
}

/** Wait, at most `ms`, for work the function started without awaiting it. */
function settleInflight(ms) {
  const deadline = Date.now() + ms
  return new Promise((resolve) => {
    const tick = () => (inflight <= 0 || Date.now() >= deadline ? resolve() : setTimeout(tick, 10))
    tick()
  })
}

/** Send the run's one answer, let unawaited work finish briefly, and end the process. */
function finish(message, graceMs) {
  if (finished) return
  finished = true
  writeLine({ t: 'result', ...message }, () => {
    settleInflight(graceMs || 0).then(() => process.exit(0))
  })
}

function errorText(err) {
  return (err && err.message) || String(err)
}

// ─── Route modules ───────────────────────────────────────────────────────────

const ROUTE_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']
const METHOD_RE = /^\s*(GET|POST|PUT|PATCH|DELETE)\b/i
/** `SELECT pg_notify($1, $2)` on the project's own stream label goes to the project's channel (stream-notify.ts). */
const NOTIFY_STATEMENT = /^\s*select\s+(?:pg_catalog\s*\.\s*)?pg_notify\s*\(\s*\$1\s*,\s*\$2\s*\)\s*;?\s*$/i
const ROUTE_TIMEOUT_MESSAGE = 'Route function timed out after 10s'

function stringify(v) {
  if (typeof v === 'string') return v
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

function safeEqual(a, b) {
  const ab = Buffer.from(String(a))
  const bb = Buffer.from(String(b))
  if (ab.length !== bb.length) return false
  return nodeCrypto.timingSafeEqual(ab, bb)
}

function makeNextServerShim() {
  const NextResponse = {
    json(body, init) {
      return {
        __backenlyResponse: true,
        status: (init && init.status) ?? 200,
        body,
        headers: { 'content-type': 'application/json', ...((init && init.headers) || {}) },
      }
    },
  }
  class NextRequest {}
  return { NextResponse, NextRequest }
}

class RunnerRequest {
  constructor(opts) {
    this.url = opts.url
    this.method = (opts.method || 'GET').toUpperCase()
    this.nextUrl = new URL(opts.url)
    this._headers = new Map(Object.entries(opts.headers || {}).map(([k, v]) => [k.toLowerCase(), String(v)]))
    this._body = opts.body
  }
  get headers() {
    const m = this._headers
    return {
      get: (name) => m.get(String(name).toLowerCase()) ?? null,
      has: (name) => m.has(String(name).toLowerCase()),
      forEach: (cb) => m.forEach((v, k) => cb(v, k)),
      entries: () => m.entries(),
    }
  }
  get cookies() {
    const parsed = new Map()
    const raw = this._headers.get('cookie') || ''
    for (const pair of raw.split(';')) {
      const idx = pair.indexOf('=')
      if (idx > 0) {
        const name = pair.slice(0, idx).trim()
        if (name) {
          let value = pair.slice(idx + 1).trim()
          try {
            value = decodeURIComponent(value)
          } catch {
            // left as sent
          }
          parsed.set(name, value)
        }
      }
    }
    return {
      get: (name) => (parsed.has(name) ? { name, value: parsed.get(name) } : undefined),
      has: (name) => parsed.has(name),
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
    const entries = Object.entries(this._body && typeof this._body === 'object' ? this._body : {})
    return {
      get: (name) => { const found = entries.find(([k]) => k === name); return found ? found[1] : null },
      has: (name) => entries.some(([k]) => k === name),
      entries: () => entries[Symbol.iterator](),
    }
  }
}

/**
 * A route module's `process`: a frozen env of the project's own variables, the
 * withheld names (see WITHHELD_ENV_NAMES in route-module-runner.ts) and
 * NODE_ENV. Never a process environment.
 */
function makeCuratedProcess(inv, withheld) {
  const projectEnv = inv.env && typeof inv.env === 'object' ? inv.env : {}
  const env = { ...projectEnv }
  for (const name of inv.withheldNames || []) env[name] = withheld
  if (inv.nodeEnv !== undefined && inv.nodeEnv !== null) env.NODE_ENV = inv.nodeEnv
  return Object.freeze({ env: Object.freeze(env) })
}

function loadJwt() {
  const j = require('jsonwebtoken')
  return j.default || j
}

/**
 * The project-aware auth helpers, without the project's secret.
 *
 * The app verified each token the request carries with the project's signing
 * secret and sent the ones that passed (verifiedTokens). verifyToken answers
 * for those and is null for any other; jsonwebtoken.verify with
 * process.env.JWT_SECRET (which holds `withheld`) re-signs a verified token with
 * a key made here and verifies that, so every option the caller passes is still
 * checked by the library itself. isAdminRequest compares with the admin key only
 * when the caller presented it, which the app checked.
 */
function makeAuth(inv, ownerTest, withheld) {
  const verified = new Set(Array.isArray(inv.verifiedTokens) ? inv.verifiedTokens : [])
  const testToken = inv.ownerTest && inv.ownerTest.token
  const signRefused = (inv.text && inv.text.signRefused) || "Functions cannot sign the project's end-user sessions."
  const isOwnerTestToken = (token) => ownerTest !== null && ownerTest.live === true && !!testToken && token === testToken
  const ownerTestUser = () => {
    const iat = Math.floor(Date.now() / 1000)
    return {
      userId: inv.ownerTest && inv.ownerTest.userId,
      email: 'test-run@backenly.internal',
      role: 'admin',
      projectId: inv.projectId,
      testRun: true,
      iat,
      exp: iat + 600,
    }
  }

  function verifyToken(token) {
    if (isOwnerTestToken(token)) return ownerTestUser()
    if (!token || typeof token !== 'string' || !verified.has(token)) return null
    let payload
    try {
      payload = loadJwt().decode(token)
    } catch {
      return null
    }
    if (!payload || typeof payload !== 'object') return null
    const now = Math.floor(Date.now() / 1000)
    if (typeof payload.exp === 'number' && now >= payload.exp) return null
    if (typeof payload.nbf === 'number' && payload.nbf > now) return null
    return payload
  }

  function isAdminRequest(request) {
    if (ownerTest !== null && ownerTest.live === true) return true
    if (!inv.adminKey) return false
    const headers = request && request.headers
    const read = (name) => {
      const v = headers && typeof headers.get === 'function' ? headers.get(name) : headers && headers[name]
      return typeof v === 'string' ? v.trim() : ''
    }
    const presented = read('x-admin-key') || read('authorization').replace(/^Bearer\s+/i, '')
    return presented.length > 0 && safeEqual(presented, inv.adminKey)
  }

  let shim = null
  function jsonwebtokenShim() {
    if (shim) return shim
    const real = loadJwt()
    const testUser = (options) => {
      const payload = ownerTestUser()
      return options && typeof options === 'object' && options.complete
        ? { header: { alg: 'HS256', typ: 'JWT' }, payload, signature: '' }
        : payload
    }
    const sign = (payload, secret, ...rest) => {
      if (secret === withheld) throw new Error(signRefused)
      const needsProjectId =
        payload && typeof payload === 'object' && !Buffer.isBuffer(payload) && payload.userId && !payload.projectId
      return real.sign(needsProjectId ? { ...payload, projectId: inv.projectId } : payload, secret, ...rest)
    }
    const verify = (token, secret, ...rest) => {
      if (isOwnerTestToken(token)) {
        const done = typeof rest[rest.length - 1] === 'function' ? rest[rest.length - 1] : null
        return done ? done(null, testUser(rest[0])) : testUser(rest[0])
      }
      if (secret !== withheld) return real.verify(token, secret, ...rest)
      if (typeof token === 'string' && verified.has(token)) {
        const decoded = real.decode(token, { complete: true })
        if (decoded && decoded.payload && typeof decoded.payload === 'object') {
          const standIn = nodeCrypto.randomBytes(32)
          const resigned = real.sign(decoded.payload, standIn, { algorithm: 'HS256', header: decoded.header, noTimestamp: true })
          return real.verify(resigned, standIn, ...rest)
        }
      }
      // Not a token this project signed: fails exactly as a wrong secret does.
      return real.verify(token, withheld, ...rest)
    }
    const decode = (token, ...rest) => (isOwnerTestToken(token) ? testUser(rest[0]) : real.decode(token, ...rest))
    shim = { ...real, sign, verify, decode }
    shim.default = shim
    return shim
  }

  return { verifyToken, isAdminRequest, jsonwebtokenShim }
}

// ─── The project's database, on its own login ───────────────────────────────

let pgTypesInstalled = false
function loadPg() {
  const pg = require('pg')
  if (!pgTypesInstalled) {
    pgTypesInstalled = true
    // int8 as BigInt, as Prisma's raw queries returned it: count(*) is a BigInt.
    pg.types.setTypeParser(20, (v) => (v === null ? null : BigInt(v)))
  }
  return pg
}

/** A database error with Prisma's raw-query `meta` beside pg's own fields, for code written against either. */
function shapeError(err) {
  if (err && typeof err === 'object' && typeof err.code === 'string' && /^[0-9A-Z]{5}$/.test(err.code) && !err.meta) {
    try {
      err.meta = { code: err.code, message: err.message }
    } catch {
      // a frozen error keeps its own shape
    }
  }
  return err
}

const loginRefused = (err) => !!err && (err.code === '28P01' || err.code === '28000')

/**
 * `prisma` and `asService` from '@/lib/db'.
 *
 * Every top-level statement runs in its own transaction that first sets the
 * caller's claims and pins search_path to the project's schema; a function's
 * own $transaction gets that once, at the top. It runs on the project's own
 * function login (function-db-role.ts), which the app hands over on the first
 * query and whose grants cover the project's schema alone.
 */
function makeDatabase(inv, logs) {
  const spec = inv.db || {}
  let connection = null
  let poolRef = null

  function newPool(connectionString) {
    const pg = loadPg()
    const pool = new pg.Pool({
      connectionString,
      max: 2,
      connectionTimeoutMillis: 10000,
      idleTimeoutMillis: 2000,
      allowExitOnIdle: true,
      application_name: 'backenly-function',
      statement_timeout: 15000,
      idle_in_transaction_session_timeout: 15000,
    })
    pool.on('error', () => {})
    return pool
  }

  function pool(refresh) {
    if (refresh || !poolRef) {
      const previous = poolRef
      const next = call('db.connection', [{ refresh: !!refresh }]).then((answer) => {
        connection = answer
        return newPool(answer.connectionString)
      })
      poolRef = next
      next.catch(() => {
        if (poolRef === next) poolRef = null
      })
      if (previous) previous.then((p) => p.end()).catch(() => {})
    }
    return poolRef
  }

  async function connect() {
    let p = await pool(false)
    try {
      return await p.connect()
    } catch (err) {
      if (!loginRefused(err)) throw err
      p = await pool(true)
      return p.connect()
    }
  }

  function templateQuery(strings, values) {
    if (typeof strings === 'string') {
      throw new TypeError('$queryRaw and $executeRaw are tagged templates: prisma.$queryRaw`SELECT ... ${value}`. For a string, use $queryRawUnsafe(sql, ...values).')
    }
    if (!strings || !Array.isArray(strings)) throw new TypeError('$queryRaw expects a tagged template')
    let text = strings[0]
    for (let i = 1; i < strings.length; i++) text += `$${i}` + strings[i]
    return { text, values }
  }

  const rowsOf = (res) => (Array.isArray(res) ? (res.length ? res[res.length - 1].rows : []) : res.rows)
  const countOf = (res) => (Array.isArray(res) ? res.reduce((n, r) => n + (r.rowCount || 0), 0) : res.rowCount || 0)

  function txApi(client) {
    const run = async (text, values) => {
      try {
        return await client.query(String(text), Array.isArray(values) ? values : [])
      } catch (err) {
        throw shapeError(err)
      }
    }
    const api = {
      $queryRawUnsafe: async (sql, ...values) => rowsOf(await run(sql, values)),
      $executeRawUnsafe: async (sql, ...values) => countOf(await run(sql, values)),
      $queryRaw: async (strings, ...values) => { const q = templateQuery(strings, values); return rowsOf(await run(q.text, q.values)) },
      $executeRaw: async (strings, ...values) => { const q = templateQuery(strings, values); return countOf(await run(q.text, q.values)) },
      // Already inside a transaction that carries the claims: the callback gets this same handle.
      $transaction: (fn) => fn(api),
    }
    return api
  }

  async function inTransaction(claims, body) {
    const client = await connect()
    let broken = false
    try {
      await client.query('BEGIN')
      await client.query(spec.sessionSql, [connection.searchPath, ...claims])
      const out = await body(txApi(client))
      await client.query('COMMIT')
      return out
    } catch (err) {
      try {
        await client.query('ROLLBACK')
      } catch {
        broken = true
      }
      throw shapeError(err)
    } finally {
      client.release(broken)
    }
  }

  const isStreamNotify = (sql, values) =>
    typeof sql === 'string' && values.length === 2 && !!spec.streamLabel && values[0] === spec.streamLabel && NOTIFY_STATEMENT.test(sql)
  const sendToStream = (values) => call('stream.notify', [String(values[1] ?? '')])

  function handle(claims) {
    return {
      $queryRawUnsafe: (sql, ...values) =>
        isStreamNotify(sql, values)
          ? sendToStream(values).then(() => [{ pg_notify: '' }])
          : track(inTransaction(claims, (tx) => tx.$queryRawUnsafe(sql, ...values))),
      $executeRawUnsafe: (sql, ...values) =>
        isStreamNotify(sql, values)
          ? sendToStream(values).then(() => 1)
          : track(inTransaction(claims, (tx) => tx.$executeRawUnsafe(sql, ...values))),
      $queryRaw: (...args) => track(inTransaction(claims, (tx) => tx.$queryRaw(...args))),
      $executeRaw: (...args) => track(inTransaction(claims, (tx) => tx.$executeRaw(...args))),
      $transaction: (fn) => track(inTransaction(claims, (tx) => fn(tx))),
    }
  }

  const prisma = handle(Array.isArray(spec.claims) ? spec.claims : [])
  let serviceDb = null
  const asService = async (fn) => {
    if (typeof fn !== 'function') throw new TypeError('asService takes a function: asService(async (db) => { ... })')
    logs.push((inv.text && inv.text.asServiceNote) || 'asService')
    serviceDb = serviceDb || handle(Array.isArray(spec.serviceClaims) ? spec.serviceClaims : [])
    return serviceDb.$transaction(fn)
  }
  return { prisma, asService }
}

function refusingDatabase(reason) {
  const refuse = () => Promise.reject(new Error(reason))
  return {
    prisma: { $queryRaw: refuse, $queryRawUnsafe: refuse, $executeRaw: refuse, $executeRawUnsafe: refuse, $transaction: refuse },
    asService: refuse,
  }
}

function buildRequire(inv, db, auth) {
  let nextServer = null
  return (id) => {
    switch (id) {
      case 'next/server':
        nextServer = nextServer || makeNextServerShim()
        return nextServer
      case '@/lib/db':
        return { prisma: db.prisma, asService: db.asService }
      case '@/lib/auth/jwt':
        return { verifyToken: auth.verifyToken, isAdminRequest: auth.isAdminRequest }
      case 'crypto':
      case 'node:crypto':
        return nodeCrypto
      case 'bcryptjs': {
        const b = require('bcryptjs')
        return b.default || b
      }
      case 'jsonwebtoken':
        return auth.jsonwebtokenShim()
      default:
        throw new Error(
          `Module "${id}" is not available to route functions. ` +
            `Allowed: next/server, @/lib/db, @/lib/auth/jwt, crypto, bcryptjs, jsonwebtoken.`,
        )
    }
  }
}

/** fetch for module code: fetch's call shape, answered by the app through its egress guard. */
function makeFetch() {
  return (input, init) => {
    const url =
      typeof input === 'string' ? input
        : input instanceof URL ? input.toString()
          : input && typeof input.url === 'string' ? input.url
            : String(input)
    const method = String((init && init.method) ?? (input && typeof input === 'object' && input.method) ?? 'GET').toUpperCase()
    const outHeaders = {}
    const rawHeaders = (init && init.headers) ?? (input && typeof input === 'object' ? input.headers : undefined)
    if (rawHeaders) {
      if (typeof rawHeaders.forEach === 'function') rawHeaders.forEach((v, k) => { outHeaders[String(k)] = String(v) })
      else if (Array.isArray(rawHeaders)) for (const [k, v] of rawHeaders) outHeaders[String(k)] = String(v)
      else for (const [k, v] of Object.entries(rawHeaders)) outHeaders[k] = String(v)
    }
    let body
    const rawBody = init && init.body
    if (rawBody !== undefined && rawBody !== null) {
      if (typeof rawBody === 'string') body = rawBody
      else if (Buffer.isBuffer(rawBody)) body = rawBody.toString('utf8')
      else if (rawBody instanceof URLSearchParams) body = rawBody.toString()
      else if (rawBody instanceof ArrayBuffer) body = Buffer.from(rawBody).toString('utf8')
      else if (ArrayBuffer.isView(rawBody)) body = Buffer.from(rawBody.buffer, rawBody.byteOffset, rawBody.byteLength).toString('utf8')
      else throw new TypeError('fetch body must be a string, Buffer, URLSearchParams or ArrayBuffer in function code — stringify JSON yourself')
    }
    const p = call('fetch', [url, { method, headers: outHeaders, body }]).then((answer) => {
      const bytes = Buffer.isBuffer(answer.body) ? answer.body : Buffer.alloc(0)
      const status = Number(answer.status) || 0
      return {
        ok: status >= 200 && status < 300,
        status,
        headers: new Map(Array.isArray(answer.headers) ? answer.headers.map(([k, v]) => [String(k), String(v)]) : []),
        async text() { return bytes.toString('utf8') },
        async json() { return JSON.parse(bytes.toString('utf8')) },
        async arrayBuffer() {
          const out = new ArrayBuffer(bytes.byteLength)
          new Uint8Array(out).set(bytes)
          return out
        },
      }
    })
    // A module that fires and forgets a refused fetch must not end the run with
    // an unhandled rejection; a caller that awaits still sees it.
    p.catch(() => {})
    return p
  }
}

function routeSandbox(inv, requireFn, logs, fetchImpl, withheld) {
  const moduleExports = {}
  const capture = (...a) => logs.push(a.map(stringify).join(' '))
  return {
    module: { exports: moduleExports },
    exports: moduleExports,
    require: requireFn,
    console: { log: capture, error: capture, warn: capture, info: capture },
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    Buffer,
    fetch: fetchImpl,
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
    process: makeCuratedProcess(inv, withheld),
    global: undefined,
    globalThis: undefined,
  }
}

function exportedMethods(sandbox) {
  const exportsObj = sandbox.module.exports || sandbox.exports || {}
  return ROUTE_METHODS.filter((m) => typeof exportsObj[m] === 'function')
}

async function runRoute(inv) {
  const logs = []
  const ownerTest = inv.testRun ? { live: true } : null
  const withheld = `withheld:${nodeCrypto.randomBytes(24).toString('hex')}`
  const auth = makeAuth(inv, ownerTest, withheld)
  const db = makeDatabase(inv, logs)
  const sandbox = routeSandbox(inv, buildRequire(inv, db, auth), logs, makeFetch(), withheld)
  vm.createContext(sandbox)

  const timeoutMs = Number(inv.timeoutMs) || 10000
  try {
    new vm.Script(String(inv.compiled), { filename: 'route-function.js' }).runInContext(sandbox, { timeout: timeoutMs })
  } catch (err) {
    return finish({ ok: false, errorKind: 'evaluation', error: errorText(err), logs })
  }

  const available = exportedMethods(sandbox)
  if (available.length === 0) return finish({ ok: false, errorKind: 'exports', error: 'no handler', logs })
  const hinted = typeof inv.hint === 'string' ? (inv.hint.match(METHOD_RE) || [])[1] : undefined
  const method = hinted && available.includes(hinted.toUpperCase()) ? hinted.toUpperCase() : available[0]
  const handler = (sandbox.module.exports || sandbox.exports)[method]

  const data = inv.data && typeof inv.data === 'object' ? decode(inv.data) : {}
  const query = new URLSearchParams()
  for (const [k, v] of Object.entries(data || {})) {
    if (k.startsWith('__') || k === 'authorization' || k === 'token') continue
    if (v != null && typeof v !== 'object') query.set(k, String(v))
  }
  const qs = query.toString()
  const request = new RunnerRequest({
    url: `https://app.backenly.com/api/v1/${inv.projectId}/fn${qs ? `?${qs}` : ''}`,
    headers: inv.headers || {},
    body: data,
    method,
  })
  const routeCtx = { params: { projectId: inv.projectId, ...Object.fromEntries(new URLSearchParams(qs)) } }

  let raw
  let timer
  try {
    raw = await Promise.race([
      Promise.resolve(handler(request, routeCtx)),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(ROUTE_TIMEOUT_MESSAGE)), timeoutMs) }),
    ])
  } catch (err) {
    if (ownerTest) ownerTest.live = false
    const msg = errorText(err)
    return finish({ ok: false, errorKind: msg === ROUTE_TIMEOUT_MESSAGE ? 'timeout' : 'handler', error: msg, logs })
  } finally {
    clearTimeout(timer)
  }

  // The run has ended: a helper the function kept (in a timer, or in a toJSON
  // the answer is serialised through) no longer answers as the owner's test.
  if (ownerTest) ownerTest.live = false
  const status = raw && typeof raw.status === 'number' ? raw.status : 200
  const body = raw && raw.__backenlyResponse ? raw.body : (raw ?? null)
  const headers = raw && raw.__backenlyResponse && raw.headers ? raw.headers : {}
  let value
  try {
    value = encode({ status, body, headers })
  } catch (err) {
    return finish({ ok: false, errorKind: 'handler', error: `The function's answer could not be sent: ${errorText(err)}`, logs })
  }
  return finish({ ok: true, value, logs }, 2000)
}

/** Evaluate a module's top level, never its handler, and say which methods it exports. */
function validateRoute(inv) {
  const withheld = `withheld:${nodeCrypto.randomBytes(24).toString('hex')}`
  const auth = makeAuth({ ...inv, verifiedTokens: [], adminKey: null, projectId: '00000000-0000-4000-8000-000000000000' }, null, withheld)
  const db = refusingDatabase('The database is not reachable while a function is being validated.')
  const fetchImpl = () => { throw new Error('fetch is not available while a function is being validated.') }
  const sandbox = routeSandbox(inv, buildRequire(inv, db, auth), [], fetchImpl, withheld)
  sandbox.console = { log() {}, error() {}, warn() {}, info() {} }
  vm.createContext(sandbox)
  try {
    new vm.Script(String(inv.compiled), { filename: 'route-function-validate.js' }).runInContext(sandbox, {
      timeout: Number(inv.timeoutMs) || 3000,
    })
  } catch (err) {
    return finish({ ok: false, errorKind: 'evaluation', error: errorText(err), logs: [] })
  }
  return finish({ ok: true, value: { methods: exportedMethods(sandbox) }, logs: [] })
}

// ─── Sandbox bodies ──────────────────────────────────────────────────────────

const WHITELISTED_PACKAGES = new Set(['pdfkit', 'csv-parse/sync', 'date-fns', 'qrcode', 'nodemailer', 'archiver'])

/** Static ES import declarations become ctx.require() calls. */
function preprocessImports(code) {
  return code
    .replace(/^\s*import\s+\*\s+as\s+(\w+)\s+from\s+['"]([^'"]+)['"]\s*;?/gm, (_, name, pkg) => `const ${name} = ctx.require('${pkg}');`)
    .replace(/^\s*import\s+(\w+)\s+from\s+['"]([^'"]+)['"]\s*;?/gm, (_, name, pkg) => `const ${name} = ctx.require('${pkg}');`)
    .replace(/^\s*import\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]\s*;?/gm, (_, names, pkg) => `const {${names}} = ctx.require('${pkg}');`)
    .replace(/^\s*import\s+['"][^'"]+['"]\s*;?/gm, '')
}

// Defence in depth only, as it always was: these match spellings, not capabilities.
const BLOCKED_PATTERNS = [
  /\bprocess\b/,
  /(?<![.\w$])require\s*\(/,
  /\bimport\s*\(/,
  /\bimportScripts\b/,
  /^\s*import\s+([\w*{]|['"])/m,
  /\beval\s*\(/,
  /\bnew\s+Function\s*\(/,
  /\bFunction\s*\(/,
  /\b__proto__\b/,
  /\bconstructor\s*\.\s*constructor\b/,
  /\bWorker\s*\(/,
  /\bchild_process\b/,
  /\bexec\s*\(/,
  /\bspawnSync\b/,
  /\bexecSync\b/,
  /\bfs\s*\.\s*(readFile|writeFile|unlink|mkdir|readdir|existsSync)/,
  /\bnet\s*\.\s*connect\b/,
  /\bos\s*\.\s*(env|exec|platform)\b/,
]

function checkBlockedPatterns(code) {
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(code)) {
      if (/import/.test(pattern.source)) {
        return `Use ctx.require('package-name') instead of import/require statements. Available packages: pdfkit, csv-parse/sync, date-fns, qrcode, nodemailer, archiver. For Stripe and other services, use ctx.integrations.stripe.* APIs.`
      }
      return `Blocked: code contains forbidden pattern '${pattern.source}'`
    }
  }
  return null
}

async function runSandbox(inv) {
  const logs = []
  const processedCode = preprocessImports(String(inv.code || ''))
  const blocked = checkBlockedPatterns(processedCode)
  if (blocked) return finish({ ok: false, errorKind: 'blocked', error: blocked, logs })

  const connectedSet = new Set(Array.isArray(inv.connectedIntegrations) ? inv.connectedIntegrations : [])
  const integrations = {
    isConnected(name) { return connectedSet.has(String(name || '').toLowerCase()) },
  }
  const manifest = inv.integrationManifest && typeof inv.integrationManifest === 'object' ? inv.integrationManifest : {}
  for (const provId of Object.keys(manifest)) {
    const methods = Array.isArray(manifest[provId]) ? manifest[provId] : []
    const api = {}
    for (const method of methods) api[method] = (...args) => call(`integrations.${provId}.${method}`, args)
    integrations[provId] = api
  }

  const safeEnv = Object.create(null)
  if (inv.envVars && typeof inv.envVars === 'object') {
    for (const k of Object.keys(inv.envVars)) if (typeof inv.envVars[k] === 'string') safeEnv[k] = inv.envVars[k]
  }
  Object.freeze(safeEnv)

  const ctx = {
    db: {
      query: (table, where, opts) => call('db.query', [table, where, opts]),
      insert: (table, data) => call('db.insert', [table, data]),
      update: (table, where, data) => call('db.update', [table, where, data]),
      delete: (table, where) => call('db.delete', [table, where]),
    },
    http: {
      get: (url, headers) => call('http.get', [url, headers]),
      post: (url, body, headers) => call('http.post', [url, body, headers]),
    },
    log: (...args) => {
      logs.push(args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' '))
    },
    require: (packageName) => {
      if (!WHITELISTED_PACKAGES.has(packageName)) {
        if (['stripe', 'axios', 'node-fetch', 'fetch'].includes(packageName)) {
          throw new Error(`'${packageName}' is not available as ctx.require(). For Stripe, use ctx.integrations.stripe.*. For HTTP requests, use ctx.http.get() / ctx.http.post().`)
        }
        throw new Error(`Package '${packageName}' is not available. Allowed packages: pdfkit, csv-parse/sync, date-fns, qrcode, nodemailer, archiver.`)
      }
      return require(packageName)
    },
    integrations,
    env: safeEnv,
  }

  const event = decode(inv.event)
  // JSON and Math are the context's own, made for this run.
  const sandbox = vm.createContext(Object.assign(Object.create(null), {
    event,
    ctx,
    Date,
    parseInt,
    parseFloat,
    isNaN,
    isFinite,
    encodeURIComponent,
    decodeURIComponent,
    String,
    Number,
    Boolean,
    Array,
    Object,
    Promise,
    RegExp,
    Error,
    console: { log: (...args) => ctx.log(...args) },
    integrations,
    process: undefined,
    global: undefined,
    globalThis: undefined,
    require: undefined,
  }))

  const timeoutMs = Number(inv.timeoutMs) || 9500
  const label = `${timeoutMs / 1000}s`
  let timer
  try {
    const wrappedCode = `(async function handler(event, ctx) {\n${processedCode}\n})(event, ctx)`
    const script = new vm.Script(wrappedCode, { filename: 'ai-function.js' })
    const resultPromise = script.runInContext(sandbox, { timeout: timeoutMs })
    let returnValue
    if (resultPromise && typeof resultPromise.then === 'function') {
      returnValue = await Promise.race([
        resultPromise,
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Function timed out after ${label}`)), timeoutMs) }),
      ])
    }
    let value
    try {
      value = encode(returnValue)
    } catch (err) {
      return finish({ ok: false, errorKind: 'error', error: `The function's return value could not be sent: ${errorText(err)}`, logs })
    }
    return finish({ ok: true, value, logs }, 2000)
  } catch (err) {
    return finish({ ok: false, errorKind: 'error', error: errorText(err), logs })
  } finally {
    clearTimeout(timer)
  }
}

/** The checks runSandbox makes before it runs anything, the package list, and a compile of its wrapper. */
function validateSandbox(inv) {
  const reply = (error) => finish({ ok: true, value: { error }, logs: [] })
  const code = inv.code
  if (typeof code !== 'string' || !code.trim()) return reply('The function body is empty.')
  const processedCode = preprocessImports(code)
  const blocked = checkBlockedPatterns(processedCode)
  if (blocked) return reply(blocked)
  for (const m of processedCode.matchAll(/\bctx\s*\.\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    if (!WHITELISTED_PACKAGES.has(m[1])) {
      return reply(`ctx.require('${m[1]}') is not available here. Available packages: ${[...WHITELISTED_PACKAGES].join(', ')}.`)
    }
  }
  try {
    // Compiling a function expression does not call it: no statement of the body runs.
    new vm.Script(`(async function handler(event, ctx) {\n${processedCode}\n})`, { filename: 'ai-function.js' })
  } catch (err) {
    return reply(`Syntax error: ${errorText(err)}`)
  }
  return reply(null)
}

// ─── Supervisor checks ───────────────────────────────────────────────────────

/** What this process can see: the supervisor refuses to run functions until none of `mustNotRead` is readable. */
function probe(inv) {
  const results = {}
  for (const p of Array.isArray(inv.mustNotRead) ? inv.mustNotRead : []) {
    try {
      const st = fs.statSync(p)
      if (st.isDirectory()) fs.readdirSync(p)
      else fs.readFileSync(p)
      results[p] = 'readable'
    } catch (err) {
      results[p] = (err && err.code) || 'error'
    }
  }
  return finish({
    ok: true,
    value: {
      uid: typeof process.getuid === 'function' ? process.getuid() : null,
      gid: typeof process.getgid === 'function' ? process.getgid() : null,
      groups: typeof process.getgroups === 'function' ? process.getgroups() : [],
      env: Object.keys(process.env).sort(),
      results,
    },
    logs: [],
  })
}

/** The image build asks this: every dependency the runner needs loads, and a module runs. */
function selfTest() {
  try {
    loadPg()
    loadJwt()
    require('bcryptjs')
  } catch (err) {
    return finish({ ok: false, errorKind: 'selftest', error: errorText(err), logs: [] })
  }
  return runRoute({
    projectId: '00000000-0000-4000-8000-000000000000',
    compiled: "exports.GET = async function () { return require('next/server').NextResponse.json({ ok: true }) }",
    hint: 'GET',
    data: {},
    headers: {},
    env: {},
    withheldNames: [],
    verifiedTokens: [],
    adminKey: null,
    db: {},
    text: { asServiceNote: '', signRefused: '' },
    ownerTest: { token: '', userId: '' },
    timeoutMs: 2000,
  })
}

// ─── Entry ───────────────────────────────────────────────────────────────────

function start(inv) {
  switch (inv && inv.kind) {
    case 'route':
      return runRoute(inv)
    case 'route-validate':
      return validateRoute(inv)
    case 'sandbox':
      return runSandbox(inv)
    case 'sandbox-validate':
      return validateSandbox(inv)
    case 'probe':
      return probe(inv)
    case 'selftest':
      return selfTest()
    default:
      return finish({ ok: false, errorKind: 'protocol', error: `Unknown invocation kind: ${inv && inv.kind}`, logs: [] })
  }
}

function main() {
  // stdout carries the protocol and nothing else.
  const toStderr = (...a) => { process.stderr.write(a.map(stringify).join(' ') + '\n') }
  console.log = toStderr
  console.info = toStderr
  console.warn = toStderr
  console.error = toStderr
  console.debug = toStderr

  process.on('uncaughtException', (err) => {
    if (!finished) finish({ ok: false, errorKind: 'handler', error: errorText(err), logs: [] })
    else toStderr('after the answer:', errorText(err))
  })
  process.on('unhandledRejection', (err) => toStderr('unhandled rejection:', errorText(err)))

  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
  let started = false
  rl.on('line', (line) => {
    if (started) return onReply(line)
    started = true
    let inv
    try {
      inv = JSON.parse(line)
    } catch {
      return finish({ ok: false, errorKind: 'protocol', error: 'The invocation is not JSON.', logs: [] })
    }
    Promise.resolve()
      .then(() => start(inv))
      .catch((err) => finish({ ok: false, errorKind: 'handler', error: errorText(err), logs: [] }))
  })
  // Input ended. Before an invocation, there is nothing to do. After one, the
  // run goes on (the image build feeds one line and closes), but no call can be
  // answered any more, so those waiting fail now instead of at the deadline.
  rl.on('close', () => {
    inputClosed = true
    if (!started) process.exit(70)
    for (const [id, pending] of pendingCalls) {
      pendingCalls.delete(id)
      pending.reject(new Error('Nothing is answering this run any more'))
    }
  })
}

// Run as a program: `node function-runner.cjs`, from source or from the bundle
// scripts/build-function-runner.mjs makes (where `module` is the bundler's own,
// so the path is what tells). Required as a module, by tests, it only exports.
const runAsProgram =
  require.main === module || (!!process.argv[1] && require('path').resolve(process.argv[1]) === __filename)
if (runAsProgram) main()

module.exports = { encode, decode, preprocessImports, checkBlockedPatterns, WHITELISTED_PACKAGES }
