/**
 * The PostgREST host (services/pgrst-host): the parts that decide, without a
 * process or a database.
 *
 *   token      a request is served only for a token signed with the region's
 *              secret, unexpired, addressed to the project in the path, and
 *              naming a project database; anything else is refused
 *   config     what the host reads, and what a child is given (nothing else)
 *   registry   one child per project, started once for concurrent requests,
 *              capped, reaped when idle, started again after a crash, and
 *              held off by a circuit after repeated failures
 *
 * Children here are fakes the registry cannot tell from the real launcher;
 * tests/integration/pgrst-host.spec.ts runs the real postgrest binary.
 */

import { createHmac } from 'crypto'
import { EventEmitter } from 'events'

import { mintInternalToken, internalClaimsFor, DEDICATED_DATABASE_NAME } from '@/lib/postgrest/gateway'
import { ChildRegistry, HostRefusal, type RegistryConfig } from '@/services/pgrst-host/children'
import { databaseUri, DEFAULTS, readConfig } from '@/services/pgrst-host/config'
import {
  childEnvironment,
  readRssBytes,
  stopProcess,
  type ChildExit,
  type LaunchedChild,
  type Launcher,
  type LaunchSpec,
} from '@/services/pgrst-host/launcher'
import { redactor, uriPassword } from '@/services/pgrst-host/log'
import { bearerToken, PROJECT_DATABASE_NAME, verifyHostToken } from '@/services/pgrst-host/token'

const SECRET = 'a-region-postgrest-secret-of-at-least-32-chars'
const PROJECT = 'ac6b51fd-5ed7-4c00-9938-cff57f34d304'
const OTHER = 'deadbeef-0000-4000-8000-000000000000'
const DB = `p_${'a'.repeat(32)}`
const DB2 = `p_${'b'.repeat(32)}`
const NOW = Date.UTC(2026, 10, 21, 12, 0, 0)

// ── token ────────────────────────────────────────────────────────────────────

const b64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')

function sign(claims: Record<string, unknown>, opts: { secret?: string; header?: Record<string, unknown> } = {}): string {
  const head = b64url(opts.header ?? { alg: 'HS256', typ: 'JWT' })
  const body = b64url(claims)
  const sig = createHmac('sha256', opts.secret ?? SECRET).update(`${head}.${body}`).digest('base64url')
  return `${head}.${body}.${sig}`
}

const seconds = (ms: number) => Math.floor(ms / 1000)
const valid = (extra: Record<string, unknown> = {}) => ({
  role: 'service_role',
  project_id: PROJECT,
  aud: PROJECT,
  db: DB,
  iat: seconds(NOW),
  exp: seconds(NOW) + 60,
  ...extra,
})

