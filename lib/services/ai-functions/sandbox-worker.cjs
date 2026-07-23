/**
 * SANDBOX WORKER — runs inside a Node.js Worker Thread
 * =====================================================
 * This script receives AI-generated function code and executes it inside
 * a strict vm context that is isolated from the parent process.
 *
 * Security properties:
 *  - Separate V8 isolate (Worker Thread) — no shared module cache with parent
 *  - process.env is NOT accessible inside this worker (env is filtered by parent)
 *  - All DB / HTTP calls are proxied back to the parent via MessageChannel
 *  - Static code analysis rejects escape patterns BEFORE execution
 *  - Hard vm.Script timeout + parent-side Worker termination backup
 *  - Memory limits enforced by workerOptions.resourceLimits
 *
 * IPC Protocol (via parentPort):
 *   parent → worker : { type:'run', code, event, id }
 *   worker → parent : { type:'call', id, callId, method, args }   (DB/HTTP proxy)
 *   parent → worker : { type:'result', callId, result } | { type:'result', callId, error }
 *   worker → parent : { type:'done', id, result, logs }
 *   worker → parent : { type:'error', id, error, logs }
 */

'use strict'

const { parentPort, workerData, isMainThread } = require('worker_threads')
const vm = require('vm')

if (isMainThread) {
  // Safeguard: this module must only run as a Worker
  process.exit(1)
}

// ─── Whitelisted packages available via ctx.require() ────────────────────────
const WHITELISTED_PACKAGES = new Set([
  'pdfkit',
  'csv-parse/sync',
  'date-fns',
  'qrcode',
  'nodemailer',
  'archiver',
])

// ─── Preprocess: convert static ES import declarations to ctx.require() ───────
function preprocessImports(code) {
  return code
    // import * as X from 'pkg'  →  const X = ctx.require('pkg')
    .replace(/^\s*import\s+\*\s+as\s+(\w+)\s+from\s+['"]([^'"]+)['"]\s*;?/gm,
      (_, name, pkg) => `const ${name} = ctx.require('${pkg}');`)
    // import X from 'pkg'  →  const X = ctx.require('pkg')
    .replace(/^\s*import\s+(\w+)\s+from\s+['"]([^'"]+)['"]\s*;?/gm,
      (_, name, pkg) => `const ${name} = ctx.require('${pkg}');`)
    // import { a, b } from 'pkg'  →  const { a, b } = ctx.require('pkg')
    .replace(/^\s*import\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]\s*;?/gm,
      (_, names, pkg) => `const {${names}} = ctx.require('${pkg}');`)
    // import 'pkg'  →  (drop side-effect-only imports)
    .replace(/^\s*import\s+['"][^'"]+['"]\s*;?/gm, '')
}

