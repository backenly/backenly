/**
 * Probe a running Backenly container's function isolation from inside it.
 *
 * Fed on stdin by scripts/test/function-isolation-docker.sh, in one of three
 * modes (PROBE_MODE):
 *
 *   docker exec -i -e PROBE_MODE=processes <c> node -       as root: what runs, as whom, with what
 *   docker exec -i -u node <c> node -                       as the app user: function runs
 *   docker exec -i -u node -e PROBE_MODE=quick <c> node -   one run, for a second container
 *
 * As the app user it talks to the function supervisor the way the app does
 * (its socket, lib/services/ai-functions/isolation/function-supervisor.cjs),
 * sends real function code that tries the known vm escapes, and checks what
 * comes back: a pool uid, nothing secret, nothing protected, timeouts and
 * memory limits enforced, nothing left behind. The container's environment
 * holds planted values standing in for the platform's secrets; a run must
 * never see one. Prints one line per check and exits non-zero on any failure.
 */
'use strict'

const net = require('net')
const fs = require('fs')

const MODE = process.env.PROBE_MODE || 'runs'
const SOCKET = process.env.BACKENLY_FN_SOCKET || '/tmp/backenly-fn/supervisor.sock'
const PLANTED = Object.entries(process.env)
  .filter(([, v]) => typeof v === 'string' && v.includes('planted-not-a-real'))
  .map(([, v]) => v)
const ALLOWED_ENV = ['HOME', 'LANG', 'NODE_ENV', 'NODE_EXTRA_CA_CERTS', 'PATH', 'TMPDIR', 'TZ']
const APP_UID = typeof process.getuid === 'function' ? process.getuid() : -1
const POOL_BASE = Number(process.env.BACKENLY_FN_UID_BASE) || 20000
/** What a run must not read: /app, and the two volumes wherever they are mounted. */
const VOLUMES = [process.env.WORKSPACE_DIR || '/app/workspace', process.env.BACKUP_DIR || '/app/backups']
const PROTECTED = ['/app', ...VOLUMES]

let failures = 0
function check(name, ok, detail) {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail !== undefined ? `\n      ${JSON.stringify(detail).slice(0, 2000)}` : ''}`)
}

function finish() {
  console.log(failures ? `\n${failures} check(s) FAILED` : '\nevery check passed')
  process.exit(failures ? 1 : 0)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Live (not zombie) processes: pid, parent, uid, command line. */
function processes() {
  const out = []
  for (const name of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue
    try {
      const status = fs.readFileSync(`/proc/${name}/status`, 'utf8')
      if (/^State:\s+Z/m.test(status)) continue
      const uid = Number(/^Uid:\s+(\d+)/m.exec(status)[1])
      const ppid = Number(/^PPid:\s+(\d+)/m.exec(status)[1])
      const cmdline = fs.readFileSync(`/proc/${name}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' ')
      out.push({ pid: Number(name), ppid, uid, cmdline })
    } catch {
      // gone
    }
  }
  return out
}

const poolProcesses = () => processes().filter((p) => p.uid >= POOL_BASE)

// ─── As root: what runs, as whom, with what ──────────────────────────────────

