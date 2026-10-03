/**
 * The Next standalone server must receive its environment BEFORE node starts.
 *
 * On 2026-09-06 a correct release with a correct app-root `.env` returned 500
 * on every page, because the standalone server chdirs into `.next/standalone/`
 * and resolves its own environment relative to there. The app root `.env` was
 * invisible to it, `lib/auth/jwt.ts` threw at module scope, and Next reported
 * it as an instrumentation-hook failure.
 *
 * The stop-gap was to copy `.env` into the build artifact. This suite exists so
 * the real contract is the tested one:
 *
 *     root .env present
 *     .next/standalone/.env ABSENT
 *     start through scripts/start-next-standalone.sh
 *         -> the server process sees JWT_SECRET, DATABASE_URL, BACKENLY_EDITION
 *
 * The entry point is a stub rather than the real server, so this runs without a
 * Next build. That is a deliberate limit: this proves environment DELIVERY, not
 * that the real server boots. The artifact smoke test covers the latter.
 */
import { spawn } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const ROOT = process.cwd()
const WRAPPER = path.join(ROOT, 'scripts', 'start-next-standalone.sh')

/** A value distinctive enough that finding it in output proves a leak. */
const SECRET = 'test-only-jwt-value-9d41f0c2b7'

let tmp: string
let envFile: string
let stub: string

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'standalone-env-'))
  envFile = path.join(tmp, 'fixture.env')
  stub = path.join(tmp, 'stub-entry.js')

  fs.writeFileSync(
    envFile,
    [
      '# a comment, and a blank line follow',
      '',
      `JWT_SECRET=${SECRET}`,
      'DATABASE_URL="postgresql://u:p@localhost:5432/db"',
      "BACKENLY_EDITION='cloud'",
      'export EXPORT_PREFIXED=yes',
      'VALUE_WITH_SPACES=a b c',
      'VALUE_WITH_EQUALS=a=b=c',
    ].join('\n') + '\n',
  )

  // Reports what the started process actually inherited, and its own pid so the
  // test can prove the wrapper exec'd rather than forking a child.
  fs.writeFileSync(
    stub,
    `const seen = {
      JWT_SECRET: process.env.JWT_SECRET,
      DATABASE_URL: process.env.DATABASE_URL,
      BACKENLY_EDITION: process.env.BACKENLY_EDITION,
      EXPORT_PREFIXED: process.env.EXPORT_PREFIXED,
      VALUE_WITH_SPACES: process.env.VALUE_WITH_SPACES,
      VALUE_WITH_EQUALS: process.env.VALUE_WITH_EQUALS,
      pid: process.pid,
    }
    console.log('STUB_SAW:' + JSON.stringify(seen))
    process.exit(42)
    `,
  )
})

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

interface Run {
  code: number | null
  stdout: string
  stderr: string
  pid: number | undefined
}

function runWrapper(args: string[], env: NodeJS.ProcessEnv = {}): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn('bash', [WRAPPER, ...args], {
      cwd: ROOT,
      env: { ...process.env, ...env },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.on('close', (code) => resolve({ code, stdout, stderr, pid: child.pid }))
  })
}