// ─── Blocked patterns — reject before execution ───────────────────────────────
const BLOCKED_PATTERNS = [
  /\bprocess\b/,
  // Block bare require(...) but NOT member access like ctx.require('pdfkit'),
  // which preprocessImports() legitimately produces from converted imports.
  // Without the lookbehind this regex rejected the worker's OWN output.
  /(?<![.\w$])require\s*\(/,
  /\bimport\s*\(/,
  /\bimportScripts\b/,
  // Static import declarations — should have been converted by preprocessImports()
  // but block as a safety net with a clear error
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

// ─── Pending proxy calls ──────────────────────────────────────────────────────
const pendingCalls = new Map()

parentPort.on('message', (msg) => {
  if (msg.type === 'result') {
    const pending = pendingCalls.get(msg.callId)
    if (!pending) return
    pendingCalls.delete(msg.callId)
    if (msg.error) pending.reject(new Error(msg.error))
    else pending.resolve(msg.result)
  }
})

let callSeq = 0
function proxyCall(method, args) {
  const callId = `c${++callSeq}`
  return new Promise((resolve, reject) => {
    pendingCalls.set(callId, { resolve, reject })
    parentPort.postMessage({ type: 'call', callId, method, args })
  })
}

// ─── Run a single function ────────────────────────────────────────────────────
async function runFunction(runId, code, event, connectedIntegrations, envVars, integrationManifest) {
  const logs = []

  // Step 1: Convert static ES import declarations to ctx.require() calls
  const processedCode = preprocessImports(code)

  // Step 2: Static analysis — reject forbidden patterns
  const blocked = checkBlockedPatterns(processedCode)
  if (blocked) {
    parentPort.postMessage({ type: 'error', id: runId, error: blocked, logs })
    return
  }

  // Build ctx.integrations proxy — calls are forwarded to parent via message channel.
  // Fully generic: the parent sends an `integrationManifest` of { providerId:
  // [methodNames] } derived from the live registry, so every connected provider
  // (stripe, email, openai, replicate, runway, stability, onesignal, …) is built
  // here with NO hardcoded provider list. Adding a provider is a registry-only
  // change. `connectedIntegrations` still powers isConnected() alias lookups.
  const connectedSet = new Set(Array.isArray(connectedIntegrations) ? connectedIntegrations : [])
  const integrations = {
    isConnected(name) { return connectedSet.has(String(name || '').toLowerCase()) },
  }
  const manifest = integrationManifest && typeof integrationManifest === 'object' ? integrationManifest : {}
  for (const provId of Object.keys(manifest)) {
    const methods = Array.isArray(manifest[provId]) ? manifest[provId] : []
    const api = {}
    for (const method of methods) {
      api[method] = (...args) => proxyCall(`integrations.${provId}.${method}`, args)
    }
    integrations[provId] = api
  }

  // Build frozen env map — per-project secrets the user set via chat/UI.
  // We freeze with a null prototype so generated code can read but cannot
  // mutate / extend the secret surface inside the sandbox.
  const safeEnv = Object.create(null)
  if (envVars && typeof envVars === 'object') {
    for (const k of Object.keys(envVars)) {
      const v = envVars[k]
      if (typeof v === 'string') safeEnv[k] = v
    }
  }
  Object.freeze(safeEnv)

  // Proxy-backed context — all async operations go through parentPort
  const ctx = {
    db: {
      query:  (table, where)       => proxyCall('db.query',  [table, where]),
      insert: (table, data)        => proxyCall('db.insert', [table, data]),
      update: (table, where, data) => proxyCall('db.update', [table, where, data]),
      delete: (table, where)       => proxyCall('db.delete', [table, where]),
    },
    http: {
      get:  (url, headers)        => proxyCall('http.get',  [url, headers]),
      post: (url, body, headers)  => proxyCall('http.post', [url, body, headers]),
    },
    log: (...args) => {
      const line = args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ')
      logs.push(line)
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

  // Freeze safe globals to prevent prototype-chain attacks
  const frozenJSON    = Object.freeze(Object.assign(Object.create(null), JSON))
  const frozenMath    = Object.freeze(Object.assign(Object.create(null), Math))

  const sandbox = vm.createContext(Object.assign(Object.create(null), {
    event,
    ctx,
    JSON:               frozenJSON,
    Math:               frozenMath,
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
    // Expose integrations as a top-level global so generated code can also do
    // `integrations.stripe.*` without the `ctx.` prefix if needed
    integrations,
    // Explicitly block dangerous globals
    process:    undefined,
    global:     undefined,
    globalThis: undefined,
    require:    undefined,
  }))

  try {
    const wrappedCode = `(async function handler(event, ctx) {\n${processedCode}\n})(event, ctx)`
    const script = new vm.Script(wrappedCode, { filename: 'ai-function.js' })
    const resultPromise = script.runInContext(sandbox, { timeout: 9500 })

    let returnValue
    if (resultPromise && typeof resultPromise.then === 'function') {
      returnValue = await Promise.race([
        resultPromise,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Function timed out after 9.5s')), 9500)
        ),
      ])
    }

    parentPort.postMessage({ type: 'done', id: runId, result: returnValue, logs })
  } catch (err) {
    parentPort.postMessage({ type: 'error', id: runId, error: err.message, logs })
  }
}

// ─── Entry: wait for 'run' message ───────────────────────────────────────────
parentPort.on('message', (msg) => {
  if (msg.type === 'run') {
    runFunction(msg.id, msg.code, msg.event, msg.connectedIntegrations, msg.envVars, msg.integrationManifest).catch((err) => {
      parentPort.postMessage({ type: 'error', id: msg.id, error: err.message, logs: [] })
    })
  }
})
