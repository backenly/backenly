/**
 * FUNCTION SUPERVISOR: starts every function run under a uid of its own
 * =======================================================================
 *
 * The web and runtime processes hold every platform secret, so customer
 * function code may not run in them (function-runner.cjs says why). This
 * process runs as root beside them, holds no secret (the container entrypoint
 * starts it with an empty environment), and for each run:
 *
 *   - takes a uid from a pool, so no two runs that are alive at the same time
 *     share one, and gives it back only once nothing of the run is left;
 *   - starts a fresh `node function-runner.cjs` as that uid and gid, with no
 *     supplementary groups, no_new_privs (setpriv), rlimits (prlimit: processes,
 *     open files, file size, no core dumps), a heap limit, the lowest OOM-killer
 *     priority (oom_score_adj 1000) and a lower CPU priority than the app;
 *   - gives it an environment holding nothing secret and a private 0700
 *     working directory, removed afterwards;
 *   - kills it at a wall-clock deadline, or when the run's resident memory
 *     passes its limit, or when it writes more output than a run may;
 *   - afterwards kills every process the uid still has (a function can start
 *     its own), removes the files and System V IPC objects it left in the
 *     world-writable places, and only then returns the uid to the pool.
 *
 * A child at another uid cannot read /proc/<pid>/environ or the memory of the
 * supervisor, the app or another run, cannot traverse /app (0750 root:node in
 * the images), and cannot open the supervisor's socket.
 *
 * The app talks to it over a UNIX socket in a 0750 root:<app group> directory:
 *
 *   app -> supervisor   one header line: { v: 1, op: 'run', timeoutMs }
 *   app -> supervisor   every later byte goes to the run's stdin unchanged
 *   supervisor -> app   'c' + each line the run writes to stdout
 *   supervisor -> app   's' + { type: 'exit', code, signal, killed, stderr, error? }
 *                       or 's' + { type: 'refused', reason, busy? }
 *
 * `busy` marks a refusal for capacity (every slot taken and the queue full, or
 * the wait for a slot ran out): the app answers 503 and the function is not
 * at fault. Any other refusal is this deployment's, never the function's.
 * `error` on an exit says why the run's process could not be started: nothing
 * ran, so the app may start a sandbox run again.
 *
 * It parses nothing a run writes beyond splitting it into lines.
 *
 * Before it accepts a run it runs one probe as a pool uid and refuses every
 * run, with the reason, if that probe can read anything it must not: PID 1's
 * environment, its own, the app's, the socket directory, or any of
 * BACKENLY_FN_PROTECTED_PATHS. A deployment that is not what this file assumes
 * fails closed instead of running functions next to secrets.
 *
 * Configuration (environment, all optional except in production images, where
 * docker/function-isolation/entrypoint.sh sets them):
 *   BACKENLY_FN_SOCKET            socket path (/tmp/backenly-fn/supervisor.sock)
 *   BACKENLY_FN_SOCKET_GID        the app's group, which may connect
 *   BACKENLY_FN_RUNNER            runner path (function-runner.cjs beside this file)
 *   BACKENLY_FN_RUNS_DIR          parent of the per-run directories (/tmp/backenly-fn-runs)
 *   BACKENLY_FN_UID_BASE / _COUNT the uid pool (20000, 512); uids in /etc/passwd are skipped
 *   BACKENLY_FN_MAX_CONCURRENCY   runs at once (4; the images set 3 on web, 2 on runtime)
 *   BACKENLY_FN_MAX_QUEUE         runs that may wait for a slot (64); more are refused as busy
 *   BACKENLY_FN_QUEUE_WAIT_MS     how long a run may wait for a slot (10000); then refused as busy
 *   BACKENLY_FN_HEAP_MB / _RSS_MB heap limit (96) and resident limit (160) per run
 *   BACKENLY_FN_NPROC / _NOFILE   processes and threads (64), open files (256) per run
 *   BACKENLY_FN_FSIZE_MB          largest file a run may write (64)
 *   BACKENLY_FN_NODE_ENV          NODE_ENV a run sees (production)
 *   BACKENLY_FN_CA_CERTS          NODE_EXTRA_CA_CERTS a run sees (a path; RDS roots)
 *   BACKENLY_FN_PROTECTED_PATHS   colon-separated paths no run may read
 *   BACKENLY_FN_APP_PID           the app's pid, whose environment the probe must not read
 *
 * Outside a container, an operator runs it as root (for example from a
 * systemd unit) with BACKENLY_FN_SOCKET_GID set to the app user's group.
 */