describe('verifyHostToken', () => {
  it('accepts the token the runtime mints for a project with a database of its own', () => {
    jest.useFakeTimers().setSystemTime(NOW)
    try {
      const token = mintInternalToken(internalClaimsFor({ projectId: PROJECT, endUserId: 'u1', database: DB }), SECRET)
      const verdict = verifyHostToken(token, SECRET, PROJECT, NOW)
      expect(verdict).toMatchObject({ ok: true, claims: { aud: PROJECT, db: DB, role: 'authenticated', sub: 'u1' } })
    } finally {
      jest.useRealTimers()
    }
  })

  it('accepts a hand-signed valid token', () => {
    expect(verifyHostToken(sign(valid()), SECRET, PROJECT, NOW).ok).toBe(true)
  })

  const refusals: Array<[string, () => string | null, number, string]> = [
    ['no token', () => null, 401, 'UNAUTHORIZED'],
    ['not a JWT', () => 'abc', 401, 'TOKEN_INVALID'],
    ['a wrong signature', () => sign(valid(), { secret: 'another-secret-of-at-least-32-characters' }), 401, 'TOKEN_INVALID'],
    ['a payload changed after signing', () => {
      const [h, , s] = sign(valid()).split('.')
      return `${h}.${b64url(valid({ aud: OTHER, project_id: OTHER }))}.${s}`
    }, 401, 'TOKEN_INVALID'],
    ['alg none', () => `${b64url({ alg: 'none' })}.${b64url(valid())}.x`, 401, 'TOKEN_INVALID'],
    ['another algorithm', () => sign(valid(), { header: { alg: 'HS512' } }), 401, 'TOKEN_INVALID'],
    ['critical extensions', () => sign(valid(), { header: { alg: 'HS256', crit: ['b64'] } }), 401, 'TOKEN_INVALID'],
    ['an expired token', () => sign(valid({ iat: seconds(NOW) - 120, exp: seconds(NOW) - 60 })), 401, 'TOKEN_EXPIRED'],
    ['no expiry', () => sign(valid({ exp: undefined })), 401, 'TOKEN_INVALID'],
    ['a token issued in the future', () => sign(valid({ iat: seconds(NOW) + 600, exp: seconds(NOW) + 660 })), 401, 'TOKEN_INVALID'],
    ['a token not valid yet', () => sign(valid({ nbf: seconds(NOW) + 600 })), 401, 'TOKEN_INVALID'],
    ['another project', () => sign(valid({ aud: OTHER, project_id: OTHER })), 403, 'TOKEN_AUDIENCE_MISMATCH'],
    ['no audience (a shared-database token)', () => sign(valid({ aud: undefined, db: undefined })), 403, 'TOKEN_AUDIENCE_MISMATCH'],
    ['a list of audiences', () => sign(valid({ aud: [PROJECT] })), 403, 'TOKEN_AUDIENCE_MISMATCH'],
    ['project_id and aud that disagree', () => sign(valid({ project_id: OTHER })), 403, 'TOKEN_AUDIENCE_MISMATCH'],
    ['no database', () => sign(valid({ db: undefined })), 403, 'TOKEN_DATABASE_INVALID'],
    ['a database that is not a project database', () => sign(valid({ db: 'postgres' })), 403, 'TOKEN_DATABASE_INVALID'],
    ['an uppercase database name', () => sign(valid({ db: `p_${'A'.repeat(32)}` })), 403, 'TOKEN_DATABASE_INVALID'],
    ['a database name with a suffix', () => sign(valid({ db: `${DB};drop` })), 403, 'TOKEN_DATABASE_INVALID'],
    ['a role the runtime never mints', () => sign(valid({ role: 'postgres' })), 403, 'TOKEN_ROLE_INVALID'],
  ]

  it.each(refusals)('refuses %s', (_what, token, status, code) => {
    const verdict = verifyHostToken(token(), SECRET, PROJECT, NOW)
    expect(verdict).toMatchObject({ ok: false, status, code })
  })

  it('refuses a valid token for project A on project B’s path', () => {
    expect(verifyHostToken(sign(valid()), SECRET, OTHER, NOW)).toMatchObject({ ok: false, status: 403, code: 'TOKEN_AUDIENCE_MISMATCH' })
  })

  it('reads only a Bearer authorization header', () => {
    expect(bearerToken('Bearer abc.def.ghi')).toBe('abc.def.ghi')
    expect(bearerToken('bearer abc')).toBe('abc')
    expect(bearerToken('Basic abc')).toBeNull()
    expect(bearerToken(undefined)).toBeNull()
    expect(bearerToken(['Bearer a', 'Bearer b'])).toBeNull()
  })

  it('uses the same database pattern as the runtime', () => {
    expect(PROJECT_DATABASE_NAME.source).toBe(DEDICATED_DATABASE_NAME.source)
    expect(PROJECT_DATABASE_NAME.flags).toBe(DEDICATED_DATABASE_NAME.flags)
  })
})

// ── config and the child's environment ───────────────────────────────────────

const BASE_ENV = {
  PGRST_HOST_JWT_SECRET: SECRET,
  PGRST_HOST_DB_URI: 'postgresql://authenticator:s%40cret-pw@localhost:5432/postgres?sslmode=require',
}

