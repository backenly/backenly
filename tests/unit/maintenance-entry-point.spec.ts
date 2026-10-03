/**
 * THE ENTRY POINT — what it refuses before it touches anything
 * ============================================================
 *
 * `scripts/run-maintenance-plan.ts` is the only way to run a maintenance plan.
 * These tests cover the refusals that must happen before any database read, by
 * running the real script as a subprocess against no database at all.
 *
 * The one that matters most:
 *
 *   **the CLI can only narrow permission, never widen it.**
 *
 * `--mode execute` does not enable mutations. It asks to use permission the
 * environment already granted through `ENABLE_PHASE_6B_MAINTENANCE_MUTATIONS`.
 * If no argument can turn writing on, then "someone ran a command" and "this
 * deployment may write" stay separate facts — and only the second one is a
 * decision about production.
 *
 * Run as a subprocess rather than by importing `main()`: the script's contract
 * includes its exit codes and the fact that it refuses before connecting, and
 * neither survives being called as a function.
 */

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(__dirname, '..', '..')
const SCRIPT = join(ROOT, 'scripts', 'run-maintenance-plan.ts')

jest.setTimeout(180_000)

const IDS = [
  '--project', 'p1',
  '--finding', 'f1',
  '--plan', 'plan-abc',
  '--plan-version', 'ver-abc',
]

interface Run {
  status: number
  output: string
}

function run(args: string[], env: Record<string, string> = {}): Run {
  try {
    // node with the tsx loader, not `npx tsx`: on Windows npx runs through a
    // shell wrapper whose exit code is not the script's, and these assertions
    // are about exit codes.
    const output = execFileSync(process.execPath, ['--import', 'tsx', SCRIPT, ...args], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        // Unroutable. Anything that reaches the database fails loudly rather
        // than quietly succeeding against a real one.
        DATABASE_URL: 'postgresql://ci:ci@127.0.0.1:1/unused',
        DIRECT_URL: 'postgresql://ci:ci@127.0.0.1:1/unused',
        ENABLE_PHASE_6B_MAINTENANCE_MUTATIONS: '',
        ...env,
      },
    })
    return { status: 0, output }
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string }
    return { status: e.status ?? 1, output: `${e.stdout ?? ''}${e.stderr ?? ''}` }
  }
}

describe('the entry point discovers nothing', () => {
  it('exists', () => {
    expect(existsSync(SCRIPT)).toBe(true)
  })

  it.each([
    ['--project', ['--finding', 'f1', '--plan', 'p', '--plan-version', 'v', '--mode', 'dry-run']],
    ['--finding', ['--project', 'p1', '--plan', 'p', '--plan-version', 'v', '--mode', 'dry-run']],
    ['--plan', ['--project', 'p1', '--finding', 'f1', '--plan-version', 'v', '--mode', 'dry-run']],
    ['--plan-version', ['--project', 'p1', '--finding', 'f1', '--plan', 'p', '--mode', 'dry-run']],
  ])('refuses without %s', (_flag, args) => {
    const r = run(args)
    expect(r.status).toBe(2)
    expect(r.output).toMatch(/all required; this script discovers nothing/)
  })

  it('refuses a mode it does not have', () => {
    const r = run([...IDS, '--mode', 'all-eligible'])
    expect(r.status).toBe(2)
    expect(r.output).toMatch(/--mode must be dry-run, execute or observe/)
  })

  it('refuses observe without an execution to observe', () => {
    // observe reports on ONE named execution. Without one it would have to go
    // looking for the latest, which is discovery by another name.
    const r = run([...IDS, '--mode', 'observe'])
    expect(r.status).toBe(2)
    expect(r.output).toMatch(/--execution <id> is required/)
  })

  it('refuses a window that is not a positive duration', () => {
    const r = run([...IDS, '--mode', 'observe', '--execution', 'e1', '--window-ms', '0'])
    expect(r.status).toBe(2)
    expect(r.output).toMatch(/--window-ms must be a positive number/)
  })
})

describe('the CLI can only narrow permission', () => {
  it('refuses to execute when the environment flag is off', () => {
    const r = run([...IDS, '--mode', 'execute', '--confirm', 'p1:plan-abc:ver-abc', '--bindings', 'b.json'])
    expect(r.status).toBe(2)
    expect(r.output).toMatch(/ENABLE_PHASE_6B_MAINTENANCE_MUTATIONS is not set/)
    expect(r.output).toMatch(/No argument to this script can turn mutations on/)
  })

  it('refuses before reading any database', () => {
    // The DATABASE_URL above is unroutable, so a run that reached the database
    // would fail with a connection error instead. Getting the flag refusal
    // proves the gate is upstream of the read.
    const r = run([...IDS, '--mode', 'execute', '--confirm', 'p1:plan-abc:ver-abc', '--bindings', 'b.json'])
    expect(r.output).not.toMatch(/ECONNREFUSED|connect|P1001/i)
  })

  it.each([
    ['--enable-mutations'],
    ['--force'],
    ['--mutations-enabled'],
  ])('has no %s argument that could turn writing on', flag => {
    const r = run([...IDS, '--mode', 'execute', '--confirm', 'p1:plan-abc:ver-abc', '--bindings', 'b.json', flag, 'true'])
    // Unknown arguments are ignored, and the environment still decides.
    expect(r.status).toBe(2)
    expect(r.output).toMatch(/ENABLE_PHASE_6B_MAINTENANCE_MUTATIONS is not set/)
  })
})