'use strict'

const net = require('net')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { spawn, spawnSync } = require('child_process')

const MAX_HEADER_BYTES = 64 * 1024
const MAX_LINE_BYTES = 32 * 1024 * 1024
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024
const STDERR_KEEP_BYTES = 8 * 1024
const MIN_TIMEOUT_MS = 1000
const MAX_TIMEOUT_MS = 60000
const GRACE_MS = 2000
/** CPU seconds any one run process may use: twice the longest deadline a run can have. */
const CPU_LIMIT_SECONDS = (2 * MAX_TIMEOUT_MS) / 1000
const WORLD_WRITABLE_DIRS = ['/tmp', '/var/tmp', '/dev/shm', '/dev/mqueue', '/run/lock']
const C_PREFIX = Buffer.from('c')
const NEWLINE = Buffer.from('\n')

function intOf(value, fallback) {
  const n = Number.parseInt(String(value ?? ''), 10)
  return Number.isFinite(n) ? n : fallback
}

function firstExisting(candidates) {
  for (const c of candidates) {
    try {
      fs.accessSync(c, fs.constants.X_OK)
      return c
    } catch {
      // next
    }
  }
  return null
}

function readConfig(env) {
  const uidBase = intOf(env.BACKENLY_FN_UID_BASE, 20000)
  const uidCount = intOf(env.BACKENLY_FN_UID_COUNT, 512)
  if (uidBase < 10000) throw new Error(`BACKENLY_FN_UID_BASE must be at least 10000, not ${uidBase}`)
  if (uidCount < 2 || uidCount > 65536) throw new Error(`BACKENLY_FN_UID_COUNT must be between 2 and 65536, not ${uidCount}`)
  const maxConcurrency = Math.max(1, intOf(env.BACKENLY_FN_MAX_CONCURRENCY, 4))
  return {
    socketPath: env.BACKENLY_FN_SOCKET || '/tmp/backenly-fn/supervisor.sock',
    socketGid: intOf(env.BACKENLY_FN_SOCKET_GID, 0),
    runnerPath: env.BACKENLY_FN_RUNNER || path.join(__dirname, 'function-runner.cjs'),
    runsDir: env.BACKENLY_FN_RUNS_DIR || '/tmp/backenly-fn-runs',
    nodePath: env.BACKENLY_FN_NODE || process.execPath,
    prlimit: env.BACKENLY_FN_PRLIMIT || firstExisting(['/usr/bin/prlimit', '/bin/prlimit']),
    setpriv: env.BACKENLY_FN_SETPRIV || firstExisting(['/usr/bin/setpriv', '/bin/setpriv']),
    choom: firstExisting(['/usr/bin/choom', '/bin/choom']),
    nice: firstExisting(['/usr/bin/nice', '/bin/nice']),
    ipcrm: firstExisting(['/usr/bin/ipcrm', '/bin/ipcrm']),
    uidBase,
    uidCount,
    maxConcurrency: Math.min(maxConcurrency, uidCount - 1),
    maxQueue: Math.max(0, intOf(env.BACKENLY_FN_MAX_QUEUE, 64)),
    queueWaitMs: Math.max(0, intOf(env.BACKENLY_FN_QUEUE_WAIT_MS, 10000)),
    heapMb: Math.max(16, intOf(env.BACKENLY_FN_HEAP_MB, 96)),
    rssMb: Math.max(32, intOf(env.BACKENLY_FN_RSS_MB, 160)),
    nproc: Math.max(16, intOf(env.BACKENLY_FN_NPROC, 64)),
    nofile: Math.max(32, intOf(env.BACKENLY_FN_NOFILE, 256)),
    fsizeBytes: Math.max(1, intOf(env.BACKENLY_FN_FSIZE_MB, 64)) * 1024 * 1024,
    childNodeEnv: env.BACKENLY_FN_NODE_ENV || 'production',
    childCaCerts: env.BACKENLY_FN_CA_CERTS || '',
    protectedPaths: String(env.BACKENLY_FN_PROTECTED_PATHS || '').split(':').filter(Boolean),
    appPid: intOf(env.BACKENLY_FN_APP_PID, 0),
  }
}

// ─── The uid pool ────────────────────────────────────────────────────────────

