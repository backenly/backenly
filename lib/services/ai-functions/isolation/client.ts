/**
 * Runs one piece of customer function code outside this process.
 *
 * This process holds every platform secret, so function code never runs in
 * it (function-runner.cjs says why). Each run is a fresh runner process:
 *
 *   - in production, started by the root function supervisor
 *     (function-supervisor.cjs) under a uid of its own, reached over its UNIX
 *     socket (BACKENLY_FN_SOCKET, default /tmp/backenly-fn/supervisor.sock);
 *   - in development only, when BACKENLY_UNSAFE_LOCAL_FUNCTIONS=1, started
 *     here as this process's own user. That keeps function code out of this
 *     process's memory and environment variables, but a process of the same uid
 *     can read /proc/<pid>/environ, so it is refused when NODE_ENV=production.
 *
 * Without either, a run fails closed with FunctionRunnerUnavailableError; it
 * never falls back to running the code here. A supervisor whose slots are all
 * taken (BACKENLY_FN_MAX_CONCURRENCY runs, BACKENLY_FN_MAX_QUEUE waiting, or no
 * slot freed within BACKENLY_FN_QUEUE_WAIT_MS) refuses with
 * FunctionRunnerBusyError: a 503 to try again, never the function's fault.
 *
 * While a run lives this side answers its calls (`handlers`): outbound HTTP
 * through the egress guard, a sandbox body's ctx.db and ctx.integrations, the
 * project's database login, its realtime stream. Each handler is bound to the
 * run's own project by the caller, never to anything the runner sends.
 */

import { spawn, type ChildProcess } from 'child_process'
import * as fs from 'fs'
import * as net from 'net'
import * as os from 'os'
import * as path from 'path'

export const DEFAULT_SUPERVISOR_SOCKET = '/tmp/backenly-fn/supervisor.sock'
export const UNSAFE_LOCAL_FLAG = 'BACKENLY_UNSAFE_LOCAL_FUNCTIONS'

/** The heap and resident limits of a development run; the supervisor has its own. */
const LOCAL_HEAP_MB = 96
const LOCAL_RSS_MB = 160
/** How long a missing socket is retried: the supervisor may be starting or restarting. */
const CONNECT_RETRY_MS = 3000
const MAX_LINE_BYTES = 32 * 1024 * 1024
const MAX_INFLIGHT_CALLS = 64
const MAX_CALLS = 10_000
const MAX_LOG_LINES = 2000
/** The supervisor's own default for BACKENLY_FN_QUEUE_WAIT_MS. */
const DEFAULT_QUEUE_WAIT_MS = 10_000
/** What a caller turned away for capacity is told to wait before trying again. */
export const BUSY_RETRY_AFTER_SECONDS = 5

/**
 * Functions could not run because the isolation they need is missing: no
 * supervisor, a supervisor refusing (its self-check failed), or a runner that
 * could not start. Never the function's own fault, so callers neither record
 * it as the function's error nor rewrite its code.
 */
export class FunctionRunnerUnavailableError extends Error {
  readonly code: 'FUNCTION_RUNNER_UNAVAILABLE' | 'FUNCTION_RUNNER_BUSY' = 'FUNCTION_RUNNER_UNAVAILABLE'
  constructor(detail: string, message?: string) {
    super(
      message ??
        `Functions cannot run here: ${detail}. Function code runs only in a separate process under its own user, ` +
          `started by the function supervisor. The Backenly images start it themselves when they start as root ` +
          `(do not override the container user); outside a container, run lib/services/ai-functions/isolation/function-supervisor.cjs as root. ` +
          `For development only, ${UNSAFE_LOCAL_FLAG}=1 runs functions as your own user; it is refused when NODE_ENV=production.`,
    )
    this.name = 'FunctionRunnerUnavailableError'
  }
}

/**
 * The supervisor turned the run away for capacity: every slot was taken and
 * the queue was full, or no slot freed in time. The function did not run and
 * is not at fault; the caller should try again shortly (a 503).
 */
export class FunctionRunnerBusyError extends FunctionRunnerUnavailableError {
  override readonly code = 'FUNCTION_RUNNER_BUSY' as const
  readonly retryAfterSeconds = BUSY_RETRY_AFTER_SECONDS
  constructor(detail: string) {
    super(detail, `Too many functions are running on this server right now (${detail}). Try again in a few seconds.`)
    this.name = 'FunctionRunnerBusyError'
  }
}