describe('executing needs the exact confirmation', () => {
  const ON = { ENABLE_PHASE_6B_MAINTENANCE_MUTATIONS: 'true' }

  it('refuses without --confirm', () => {
    const r = run([...IDS, '--mode', 'execute', '--bindings', 'b.json'], ON)
    expect(r.status).toBe(2)
    expect(r.output).toMatch(/--confirm must be exactly "p1:plan-abc:ver-abc"/)
  })

  it('refuses a confirmation naming a different plan version', () => {
    const r = run([...IDS, '--mode', 'execute', '--confirm', 'p1:plan-abc:OTHER', '--bindings', 'b.json'], ON)
    expect(r.status).toBe(2)
    expect(r.output).toMatch(/--confirm must be exactly/)
  })

  it('refuses a confirmation naming a different project', () => {
    const r = run([...IDS, '--mode', 'execute', '--confirm', 'OTHER:plan-abc:ver-abc', '--bindings', 'b.json'], ON)
    expect(r.status).toBe(2)
    expect(r.output).toMatch(/--confirm must be exactly/)
  })

  it('refuses without bindings, rather than generating any SQL', () => {
    const r = run([...IDS, '--mode', 'execute', '--confirm', 'p1:plan-abc:ver-abc'], ON)
    expect(r.status).toBe(2)
    expect(r.output).toMatch(/--bindings <file\.json> or --bindings-json <json> is required/)
    expect(r.output).toMatch(/typed data, never generated SQL/)
  })

  it('accepts inline bindings, which is the only form a container can use', () => {
    // The container has no file to read. Bindings are the operator's mapping,
    // not the plan — the plan is still rebuilt from the database.
    const r = run([...IDS, '--mode', 'execute', '--confirm', 'p1:plan-abc:ver-abc', '--bindings-json', '{}'], ON)
    expect(r.output).not.toMatch(/is required to execute/)
  })

  it('refuses both binding forms at once, rather than picking one', () => {
    const r = run(
      [...IDS, '--mode', 'execute', '--confirm', 'p1:plan-abc:ver-abc', '--bindings', 'b.json', '--bindings-json', '{}'],
      ON,
    )
    expect(r.status).toBe(2)
    expect(r.output).toMatch(/not both/)
  })

  it('gets past the argument gates with everything correct, and only then reads', () => {
    // Non-vacuity for the block above: with a valid confirmation the script
    // proceeds to resolve the plan and fails on the unroutable database. If it
    // refused here too, the tests above would prove nothing.
    const r = run([...IDS, '--mode', 'execute', '--confirm', 'p1:plan-abc:ver-abc', '--bindings', 'b.json'], ON)
    expect(r.output).not.toMatch(/--confirm must be exactly/)
    expect(r.output).not.toMatch(/ENABLE_PHASE_6B_MAINTENANCE_MUTATIONS is not set/)
  })
})

describe('the connection guard, in the entry point itself', () => {
  // The launcher's ARN check is a check on a pointer. This is the check on the
  // connection, and it is the same guard the migration runner applies in shell.
  const url = (db: string, password = 'pw') =>
    `postgresql://backenly_user:${password}@db.example.internal:5432/${db}?sslmode=require`

  it('refuses when the connected database is not the expected one', () => {
    const r = run([...IDS, '--mode', 'dry-run'], {
      EXPECT_DATABASE: 'backenly',
      DATABASE_URL: url('backenly_staging'),
    })
    expect(r.status).toBe(2)
    expect(r.output).toMatch(/connected database is "backenly_staging", expected "backenly"/)
  })

  it('is not confused by a password containing a slash or an at-sign', () => {
    const r = run([...IDS, '--mode', 'dry-run'], {
      EXPECT_DATABASE: 'backenly',
      DATABASE_URL: url('backenly', 'a/b@c'),
    })
    expect(r.output).toMatch(/database: backenly \(matches EXPECT_DATABASE\)/)
    expect(r.output).not.toMatch(/connected database is/)
  })

  it('refuses a URL with no database path rather than guessing', () => {
    const r = run([...IDS, '--mode', 'dry-run'], {
      EXPECT_DATABASE: 'backenly',
      DATABASE_URL: 'postgresql://backenly_user:pw@db.example.internal:5432',
    })
    expect(r.status).toBe(2)
    expect(r.output).toMatch(/connected database is/)
  })

  it('applies to dry-run too, not only to execute', () => {
    // A report about the wrong database is worse than no report.
    const r = run([...IDS, '--mode', 'dry-run'], {
      EXPECT_DATABASE: 'backenly',
      DATABASE_URL: url('some_other_db'),
    })
    expect(r.status).toBe(2)
  })

  it('skips the check when no database was named', () => {
    const r = run([...IDS, '--mode', 'dry-run'])
    expect(r.output).not.toMatch(/matches EXPECT_DATABASE/)
    expect(r.output).not.toMatch(/connected database is/)
  })
})