describe('readConfig', () => {
  it('has the documented defaults', () => {
    const config = readConfig(BASE_ENV)
    expect(config).toMatchObject({
      listenHost: '0.0.0.0',
      port: 3200,
      binary: 'postgrest',
      maxChildren: 20,
      childDbPool: 3,
      childPoolIdleSeconds: 30,
      idleMs: 600_000,
      readyTimeoutMs: 10_000,
      stopGraceMs: 10_000,
      maxBodyBytes: 10 * 1024 * 1024,
      crashLimit: 3,
      crashWindowMs: 300_000,
      circuitOpenMs: 300_000,
    })
  })

  it('reads every setting', () => {
    const config = readConfig({
      ...BASE_ENV,
      PGRST_HOST_BIND: '127.0.0.1',
      PGRST_HOST_PORT: '4000',
      PGRST_HOST_BINARY: '/usr/local/bin/postgrest',
      PGRST_HOST_MAX_CHILDREN: '40',
      PGRST_HOST_CHILD_DB_POOL: '2',
      PGRST_HOST_IDLE_SECONDS: '120',
      PGRST_HOST_READY_TIMEOUT_SECONDS: '5',
      PGRST_HOST_STOP_GRACE_SECONDS: '3',
      PGRST_HOST_MAX_BODY_BYTES: '1000',
      PGRST_HOST_UPSTREAM_TIMEOUT_SECONDS: '30',
    })
    expect(config).toMatchObject({
      listenHost: '127.0.0.1',
      port: 4000,
      binary: '/usr/local/bin/postgrest',
      maxChildren: 40,
      childDbPool: 2,
      idleMs: 120_000,
      readyTimeoutMs: 5000,
      stopGraceMs: 3000,
      maxBodyBytes: 1000,
      upstreamTimeoutMs: 30_000,
    })
  })

  it('refuses to start without what it needs, naming the variable and never its value', () => {
    expect(() => readConfig({ ...BASE_ENV, PGRST_HOST_JWT_SECRET: '' })).toThrow('PGRST_HOST_JWT_SECRET is not set')
    expect(() => readConfig({ ...BASE_ENV, PGRST_HOST_JWT_SECRET: 'short-secret' })).toThrow('at least 32')
    expect(() => readConfig({ ...BASE_ENV, PGRST_HOST_DB_URI: undefined })).toThrow('PGRST_HOST_DB_URI is not set')
    for (const uri of ['not a uri with-pw', 'mysql://u:pw@h/db', 'postgresql://u:pw@h1:5432,h2:5432/db', 'postgresql://h/db']) {
      let message = ''
      try {
        readConfig({ ...BASE_ENV, PGRST_HOST_DB_URI: uri })
      } catch (err) {
        message = (err as Error).message
      }
      expect(message).toContain('PGRST_HOST_DB_URI')
      expect(message).not.toContain('pw')
    }
    expect(() => readConfig({ ...BASE_ENV, PGRST_HOST_MAX_CHILDREN: '0' })).toThrow('PGRST_HOST_MAX_CHILDREN')
    expect(() => readConfig({ ...BASE_ENV, PGRST_HOST_CHILD_DB_POOL: '2.5' })).toThrow('PGRST_HOST_CHILD_DB_POOL')
    expect(() => readConfig({ ...BASE_ENV, PGRST_HOST_PORT: 'http' })).toThrow('PGRST_HOST_PORT')
  })
})

describe('the environment a child is given', () => {
  const config = readConfig(BASE_ENV)

  it('is PostgREST’s own settings for one database, and nothing inherited but PATH', () => {
    process.env.PGRST_HOST_NOT_FOR_CHILDREN = 'x'
    process.env.PGRST_DB_SCHEMAS = 'public'
    try {
      const env = childEnvironment(config, { projectId: PROJECT, database: DB }, { server: 41001, admin: 41002 }, '/usr/bin')
      expect(env).toEqual({
        PGRST_DB_URI: `postgresql://authenticator:s%40cret-pw@localhost:5432/${DB}?sslmode=require`,
        PGRST_DB_PRE_CONFIG: 'postgrest.pre_config',
        PGRST_DB_ANON_ROLE: 'anon',
        PGRST_DB_CHANNEL_ENABLED: 'true',
        PGRST_DB_CHANNEL: 'pgrst',
        PGRST_JWT_SECRET: SECRET,
        PGRST_JWT_AUD: PROJECT,
        PGRST_DB_POOL: '3',
        PGRST_DB_POOL_MAX_IDLETIME: '30',
        PGRST_SERVER_HOST: '127.0.0.1',
        PGRST_SERVER_PORT: '41001',
        PGRST_ADMIN_SERVER_HOST: '127.0.0.1',
        PGRST_ADMIN_SERVER_PORT: '41002',
        LANG: 'C.UTF-8',
        PATH: '/usr/bin',
      })
    } finally {
      delete process.env.PGRST_HOST_NOT_FOR_CHILDREN
      delete process.env.PGRST_DB_SCHEMAS
    }
  })

  it('never connects a child to a database that is not a project database', () => {
    for (const bad of ['postgres', 'template1', `${DB}/x`, `p_${'g'.repeat(32)}`]) {
      expect(() => databaseUri(config.dbUri, bad)).toThrow('not a project database name')
    }
  })
})

