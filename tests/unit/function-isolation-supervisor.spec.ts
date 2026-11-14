/**
 * The function supervisor's decisions, without root.
 *
 * lib/services/ai-functions/isolation/function-supervisor.cjs starts each
 * function run under a uid no other live run shares, with an environment that
 * holds nothing secret, under rlimits and no_new_privs. What it decides is
 * pure and is pinned here; that it really runs code that way needs root and is
 * tests/unit/function-isolation-root.spec.ts.
 */

const supervisor = require('../../lib/services/ai-functions/isolation/function-supervisor.cjs')
const { readConfig, UidPool, Gate, childCommand, childEnv, parseHeader } = supervisor

describe('the uid pool', () => {
  it('never hands out a uid that is out, so no two live runs share one', () => {
    const pool = new UidPool(20000, 8)
    const taken = Array.from({ length: 8 }, () => pool.take())
    expect(new Set(taken).size).toBe(8)
    expect(taken.every((uid: number) => uid >= 20000 && uid < 20008)).toBe(true)
    expect(pool.take()).toBeNull()
  })

  it('reuses a uid as late as it can', () => {
    const pool = new UidPool(20000, 3)
    const a = pool.take()
    pool.release(a, true)
    // The two never used come first; the one just given back waits its turn.
    expect([pool.take(), pool.take(), pool.take()]).toEqual([20001, 20002, a])
  })

  it('never gives out again a uid whose run could not be cleaned away', () => {
    const pool = new UidPool(20000, 2)
    const dirty = pool.take()
    pool.release(dirty, false)
    expect(pool.quarantined.has(dirty)).toBe(true)
    expect(pool.take()).toBe(20001)
    expect(pool.take()).toBeNull()
  })

  it('skips uids that already belong to someone', () => {
    const pool = new UidPool(20000, 4, (uid: number) => uid !== 20001)
    const taken = [pool.take(), pool.take(), pool.take()]
    expect(taken).toEqual([20000, 20002, 20003])
  })
})

describe('the concurrency gate', () => {
  it('admits up to its limit, then the next in line as each run ends', async () => {
    const gate = new Gate(2, 10)
    expect(await gate.acquire(1000)).toBe(true)
    expect(await gate.acquire(1000)).toBe(true)
    const third = gate.acquire(1000)
    gate.release()
    expect(await third).toBe(true)
  })

  it('turns a run away once it has waited its limit, or when the queue is full', async () => {
    const gate = new Gate(1, 1)
    expect(await gate.acquire(10)).toBe(true)
    const waiting = gate.acquire(30)
    expect(await gate.acquire(10)).toBe(false)
    expect(await waiting).toBe(false)
  })
})

describe('the command a run starts with', () => {
  const config = {
    ...readConfig({}),
    prlimit: '/usr/bin/prlimit',
    setpriv: '/usr/bin/setpriv',
    choom: '/usr/bin/choom',
    nice: '/usr/bin/nice',
    nodePath: '/usr/local/bin/node',
    runnerPath: '/opt/backenly-fn/function-runner.cjs',
  }

  it('limits processes, files, core dumps and CPU time, gives up privileges for good, and only then becomes node', () => {
    const { file, args } = childCommand(config)
    expect(file).toBe('/usr/bin/prlimit')
    expect(args.slice(0, args.indexOf('--'))).toEqual([
      `--nproc=${config.nproc}`,
      `--nofile=${config.nofile}`,
      '--core=0',
      `--fsize=${config.fsizeBytes}`,
      // A backstop for a process its supervisor no longer watches: twice the longest deadline.
      '--cpu=120:130',
    ])
    const setpriv = args.indexOf('/usr/bin/setpriv')
    expect(args.slice(setpriv, setpriv + 3)).toEqual(['/usr/bin/setpriv', '--no-new-privs', '--'])
    expect(args.slice(setpriv + 3)).toEqual(['/usr/local/bin/node', `--max-old-space-size=${config.heapMb}`, '/opt/backenly-fn/function-runner.cjs'])
    // First for the OOM killer, and behind the app for the CPU.
    expect(args.join(' ')).toContain('/usr/bin/choom -n 1000 --')
    expect(args.join(' ')).toContain('/usr/bin/nice -n 10')
  })

  it('names no uid: spawn() switches uid and gid, and drops groups, before anything runs', () => {
    expect(childCommand(config).args.join(' ')).not.toMatch(/reuid|regid|--user|--group/)
  })
})

describe('what a run is given', () => {
  const saved = process.env.PLANTED_SUPERVISOR_SECRET
  afterAll(() => {
    if (saved === undefined) delete process.env.PLANTED_SUPERVISOR_SECRET
    else process.env.PLANTED_SUPERVISOR_SECRET = saved
  })

  it('is an environment of a fixed list of names, none of them secret, and nothing of the supervisor’s own', () => {
    process.env.PLANTED_SUPERVISOR_SECRET = 'planted-not-a-real-secret'
    const env = childEnv({ ...readConfig({}), childCaCerts: '/opt/backenly-fn/rds-ca-cloud-regions.pem' }, '/tmp/backenly-fn-runs/run-x')
    expect(Object.keys(env).sort()).toEqual(['HOME', 'LANG', 'NODE_ENV', 'NODE_EXTRA_CA_CERTS', 'PATH', 'TMPDIR', 'TZ'])
    expect(env.HOME).toBe('/tmp/backenly-fn-runs/run-x')
    expect(env.TMPDIR).toBe('/tmp/backenly-fn-runs/run-x')
    expect(JSON.stringify(env)).not.toContain('planted')
  })

  it('reads its settings from the supervisor’s environment, and refuses a pool that could hold real users', () => {
    const config = readConfig({ BACKENLY_FN_UID_BASE: '30000', BACKENLY_FN_UID_COUNT: '64', BACKENLY_FN_MAX_CONCURRENCY: '3' })
    expect(config).toMatchObject({ uidBase: 30000, uidCount: 64, maxConcurrency: 3, socketPath: '/tmp/backenly-fn/supervisor.sock' })
    expect(() => readConfig({ BACKENLY_FN_UID_BASE: '1000' })).toThrow(/at least 10000/)
  })
})

describe('the request header', () => {
  it('takes a run request and keeps its deadline within bounds', () => {
    expect(parseHeader(Buffer.from('{"v":1,"op":"run","timeoutMs":15000}'))).toEqual({ timeoutMs: 15000 })
    expect(parseHeader(Buffer.from('{"v":1,"op":"run","timeoutMs":999999}'))).toEqual({ timeoutMs: 60000 })
    expect(parseHeader(Buffer.from('{"v":1,"op":"run","timeoutMs":1}'))).toEqual({ timeoutMs: 1000 })
  })

  it.each([['not json'], ['{"v":2,"op":"run"}'], ['{"v":1,"op":"exec"}'], ['null']])('refuses %s', (raw) => {
    expect(parseHeader(Buffer.from(raw))).toBeNull()
  })
})