/**
 * Uids for runs. `take` never hands out one that is out; `release` returns it to
 * the END of the free list, so a uid is reused as late as possible, and
 * quarantines it instead when its run could not be cleaned away.
 */
class UidPool {
  constructor(base, count, usable = () => true) {
    this.free = []
    this.busy = new Set()
    this.quarantined = new Set()
    for (let uid = base; uid < base + count; uid++) if (usable(uid)) this.free.push(uid)
  }
  take() {
    const uid = this.free.shift()
    if (uid === undefined) return null
    this.busy.add(uid)
    return uid
  }
  release(uid, clean) {
    if (!this.busy.delete(uid)) return
    if (clean) this.free.push(uid)
    else this.quarantined.add(uid)
  }
  get size() {
    return this.free.length + this.busy.size
  }
}

/** At most `limit` runs at once; the rest wait in order, each for at most its own deadline. */
class Gate {
  constructor(limit, maxQueue) {
    this.limit = limit
    this.maxQueue = maxQueue
    this.active = 0
    this.waiting = []
  }
  acquire(waitMs) {
    if (this.active < this.limit) {
      this.active++
      return Promise.resolve(true)
    }
    if (this.waiting.length >= this.maxQueue) return Promise.resolve(false)
    return new Promise((resolve) => {
      const entry = { resolve, timer: null }
      entry.timer = setTimeout(() => {
        const i = this.waiting.indexOf(entry)
        if (i >= 0) this.waiting.splice(i, 1)
        resolve(false)
      }, waitMs)
      this.waiting.push(entry)
    })
  }
  release() {
    const next = this.waiting.shift()
    if (next) {
      clearTimeout(next.timer)
      next.resolve(true)
    } else {
      this.active = Math.max(0, this.active - 1)
    }
  }
}

// ─── /proc ───────────────────────────────────────────────────────────────────

function statusOf(pid) {
  try {
    return fs.readFileSync(`/proc/${pid}/status`, 'utf8')
  } catch {
    return null
  }
}

/** Live (not zombie) processes whose real, effective or saved uid `owns` accepts. */
function processesOwnedBy(owns) {
  const out = []
  let names
  try {
    names = fs.readdirSync('/proc')
  } catch {
    return out
  }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue
    const status = statusOf(name)
    if (!status) continue
    if (/^State:\s+Z/m.test(status)) continue
    const m = /^Uid:\s+(\d+)\s+(\d+)\s+(\d+)/m.exec(status)
    if (m && (owns(Number(m[1])) || owns(Number(m[2])) || owns(Number(m[3])))) out.push(Number(name))
  }
  return out
}

/** Live (not zombie) processes whose real, effective or saved uid is `uid`. */
function processesOf(uid) {
  return processesOwnedBy((u) => u === uid)
}

/** Every uid some live process runs as, read once. */
function uidsInUse() {
  const uids = new Set()
  let names
  try {
    names = fs.readdirSync('/proc')
  } catch {
    return uids
  }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue
    const m = /^Uid:\s+(\d+)\s+(\d+)\s+(\d+)/m.exec(statusOf(name) || '')
    if (m) for (const i of [1, 2, 3]) uids.add(Number(m[i]))
  }
  return uids
}

function rssKbOf(pid) {
  const status = statusOf(pid)
  const m = status && /^VmRSS:\s+(\d+)\s+kB/m.exec(status)
  return m ? Number(m[1]) : 0
}

