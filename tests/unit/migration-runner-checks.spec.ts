/**
 * THE MIGRATION TOOLING'S FIXED CHECKS — held to what they claim to check
 * =======================================================================
 *
 * On 2026-09-24 staging's deploy of 20260924120000_project_pause failed with
 * 42501 because the app-role cutover had left every enum with the admin role.
 * The fix has four parts, and this file holds the parts that can be held
 * without a database:
 *
 *   - the pause migration's absence and presence proofs name EVERY effect the
 *     migration declares, derived from the migration text itself, so an edit
 *     to one without the other fails here;
 *   - the image carries the checks the entrypoint runs;
 *   - the enum repair SQL stays inside its vocabulary, and the audit really
 *     refuses what it says it refuses;
 *   - the cutover now moves enums, and still passes its own audit;
 *   - both launchers read a runner task's outcome the same way, and a zero
 *     exit without the runner's own proof is not a success.
 *
 * The database-backed half is tests/integration/migration-ownership-recovery.spec.ts.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  ENUM_REPAIR_SQL_PATH,
  auditEnumRepairSql,
  buildEnumRepairScript,
  parseRepairResult,
} from '@/tools/managed-db/enum-ownership-repair'
import { readMigrationJobOutcome } from '@/tools/managed-db/migration-job-outcome'
import { auditCutoverSql } from '@/scripts/run-app-role-cutover'

const ROOT = join(__dirname, '..', '..')
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8')

const PAUSE = '20260924120000_project_pause'
const RUNNER = join('tools', 'managed-db', 'runner')

describe('the pause migration proofs name every effect the migration declares', () => {
  const migration = read('prisma', 'migrations-canonical', PAUSE, 'migration.sql')
  const absent = read(RUNNER, 'checks', `${PAUSE}.absent.sql`)
  const present = read(RUNNER, 'checks', `${PAUSE}.present.sql`)

  // Parsed from the migration, not restated: the point is that the proofs
  // follow the file, whatever it says.
  const enumValues = [...migration.matchAll(/ADD VALUE '([^']+)'/g)].map(m => m[1])
  const columns = [...migration.matchAll(/ADD COLUMN "([^"]+)"/g)].map(m => m[1])
  const indexes = [...migration.matchAll(/CREATE (?:UNIQUE )?INDEX "([^"]+)"/g)].map(m => m[1])

  it('the migration declares what this test expects to find', () => {
    // Non-vacuity: a parse that found nothing would make every check below pass.
    expect(enumValues).toEqual(['CANCELLED'])
    expect(columns).toHaveLength(7)
    expect(indexes).toEqual(['projects_pausedAt_idx'])
  })

  it('declares no other kind of effect the proofs would not see', () => {
    const statements = migration
      .split('\n')
      .filter(l => !l.trim().startsWith('--'))
      .join('\n')
      .split(';')
      .map(s => s.replace(/\s+/g, ' ').trim())
      .filter(Boolean)
    const kinds = statements.map(s => s.split(' ').slice(0, 2).join(' '))
    expect([...new Set(kinds)].sort()).toEqual(['ALTER TABLE', 'ALTER TYPE', 'CREATE INDEX'])
  })

  it.each([
    { file: 'absent', sql: absent },
    { file: 'present', sql: present },
  ])('the $file proof names every declared effect', ({ sql }) => {
    for (const v of enumValues) expect(sql).toContain(`'${v}'`)
    for (const c of columns) expect(sql).toContain(`'${c}'`)
    for (const i of indexes) expect(sql).toContain(i)
  })
})

describe('the runner image carries the checks the entrypoint runs', () => {
  const entrypoint = read(RUNNER, 'entrypoint.sh')

  it('every check file the entrypoint names exists', () => {
    const named = [...entrypoint.matchAll(/run_check "?([^"\s;]+)"?/g)]
      .map(m => m[1].replace('$MIGRATION', PAUSE))
      .filter(n => n !== '$1')
    expect(named.sort()).toEqual(
      ['ownership-preflight.sql', `${PAUSE}.absent.sql`, `${PAUSE}.present.sql`].sort(),
    )
    for (const n of named) expect(existsSync(join(ROOT, RUNNER, 'checks', n))).toBe(true)
  })

  it('the image copies the checks to where the entrypoint reads them', () => {
    expect(read(RUNNER, 'Dockerfile.migrate')).toMatch(/^COPY checks \.\/checks$/m)
    expect(read(RUNNER, 'Dockerfile.migrate')).toMatch(/^WORKDIR \/app$/m)
    expect(entrypoint).toContain('CHECKS="${MIGRATE_CHECKS:-/app/checks}"')
    expect(read(RUNNER, 'build-and-push.sh')).toContain('cp -r "$ROOT/tools/managed-db/runner/checks" "$CTX/checks"')
  })

  it('the checks are read-only: DO blocks, no DDL, no data changes', () => {
    for (const f of ['ownership-preflight.sql', `${PAUSE}.absent.sql`, `${PAUSE}.present.sql`]) {
      const executable = read(RUNNER, 'checks', f)
        .split('\n')
        .filter(l => !l.trim().startsWith('--'))
        .join('\n')
        .replace(/'(?:[^']|'')*'/g, "''")
      expect(executable).not.toMatch(/\b(ALTER|CREATE|DROP|GRANT|REVOKE|INSERT|UPDATE|DELETE|TRUNCATE|EXECUTE)\b/i)
      expect(executable.replace(/DO\s+\$\$[\s\S]*?\$\$\s*;/gi, '').trim()).toBe('')
    }
  })
})

describe('the enum repair SQL stays inside its vocabulary', () => {
  const sql = read(ENUM_REPAIR_SQL_PATH)

  it('the real file passes its audit', () => {
    expect(auditEnumRepairSql(sql)).toEqual([])
  })

  it.each([
    { name: 'a password change', add: "DO $$ BEGIN EXECUTE 'ALTER ROLE backenly_app PASSWORD ''x'''; END $$;" },
    { name: 'a grant', add: 'DO $$ BEGIN GRANT backenly_admin TO backenly_app; END $$;' },
    { name: 'a table change', add: 'DO $$ BEGIN ALTER TABLE projects OWNER TO backenly_app; END $$;' },
    { name: 'a second dynamic statement', add: "DO $$ BEGIN EXECUTE format('ALTER TYPE %s RENAME TO x', 'y'); END $$;" },
    { name: 'a top-level statement', add: 'SELECT 1;' },
    { name: 'a data change', add: "DO $$ BEGIN UPDATE plans SET name = 'x'; END $$;" },
  ])('refuses $name', ({ add }) => {
    expect(auditEnumRepairSql(`${sql}\n${add}\n`).length).toBeGreaterThan(0)
  })

  it('builds a script whose only additions are three validated settings', () => {
    const script = buildEnumRepairScript(sql, { apply: false, database: 'backenly', appRole: 'backenly_app' })
    const [a, b, c, ...rest] = script.split('\n')
    expect(a).toBe("SELECT set_config('backenly.repair_apply', 'false', false);")
    expect(b).toBe("SELECT set_config('backenly.repair_expect_database', 'backenly', false);")
    expect(c).toBe("SELECT set_config('backenly.repair_expect_app_role', 'backenly_app', false);")
    expect(rest.join('\n')).toBe(sql)
  })

  it.each(["backenly'; DROP TABLE plans; --", 'Backenly', 'back-enly', ''])(
    'refuses a database name that is not a plain identifier: %p',
    name => {
      expect(() => buildEnumRepairScript(sql, { apply: true, database: name, appRole: 'backenly_app' })).toThrow()
    },
  )

  it('reads the result line, and treats its absence as no result', () => {
    expect(parseRepairResult('x\nNOTICE:  REPAIR_RESULT mode=apply would_move=5 moved=5 not_owned_by_app_role=0\n')).toEqual({
      mode: 'apply',
      wouldMove: 5,
      moved: 5,
      notOwnedByAppRole: 0,
    })
    expect(parseRepairResult('NOTICE:  before public."X" owner a -> b (will move)')).toBeNull()
  })
})

describe('the cutover now moves enum types, and still passes its own audit', () => {
  const sql = read('tools', 'managed-db', 'sql', 'app-role-cutover.sql')

  it('passes auditCutoverSql', () => {
    expect(auditCutoverSql(sql)).toEqual([])
  })

  it('moves public enums owned by the admin role, and proves none are left', () => {
    expect(sql).toContain("EXECUTE format('ALTER TYPE %s OWNER TO %I', r.ident, app_role)")
    expect(sql).toMatch(/RAISE EXCEPTION 'an enum type in public is still owned by %/)
    // The measurement shows current owner -> desired owner.
    expect(sql).toMatch(/ENUM TYPES: current owner -> desired owner/)
  })
})

describe('both launchers read a runner task the same way', () => {
  it('a preflight refusal says nothing was applied, not "partially migrated"', () => {
    const o = readMigrationJobOutcome(
      'deploy',
      'Error: ownership preflight: backenly_app cannot alter ...\nrefusing: ownership preflight failed; nothing was applied and no migration history was written',
      3,
    )
    expect(o.exitCode).toBe(1)
    expect(o.message).toMatch(/Nothing was applied and no migration history was written/)
    expect(o.message).not.toMatch(/partially/)
  })

  it('a deploy is proved only when the preflight passed AND prisma applied or had nothing to apply', () => {
    expect(readMigrationJobOutcome('deploy', 'All migrations have been successfully applied.', 0).exitCode).toBe(1)
    expect(
      readMigrationJobOutcome('deploy', 'PREFLIGHT PASSED: ...\nAll migrations have been successfully applied.', 0).exitCode,
    ).toBe(0)
    expect(readMigrationJobOutcome('deploy', 'PREFLIGHT PASSED: ...\nNo pending migrations to apply.', 0).exitCode).toBe(0)
  })

  it('a rollback is proved only by the absence proof AND prisma marking it rolled back', () => {
    const absent = `ABSENT: ${PAUSE} left none of its declared effects behind`
    const marked = `Migration ${PAUSE} marked as rolled back.`
    expect(readMigrationJobOutcome('rollback', marked, 0).exitCode).toBe(1)
    expect(readMigrationJobOutcome('rollback', absent, 0).exitCode).toBe(1)
    expect(readMigrationJobOutcome('rollback', `${absent}\n${marked}`, 0).exitCode).toBe(0)
  })

  it('a zero exit whose proof never arrived is not a success', () => {
    for (const c of ['preflight', 'verify', 'baseline', 'rollback', 'deploy'] as const) {
      expect(readMigrationJobOutcome(c, '', 0).exitCode).toBe(1)
    }
  })

  it('status passes prisma’s own answer through', () => {
    expect(readMigrationJobOutcome('status', 'Following migration have not yet been applied', 1).exitCode).toBe(1)
    expect(readMigrationJobOutcome('status', 'Database schema is up to date!', 0).exitCode).toBe(0)
  })
})