describe('what the host writes to its log', () => {
  it('removes the secret, the password and every connection URI', () => {
    const redact = redactor([SECRET, uriPassword(BASE_ENV.PGRST_HOST_DB_URI), 's%40cret-pw'])
    expect(uriPassword(BASE_ENV.PGRST_HOST_DB_URI)).toBe('s@cret-pw')
    const line = redact(`jwt ${SECRET} pw s@cret-pw raw s%40cret-pw uri ${BASE_ENV.PGRST_HOST_DB_URI} end`)
    expect(line).not.toContain(SECRET)
    expect(line).not.toContain('s@cret-pw')
    expect(line).not.toContain('s%40cret-pw')
    expect(line).not.toContain('localhost:5432')
    expect(line).toContain('[connection uri]')
  })
})

describe('child process helpers', () => {
  it('reads resident memory from /proc', () => {
    const read = () => 'Name:\tpostgrest\nVmPeak:\t  900 kB\nVmRSS:\t   23456 kB\n'
    expect(readRssBytes(1234, read)).toBe(23456 * 1024)
    expect(readRssBytes(null, read)).toBeNull()
    expect(readRssBytes(1234, () => { throw new Error('no /proc') })).toBeNull()
  })

  class FakeProcess extends EventEmitter {
    signals: string[] = []
    constructor(private readonly exitsOn: string) {
      super()
    }
    kill(signal: string): boolean {
      this.signals.push(signal)
      if (signal === this.exitsOn) setImmediate(() => this.emit('exit', null, signal))
      return true
    }
  }
  const exitOf = (p: FakeProcess) => new Promise((resolve) => p.once('exit', (code, signal) => resolve({ code, signal })))

  it('sends SIGTERM and nothing more to a child that stops', async () => {
    const proc = new FakeProcess('SIGTERM')
    const onKill = jest.fn()
    await stopProcess(proc, exitOf(proc), 30, onKill)
    await new Promise((r) => setTimeout(r, 60))
    expect(proc.signals).toEqual(['SIGTERM'])
    expect(onKill).not.toHaveBeenCalled()
  })

  it('sends SIGKILL once the grace has passed', async () => {
    const proc = new FakeProcess('SIGKILL')
    const onKill = jest.fn()
    const exit = await stopProcess(proc, exitOf(proc), 30, onKill)
    expect(proc.signals).toEqual(['SIGTERM', 'SIGKILL'])
    expect(onKill).toHaveBeenCalledTimes(1)
    expect(exit).toEqual({ code: null, signal: 'SIGKILL' })
  })
})

// ── the registry ─────────────────────────────────────────────────────────────

interface FakeChild extends LaunchedChild {
  spec: LaunchSpec
  signals: string[]
  becomeReady(): void
  crash(code?: number): void
}