function uidsInPasswd() {
  const uids = new Set()
  try {
    for (const line of fs.readFileSync('/etc/passwd', 'utf8').split('\n')) {
      const uid = Number(line.split(':')[2])
      if (Number.isInteger(uid)) uids.add(uid)
    }
  } catch {
    // no passwd file: nothing to avoid
  }
  return uids
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Kill everything the uids `owns` accepts still run; the number killed, and whether nothing is left. */
async function reapOwnedBy(owns) {
  let killed = 0
  for (let round = 0; round < 40; round++) {
    const pids = processesOwnedBy(owns)
    if (pids.length === 0) return { killed, clean: true }
    for (const pid of pids) {
      try {
        process.kill(pid, 'SIGKILL')
        killed++
      } catch {
        // already gone
      }
    }
    await sleep(round < 5 ? 10 : 50)
  }
  return { killed, clean: processesOwnedBy(owns).length === 0 }
}

/** Kill everything `uid` still runs; true once nothing is left. */
async function reap(uid) {
  return (await reapOwnedBy((u) => u === uid)).clean
}

/**
 * What runs left where any uid may write, for the uids `owns` accepts:
 * files, directories and System V IPC objects. The number of files removed.
 */
function removeLeftovers(owns, ipcrm) {
  let removed = 0
  for (const dir of WORLD_WRITABLE_DIRS) {
    let names
    try {
      names = fs.readdirSync(dir)
    } catch {
      continue
    }
    for (const name of names) {
      const p = path.join(dir, name)
      try {
        if (owns(fs.lstatSync(p).uid)) {
          fs.rmSync(p, { recursive: true, force: true })
          removed++
        }
      } catch {
        // gone, or not ours to remove
      }
    }
  }
  if (!ipcrm) return removed
  for (const [file, idName, flag] of [
    ['/proc/sysvipc/shm', 'shmid', '-m'],
    ['/proc/sysvipc/sem', 'semid', '-s'],
    ['/proc/sysvipc/msg', 'msqid', '-q'],
  ]) {
    let lines
    try {
      lines = fs.readFileSync(file, 'utf8').trim().split('\n')
    } catch {
      continue
    }
    const head = (lines.shift() || '').trim().split(/\s+/)
    const idCol = head.indexOf(idName)
    const uidCol = head.indexOf('uid')
    const cuidCol = head.indexOf('cuid')
    if (idCol < 0 || uidCol < 0) continue
    for (const line of lines) {
      const cols = line.trim().split(/\s+/)
      if (owns(Number(cols[uidCol])) || (cuidCol >= 0 && owns(Number(cols[cuidCol])))) {
        spawnSync(ipcrm, [flag, cols[idCol]], { stdio: 'ignore' })
      }
    }
  }
  return removed
}

/**
 * Everything earlier runs left. A supervisor that exited (the entrypoint starts
 * another) leaves its runs going with no deadline and no memory watch, and
 * their files where the next run of the same uid would find them. So before
 * this one serves a run, every process of a pool uid is killed, what pool uids
 * own where any uid may write is removed, and so is every run directory.
 */
async function sweepPool(config, inPool) {
  const { killed, clean } = await reapOwnedBy(inPool)
  const removed = removeLeftovers(inPool, config.ipcrm)
  let runDirs = 0
  let names = []
  try {
    names = fs.readdirSync(config.runsDir)
  } catch {
    // no runs yet
  }
  for (const name of names) {
    try {
      fs.rmSync(path.join(config.runsDir, name), { recursive: true, force: true })
      runDirs++
    } catch {
      // gone
    }
  }
  return { killed, removed, runDirs, clean }
}

// ─── One run ─────────────────────────────────────────────────────────────────

/**
 * The command a run starts with. spawn() itself switches to the run's uid and
 * gid and drops supplementary groups; each program here then only lowers what
 * the run may do before it becomes node: rlimits (prlimit; NPROC counts per uid,
 * and the uid is the run's alone), the first process the OOM killer takes
 * (choom), a lower CPU priority than the app (nice), and no_new_privs (setpriv),
 * so no setuid binary can raise it again. The CPU limit is a backstop for a
 * process that outlives its supervisor: far past any run's own deadline, it
 * ends whatever a supervisor that exited could no longer stop.
 */
function childCommand(config) {
  const chain = [
    config.prlimit,
    `--nproc=${config.nproc}`,
    `--nofile=${config.nofile}`,
    '--core=0',
    `--fsize=${config.fsizeBytes}`,
    `--cpu=${CPU_LIMIT_SECONDS}:${CPU_LIMIT_SECONDS + 10}`,
    '--',
  ]
  if (config.choom) chain.push(config.choom, '-n', '1000', '--')
  if (config.nice) chain.push(config.nice, '-n', '10')
  chain.push(config.setpriv, '--no-new-privs', '--', config.nodePath, `--max-old-space-size=${config.heapMb}`, config.runnerPath)
  return { file: chain[0], args: chain.slice(1) }
}

/** Everything a run's process environment holds. Nothing in it is secret. */
function childEnv(config, runDir) {
  const env = {
    PATH: '/usr/local/bin:/usr/bin:/bin',
    NODE_ENV: config.childNodeEnv,
    TZ: 'UTC',
    LANG: 'C.UTF-8',
    HOME: runDir,
    TMPDIR: runDir,
  }
  if (config.childCaCerts) env.NODE_EXTRA_CA_CERTS = config.childCaCerts
  return env
}

function ensureDir(dir, mode, uid, gid) {
  let st = null
  try {
    st = fs.lstatSync(dir)
  } catch {
    // absent
  }
  if (st && (!st.isDirectory() || st.uid !== uid)) {
    // Not ours, in a world-writable parent: moved aside, never trusted.
    fs.renameSync(dir, `${dir}.untrusted-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`)
    st = null
  }
  if (!st) fs.mkdirSync(dir, { mode })
  fs.chownSync(dir, uid, gid)
  fs.chmodSync(dir, mode)
}

/**
 * Start one run. `onLine` receives each complete line the runner writes (a
 * Buffer, newline removed). Resolves with how it ended once its uid has been
 * cleaned and returned.
 */
function startRun(config, state, timeoutMs, onLine) {
  const uid = state.pool.take()
  if (uid === null) return null

  const runDir = path.join(config.runsDir, `run-${crypto.randomBytes(12).toString('hex')}`)
  let child
  let spawnError = null
  try {
    fs.mkdirSync(runDir, { mode: 0o700 })
    fs.chownSync(runDir, uid, uid)
    fs.chmodSync(runDir, 0o700)
    const { file, args } = childCommand(config)
    child = spawn(file, args, {
      uid,
      gid: uid,
      cwd: runDir,
      env: childEnv(config, runDir),
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    })
  } catch (err) {
    spawnError = err
  }

  let killed = null
  let stderrTail = Buffer.alloc(0)
  let output = 0
  let partial = Buffer.alloc(0)
  let resolveDone
  const done = new Promise((resolve) => { resolveDone = resolve })
  const timers = []

  const kill = (reason) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return
    if (!killed) killed = reason
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {
      try {
        child.kill('SIGKILL')
      } catch {
        // gone
      }
    }
  }

  const finalize = async (exit) => {
    for (const t of timers) clearInterval(t)
    let clean = await reap(uid)
    try {
      fs.rmSync(runDir, { recursive: true, force: true })
    } catch {
      clean = false
    }
    removeLeftovers((u) => u === uid, config.ipcrm)
    clean = clean && processesOf(uid).length === 0
    if (!clean) process.stderr.write(`function-supervisor: uid ${uid} could not be cleaned and is quarantined\n`)
    state.pool.release(uid, clean)
    resolveDone({
      code: exit.code,
      signal: exit.signal,
      killed,
      stderr: stderrTail.toString('utf8'),
      error: exit.error || null,
    })
  }

  if (spawnError || !child || !child.pid) {
    // `error` on the exit line says why the runner could not start, and only that.
    const message = (spawnError && spawnError.message) || 'no process was started'
    if (child) child.on('error', () => {})
    finalize({ code: null, signal: null, error: message })
    return { uid, feed() {}, abort() {}, done }
  }

  if (!config.choom) {
    try {
      fs.writeFileSync(`/proc/${child.pid}/oom_score_adj`, '1000')
    } catch {
      // not fatal: the RSS watchdog still bounds the run
    }
  }

  child.on('error', () => {})
  child.stdin.on('error', () => {})
  child.stderr.on('data', (chunk) => {
    stderrTail = Buffer.concat([stderrTail, chunk])
    if (stderrTail.length > STDERR_KEEP_BYTES) stderrTail = stderrTail.subarray(stderrTail.length - STDERR_KEEP_BYTES)
  })
  child.stdout.on('data', (chunk) => {
    output += chunk.length
    if (output > MAX_OUTPUT_BYTES) return kill('output')
    let data = partial.length ? Buffer.concat([partial, chunk]) : chunk
    let nl
    while ((nl = data.indexOf(10)) >= 0) {
      onLine(data.subarray(0, nl))
      data = data.subarray(nl + 1)
    }
    partial = Buffer.from(data)
    if (partial.length > MAX_LINE_BYTES) kill('output')
  })

  timers.push(setTimeout(() => kill('timeout'), timeoutMs + GRACE_MS))
  let tick = 0
  timers.push(setInterval(() => {
    tick++
    let kb = rssKbOf(child.pid)
    // Every second, the whole uid: a run may have started processes of its own.
    if (tick % 10 === 0) kb = processesOf(uid).reduce((sum, pid) => sum + rssKbOf(pid), 0)
    if (kb > config.rssMb * 1024) kill('memory')
  }, 100))

  let exited = null
  child.on('exit', (code, signal) => {
    exited = { code, signal }
    // Anything the run started still holds its pipes open: end it all now.
    reap(uid).then(() => {
      setTimeout(() => {
        child.stdout.destroy()
        child.stderr.destroy()
      }, 1000)
    })
  })
  child.on('close', () => finalize(exited || { code: child.exitCode, signal: child.signalCode }))

  return {
    uid,
    feed(bytes) {
      if (child.stdin.writable) child.stdin.write(bytes)
    },
    abort(reason) {
      kill(reason)
    },
    done,
  }
}

