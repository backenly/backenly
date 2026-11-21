/**
 * A PROJECT'S OWN DATABASE: THE PARTS THAT NEED NO DATABASE
 * =========================================================
 * lib/data-plane/project-databases.ts creates and drops a project's own
 * database as the region's database creator. What it does on PostgreSQL runs
 * in tests/integration/regional-bootstrap.spec.ts against a template the
 * regional procedure built. Pinned here:
 *
 *   names      p_ and 32 lowercase hex digits of a random UUID, a new one
 *              each time, never derived from anything about the project
 *   creator    DBCREATOR_DATABASE_URL at home, DBCREATOR_DATABASE_URL_<REGION>
 *              elsewhere, never the home value for another region, and a
 *              refusal that names the variable
 *   retry      a clone is tried again while the template is converging (42501)
 *              or in use (55006), with a doubling delay, for about 30 s, and
 *              then refused as retryable; any other error is not retried
 *   grants     the clone's grants are the text of
 *              scripts/sql/project-database-acl.sql, byte for byte: the web
 *              image carries no scripts/ directory
 */

import fs from 'fs'
import path from 'path'

import {
  CLONE_RETRY_BUDGET_MS,
  PROJECT_DATABASE_ACL_SQL,
  ProjectDatabaseTemplateBusyError,
  isRetryableCloneError,
  newProjectDatabaseName,
  regionDbcreatorUrl,
  requireRegionDbcreatorUrl,
  withCloneRetry,
} from '@/lib/data-plane/project-databases'
import { RegionNotConfiguredError, isProjectDatabaseName } from '@/lib/data-plane/regional'
import { HOME_REGION } from '@/lib/regions'

const pgError = (code: string, message = `error ${code}`) => Object.assign(new Error(message), { code })

/** A clock and a sleep that only move when the code under test sleeps. */
function virtualTime() {
  let now = 1_000_000
  const slept: number[] = []
  return {
    now: () => now,
    sleep: async (ms: number) => {
      slept.push(ms)
      now += ms
    },
    slept,
  }
}

describe('a project database name', () => {
  it('is p_ and 32 lowercase hex digits, new every time', () => {
    const names = new Set(Array.from({ length: 200 }, () => newProjectDatabaseName()))
    expect(names.size).toBe(200)
    for (const name of names) {
      expect(name).toMatch(/^p_[0-9a-f]{32}$/)
      expect(isProjectDatabaseName(name)).toBe(true)
    }
  })

  it('is not derived from the project: creating one takes nothing but the region and the id it records', () => {
    // The only input is randomness; the function takes no argument at all.
    expect(newProjectDatabaseName.length).toBe(0)
  })
})

describe('the database creator connection', () => {
  const env = {
    DBCREATOR_DATABASE_URL: 'postgresql://creator:pw@home.test:5432/control',
    DBCREATOR_DATABASE_URL_US_EAST_1: 'postgresql://creator:pw@virginia.test:5432/control',
    DBCREATOR_DATABASE_URL_US_WEST_2: '  ',
  }

  it('is DBCREATOR_DATABASE_URL at home and DBCREATOR_DATABASE_URL_<REGION> elsewhere', () => {
    expect(regionDbcreatorUrl(HOME_REGION, env)).toBe(env.DBCREATOR_DATABASE_URL)
    expect(regionDbcreatorUrl('us-east-1', env)).toBe(env.DBCREATOR_DATABASE_URL_US_EAST_1)
  })

  it('is never the home value for another region, and its absence names the variable', () => {
    expect(regionDbcreatorUrl('us-west-2', env)).toBeUndefined()
    expect(regionDbcreatorUrl('eu-central-1', env)).toBeUndefined()
    expect(() => requireRegionDbcreatorUrl('eu-central-1', { env })).toThrow(RegionNotConfiguredError)
    expect(() => requireRegionDbcreatorUrl('eu-central-1', { env })).toThrow('DBCREATOR_DATABASE_URL_EU_CENTRAL_1 is not set')
    expect(() => requireRegionDbcreatorUrl(HOME_REGION, { env: {} })).toThrow('DBCREATOR_DATABASE_URL is not set')
  })
})