/**
 * The run's process could not be started: the system refused a new process
 * (too many open files or processes) or the runner could not be executed.
 * Nothing ran, so the run may be started again, and a sandbox run is (#606).
 */
export class FunctionRunnerStartError extends FunctionRunnerUnavailableError {
  constructor(readonly detail: string) {
    super(detail, `The function's runner could not start: ${detail}`)
    this.name = 'FunctionRunnerStartError'
  }
}

/** How long the supervisor may hold a run before it starts (BACKENLY_FN_QUEUE_WAIT_MS, as the supervisor reads it). */
function supervisorQueueWaitMs(): number {
  const n = Number.parseInt(process.env.BACKENLY_FN_QUEUE_WAIT_MS ?? '', 10)
  return Number.isFinite(n) ? Math.max(0, n) : DEFAULT_QUEUE_WAIT_MS
}

export type IsolatedKind = 'route' | 'route-validate' | 'sandbox' | 'sandbox-validate'

export interface IsolatedJob {
  kind: IsolatedKind
  /** Everything the runner is given. JSON-safe already: values that need it are encoded by the caller. */
  payload: Record<string, unknown>
  /** The run is killed this long after it starts (the supervisor adds a short grace). */
  hardTimeoutMs: number
}

export type CallHandlers = Record<string, (args: unknown[]) => unknown>

export interface RunnerResult {
  ok: boolean
  value?: unknown
  error?: string
  errorKind?: string
  logs: string[]
}

export type KillReason = 'timeout' | 'memory' | 'output' | 'caller' | 'shutdown'

export interface IsolatedOutcome {
  /** The runner's answer. Present whenever it answered, however it ended afterwards. */
  result: RunnerResult | null
  killed: KillReason | null
  exitCode: number | null
  signal: string | null
  stderr: string
  /**
   * Whether the runner said a sandbox body's own code had started. A run that
   * ended without an answer before then did nothing the function does, and may
   * be started again (#606).
   */
  codeStarted?: boolean
}

/** What a run that ended without answering wrote last about why: its first error line, kept short. */
export function stderrReason(stderr: string): string | null {
  const lines = stderr.split('\n').map((l) => l.trim()).filter(Boolean)
  const line = lines.find((l) => /^[A-Za-z]*Error\b/.test(l)) ?? lines[lines.length - 1]
  if (!line) return null
  return line.length > 300 ? `${line.slice(0, 299)}…` : line
}

/** Whether a run that ended without an answer ended for want of memory. */
export function endedForMemory(outcome: IsolatedOutcome): boolean {
  return outcome.killed === 'memory' || /heap out of memory|Allocation failed|out of memory/i.test(outcome.stderr)
}

// ─── Wire codec (the runner's copy is in function-runner.cjs) ───────────────

const TAG = '$bkn'
const MAX_DEPTH = 1000

/** A value as the runner receives it: JSON, with what JSON cannot carry tagged. */
export function encodeValue(value: unknown): unknown {
  return encodeAt(value, new Set(), 0)
}

function encodeAt(value: unknown, stack: Set<object>, depth: number): unknown {
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
  const obj = value as any
  // By internal tag, not instanceof, so a value from another realm keeps its type.
  const kind = Object.prototype.toString.call(obj)
  if (kind === '[object Date]') {
    const time = obj.getTime()
    return { [TAG]: 'd', v: Number.isNaN(time) ? null : obj.toISOString() }
  }
  if (Buffer.isBuffer(obj) || ArrayBuffer.isView(obj)) {
    return { [TAG]: 'b', v: Buffer.from(obj.buffer, obj.byteOffset, obj.byteLength).toString('base64') }
  }
  if (kind === '[object ArrayBuffer]') return { [TAG]: 'b', v: Buffer.from(obj).toString('base64') }
  if (stack.has(obj)) throw new TypeError('Converting circular structure to JSON')
  stack.add(obj)
  try {
    if (Array.isArray(obj)) return obj.map((item) => encodeAt(item, stack, depth + 1))
    if (kind === '[object Map]') {
      return { [TAG]: 'm', v: [...obj].map(([k, v]) => [encodeAt(k, stack, depth + 1), encodeAt(v, stack, depth + 1)]) }
    }
    if (kind === '[object Set]') return { [TAG]: 's', v: [...obj].map((item) => encodeAt(item, stack, depth + 1)) }
    if (typeof obj.toJSON === 'function') return encodeAt(obj.toJSON(), stack, depth + 1)
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(obj)) {
      const item = obj[key]
      if (typeof item === 'function' || typeof item === 'symbol') continue
      out[key] = encodeAt(item, stack, depth + 1)
    }
    return Object.prototype.hasOwnProperty.call(out, TAG) ? { [TAG]: 'o', v: out } : out
  } finally {
    stack.delete(obj)
  }
}