// ─── The socket ──────────────────────────────────────────────────────────────

function parseHeader(buf) {
  let header
  try {
    header = JSON.parse(buf.toString('utf8'))
  } catch {
    return null
  }
  if (!header || header.v !== 1 || header.op !== 'run') return null
  const timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Number(header.timeoutMs) || 10000))
  return { timeoutMs }
}

function supervisorLine(socket, message) {
  if (!socket.destroyed) socket.write(`s${JSON.stringify(message)}\n`)
}

function serve(config, state, socket) {
  let head = Buffer.alloc(0)
  let header = null
  let run = null
  let gone = false
  const early = []

  socket.on('error', () => {})
  socket.on('close', () => {
    gone = true
    if (run) run.abort('caller')
  })

  const begin = async () => {
    if (state.refusing) {
      supervisorLine(socket, { type: 'refused', reason: state.refusing })
      return socket.end()
    }
    // acquire decides a full queue at once, so this says which refusal it was.
    const queueFull = state.gate.active >= state.gate.limit && state.gate.waiting.length >= state.gate.maxQueue
    const admitted = await state.gate.acquire(config.queueWaitMs)
    if (!admitted) {
      supervisorLine(socket, {
        type: 'refused',
        busy: true,
        reason:
          `every function slot on this server (${config.maxConcurrency}) was in use and ` +
          (queueFull ? `the queue for one (${config.maxQueue}) was full` : `none came free within ${config.queueWaitMs} ms`),
      })
      return socket.end()
    }
    if (gone) return state.gate.release()
    run = startRun(config, state, header.timeoutMs, (line) => {
      if (!socket.destroyed) socket.write(Buffer.concat([C_PREFIX, line, NEWLINE]))
    })
    if (!run) {
      state.gate.release()
      supervisorLine(socket, { type: 'refused', busy: true, reason: 'no uid was free for another run' })
      return socket.end()
    }
    for (const bytes of early.splice(0)) run.feed(bytes)
    state.active.add(run)
    const end = await run.done
    state.active.delete(run)
    state.gate.release()
    if (end.killed && end.killed !== 'caller') {
      process.stderr.write(`function-supervisor: a run was stopped (${end.killed})\n`)
    }
    supervisorLine(socket, { type: 'exit', ...end })
    socket.end()
  }

  socket.on('data', (chunk) => {
    if (header) {
      if (run) run.feed(chunk)
      else early.push(chunk)
      return
    }
    head = Buffer.concat([head, chunk])
    const nl = head.indexOf(10)
    if (nl < 0) {
      if (head.length > MAX_HEADER_BYTES) socket.destroy()
      return
    }
    header = parseHeader(head.subarray(0, nl))
    const rest = head.subarray(nl + 1)
    head = Buffer.alloc(0)
    if (!header) {
      supervisorLine(socket, { type: 'refused', reason: 'malformed request' })
      return socket.end()
    }
    if (rest.length) early.push(Buffer.from(rest))
    begin().catch((err) => {
      supervisorLine(socket, { type: 'refused', reason: `supervisor error: ${err && err.message}` })
      socket.end()
    })
  })
}

