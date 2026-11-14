/**
 * Probe a running Backenly container's function isolation from inside it.
 *
 * Run as the app user inside the container, fed on stdin by
 * scripts/test/function-isolation-docker.sh:
 *
 *   docker exec -i -u node <container> node - < scripts/test/function-isolation-probe.cjs
 *
 * It talks to the function supervisor the way the app does (its socket,
 * lib/services/ai-functions/isolation/function-supervisor.cjs), sends real
 * function code that tries the known vm escapes, and checks
 * what comes back: a pool uid, nothing secret, nothing protected, timeouts and
 * memory limits enforced, nothing left behind. The container's environment
 * holds planted values standing in for the platform's secrets; a run must
 * never see one. Prints one line per check and exits non-zero on any failure.
 */
'use strict'

const net = require('net')
const fs = require('fs')

const SOCKET = process.env.BACKENLY_FN_SOCKET || '/tmp/backenly-fn/supervisor.sock'
const PLANTED = Object.entries(process.env)
  .filter(([, v]) => typeof v === 'string' && v.includes('planted-not-a-real'))
  .map(([, v]) => v)
const ALLOWED_ENV = ['HOME', 'LANG', 'NODE_ENV', 'NODE_EXTRA_CA_CERTS', 'PATH', 'TMPDIR', 'TZ']
const APP_UID = typeof process.getuid === 'function' ? process.getuid() : -1

let failures = 0
function check(name, ok, detail) {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail !== undefined ? `\n      ${JSON.stringify(detail).slice(0, 2000)}` : ''}`)
}

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
    app: attempt(() => fs.readdirSync('/app')),
    workspace: attempt(() => fs.readdirSync('/app/workspace')),
    backups: attempt(() => fs.readdirSync('/app/backups')),
    socketDir: attempt(() => fs.readdirSync('/tmp/backenly-fn')),
    environs,
  })
}
`

async function main() {
  check('the supervisor socket exists', fs.existsSync(SOCKET), SOCKET)
  check('planted values are present to look for', PLANTED.length >= 3, PLANTED.length)

  // Three runs at once: three different pool uids.
  const runs = await Promise.all([run('route', route(ESCAPE)), run('route', route(ESCAPE)), run('route', route(ESCAPE))])
  const seen = runs.map((r) => (r.result && r.result.ok ? r.result.value.body : null))
  check('every escape run answered', seen.every(Boolean), runs.map((r) => r.end))
  if (seen.every(Boolean)) {
    const uids = seen.map((s) => s.uid)
    check('overlapping runs ran under distinct uids', new Set(uids).size === uids.length, uids)
    check('no run was root or the app user', uids.every((u) => u !== 0 && u !== APP_UID), uids)
    check('each run had its own gid and no other group', seen.every((s) => s.gid === s.uid && s.groups.every((g) => g === s.uid)), seen.map((s) => [s.uid, s.gid, s.groups]))
    check('a run\'s environment held only its fixed names', seen.every((s) => Object.keys(s.env).every((k) => ALLOWED_ENV.includes(k))), seen[0].env)
    check('both escapes reached the run\'s own process', seen.every((s) => s.samePid))
    check('no platform database client was there to borrow', seen.every((s) => s.platformClient === 'undefined'))
    check('/app and its volumes were out of reach', seen.every((s) => [s.app, s.workspace, s.backups].every((v) => v === 'refused:EACCES' || v === 'refused:ENOENT')), [seen[0].app, seen[0].workspace, seen[0].backups])
    check('the supervisor socket was out of reach', seen.every((s) => s.socketDir === 'refused:EACCES'), seen[0].socketDir)
    const foreign = seen.flatMap((s) => s.environs.filter((e) => typeof e.text === 'string' && e.uid !== s.uid))
    check('no other process\'s environment was readable', foreign.length === 0, foreign.map((e) => e.pid))
    const text = JSON.stringify(seen)
    check('no planted secret came back', PLANTED.every((v) => !text.includes(v)))
  }

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
  check('a sandbox body escaping its vm saw nothing secret', !!box && box.pid1 === 'refused' && PLANTED.every((v) => !JSON.stringify(box).includes(v)), escaped)

  const hung = await run('route', route(`
    const { NextResponse } = require('next/server')
    exports.GET = async function GET() { while (true) {} }
  `))
  check('a handler that never yields was killed at its deadline', !hung.result && hung.end.killed === 'timeout', hung.end)

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
  await new Promise((r) => setTimeout(r, 1500))
  check('a process a run started did not outlive it', leftPid > 0 && !fs.existsSync(`/proc/${leftPid}`), leftPid)
  check('a file a run left in /tmp was removed', !fs.existsSync(marker), marker)

  console.log(failures ? `\n${failures} check(s) FAILED` : '\nevery check passed')
  process.exit(failures ? 1 : 0)
}

main().catch((err) => {
  console.log(`FAIL  the probe itself: ${err && err.stack}`)
  process.exit(1)
})