/**
 * A value the runner sent. Untrusted: nothing here runs code, `__proto__` stays
 * data, and nesting deeper than MAX_DEPTH is refused with a RangeError rather
 * than taking this process's stack. (Its size is bounded by the line it came
 * in, MAX_LINE_BYTES.)
 */
export function decodeValue(value: unknown): unknown {
  return decodeAt(value, 0)
}

function decodeAt(value: unknown, depth: number): unknown {
  if (value === null || typeof value !== 'object') return value
  if (depth > MAX_DEPTH) throw new RangeError('A value from a function run is nested too deeply')
  if (Array.isArray(value)) return value.map((item) => decodeAt(item, depth + 1))
  const obj = value as Record<string, any>
  if (Object.prototype.hasOwnProperty.call(obj, TAG) && typeof obj[TAG] === 'string') {
    const v = obj.v
    switch (obj[TAG]) {
      case 'u':
        return undefined
      case 'f':
        return v === 'Infinity' ? Infinity : v === '-Infinity' ? -Infinity : NaN
      case 'n':
        if (typeof v !== 'string' || !/^-?\d{1,4096}$/.test(v)) throw new TypeError('Malformed BigInt from a function run')
        return BigInt(v)
      case 'd':
        return v === null ? new Date(NaN) : new Date(String(v))
      case 'b':
        return Buffer.from(typeof v === 'string' ? v : '', 'base64')
      case 'm':
        return new Map((Array.isArray(v) ? v : []).map((pair: any) => [decodeAt(pair?.[0], depth + 1), decodeAt(pair?.[1], depth + 1)]))
      case 's':
        return new Set((Array.isArray(v) ? v : []).map((item: unknown) => decodeAt(item, depth + 1)))
      case 'o':
        return decodePlain(v && typeof v === 'object' ? v : {}, depth)
      default:
        break
    }
  }
  return decodePlain(obj, depth)
}

function decodePlain(obj: Record<string, unknown>, depth: number): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(obj)) {
    const item = decodeAt(obj[key], depth + 1)
    if (key === '__proto__') Object.defineProperty(out, key, { value: item, enumerable: true, writable: true, configurable: true })
    else out[key] = item
  }
  return out
}

// ─── Transport ───────────────────────────────────────────────────────────────

interface SessionEnd {
  killed: KillReason | null
  exitCode: number | null
  signal: string | null
  stderr: string
  /** The run never started, or the supervisor refused it: not the function's doing. */
  unavailable?: string
  /** The supervisor refused it for capacity. */
  busy?: string
  /** Its process could not be started, so nothing ran: why. */
  startFailed?: string
}

interface Session {
  /** One line to the runner's stdin. */
  send(line: string): void
  /** End the run now. */
  abort(): void
  onMessage(cb: (msg: any) => void): void
  onEnd(cb: (end: SessionEnd) => void): void
}

type Mode = { kind: 'supervisor'; socketPath: string } | { kind: 'local' }

function isolationMode(): Mode {
  const local = process.env[UNSAFE_LOCAL_FLAG]
  if (local === '1' || local === 'true') {
    if (process.env.NODE_ENV === 'production') {
      throw new FunctionRunnerUnavailableError(`${UNSAFE_LOCAL_FLAG} is set, and it is refused when NODE_ENV=production`)
    }
    return { kind: 'local' }
  }
  if (process.platform === 'win32') {
    throw new FunctionRunnerUnavailableError('there is no function supervisor on Windows')
  }
  return { kind: 'supervisor', socketPath: process.env.BACKENLY_FN_SOCKET || DEFAULT_SUPERVISOR_SOCKET }
}

/** Split a byte stream into lines, refusing a line too long to be one the protocol sends. */
/**
 * Split a byte stream into lines, refusing a line too long to be one the
 * protocol sends. The returned function is a stream 'data' handler of this
 * process, and what it reads is a function's to write: nothing in it may
 * throw out, so a line that fails to be handled ends that run (onBad) and only
 * that run.
 */