// ─── The self-check ──────────────────────────────────────────────────────────

/** Run one probe as a pool uid. Returns null when this deployment is fit to run functions, else why not. */
async function selfCheck(config, state) {
  const mustNotRead = [
    '/proc/1/environ',
    `/proc/${process.pid}/environ`,
    path.dirname(config.socketPath),
    ...(config.appPid > 0 ? [`/proc/${config.appPid}/environ`] : []),
    ...config.protectedPaths,
  ]
  const lines = []
  const run = startRun(config, state, 5000, (line) => lines.push(line.toString('utf8')))
  if (!run) return 'no uid is free for the probe'
  run.feed(Buffer.from(JSON.stringify({ v: 1, kind: 'probe', mustNotRead }) + '\n'))
  const end = await run.done
  if (end.error) return end.error
  let result = null
  for (const line of lines) {
    try {
      const msg = JSON.parse(line)
      if (msg && msg.t === 'result') result = msg
    } catch {
      // not the result
    }
  }
  if (!result || !result.ok) return `the probe run gave no answer (exit ${end.code}, ${end.signal || 'no signal'}): ${end.stderr.trim().slice(-500)}`
  const seen = result.value || {}
  if (seen.uid !== run.uid || seen.gid !== run.uid) return `the probe ran as uid ${seen.uid}/gid ${seen.gid}, not ${run.uid}`
  if (!Array.isArray(seen.groups) || seen.groups.some((g) => g !== run.uid)) return `the probe kept groups ${JSON.stringify(seen.groups)}`
  const allowed = new Set(Object.keys(childEnv(config, '/')))
  const extra = (seen.env || []).filter((k) => !allowed.has(k))
  if (extra.length) return `the probe's environment held ${extra.join(', ')}`
  const readable = Object.entries(seen.results || {}).filter(([, r]) => r === 'readable').map(([p]) => p)
  if (readable.length) return `a function could read ${readable.join(', ')}`
  return null
}