describe('cloning the template', () => {
  it('retries while the template is converging or in use, then succeeds', async () => {
    const clock = virtualTime()
    const errors = [pgError('42501', 'permission denied to copy database'), pgError('55006', 'is being accessed by other users')]
    let calls = 0
    const result = await withCloneRetry(
      async () => {
        calls++
        const next = errors.shift()
        if (next) throw next
        return 'cloned'
      },
      { now: clock.now, sleep: clock.sleep },
    )
    expect(result).toBe('cloned')
    expect(calls).toBe(3)
    // A doubling delay from 250 ms.
    expect(clock.slept).toEqual([250, 500])
  })

  it('gives up after about 30 s with a retryable refusal naming the last error', async () => {
    const clock = virtualTime()
    let calls = 0
    const attempt = withCloneRetry(
      async () => {
        calls++
        throw pgError('55006', 'source database "backenly_project_template" is being accessed by other users')
      },
      { now: clock.now, sleep: clock.sleep },
    )
    await expect(attempt).rejects.toBeInstanceOf(ProjectDatabaseTemplateBusyError)
    await expect(attempt).rejects.toMatchObject({ code: 'PROJECT_DATABASE_TEMPLATE_BUSY', status: 503, retryable: true })
    await expect(attempt).rejects.toThrow(/55006: source database "backenly_project_template" is being accessed/)
    // Never longer than the budget, and capped at 4 s between attempts.
    expect(clock.slept.reduce((a, b) => a + b, 0)).toBe(CLONE_RETRY_BUDGET_MS)
    expect(Math.max(...clock.slept)).toBeLessThanOrEqual(4_000)
    expect(calls).toBe(clock.slept.length + 1)
  })

  it('does not retry anything else', async () => {
    const clock = virtualTime()
    let calls = 0
    await expect(
      withCloneRetry(
        async () => {
          calls++
          throw pgError('42P04', 'database already exists')
        },
        { now: clock.now, sleep: clock.sleep },
      ),
    ).rejects.toThrow('database already exists')
    expect(calls).toBe(1)
    expect(clock.slept).toEqual([])
    expect(isRetryableCloneError(new Error('no code'))).toBe(false)
    expect(isRetryableCloneError(null)).toBe(false)
    expect(isRetryableCloneError(pgError('42501'))).toBe(true)
    expect(isRetryableCloneError(pgError('55006'))).toBe(true)
  })
})

describe('the clone’s grants', () => {
  it('are scripts/sql/project-database-acl.sql, byte for byte', () => {
    const file = fs.readFileSync(path.join(process.cwd(), 'scripts/sql/project-database-acl.sql'), 'utf8')
    expect(PROJECT_DATABASE_ACL_SQL).toBe(file)
  })
})

describe('the module', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'lib/data-plane/project-databases.ts'), 'utf8')
  // The code before the embedded SQL file, without its comments.
  const code = source
    .slice(0, source.indexOf('export const PROJECT_DATABASE_ACL_SQL'))
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')

  it('never comments on a database: every login on the instance can read database comments', () => {
    expect(code).not.toMatch(/COMMENT\s+ON\s+DATABASE/i)
  })

  it('drops a database only WITH (FORCE) and IF EXISTS, so a drop is idempotent', () => {
    const drops = [...code.matchAll(/DROP DATABASE[^`]*/g)].map((m) => m[0])
    expect(drops.length).toBeGreaterThan(0)
    for (const drop of drops) expect(drop).toMatch(/^DROP DATABASE IF EXISTS \$\{quotedDatabase\(database\)\} WITH \(FORCE\)/)
  })
})
