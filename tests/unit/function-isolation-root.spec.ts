/**
 * THE UID BOUNDARY, AS ROOT
 * =========================
 *
 * In production, function code runs in a process the root function supervisor
 * (lib/services/ai-functions/isolation/function-supervisor.cjs) starts under a
 * uid no other live process shares. That is what keeps a function that
 * escapes its vm context from reading the app's environment and memory, and it
 * can only be set up, and so only tested, as root on Linux with util-linux.
 *
 * Here a real supervisor runs from a world-readable copy (the checkout may sit
 * in a 0750 home directory pool uids cannot traverse), on its own socket and
 * its own uid range, and real functions try the known escapes.
 * CI runs this file a second time under sudo (.github/workflows/ci.yml,
 * "Function isolation, as root"); anywhere else it is skipped, and its name
 * says why. scripts/test/function-isolation-docker.sh proves the same against
 * a built image.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { executeRouteModuleFunction } from '@/lib/services/ai-functions/route-module-runner'
import { encodeValue, FunctionRunnerUnavailableError, runIsolated } from '@/lib/services/ai-functions/isolation/client'

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0
const utilLinux = ['/usr/bin/setpriv', '/usr/bin/prlimit'].every((p) => existsSync(p))
const skipReason =
  process.platform !== 'linux' ? 'needs Linux'
    : !isRoot ? `needs root, and this is uid ${process.getuid?.()}`
      : !utilLinux ? 'needs util-linux setpriv and prlimit'
        : null
const describeAsRoot = skipReason ? describe.skip : describe

jest.setTimeout(90_000)

const PROJECT = '44444444-5555-4666-8777-888888888888'
const AUTH = { jwtSecret: null, adminKey: null }
const BASE = 2_000_100_000
const COUNT = 16
const PLANTED = 'planted-not-a-real-secret-for-the-root-suite'
const ISOLATION = join(__dirname, '..', '..', 'lib', 'services', 'ai-functions', 'isolation')

const inPool = (uid: number) => uid >= BASE && uid < BASE + COUNT

/** Live processes whose uid is in the test pool. */
function poolProcesses(base = BASE, count = COUNT): number[] {
  const out: number[] = []
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue
    try {
      const status = readFileSync(`/proc/${name}/status`, 'utf8')
      if (/^State:\s+Z/m.test(status)) continue
      const uid = Number(/^Uid:\s+(\d+)/m.exec(status)?.[1])
      if (uid >= base && uid < base + count) out.push(Number(name))
    } catch {
      // gone
    }
  }
  return out
}

async function until(check: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (check()) return true
    await new Promise((r) => setTimeout(r, 100))
  }
  return check()
}