// ─── Entry ───────────────────────────────────────────────────────────────────

async function main() {
  if (typeof process.getuid !== 'function' || process.getuid() !== 0) {
    process.stderr.write('function-supervisor: must run as root, to start each run under its own uid\n')
    process.exit(1)
  }
  const config = readConfig(process.env)
  for (const [name, value] of [['prlimit', config.prlimit], ['setpriv', config.setpriv]]) {
    if (!value) {
      process.stderr.write(`function-supervisor: ${name} (util-linux) is required and was not found\n`)
      process.exit(1)
    }
  }
  const named = uidsInPasswd()
  const inPool = (uid) => uid >= config.uidBase && uid < config.uidBase + config.uidCount && !named.has(uid)
  // Before anything else: whatever an earlier supervisor's runs left.
  const swept = await sweepPool(config, inPool)
  if (swept.killed || swept.removed || swept.runDirs) {
    process.stderr.write(
      `function-supervisor: removed what earlier runs left: ${swept.killed} process(es), ${swept.removed} file(s), ${swept.runDirs} run director(ies)\n`,
    )
  }
  // A uid something still runs as (one that would not die) is never handed out.
  const running = uidsInUse()
  const state = {
    pool: new UidPool(config.uidBase, config.uidCount, (uid) => !named.has(uid) && !running.has(uid)),
    gate: new Gate(config.maxConcurrency, config.maxQueue),
    active: new Set(),
    refusing: null,
  }
  if (state.pool.size <= config.maxConcurrency) {
    process.stderr.write('function-supervisor: the uid pool is smaller than the concurrency it must serve\n')
    process.exit(1)
  }

  ensureDir(config.runsDir, 0o711, 0, 0)
  ensureDir(path.dirname(config.socketPath), 0o750, 0, config.socketGid)
  try {
    fs.unlinkSync(config.socketPath)
  } catch {
    // none left behind
  }

  state.refusing = await selfCheck(config, state).catch((err) => `the probe failed: ${err && err.message}`)
  if (state.refusing) process.stderr.write(`function-supervisor: REFUSING every function run: ${state.refusing}\n`)

  const server = net.createServer((socket) => serve(config, state, socket))
  server.listen(config.socketPath, () => {
    fs.chownSync(config.socketPath, 0, config.socketGid)
    fs.chmodSync(config.socketPath, 0o660)
    process.stderr.write(
      `function-supervisor: listening on ${config.socketPath}; uids ${config.uidBase}-${config.uidBase + config.uidCount - 1}, ` +
        `${config.maxConcurrency} at once, heap ${config.heapMb} MB, rss ${config.rssMb} MB${state.refusing ? ', refusing runs' : ''}\n`,
    )
  })
  const stop = () => {
    server.close()
    for (const run of state.active) run.abort('shutdown')
    setTimeout(() => process.exit(0), 500)
  }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`function-supervisor: ${(err && err.stack) || err}\n`)
    process.exit(1)
  })
}

module.exports = { readConfig, UidPool, Gate, childCommand, childEnv, parseHeader, processesOf, selfCheck }