function lineReader(onLine: (line: Buffer) => void, onBad: () => void): (chunk: Buffer) => void {
  let partial = Buffer.alloc(0)
  let bad = false
  return (chunk) => {
    if (bad) return
    try {
      let data = partial.length ? Buffer.concat([partial, chunk]) : chunk
      let nl: number
      while ((nl = data.indexOf(10)) >= 0) {
        onLine(data.subarray(0, nl))
        data = data.subarray(nl + 1)
      }
      partial = Buffer.from(data)
      if (partial.length > MAX_LINE_BYTES) throw new RangeError('A line from a function run is too long')
    } catch {
      bad = true
      partial = Buffer.alloc(0)
      try {
        onBad()
      } catch {
        // the run is already ending
      }
    }
  }
}

function parseLine(line: Buffer): any {
  try {
    return JSON.parse(line.toString('utf8'))
  } catch {
    return null
  }
}

function connectOnce(socketPath: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath)
    socket.once('connect', () => {
      socket.removeListener('error', reject)
      resolve(socket)
    })
    socket.once('error', reject)
  })
}

async function connectSupervisor(socketPath: string): Promise<net.Socket> {
  const deadline = Date.now() + CONNECT_RETRY_MS
  for (;;) {
    try {
      return await connectOnce(socketPath)
    } catch (err: any) {
      const code = err?.code
      if ((code === 'ENOENT' || code === 'ECONNREFUSED') && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100))
        continue
      }
      const why =
        code === 'ENOENT' || code === 'ECONNREFUSED'
          ? `no function supervisor is listening at ${socketPath}`
          : code === 'EACCES'
            ? `this process may not open the function supervisor's socket at ${socketPath}`
            : `the function supervisor could not be reached (${err?.message ?? err})`
      throw new FunctionRunnerUnavailableError(why)
    }
  }
}

async function supervisedSession(socketPath: string, timeoutMs: number): Promise<Session> {
  const socket = await connectSupervisor(socketPath)
  const messageHandlers: Array<(msg: any) => void> = []
  const endHandlers: Array<(end: SessionEnd) => void> = []
  let ended = false
  const end = (e: SessionEnd) => {
    if (ended) return
    ended = true
    for (const h of endHandlers) h(e)
    socket.destroy()
  }

  socket.on('data', lineReader(
    (line) => {
      const kind = line[0]
      const msg = parseLine(line.subarray(1))
      if (kind === 0x63 /* c */) {
        if (msg) for (const h of messageHandlers) h(msg)
      } else if (kind === 0x73 /* s */ && msg) {
        if (msg.type === 'refused') {
          end(msg.busy === true
            ? { killed: null, exitCode: null, signal: null, stderr: '', busy: String(msg.reason) }
            : { killed: null, exitCode: null, signal: null, stderr: '', unavailable: `the function supervisor refused the run (${String(msg.reason)})` })
        } else if (msg.type === 'exit') {
          end({
            killed: typeof msg.killed === 'string' ? (msg.killed as KillReason) : null,
            exitCode: typeof msg.code === 'number' ? msg.code : null,
            signal: typeof msg.signal === 'string' ? msg.signal : null,
            stderr: typeof msg.stderr === 'string' ? msg.stderr : '',
            startFailed: msg.error ? String(msg.error) : undefined,
          })
        }
      }
    },
    () => end({ killed: 'output', exitCode: null, signal: null, stderr: '' }),
  ))
  socket.on('error', () => {})
  socket.on('close', () => end({ killed: null, exitCode: null, signal: null, stderr: '', unavailable: 'the function supervisor closed the connection' }))
  socket.write(JSON.stringify({ v: 1, op: 'run', timeoutMs }) + '\n')

  return {
    send: (line) => { if (!socket.destroyed) socket.write(line + '\n') },
    abort: () => socket.destroy(),
    onMessage: (cb) => { messageHandlers.push(cb) },
    onEnd: (cb) => { endHandlers.push(cb) },
  }
}

/** The runner in a checkout: development and tests only. */
function localRunnerPath(): string {
  return process.env.BACKENLY_FN_RUNNER_PATH || path.resolve(process.cwd(), 'lib/services/ai-functions/isolation/function-runner.cjs')
}