describe('start-next-standalone.sh delivers the environment before node starts', () => {
  it('never reads the artifact copy, whether or not one exists', () => {
    // Asserting that .next/standalone/.env is absent would only be testing
    // whether this machine happens to have a build lying around: true in CI,
    // false on a developer box that has run `npm run build`. The durable
    // property is that the wrapper CANNOT consult it, so assert on the source.
    const src = fs.readFileSync(WRAPPER, 'utf8')
    const code = src
      .split('\n')
      .filter((l) => !l.trim().startsWith('#'))
      .join('\n')
    expect(code).not.toMatch(/standalone\/\.env/)
    expect(code).toMatch(/BACKENLY_ENV_FILE:-\$ROOT\/\.env/)
  })

  it('the app root .env reaches the server process', async () => {
    const r = await runWrapper([stub], { BACKENLY_ENV_FILE: envFile })
    // The wrapper reports which file it loaded, so the source is not inferred.
    expect(r.stdout).toContain(`from ${envFile}`)
    expect(r.stderr).toBe('')
    expect(r.code).toBe(42)

    const line = r.stdout.split('\n').find((l) => l.startsWith('STUB_SAW:'))
    expect(line).toBeDefined()
    const seen = JSON.parse(line!.slice('STUB_SAW:'.length))

    expect(seen.JWT_SECRET).toBe(SECRET)
    expect(seen.DATABASE_URL).toBe('postgresql://u:p@localhost:5432/db')
    expect(seen.EXPORT_PREFIXED).toBe('yes')
    expect(seen.VALUE_WITH_SPACES).toBe('a b c')
    // Only the FIRST '=' separates name from value.
    expect(seen.VALUE_WITH_EQUALS).toBe('a=b=c')
  })

  it('BACKENLY_EDITION survives, because losing it is the dangerous failure', async () => {
    // An unset edition resolves to single-tenant and starts SILENTLY, which
    // would run Cloud production against OSS project-resolution rules.
    const r = await runWrapper([stub], { BACKENLY_ENV_FILE: envFile })
    const line = r.stdout.split('\n').find((l) => l.startsWith('STUB_SAW:'))!
    expect(JSON.parse(line.slice('STUB_SAW:'.length)).BACKENLY_EDITION).toBe('cloud')
  })

  it('never prints a value', async () => {
    const r = await runWrapper([stub], { BACKENLY_ENV_FILE: envFile })
    // The stub echoes what it inherited, so only inspect the wrapper's own
    // lines, which are the ones a deploy log would keep.
    const wrapperOutput = r.stdout
      .split('\n')
      .filter((l) => l.startsWith('start-next-standalone:'))
      .join('\n')
    expect(wrapperOutput).not.toContain(SECRET)
    expect(wrapperOutput).not.toContain('postgresql://')
    expect(wrapperOutput).toMatch(/loaded \d+ variable\(s\)/)
  })

  it('execs node instead of supervising it', async () => {
    // If the wrapper ran `node "$ENTRY"` without exec, node would be a CHILD of
    // the spawned bash and carry a different pid. PM2 would then supervise the
    // shell, and signals would land on the wrapper rather than the server.
    if (process.platform === 'win32') return // pid identity is not meaningful here
    const r = await runWrapper([stub], { BACKENLY_ENV_FILE: envFile })
    const line = r.stdout.split('\n').find((l) => l.startsWith('STUB_SAW:'))!
    expect(JSON.parse(line.slice('STUB_SAW:'.length)).pid).toBe(r.pid)
  })
})

describe('it refuses rather than starting a half-configured server', () => {
  it('fails when the environment file is missing', async () => {
    const r = await runWrapper([stub], { BACKENLY_ENV_FILE: path.join(tmp, 'nope.env') })
    expect(r.code).not.toBe(0)
    expect(r.code).not.toBe(42) // the stub never ran
    expect(r.stderr).toMatch(/no environment file/)
  })

  it('fails on a malformed entry rather than skipping it', async () => {
    const bad = path.join(tmp, 'malformed.env')
    fs.writeFileSync(bad, 'JWT_SECRET=ok\nthis-line-has-no-equals\n')
    const r = await runWrapper([stub], { BACKENLY_ENV_FILE: bad })
    expect(r.code).not.toBe(42)
    expect(r.stderr).toMatch(/malformed entry/)
  })

  it('fails on an invalid variable name', async () => {
    const bad = path.join(tmp, 'badname.env')
    fs.writeFileSync(bad, '9INVALID=x\n')
    const r = await runWrapper([stub], { BACKENLY_ENV_FILE: bad })
    expect(r.code).not.toBe(42)
    expect(r.stderr).toMatch(/invalid variable name/)
  })

  it('refuses an unterminated quote instead of truncating a secret', async () => {
    const bad = path.join(tmp, 'multiline.env')
    fs.writeFileSync(bad, 'KEY="line one\nline two"\n')
    const r = await runWrapper([stub], { BACKENLY_ENV_FILE: bad })
    expect(r.code).not.toBe(42)
    expect(r.stderr).toMatch(/unterminated quote/)
  })

  it('does not execute command substitution found in a value', async () => {
    // `. .env` would run this. Parsing must not.
    const evil = path.join(tmp, 'evil.env')
    const marker = path.join(tmp, 'pwned.txt')
    fs.writeFileSync(evil, `JWT_SECRET=x\nEVIL=$(touch ${marker.replace(/\\/g, '/')})\n`)
    const r = await runWrapper([stub], { BACKENLY_ENV_FILE: evil })
    expect(r.code).toBe(42)
    expect(fs.existsSync(marker)).toBe(false)
  })

  it('fails when the entry point does not exist', async () => {
    const r = await runWrapper([path.join(tmp, 'missing-server.js')], { BACKENLY_ENV_FILE: envFile })
    expect(r.code).not.toBe(0)
    expect(r.stderr).toMatch(/entry not found/)
  })
})