/** A supervisor of our own, from a copy any uid can read. */
async function startSupervisor(dir: string, base: number, protectedPaths: string): Promise<{ socket: string; child: ChildProcess; log: () => string }> {
  const socket = join(dir, `sock-${base}`, 'supervisor.sock')
  let log = ''
  const child = spawn(join(dir, 'node'), [join(dir, 'function-supervisor.cjs')], {
    env: {
      PATH: '/usr/local/bin:/usr/bin:/bin',
      BACKENLY_FN_SOCKET: socket,
      BACKENLY_FN_SOCKET_GID: '0',
      BACKENLY_FN_RUNNER: join(dir, 'function-runner.cjs'),
      BACKENLY_FN_NODE: join(dir, 'node'),
      BACKENLY_FN_RUNS_DIR: join(dir, `runs-${base}`),
      BACKENLY_FN_UID_BASE: String(base),
      BACKENLY_FN_UID_COUNT: String(COUNT),
      BACKENLY_FN_MAX_CONCURRENCY: '4',
      BACKENLY_FN_RSS_MB: '160',
      BACKENLY_FN_PROTECTED_PATHS: protectedPaths,
      BACKENLY_FN_APP_PID: String(process.pid),
      // Proves the supervisor's own environment never reaches a run.
      PLANTED_SUPERVISOR_SECRET: PLANTED,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  child.stderr!.on('data', (chunk) => { log += chunk.toString() })
  const up = await until(() => existsSync(socket), 20_000)
  if (!up) throw new Error(`the supervisor did not start:\n${log}`)
  return { socket, child, log: () => log }
}

describeAsRoot(`the function supervisor, as root${skipReason ? ` (SKIPPED: ${skipReason})` : ''}`, () => {
  let dir = ''
  let protectedDir = ''
  let supervisor: Awaited<ReturnType<typeof startSupervisor>>
  const env = process.env as Record<string, string | undefined>
  const before = { flag: env.BACKENLY_UNSAFE_LOCAL_FUNCTIONS, socket: env.BACKENLY_FN_SOCKET, planted: env.PLANTED_APP_SECRET }

  beforeAll(async () => {
    dir = mkdtempSync('/tmp/backenly-fn-root-test-')
    chmodSync(dir, 0o755)
    for (const file of ['function-runner.cjs', 'function-supervisor.cjs']) copyFileSync(join(ISOLATION, file), join(dir, file))
    // The node binary too: a tool cache under a private home is not readable by a pool uid.
    copyFileSync(process.execPath, join(dir, 'node'))
    chmodSync(join(dir, 'node'), 0o755)
    // Stands in for the EFS volumes under /app: only its owner may enter.
    protectedDir = join(dir, 'protected')
    mkdirSync(protectedDir, { mode: 0o700 })
    chmodSync(protectedDir, 0o700)
    writeFileSync(join(protectedDir, 'backup.sql'), 'every project\'s rows')
    supervisor = await startSupervisor(dir, BASE, protectedDir)

    // This process plays the app: it holds a secret, and uses the supervisor.
    env.PLANTED_APP_SECRET = PLANTED
    delete env.BACKENLY_UNSAFE_LOCAL_FUNCTIONS
    env.BACKENLY_FN_SOCKET = supervisor.socket
  })

  afterAll(async () => {
    supervisor?.child.kill('SIGKILL')
    if (before.flag === undefined) delete env.BACKENLY_UNSAFE_LOCAL_FUNCTIONS
    else env.BACKENLY_UNSAFE_LOCAL_FUNCTIONS = before.flag
    if (before.socket === undefined) delete env.BACKENLY_FN_SOCKET
    else env.BACKENLY_FN_SOCKET = before.socket
    if (before.planted === undefined) delete env.PLANTED_APP_SECRET
    else env.PLANTED_APP_SECRET = before.planted
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  const run = (code: string) =>
    executeRouteModuleFunction(code, PROJECT, { type: 'manual', data: {} }, 'GET /fn/root-probe', { authMaterial: AUTH })

  it('passed its own check before taking runs: a pool uid could read nothing it must not', () => {
    expect(supervisor.log()).toContain('listening on')
    expect(supervisor.log()).not.toContain('REFUSING')
  })

  it('runs functions that overlap under distinct pool uids, never root, with no group and nothing secret', async () => {
    const code = `
      import { NextResponse } from 'next/server'
      const p: any = Object.constructor('return process')()
      export async function GET() {
        await new Promise((r) => setTimeout(r, 1500))
        return NextResponse.json({ uid: p.getuid(), gid: p.getgid(), groups: p.getgroups(), env: { ...p.env }, pid: p.pid })
      }
    `
    const results = await Promise.all([run(code), run(code), run(code), run(code)])
    const seen = results.map((r) => r.returnValue.body)
    const uids = seen.map((s) => s.uid)
    expect(new Set(uids).size).toBe(4)
    for (const s of seen) {
      expect(inPool(s.uid)).toBe(true)
      expect(s.gid).toBe(s.uid)
      expect(s.groups.every((g: number) => g === s.uid)).toBe(true)
      expect(Object.keys(s.env).sort()).toEqual(['HOME', 'LANG', 'NODE_ENV', 'PATH', 'TMPDIR', 'TZ'])
    }
    expect(JSON.stringify(seen)).not.toContain(PLANTED)
  })

  it('cannot read the environment or memory of any process but its own', async () => {
    const { returnValue } = await run(`
      import { NextResponse } from 'next/server'
      export async function GET() {
        const p: any = Object.constructor('return process')()
        const fs = p.getBuiltinModule ? p.getBuiltinModule('fs') : p.mainModule.require('fs')
        const mine = p.getuid()
        const readable: Array<{ pid: number; uid: number; text: string }> = []
        const refused: number[] = []
        for (const name of fs.readdirSync('/proc')) {
          if (!/^\\d+$/.test(name)) continue
          try {
            const text = fs.readFileSync('/proc/' + name + '/environ', 'utf8')
            readable.push({ pid: Number(name), uid: fs.statSync('/proc/' + name).uid, text })
          } catch (e) {
            refused.push(Number(name))
          }
        }
        let memory = 'refused'
        try { fs.readFileSync('/proc/' + p.ppid + '/mem'); memory = 'read' } catch (e) {}
        return NextResponse.json({ mine, ppid: p.ppid, readable, refused, memory })
      }
    `)
    const seen = returnValue.body
    // Only its own uid's processes; not PID 1, not the supervisor, not this process.
    expect(seen.readable.filter((r: { uid: number }) => r.uid !== seen.mine)).toEqual([])
    expect(seen.refused).toEqual(expect.arrayContaining([1, seen.ppid, process.pid]))
    expect(seen.memory).toBe('refused')
    expect(JSON.stringify(seen)).not.toContain(PLANTED)
  })

  it('cannot read what is protected, nor reach the supervisor', async () => {
    const { returnValue } = await run(`
      import { NextResponse } from 'next/server'
      export async function GET() {
        const p: any = Object.constructor('return process')()
        const fs = p.getBuiltinModule ? p.getBuiltinModule('fs') : p.mainModule.require('fs')
        const tryRead = (path: string) => { try { return fs.statSync(path).isDirectory() ? fs.readdirSync(path) : fs.readFileSync(path, 'utf8') } catch (e: any) { return e.code } }
        return NextResponse.json({ data: tryRead(${JSON.stringify(protectedDir)}), socketDir: tryRead(${JSON.stringify(join(dir, `sock-${BASE}`))}) })
      }
    `)
    expect(returnValue.body).toEqual({ data: 'EACCES', socketDir: 'EACCES' })
  })

  it('gives a sandbox body that escapes nothing secret either', async () => {
    const outcome = await runIsolated({
      kind: 'sandbox',
      payload: {
        code: `
          const p = Object.constructor('return this')()['proc' + 'ess']
          const load = (n) => (p.getBuiltinModule ? p.getBuiltinModule(n) : p.mainModule.require(n))
          let pid1 = 'refused'
          try { pid1 = load('f' + 's').readFileSync('/proc/1/environ', 'utf8') } catch (e) {}
          return { uid: p.getuid(), env: Object.assign({}, p.env), pid1 }
        `,
        event: encodeValue({ type: 'manual', data: {} }),
        connectedIntegrations: [],
        envVars: {},
        integrationManifest: {},
        timeoutMs: 9500,
      },
      hardTimeoutMs: 12_000,
    })
    const seen = outcome.result?.value as { uid: number; env: Record<string, string>; pid1: string }
    expect(inPool(seen.uid)).toBe(true)
    expect(seen.pid1).toBe('refused')
    expect(JSON.stringify(seen)).not.toContain(PLANTED)
  })

  it('stops a handler that never yields at its deadline, while this process keeps serving, and leaves nothing running', async () => {
    let ticks = 0
    const timer = setInterval(() => { ticks++ }, 100)
    try {
      await expect(run(`
        import { NextResponse } from 'next/server'
        export async function GET() { while (true) {} return NextResponse.json({}) }
      `)).rejects.toThrow('Route function timed out after 10s')
    } finally {
      clearInterval(timer)
    }
    expect(ticks).toBeGreaterThan(80)
    expect(await until(() => poolProcesses().length === 0, 5000)).toBe(true)
  })

  it('answers a handler that returns while it starves its own event loop, then ends that process', async () => {
    const { returnValue } = await run(`
      import { NextResponse } from 'next/server'
      export async function GET() {
        const spin = (): Promise<void> => Promise.resolve().then(spin)
        spin()
        return NextResponse.json({ answered: true })
      }
    `)
    expect(returnValue.body).toEqual({ answered: true })
    expect(await until(() => poolProcesses().length === 0, 25_000)).toBe(true)
  })

  it('stops a run that holds memory outside its heap', async () => {
    await expect(run(`
      import { NextResponse } from 'next/server'
      export async function GET() {
        const keep = []
        for (let i = 0; i < 64; i++) { keep.push(Buffer.alloc(16 * 1024 * 1024, 1)); await new Promise((r) => setTimeout(r, 20)) }
        return NextResponse.json({ held: keep.length })
      }
    `)).rejects.toThrow(/memory/)
  })

  it('kills what a run started and removes what it left in /tmp, before its uid is used again', async () => {
    const marker = `/tmp/backenly-fn-leftover-${process.pid}-${Date.now()}`
    const { returnValue } = await run(`
      import { NextResponse } from 'next/server'
      export async function GET() {
        const p: any = Object.constructor('return process')()
        const load = (n: string) => (p.getBuiltinModule ? p.getBuiltinModule(n) : p.mainModule.require(n))
        load('fs').writeFileSync(${JSON.stringify(marker)}, 'left behind')
        const lingering = load('child' + '_process').spawn('sleep', ['60'], { detached: true, stdio: 'ignore' })
        lingering.unref()
        return NextResponse.json({ pid: lingering.pid })
      }
    `)
    const pid = returnValue.body.pid as number
    expect(pid).toBeGreaterThan(0)
    expect(await until(() => !existsSync(`/proc/${pid}`) && !existsSync(marker), 10_000)).toBe(true)
    expect(poolProcesses()).toEqual([])
  })

  it('refuses every run, and says why, where a function could read what it must not', async () => {
    const open = join(dir, 'open')
    mkdirSync(open, { mode: 0o755 })
    chmodSync(open, 0o755)
    const leaky = await startSupervisor(dir, BASE + 1000, open)
    const socket = env.BACKENLY_FN_SOCKET
    env.BACKENLY_FN_SOCKET = leaky.socket
    try {
      const failure = await run(`
        import { NextResponse } from 'next/server'
        export async function GET() { return NextResponse.json({ ran: true }) }
      `).then(() => null, (err) => err)
      expect(failure).toBeInstanceOf(FunctionRunnerUnavailableError)
      expect(failure.message).toContain('could read')
      expect(leaky.log()).toContain('REFUSING')
    } finally {
      env.BACKENLY_FN_SOCKET = socket
      leaky.child.kill('SIGKILL')
    }
  })
})