/** A development run's environment: nothing of this process's own. */
function localChildEnv(dir: string): NodeJS.ProcessEnv {
  const env: Record<string, string> = { TZ: 'UTC', HOME: dir, TMPDIR: dir, TEMP: dir, TMP: dir }
  if (process.env.NODE_ENV) env.NODE_ENV = process.env.NODE_ENV
  if (process.env.NODE_EXTRA_CA_CERTS) env.NODE_EXTRA_CA_CERTS = process.env.NODE_EXTRA_CA_CERTS
  // Windows will not load the DLLs node needs for sockets and randomness without these.
  if (process.platform === 'win32') {
    for (const key of ['SystemRoot', 'windir', 'ComSpec', 'PATHEXT']) {
      const v = process.env[key]
      if (v) env[key] = v
    }
  }
  // ProcessEnv declares NODE_ENV as always set; a child of a process without
  // one gets none either.
  return env as NodeJS.ProcessEnv
}

function rssKbOf(pid: number): number {
  try {
    const m = /^VmRSS:\s+(\d+)\s+kB/m.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8'))
    return m ? Number(m[1]) : 0
  } catch {
    return 0
  }
}

function localSession(timeoutMs: number): Session {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backenly-fn-'))
  let child: ChildProcess
  try {
    // Not detached: in this process's group, an interrupt from the terminal
    // ends a run with it rather than leaving it behind.
    child = spawn(process.execPath, [`--max-old-space-size=${LOCAL_HEAP_MB}`, localRunnerPath()], {
      cwd: dir,
      env: localChildEnv(dir),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
  } catch (err: any) {
    fs.rmSync(dir, { recursive: true, force: true })
    throw new FunctionRunnerStartError(String(err?.message ?? err))
  }
  const messageHandlers: Array<(msg: any) => void> = []
  const endHandlers: Array<(end: SessionEnd) => void> = []
  let killed: KillReason | null = null
  let stderr = Buffer.alloc(0)
  let spawnError: string | null = null

  const kill = (reason: KillReason) => {
    if (child.exitCode !== null || child.signalCode !== null) return
    killed ??= reason
    try {
      child.kill('SIGKILL')
    } catch {
      // gone
    }
  }

  const deadline = setTimeout(() => kill('timeout'), timeoutMs + 2000)
  const watchdog = process.platform === 'linux'
    ? setInterval(() => { if (child.pid && rssKbOf(child.pid) > LOCAL_RSS_MB * 1024) kill('memory') }, 100)
    : null

  child.on('error', (err) => { spawnError = err.message })
  child.stdin?.on('error', () => {})
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr = Buffer.concat([stderr, chunk])
    if (stderr.length > 8192) stderr = stderr.subarray(stderr.length - 8192)
  })
  child.stdout?.on('data', lineReader(
    (line) => {
      const msg = parseLine(line)
      if (msg) for (const h of messageHandlers) h(msg)
    },
    () => kill('output'),
  ))
  child.on('close', (code, signal) => {
    clearTimeout(deadline)
    if (watchdog) clearInterval(watchdog)
    fs.rmSync(dir, { recursive: true, force: true })
    const end: SessionEnd = {
      killed,
      exitCode: code,
      signal,
      stderr: stderr.toString('utf8'),
      startFailed: spawnError ?? undefined,
    }
    for (const h of endHandlers) h(end)
  })

  return {
    send: (line) => { if (child.stdin?.writable) child.stdin.write(line + '\n') },
    abort: () => kill('caller'),
    onMessage: (cb) => { messageHandlers.push(cb) },
    onEnd: (cb) => { endHandlers.push(cb) },
  }
}

// ─── A run ───────────────────────────────────────────────────────────────────

function toResult(msg: any): RunnerResult {
  const logs = Array.isArray(msg.logs) ? msg.logs.slice(0, MAX_LOG_LINES).map((l: unknown) => String(l)) : []
  if (msg.ok === true) return { ok: true, value: decodeValue(msg.value), logs }
  return {
    ok: false,
    error: typeof msg.error === 'string' ? msg.error : 'The function failed',
    errorKind: typeof msg.errorKind === 'string' ? msg.errorKind : undefined,
    logs,
  }
}

/**
 * Run a job in its own runner process and answer its calls with `handlers`.
 *
 * Resolves as soon as the runner answers. The process lives on briefly, so a
 * call it makes after answering (work the function started without awaiting)
 * is still answered; its end is not waited for.
 */
