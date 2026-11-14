/**
 * FUNCTION CODE RUNS IN A PROCESS OF ITS OWN, HOLDING NOTHING OF THIS ONE
 * =======================================================================
 *
 * A function could escape its node:vm context with
 * `Object.constructor('return process')()` and read every platform secret from
 * the web or runtime process it ran in, and with `globalThis.prisma` reach the
 * platform's database. Each run now happens in a fresh runner process
 * (lib/services/ai-functions/isolation/), so the same escapes reach that
 * process, which was given nothing secret.
 *
 * These run the real escapes against the real runner, and plant the platform's
 * secrets in THIS process's environment first. Here the runner runs
 * as the test's own user (BACKENLY_UNSAFE_LOCAL_FUNCTIONS, jest.setup.js), so
 * reading /proc/<this pid>/environ is still possible and is not asserted: the
 * uid boundary that closes it is tests/unit/function-isolation-root.spec.ts,
 * which runs as root in CI. What is asserted here holds in both modes: another
 * process, an environment of a fixed list of non-secret names, no platform
 * client, a hung or bloated run stopped while this process keeps going, and no
 * fallback to running anything here.
 */

import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { executeRouteModuleFunction, validateRouteModule } from '@/lib/services/ai-functions/route-module-runner'
import { encodeValue, FunctionRunnerUnavailableError, runIsolated } from '@/lib/services/ai-functions/isolation/client'

jest.setTimeout(60_000)

const PROJECT = '33333333-4444-4555-8666-777777777777'
const AUTH = { jwtSecret: 'isolation-test-project-secret-not-a-real-one', adminKey: null }

/** The platform's secrets, planted here; none may come back. */
const PLANTED: Record<string, string> = {
  JWT_SECRET: 'planted-not-a-real-jwt-secret-for-isolation',
  MASTER_ENCRYPTION_KEY: 'planted-not-a-real-master-encryption-key',
  ENV_VAR_ENCRYPTION_KEY: 'planted-not-a-real-env-var-encryption-key',
  INTERNAL_API_TOKEN: 'planted-not-a-real-internal-api-token',
  STRIPE_SECRET_KEY: 'planted-not-a-real-stripe-secret-key',
  // Assembled, so the credential scanners do not read a fixture as a leak.
  DATABASE_URL: ['postgresql:', '', 'platform:planted-not-a-real-password@127.0.0.1:1', 'backenly'].join('/'),
}