function fakeLauncher(opts: { autoReady?: boolean } = {}) {
  const children: FakeChild[] = []
  let failures = 0
  const launcher: Launcher = async (spec) => {
    if (failures > 0) {
      failures--
      throw new Error('spawn postgrest ENOENT')
    }
    let resolveReady!: () => void
    let rejectReady!: (err: Error) => void
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve
      rejectReady = reject
    })
    ready.catch(() => {})
    let done = false
    let resolveExit!: (exit: ChildExit) => void
    const exited = new Promise<ChildExit>((resolve) => {
      resolveExit = (exit) => {
        if (done) return
        done = true
        rejectReady(new Error('exited before ready'))
        resolve(exit)
      }
    })
    const signals: string[] = []
    const n = children.length
    const child: FakeChild = {
      spec,
      pid: 1000 + n,
      port: 40000 + n,
      ready,
      exited,
      signals,
      stop: async () => {
        signals.push('SIGTERM')
        resolveExit({ code: 0, signal: 'SIGTERM' })
        return exited
      },
      probeReady: async () => !done,
      rssBytes: () => (done ? null : 30 * 1048576),
      becomeReady: () => resolveReady(),
      crash: (code = 1) => resolveExit({ code, signal: null }),
    }
    children.push(child)
    if (opts.autoReady !== false) resolveReady()
    return child
  }
  return { launcher, children, failNext: (count = 1) => (failures = count) }
}

const flush = () => new Promise((resolve) => setImmediate(resolve))

const REGISTRY: RegistryConfig = {
  maxChildren: 2,
  idleMs: 1000,
  readyTimeoutMs: 5000,
  stopGraceMs: 50,
  crashLimit: 3,
  crashWindowMs: 300_000,
  circuitOpenMs: 300_000,
  busyRetryAfterSeconds: 5,
}

function setup(opts: { autoReady?: boolean; config?: Partial<RegistryConfig> } = {}) {
  const fake = fakeLauncher(opts)
  const clock = { now: NOW }
  const lines: string[] = []
  const registry = new ChildRegistry(fake.launcher, { ...REGISTRY, ...opts.config }, {
    now: () => clock.now,
    log: (line) => lines.push(line),
  })
  return { ...fake, clock, lines, registry }
}

async function refusalOf(promise: Promise<unknown>): Promise<HostRefusal> {
  try {
    await promise
  } catch (err) {
    expect(err).toBeInstanceOf(HostRefusal)
    return err as HostRefusal
  }
  throw new Error('expected a refusal')
}

const P = (n: number) => `00000000-0000-4000-8000-00000000000${n}`
const D = (n: number) => `p_${String(n).repeat(32)}`