function processTable() {
  const all = processes()
  const listing = all.map((p) => [p.pid, p.ppid, p.uid, p.cmdline])
  const pid1 = all.find((p) => p.pid === 1)
  check('PID 1 is tini', !!pid1 && /\btini\b/.test(pid1.cmdline), pid1)

  const supervisors = all.filter((p) => p.cmdline.includes('function-supervisor.cjs'))
  check('exactly one function supervisor is running', supervisors.length === 1, listing)
  const supervisor = supervisors[0]
  if (supervisor) {
    check('the supervisor runs as root', supervisor.uid === 0, supervisor)
    const environ = fs.readFileSync(`/proc/${supervisor.pid}/environ`, 'utf8').split('\0').filter(Boolean)
    const names = environ.map((kv) => kv.slice(0, kv.indexOf('=')))
    check(
      "the supervisor's environment holds only PATH and its own BACKENLY_FN_ settings",
      names.every((n) => n === 'PATH' || n.startsWith('BACKENLY_FN_')),
      names,
    )
    check("no planted secret is in the supervisor's environment", PLANTED.every((v) => !environ.some((kv) => kv.includes(v))))
  }

  // tini's one child is the image's CMD, which the entrypoint became.
  const apps = all.filter((p) => p.ppid === 1)
  const app = apps.length === 1 ? apps[0] : null
  check(`the app (${app ? app.cmdline : '?'}) runs as node, uid 1000`, !!app && app.uid === 1000, listing)
  if (app) {
    const appEnv = fs.readFileSync(`/proc/${app.pid}/environ`, 'utf8')
    check('the app holds the planted secrets a run must not see', PLANTED.length >= 3 && PLANTED.every((v) => appEnv.includes(v)), PLANTED.length)
  }
  const appDir = fs.statSync('/app')
  check('/app is root:node 0750', appDir.uid === 0 && appDir.gid === 1000 && (appDir.mode & 0o777) === 0o750, [appDir.uid, appDir.gid, (appDir.mode & 0o777).toString(8)])
  for (const dir of VOLUMES) {
    let mode
    try {
      const st = fs.statSync(dir)
      mode = `${st.uid}:${st.gid} ${(st.mode & 0o777).toString(8)}`
    } catch (err) {
      mode = err.code
    }
    check(`${dir} is the app's and closed to other uids`, mode === '1000:1000 750' || mode === '1000:1000 700', mode)
  }
  finish()
}

// ─── As the app user: function runs through the supervisor ───────────────────

/** One run through the supervisor: the runner's answer, and how the run ended. */
function run(kind, payload, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(SOCKET)
    let buffered = ''
    let result = null
    socket.setEncoding('utf8')
    socket.on('connect', () => {
      socket.write(JSON.stringify({ v: 1, op: 'run', timeoutMs }) + '\n')
      socket.write(JSON.stringify({ v: 1, kind, ...payload }) + '\n')
    })
    socket.on('data', (chunk) => {
      buffered += chunk
      let nl
      while ((nl = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, nl)
        buffered = buffered.slice(nl + 1)
        let msg = null
        try {
          msg = JSON.parse(line.slice(1))
        } catch {
          continue
        }
        if (line[0] === 'c' && msg && msg.t === 'result') result = msg
        if (line[0] === 's') {
          resolve({ result, end: msg })
          socket.end()
        }
      }
    })
    socket.on('error', reject)
  })
}

/** A route module, as the app would send it once compiled. */
const route = (compiled) => ({
  projectId: '55555555-6666-4777-8888-999999999999',
  compiled,
  hint: 'GET',
  data: {},
  headers: {},
  env: {},
  nodeEnv: 'production',
  testRun: false,
  verifiedTokens: [],
  adminKey: null,
  db: {},
  text: { asServiceNote: '', signRefused: '' },
  withheldNames: ['JWT_SECRET', 'ADMIN_API_KEY', 'AI_EXECUTION_TOKEN'],
  ownerTest: { token: 'owner-test-run', userId: '00000000-0000-4000-8000-000000000001' },
  timeoutMs: 10000,
})