export async function runIsolated(job: IsolatedJob, handlers: CallHandlers = {}): Promise<IsolatedOutcome> {
  const mode = isolationMode()
  const session = mode.kind === 'local' ? localSession(job.hardTimeoutMs) : await supervisedSession(mode.socketPath, job.hardTimeoutMs)

  return new Promise<IsolatedOutcome>((resolve, reject) => {
    let settled = false
    let inflight = 0
    let calls = 0
    let codeStarted = false
    // Should neither the runner nor the supervisor ever say how the run ended.
    // A supervised run may first wait for a slot, which its deadline does not count.
    const backstop = setTimeout(() => {
      session.abort()
      settle({ result: null, killed: 'timeout', exitCode: null, signal: null, stderr: '', codeStarted })
    }, job.hardTimeoutMs + (mode.kind === 'supervisor' ? supervisorQueueWaitMs() : 0) + 10_000)

    function settle(outcome: IsolatedOutcome) {
      if (settled) return
      settled = true
      clearTimeout(backstop)
      resolve(outcome)
    }

    const reply = (id: unknown, ok: boolean, value?: unknown, error?: string) => {
      let line: string
      try {
        line = JSON.stringify(ok ? { t: 'reply', id, ok: true, value: encodeValue(value) } : { t: 'reply', id, ok: false, error })
      } catch (err: any) {
        line = JSON.stringify({ t: 'reply', id, ok: false, error: `The answer could not be sent: ${err?.message ?? err}` })
      }
      session.send(line)
    }

    // Every line arrives in a stream event handler of this process, and the
    // function wrote it: one that cannot be read or handled ends this run as a
    // failure of the function's, and throws nowhere else.
    const unreadable = (err: unknown) => {
      session.abort()
      settle({
        result: { ok: false, error: `The function's run sent output that could not be read (${(err as any)?.message ?? err})`, errorKind: 'protocol', logs: [] },
        killed: null,
        exitCode: null,
        signal: null,
        stderr: '',
        codeStarted,
      })
    }

    session.onMessage((msg) => {
      try {
        if (msg?.t === 'started') {
          codeStarted = true
          return
        }
        if (msg?.t === 'result') {
          settle({ result: toResult(msg), killed: null, exitCode: null, signal: null, stderr: '', codeStarted })
          return
        }
        if (msg?.t !== 'call') return
        const id = msg.id
        const method = typeof msg.method === 'string' ? msg.method : ''
        if (++calls > MAX_CALLS) return reply(id, false, undefined, 'A function run may make at most 10000 calls')
        if (inflight >= MAX_INFLIGHT_CALLS) return reply(id, false, undefined, `A function run may have at most ${MAX_INFLIGHT_CALLS} calls in flight`)
        const handler = Object.prototype.hasOwnProperty.call(handlers, method) ? handlers[method] : undefined
        if (typeof handler !== 'function') return reply(id, false, undefined, `Unknown method: ${method}`)
        let args: unknown[]
        try {
          const decoded = decodeValue(msg.args)
          args = Array.isArray(decoded) ? decoded : []
        } catch (err: any) {
          return reply(id, false, undefined, err?.message ?? String(err))
        }
        inflight++
        Promise.resolve()
          .then(() => handler(args))
          .then(
            (value) => reply(id, true, value ?? null),
            (err: any) => reply(id, false, undefined, err?.message ?? String(err)),
          )
          .catch(() => {})
          .finally(() => { inflight-- })
      } catch (err) {
        unreadable(err)
      }
    })

    session.onEnd((end) => {
      if (settled) return
      const refusal =
        end.busy !== undefined ? new FunctionRunnerBusyError(end.busy)
          : end.startFailed !== undefined ? new FunctionRunnerStartError(end.startFailed)
            : end.unavailable ? new FunctionRunnerUnavailableError(end.unavailable)
              : null
      if (refusal) {
        settled = true
        clearTimeout(backstop)
        reject(refusal)
        return
      }
      settle({ result: null, killed: end.killed, exitCode: end.exitCode, signal: end.signal, stderr: end.stderr, codeStarted })
    })

    try {
      session.send(JSON.stringify({ v: 1, kind: job.kind, ...job.payload }))
    } catch (err: any) {
      session.abort()
      settled = true
      clearTimeout(backstop)
      reject(err)
    }
  })
}