/** All a run's process environment may hold (local mode adds Windows' own on Windows). */
const ALLOWED_ENV = ['NODE_ENV', 'TZ', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'NODE_EXTRA_CA_CERTS', 'LANG', 'PATH', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT']

const saved: Record<string, string | undefined> = {}
beforeAll(() => {
  for (const [k, v] of Object.entries(PLANTED)) {
    saved[k] = process.env[k]
    process.env[k] = v
  }
})
afterAll(() => {
  for (const k of Object.keys(PLANTED)) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

function expectNothingPlanted(seen: unknown) {
  const text = JSON.stringify(seen)
  for (const value of Object.values(PLANTED)) expect(text).not.toContain(value)
  expect(text).not.toContain('planted-not-a-real')
}

function expectOnlyAllowedNames(env: Record<string, unknown>) {
  const extra = Object.keys(env).filter((k) => !ALLOWED_ENV.includes(k.toUpperCase()))
  expect(extra).toEqual([])
}

const run = (code: string) =>
  executeRouteModuleFunction(code, PROJECT, { type: 'manual', data: {} }, 'GET /fn/escape', { authMaterial: AUTH })

describe('a route module that escapes its vm context', () => {
  const ESCAPES = `
    import { NextResponse } from 'next/server'
    export async function GET(request: any) {
      const seen: Record<string, unknown> = {}
      const attempt = (name: string, fn: () => unknown) => {
        try { seen[name] = fn() } catch (e: any) { seen[name] = 'refused: ' + (e && e.message) }
      }
      const C = 'constructor'
      const p: any = Object.constructor('return process')()
      const viaRequest: any = request[C][C]('return process')()
      const load = (name: string) => (p.getBuiltinModule ? p.getBuiltinModule(name) : p.mainModule.require(name))
      attempt('objectConstructor', () => ({ pid: p.pid, env: { ...p.env } }))
      attempt('requestConstructor', () => ({ pid: viaRequest.pid, env: { ...viaRequest.env } }))
      attempt('platformClient', () => typeof Object.constructor('return globalThis')().prisma)
      attempt('selfEnviron', () => load('fs').readFileSync('/proc/self/environ', 'utf8'))
      attempt('spawnedEnv', () => JSON.parse(load('child' + '_process').execFileSync(p.execPath, ['-e', 'process.stdout.write(JSON.stringify(process.env))'], { encoding: 'utf8' })))
      return NextResponse.json(seen)
    }
  `

  it('reaches another process, which holds no platform secret', async () => {
    const { returnValue } = await run(ESCAPES)
    const seen = returnValue.body
    expect(seen.objectConstructor.pid).not.toBe(process.pid)
    expect(seen.requestConstructor.pid).toBe(seen.objectConstructor.pid)
    expectOnlyAllowedNames(seen.objectConstructor.env)
    expectOnlyAllowedNames(seen.spawnedEnv)
    expectNothingPlanted(seen)
  })

  it('finds no platform database client to borrow', async () => {
    const { returnValue } = await run(ESCAPES)
    expect(returnValue.body.platformClient).toBe('undefined')
  })

  it('is evaluated at deploy time in another process too, never in this one', async () => {
    const check = await validateRouteModule(`
      import { NextResponse } from 'next/server'
      throw new Error('evaluated in pid ' + Object.constructor('return process')().pid)
      export async function GET() { return NextResponse.json({}) }
    `)
    expect(check.valid).toBe(false)
    const pid = Number(/evaluated in pid (\d+)/.exec(check.error ?? '')?.[1])
    expect(pid).toBeGreaterThan(0)
    expect(pid).not.toBe(process.pid)
  })
})

describe('a sandbox body that escapes its vm context', () => {
  it('reaches another process, which holds no platform secret', async () => {
    const code = `
      const g = Object.constructor('return this')()
      const p = g['proc' + 'ess']
      const load = (n) => (p.getBuiltinModule ? p.getBuiltinModule(n) : p.mainModule.require(n))
      let environ = null
      try { environ = load('f' + 's').readFileSync('/proc/self/environ', 'utf8') } catch (e) { environ = 'refused' }
      return { pid: p.pid, env: Object.assign({}, p.env), environ }
    `
    const outcome = await runIsolated({
      kind: 'sandbox',
      payload: { code, event: encodeValue({ type: 'manual', data: {} }), connectedIntegrations: [], envVars: {}, integrationManifest: {}, timeoutMs: 9500 },
      hardTimeoutMs: 12_000,
    })
    expect(outcome.result?.ok).toBe(true)
    const seen = outcome.result!.value as { pid: number; env: Record<string, string> }
    expect(seen.pid).not.toBe(process.pid)
    expectOnlyAllowedNames(seen.env)
    expectNothingPlanted(seen)
  })
})

describe('a run that does not end on its own', () => {
  it('is stopped at its deadline, and this process keeps serving meanwhile', async () => {
    let ticks = 0
    const timer = setInterval(() => { ticks++ }, 100)
    const started = Date.now()
    try {
      await expect(run(`
        import { NextResponse } from 'next/server'
        export async function GET() {
          while (true) {}
          return NextResponse.json({ never: true })
        }
      `)).rejects.toThrow('Route function timed out after 10s')
    } finally {
      clearInterval(timer)
    }
    expect(Date.now() - started).toBeLessThan(30_000)
    // A synchronous loop in a handler stopped the host's event loop for good
    // when the handler ran here. Ten seconds and more of ticks say it did not.
    expect(ticks).toBeGreaterThan(80)
  })

  it('is stopped when it exhausts its heap, and said to be out of memory', async () => {
    await expect(run(`
      import { NextResponse } from 'next/server'
      export async function GET() {
        const keep: number[][] = []
        for (;;) keep.push(new Array(100000).fill(Math.random()))
        return NextResponse.json({ never: keep.length })
      }
    `)).rejects.toThrow(/memory/)
  })

  ;(process.platform === 'linux' ? it : it.skip)('is stopped when it holds memory outside the heap (ArrayBuffers)', async () => {
    await expect(run(`
      import { NextResponse } from 'next/server'
      export async function GET() {
        const keep = []
        for (let i = 0; i < 64; i++) {
          keep.push(Buffer.alloc(16 * 1024 * 1024, 1))
          await new Promise((r) => setTimeout(r, 20))
        }
        return NextResponse.json({ held: keep.length })
      }
    `)).rejects.toThrow(/memory/)
  })
})

describe('where nothing isolated can run it', () => {
  const sandboxValidation = () => runIsolated({ kind: 'sandbox-validate', payload: { code: 'return 1' }, hardTimeoutMs: 5000 })

  it('refuses the development opt-out when NODE_ENV is production', async () => {
    const env = process.env as Record<string, string | undefined>
    const before = env.NODE_ENV
    env.NODE_ENV = 'production'
    try {
      await expect(sandboxValidation()).rejects.toBeInstanceOf(FunctionRunnerUnavailableError)
    } finally {
      env.NODE_ENV = before
    }
  })

  it('fails closed without a supervisor, and never runs the code here instead', async () => {
    const env = process.env as Record<string, string | undefined>
    const before = { flag: env.BACKENLY_UNSAFE_LOCAL_FUNCTIONS, socket: env.BACKENLY_FN_SOCKET }
    delete env.BACKENLY_UNSAFE_LOCAL_FUNCTIONS
    env.BACKENLY_FN_SOCKET = join(tmpdir(), `no-supervisor-${process.pid}`, 'supervisor.sock')
    try {
      const failure = await sandboxValidation().then(() => null, (err) => err)
      expect(failure).toBeInstanceOf(FunctionRunnerUnavailableError)
      expect(failure.message).toMatch(/Functions cannot run here/)
    } finally {
      if (before.flag === undefined) delete env.BACKENLY_UNSAFE_LOCAL_FUNCTIONS
      else env.BACKENLY_UNSAFE_LOCAL_FUNCTIONS = before.flag
      if (before.socket === undefined) delete env.BACKENLY_FN_SOCKET
      else env.BACKENLY_FN_SOCKET = before.socket
    }
  })
})