const ESCAPE = `
const { NextResponse } = require('next/server')
exports.GET = async function GET(request) {
  const C = 'constructor'
  const p = Object.constructor('return process')()
  const viaRequest = request[C][C]('return process')()
  const fs = p.getBuiltinModule ? p.getBuiltinModule('fs') : p.mainModule.require('fs')
  const attempt = (fn) => { try { return fn() } catch (e) { return 'refused:' + (e && e.code) } }
  const environs = []
  for (const name of fs.readdirSync('/proc')) {
    if (!/^[0-9]+$/.test(name)) continue
    const text = attempt(() => fs.readFileSync('/proc/' + name + '/environ', 'utf8'))
    environs.push({ pid: Number(name), uid: attempt(() => fs.statSync('/proc/' + name).uid), text })
  }
  await new Promise((r) => setTimeout(r, 1000))
  return NextResponse.json({
    uid: p.getuid(), gid: p.getgid(), groups: p.getgroups(), pid: p.pid,
    env: Object.assign({}, p.env), samePid: viaRequest.pid === p.pid,
    platformClient: typeof Object.constructor('return globalThis')().prisma,
    pid1: attempt(() => fs.readFileSync('/proc/1/environ', 'utf8')),
    protectedDirs: ${JSON.stringify(PROTECTED)}.map((d) => attempt(() => fs.readdirSync(d))),
    socketDir: attempt(() => fs.readdirSync('/tmp/backenly-fn')),
    environs,
  })
}
`

function checkEscapes(seen) {
  const uids = seen.map((s) => s.uid)
  check('overlapping runs ran under distinct pool uids', new Set(uids).size === uids.length && uids.every((u) => u >= POOL_BASE), uids)
  check('no run was root or the app user', uids.every((u) => u !== 0 && u !== APP_UID), uids)
  check('each run had its own gid and no other group', seen.every((s) => s.gid === s.uid && s.groups.every((g) => g === s.uid)), seen.map((s) => [s.uid, s.gid, s.groups]))
  check("a run's environment held only its fixed names", seen.every((s) => Object.keys(s.env).every((k) => ALLOWED_ENV.includes(k))), seen[0].env)
  check("both escapes reached the run's own process", seen.every((s) => s.samePid))
  check('no platform database client was there to borrow', seen.every((s) => s.platformClient === 'undefined'))
  check("/proc/1/environ was unreadable", seen.every((s) => s.pid1 === 'refused:EACCES'), seen[0].pid1)
  const foreign = seen.flatMap((s) => s.environs.filter((e) => typeof e.text === 'string' && e.uid !== s.uid))
  check("no other process's environment (tini's, the supervisor's, the app's) was readable", foreign.length === 0, foreign.map((e) => [e.pid, e.uid]))
  check(`${PROTECTED.join(', ')} were out of reach`, seen.every((s) => s.protectedDirs.every((v) => v === 'refused:EACCES')), seen[0].protectedDirs)
  check('the supervisor socket was out of reach', seen.every((s) => s.socketDir === 'refused:EACCES'), seen[0].socketDir)
  check('no planted secret came back', PLANTED.every((v) => !JSON.stringify(seen).includes(v)))
}

/** Until no pool uid runs anything (a run that answered may live on briefly). */
async function poolIdle(ms = 10000) {
  const deadline = Date.now() + ms
  while (poolProcesses().length > 0 && Date.now() < deadline) await sleep(100)
  return poolProcesses().length === 0
}

