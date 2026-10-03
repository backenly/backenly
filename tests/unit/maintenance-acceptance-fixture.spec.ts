/**
 * THE ACCEPTANCE FIXTURE CANNOT BECOME AN ADMIN TOOL
 * ==================================================
 *
 * It prepares one disposable project so the maintenance ladder can be exercised
 * against production. The danger is not what it does today — it is what a
 * "small addition" would turn it into: a thing in a production image that takes
 * a table name, or a column, or SQL.
 *
 * So these tests are mostly about what it REFUSES, and one of them reads the
 * source to assert the surface has not grown. That is unusual and deliberate:
 * an argument the parser ignores today is one line away from being honoured,
 * and the whole safety claim is "read this file and you know what it can write".
 *
 * The fixture SHAPE is asserted too, because it is not arbitrary. It mirrors
 * tests/integration/maintenance-resolve-db.spec.ts, which measured the three
 * conditions under which the structural diagnosis will decide rather than
 * refuse. Weakening any of them would make the production exercise pass while
 * proving nothing.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(__dirname, '..', '..')
const SCRIPT = join(ROOT, 'scripts', 'maintenance-acceptance-fixture.ts')
const SOURCE = readFileSync(SCRIPT, 'utf8')
const PROJECT = '11111111-2222-4333-8444-555555555555'

jest.setTimeout(180_000)

function run(args: string[], env: Record<string, string> = {}): { status: number; output: string } {
  try {
    const output = execFileSync(process.execPath, ['--import', 'tsx', SCRIPT, ...args], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        DATABASE_URL: 'postgresql://ci:ci@127.0.0.1:1/unused',
        DIRECT_URL: 'postgresql://ci:ci@127.0.0.1:1/unused',
        ...env,
      },
    })
    return { status: 0, output }
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string }
    return { status: e.status ?? 1, output: `${e.stdout ?? ''}${e.stderr ?? ''}` }
  }
}

describe('the surface is two arguments wide', () => {
  it.each(['--sql', '--query', '--table', '--schema', '--column', '--force', '--operations'])(
    'has no %s argument anywhere in its source',
    flag => {
      // Not "the parser ignores it" — absent. An ignored argument is one line
      // from being honoured, and this file's safety claim is that reading it
      // tells you everything it can write.
      expect(SOURCE).not.toContain(`'${flag}'`)
      expect(SOURCE).not.toContain(`"${flag}"`)
    },
  )

  it('reads exactly the arguments it documents', () => {
    const flags = [...SOURCE.matchAll(/arg\('(--[a-z-]+)'\)/g)].map(m => m[1]).sort()
    expect([...new Set(flags)]).toEqual(['--confirm', '--confirm-destroy', '--mode', '--project'])
  })

  it('refuses a mode it does not have', () => {
    expect(run(['--mode', 'seed', '--project', PROJECT]).output).toMatch(/--mode must be prepare, cleanup, inspect or induce-regression/)
  })

  it('refuses without a project, for the modes that need one', () => {
    // `prepare` no longer takes one: the product mints the id.
    expect(run(['--mode', 'inspect']).output).toMatch(/--project <id> is required/)
    expect(run(['--mode', 'cleanup']).output).toMatch(/--project <id> is required/)
  })

  it('refuses a project id that is not a uuid', () => {
    const r = run(['--mode', 'inspect', '--project', 'sessions'])
    expect(r.status).toBe(2)
    expect(r.output).toMatch(/--project must be a uuid/)
  })

  it('refuses a confirmation that does not name the acceptance project', () => {
    const r = run(['--mode', 'prepare', '--confirm', 'yes'])
    expect(r.status).toBe(2)
    expect(r.output).toMatch(/--confirm must be exactly "maintenance-prod-acceptance"/)
  })

  it('will not destroy on the preparation confirmation alone', () => {
    // Cleanup takes a DIFFERENT confirmation, so a shell-history re-run of the
    // prepare command cannot delete the evidence it just created.
    const r = run(['--mode', 'cleanup', '--project', PROJECT, '--confirm', PROJECT])
    expect(r.status).toBe(2)
    expect(r.output).toMatch(/--confirm-destroy must be exactly/)
  })

  it('applies the connection guard before anything else', () => {
    const r = run(['--mode', 'prepare', '--confirm', 'maintenance-prod-acceptance'], {
      EXPECT_DATABASE: 'backenly',
      DATABASE_URL: 'postgresql://u:p@h:5432/some_other_db',
    })
    expect(r.status).toBe(2)
    expect(r.output).toMatch(/connected database is "some_other_db", expected "backenly"/)
  })
})

describe('it only ever touches the acceptance project', () => {
  it('pins the marker name as an exact string', () => {
    expect(SOURCE).toMatch(/ACCEPTANCE_PROJECT_NAME = 'maintenance-prod-acceptance'/)
    // Compared with ===, never with includes or a regex that a real project
    // name could satisfy. Preparation now creates the project through the
    // product, so the name is what it MINTS with; cleanup still refuses any
    // project carrying a different one.
    expect(SOURCE).toMatch(/name: ACCEPTANCE_PROJECT_NAME/)
    expect(SOURCE).toMatch(/project\.name !== ACCEPTANCE_PROJECT_NAME/)
  })

  it('derives the schema from the project id and nothing else', () => {
    expect(SOURCE).toMatch(/schemaFor = \(projectId: string\) => `workspace_\$\{projectId\}`/)
  })
})

describe('the fixture shape is the measured one', () => {
  it('inserts more rows than the covariation probe requires', () => {
    // Read from the source rather than imported: importing the module runs
    // `main()`, which is exactly the thing a unit test must not do to a script
    // that writes to a database.
    const rows = Number(SOURCE.match(/FIXTURE_ROWS = (\d+)/)?.[1])
    // The probe refuses below 50 and reports blockedBy rather than concluding.
    expect(rows).toBeGreaterThanOrEqual(50)
  })

  it('constrains both lifecycle columns, through the product path', () => {
    // Without CHECK constraints the subsystem shows a missing-constraint
    // symptom as well, and the diagnosis correctly refuses to break the tie.
    expect(SOURCE).toMatch(/constraintType: 'check'/)
    expect(SOURCE).toMatch(/status IN \('active','archived','pending'\)/)
    expect(SOURCE).toMatch(/legacy_state IN \('ACTIVE','ARCHIVED','PENDING'\)/)
  })

  it('creates the project and tables through the product lifecycle, not raw DDL', () => {
    // The first production run failed because this used raw DDL, leaving a
    // table with no Table metadata row — which is what made add_structure
    // expand into a CREATE_TABLE that destroyed 80 rows.
    expect(SOURCE).toMatch(/createProvisionedProject/)
    expect(SOURCE).toMatch(/act\('CREATE_TABLE'/)
    expect(SOURCE).not.toMatch(/CREATE TABLE "/)
    expect(SOURCE).not.toMatch(/CREATE SCHEMA/)
  })

  it('asserts the Table metadata row exists afterwards', () => {
    expect(SOURCE).toMatch(/has no Table metadata row after the product path created it/)
  })

  it('refuses to reuse an existing acceptance project', () => {
    // Reusing one hides whether the product path still works from a cold start.
    expect(SOURCE).toMatch(/an acceptance project already exists/)
  })

  it('analyses the table, because the coverage assessor reads planner statistics', () => {
    expect(SOURCE).toMatch(/ANALYZE "\$\{schema\}"\."sessions"/)
  })

  it('does NOT create the target column, which add_structure owns', () => {
    // add_structure's precondition is that the target does not exist, so a
    // fixture that created it would make the first rung refuse.
    expect(SOURCE).not.toMatch(/ADD COLUMN lifecycle_state|lifecycle_state text/)
    expect(SOURCE).toMatch(/TARGET_COLUMN = 'lifecycle_state'/)
  })

  it('creates a reader that names status and not the target', () => {
    // Phase 7 can only switch readers Backenly wrote. Without one,
    // switch_readers reports zero controllable readers, which is not a proof
    // that switching works.
    expect(SOURCE).toMatch(/FIXTURE_FUNCTION_CODE = `async \(ctx\)/)
    const code = SOURCE.split('FIXTURE_FUNCTION_CODE = `')[1].split('`')[0]
    expect(/\bstatus\b/.test(code)).toBe(true)
    expect(/\blifecycle_state\b/.test(code)).toBe(false)
  })

  it('labels the finding as fixture evidence, not a detector result', () => {
    // This exercise proves the execution path, not Phase 1-3 detection, and
    // the row has to say so where anything reading it will see.
    expect(SOURCE).toMatch(/acceptanceFixture: true/)
    expect(SOURCE).toMatch(/NOT produced by the recurrence detector/)
    expect(SOURCE).toMatch(/source: 'acceptance_fixture'/)
  })
})

describe('cleanup is separate on purpose', () => {
  it('is never run from a finally block', () => {
    // A run that stopped halfway leaves evidence that has to stay inspectable.
    expect(SOURCE).not.toMatch(/finally\s*\{[^}]*cleanup\(/)
  })

  it('removes only the acceptance project', () => {
    expect(SOURCE).toMatch(/cleanup only ever removes the acceptance project/)
  })
})