describe('ChildRegistry', () => {
  it('starts one child for concurrent first requests', async () => {
    const { registry, children } = setup({ autoReady: false })
    const pending = Promise.all([1, 2, 3, 4, 5].map(() => registry.acquire(P(1), D(1))))
    await flush()
    expect(children).toHaveLength(1)
    children[0].becomeReady()
    const leases = await pending
    expect(new Set(leases.map((l) => l.port))).toEqual(new Set([children[0].port]))
    expect(registry.state(P(1), D(1))).toMatchObject({ state: 'ready', inFlight: 5, pid: children[0].pid })
    leases.forEach((l) => l.release())
    expect(registry.state(P(1), D(1)).inFlight).toBe(0)
  })

  it('at the cap, stops the least recently used idle child to make room', async () => {
    const { registry, children, clock, lines } = setup()
    ;(await registry.acquire(P(1), D(1))).release()
    clock.now += 10
    ;(await registry.acquire(P(2), D(2))).release()
    clock.now += 10
    ;(await registry.acquire(P(1), D(1))).release() // P(2) is now the least recently used
    clock.now += 10
    const lease = await registry.acquire(P(3), D(3))
    expect(children.map((c) => c.spec.projectId)).toEqual([P(1), P(2), P(3)])
    expect(children[1].signals).toEqual(['SIGTERM'])
    expect(children[0].signals).toEqual([])
    expect(registry.size).toBe(2)
    expect(lines.some((l) => l.includes(`${P(2)} evicted to make room for ${P(3)}`))).toBe(true)
    lease.release()
  })

  it('at the cap with every child busy, refuses without starting anything', async () => {
    const { registry, children } = setup()
    const a = await registry.acquire(P(1), D(1))
    const b = await registry.acquire(P(2), D(2))
    const refusal = await refusalOf(registry.acquire(P(3), D(3)))
    expect(refusal).toMatchObject({ status: 503, code: 'DATA_PLANE_BUSY', retryAfterSeconds: 5 })
    expect(children).toHaveLength(2)
    a.release()
    b.release()
  })

  it('never evicts a child that is still starting', async () => {
    const { registry, children } = setup({ autoReady: false })
    const waiting = registry.acquire(P(1), D(1))
    await flush()
    const second = registry.acquire(P(2), D(2))
    await flush()
    children[1].becomeReady()
    ;(await second).release()
    const third = registry.acquire(P(3), D(3))
    await flush()
    expect(children[0].signals).toEqual([])
    expect(children[1].signals).toEqual(['SIGTERM'])
    children[0].becomeReady()
    children[2].becomeReady()
    ;(await waiting).release()
    ;(await third).release()
  })

  it('starts a crashed child again on the next request', async () => {
    const { registry, children } = setup()
    ;(await registry.acquire(P(1), D(1))).release()
    children[0].crash()
    await flush()
    expect(registry.state(P(1), D(1))).toMatchObject({ state: 'stopped', recentFailures: 1 })
    const lease = await registry.acquire(P(1), D(1))
    expect(children).toHaveLength(2)
    expect(lease.port).toBe(children[1].port)
    lease.release()
  })

  it('opens a database’s circuit after 3 failures within 5 minutes, and closes it 5 minutes later', async () => {
    const { registry, children, clock, lines } = setup()
    for (let i = 0; i < 3; i++) {
      ;(await registry.acquire(P(1), D(1))).release()
      children[i].crash()
      await flush()
      clock.now += 60_000
    }
    const refusal = await refusalOf(registry.acquire(P(1), D(1)))
    expect(refusal).toMatchObject({ status: 503, code: 'DATA_PLANE_CIRCUIT_OPEN' })
    // Opened at the third crash, one minute ago, for five minutes.
    expect(refusal.retryAfterSeconds).toBe(240)
    expect(children).toHaveLength(3)
    expect(registry.state(P(1), D(1)).state).toBe('circuit_open')
    expect(lines.some((l) => l.includes(`circuit open for database ${D(1)}`))).toBe(true)

    clock.now += 239_000
    expect(await refusalOf(registry.acquire(P(1), D(1)))).toMatchObject({ code: 'DATA_PLANE_CIRCUIT_OPEN', retryAfterSeconds: 1 })
    clock.now += 1000
    const lease = await registry.acquire(P(1), D(1))
    expect(children).toHaveLength(4)
    lease.release()
  })

  it('does not open the circuit for failures spread over more than 5 minutes', async () => {
    const { registry, children, clock } = setup()
    for (let i = 0; i < 4; i++) {
      ;(await registry.acquire(P(1), D(1))).release()
      children[i].crash()
      await flush()
      clock.now += 151_000
    }
    ;(await registry.acquire(P(1), D(1))).release()
    expect(children).toHaveLength(5)
  })

  it('stops a child that does not become ready in time and counts it as a failure', async () => {
    const { registry, children } = setup({ autoReady: false, config: { readyTimeoutMs: 50 } })
    const refusal = await refusalOf(registry.acquire(P(1), D(1)))
    expect(refusal).toMatchObject({ status: 503, code: 'DATA_PLANE_START_FAILED' })
    await flush()
    expect(children[0].signals).toEqual(['SIGTERM'])
    expect(registry.state(P(1), D(1))).toMatchObject({ state: 'stopped', recentFailures: 1 })
  })

  it('counts a binary that cannot be run as a failure', async () => {
    const { registry, failNext } = setup()
    failNext(3)
    for (let i = 0; i < 3; i++) {
      expect(await refusalOf(registry.acquire(P(1), D(1)))).toMatchObject({ code: 'DATA_PLANE_START_FAILED' })
    }
    expect(await refusalOf(registry.acquire(P(1), D(1)))).toMatchObject({ code: 'DATA_PLANE_CIRCUIT_OPEN' })
  })

  it('stops a child idle for the idle period, and never one with a request in flight', async () => {
    const { registry, children, clock } = setup()
    ;(await registry.acquire(P(1), D(1))).release()
    const held = await registry.acquire(P(2), D(2))
    clock.now += 999
    expect(await registry.reapIdle()).toBe(0)
    clock.now += 1
    expect(await registry.reapIdle()).toBe(1)
    expect(children[0].signals).toEqual(['SIGTERM'])
    expect(children[1].signals).toEqual([])
    expect(registry.state(P(1), D(1)).state).toBe('stopped')
    clock.now += 10_000
    expect(await registry.reapIdle()).toBe(0)
    held.release()
    clock.now += 1000
    expect(await registry.reapIdle()).toBe(1)
  })

  it('refuses a database already served for another project', async () => {
    const { registry, children } = setup()
    const lease = await registry.acquire(P(1), D(1))
    expect(await refusalOf(registry.acquire(P(2), D(1)))).toMatchObject({ status: 409, code: 'DATABASE_IN_USE' })
    expect(children).toHaveLength(1)
    lease.release()
  })

  it('refuses a token naming another database than the running child’s, until a restart moves it', async () => {
    const { registry, children } = setup()
    ;(await registry.acquire(P(1), D(1))).release()
    expect(await refusalOf(registry.acquire(P(1), D(2)))).toMatchObject({ status: 409, code: 'DATABASE_MISMATCH' })
    expect(children).toHaveLength(1)
    const state = await registry.restart(P(1), D(2))
    expect(state).toMatchObject({ state: 'ready', database: D(2) })
    expect(children[0].signals).toEqual(['SIGTERM'])
    expect(await refusalOf(registry.acquire(P(1), D(1)))).toMatchObject({ code: 'DATABASE_MISMATCH' })
  })

  it('restart replaces a running child and closes the database’s circuit', async () => {
    const { registry, children } = setup()
    for (let i = 0; i < 3; i++) {
      ;(await registry.acquire(P(1), D(1))).release()
      children[i].crash()
      await flush()
    }
    expect(registry.state(P(1), D(1)).state).toBe('circuit_open')
    const state = await registry.restart(P(1), D(1))
    expect(state).toMatchObject({ state: 'ready', pid: children[3].pid, recentFailures: 0, circuitOpenUntil: null })
    const again = await registry.restart(P(1), D(1))
    expect(children[3].signals).toEqual(['SIGTERM'])
    expect(again.pid).toBe(children[4].pid)
  })

  it('a request waiting on a child that a restart replaces is served by the replacement', async () => {
    const { registry, children } = setup({ autoReady: false })
    const waiting = registry.acquire(P(1), D(1))
    await flush()
    const restarted = registry.restart(P(1), D(1))
    await flush()
    await flush()
    expect(children).toHaveLength(2)
    expect(children[0].signals).toEqual(['SIGTERM'])
    children[1].becomeReady()
    const lease = await waiting
    expect(lease.port).toBe(children[1].port)
    expect((await restarted).pid).toBe(children[1].pid)
    lease.release()
  })

  it('shutdown stops every child and refuses new requests', async () => {
    const { registry, children } = setup()
    ;(await registry.acquire(P(1), D(1))).release()
    ;(await registry.acquire(P(2), D(2))).release()
    await registry.shutdown()
    expect(children.map((c) => c.signals)).toEqual([['SIGTERM'], ['SIGTERM']])
    expect(await refusalOf(registry.acquire(P(1), D(1)))).toMatchObject({ status: 503 })
  })

  it('logs each lifecycle event with the project id first, and nothing secret', async () => {
    const { registry, children, lines } = setup()
    ;(await registry.acquire(P(1), D(1))).release()
    children[0].crash(2)
    await flush()
    await registry.restart(P(1), D(1))
    await registry.shutdown()
    expect(lines.length).toBeGreaterThanOrEqual(5)
    for (const line of lines) {
      expect(line.startsWith(`[pgrst-host] ${P(1)} `)).toBe(true)
      expect(line).not.toContain(SECRET)
    }
  })
})

describe('the defaults the plan asks for', () => {
  it('reaps after 10 minutes, waits 10 s for ready and 10 s between SIGTERM and SIGKILL, and uses a small pool', () => {
    expect(DEFAULTS.idleSeconds).toBe(600)
    expect(DEFAULTS.readyTimeoutSeconds).toBe(10)
    expect(DEFAULTS.stopGraceSeconds).toBe(10)
    expect(DEFAULTS.childDbPool).toBeGreaterThanOrEqual(2)
    expect(DEFAULTS.childDbPool).toBeLessThanOrEqual(4)
    expect(DEFAULTS.childPoolIdleSeconds).toBe(30)
  })
})