async function runs() {
  check('the supervisor socket exists', fs.existsSync(SOCKET), SOCKET)
  check('planted values are present to look for', PLANTED.length >= 3, PLANTED.length)

  // Runs at once, up to the image's concurrency: each under a pool uid of its own.
  const overlap = Math.max(2, Math.min(3, Number(process.env.BACKENLY_FN_MAX_CONCURRENCY) || 2))
  const all = await Promise.all(Array.from({ length: overlap }, () => run('route', route(ESCAPE))))
  const seen = all.map((r) => (r.result && r.result.ok ? r.result.value.body : null))
  check(`${overlap} overlapping escape runs answered`, seen.every(Boolean), all.map((r) => r.end))
  if (seen.every(Boolean)) checkEscapes(seen)

  const escaped = await run('sandbox', {
    code: `
      const p = Object.constructor('return this')()['proc' + 'ess']
      const load = (n) => (p.getBuiltinModule ? p.getBuiltinModule(n) : p.mainModule.require(n))
      let pid1 = 'refused'
      try { pid1 = load('f' + 's').readFileSync('/proc/1/environ', 'utf8') } catch (e) {}
      return { uid: p.getuid(), env: Object.assign({}, p.env), pid1 }
    `,
    event: { type: 'manual', data: {} },
    connectedIntegrations: [],
    envVars: {},
    integrationManifest: {},
    timeoutMs: 9500,
  }, 12000)
  const box = escaped.result && escaped.result.ok ? escaped.result.value : null
  check(
    'a sandbox body escaping its vm ran under a pool uid and saw nothing secret',
    !!box && box.uid >= POOL_BASE && box.pid1 === 'refused' && PLANTED.every((v) => !JSON.stringify(box).includes(v)),
    escaped,
  )

  // A handler that never yields: killed at its deadline, and nothing of its uid left.
  check('no earlier run was still alive', await poolIdle(), poolProcesses())
  const hanging = run('route', route(`
    const { NextResponse } = require('next/server')
    exports.GET = async function GET() { while (true) {} }
  `))
  await sleep(2000)
  const hungUids = [...new Set(poolProcesses().map((p) => p.uid))]
  const startedAt = Date.now()
  const hung = await hanging
  check(
    `a handler that never yields was killed at its deadline (${((Date.now() - startedAt) / 1000 + 2).toFixed(1)}s in)`,
    !hung.result && hung.end.killed === 'timeout',
    hung.end,
  )
  await sleep(1500)
  const left = processes().filter((p) => hungUids.includes(p.uid))
  check(`its uid (${hungUids.join(', ')}) was reaped: no process of it is left`, hungUids.length === 1 && left.length === 0, { hungUids, left })

  const bloated = await run('route', route(`
    const { NextResponse } = require('next/server')
    exports.GET = async function GET() {
      const keep = []
      for (let i = 0; i < 64; i++) { keep.push(Buffer.alloc(16 * 1024 * 1024, 1)); await new Promise((r) => setTimeout(r, 20)) }
      return NextResponse.json({ held: keep.length })
    }
  `))
  check('a run holding memory outside its heap was killed', !bloated.result && bloated.end.killed === 'memory', bloated.end)

  const marker = `/tmp/backenly-fn-probe-${process.pid}`
  const leaving = await run('route', route(`
    const { NextResponse } = require('next/server')
    exports.GET = async function GET() {
      const p = Object.constructor('return process')()
      const load = (n) => (p.getBuiltinModule ? p.getBuiltinModule(n) : p.mainModule.require(n))
      load('fs').writeFileSync(${JSON.stringify(marker)}, 'left behind')
      const child = load('child' + '_process').spawn('sleep', ['60'], { detached: true, stdio: 'ignore' })
      child.unref()
      return NextResponse.json({ pid: child.pid })
    }
  `))
  const leftPid = leaving.result && leaving.result.ok ? leaving.result.value.body.pid : 0
  await sleep(1500)
  check('a process a run started did not outlive it', leftPid > 0 && !fs.existsSync(`/proc/${leftPid}`), leftPid)
  check('a file a run left in /tmp was removed', !fs.existsSync(marker), marker)

  finish()
}

/** One escape run, for a second container that only has to show the same holds there. */
async function quick() {
  const one = await run('route', route(ESCAPE))
  const seen = one.result && one.result.ok ? one.result.value.body : null
  check('an escape run answered', !!seen, one.end)
  if (seen) {
    check('it ran under a pool uid', seen.uid >= POOL_BASE && seen.uid !== APP_UID, seen.uid)
    check(`${PROTECTED.join(', ')} were out of reach`, seen.protectedDirs.every((v) => v === 'refused:EACCES'), seen.protectedDirs)
    check('no planted secret came back', PLANTED.every((v) => !JSON.stringify(seen).includes(v)))
  }
  finish()
}

const main = MODE === 'processes' ? async () => processTable() : MODE === 'quick' ? quick : runs
main().catch((err) => {
  console.log(`FAIL  the probe itself: ${err && err.stack}`)
  process.exit(1)
})
