/**
 * The import sandbox's checks that need no database: where a source may be
 * read, the job token, what a moved user may carry, and the schemas every op
 * a sandbox task sends must pass
 * (lib/import/sandbox.ts, lib/import/worker-api.ts, lib/import/worker/main.ts).
 */

import { importReading } from '@/lib/import/jobs'
import { newJobToken, sandboxConfig, setSandboxLauncherForTests, tokenHash, tokenMatches } from '@/lib/import/sandbox'
import { KEPT_BCRYPT_HASH, keptAuthUser } from '@/lib/import/supabase-auth'
import { opArgsAccepted } from '@/lib/import/worker-api'
import { failureOf, mergePatches, workerEnv } from '@/lib/import/worker/main'
import { ImportInputError } from '@/lib/import/driver'
import { ImportAborted } from '@/lib/import/pg-engine'

const SANDBOX_ENV = {
  IMPORT_SANDBOX_CLUSTER: 'arn:aws:ecs:ap-south-1:111122223333:cluster/backenly-staging',
  IMPORT_SANDBOX_FAMILY: 'backenly-staging-import-worker',
  IMPORT_SANDBOX_SUBNETS: 'subnet-0a1b2c3d, subnet-4e5f6a7b',
  IMPORT_SANDBOX_SECURITY_GROUP: 'sg-0123abcd',
  IMPORT_SANDBOX_EXECUTION_ROLE_ARN: 'arn:aws:iam::111122223333:role/backenly-staging-import-worker-exec',
  IMPORT_SANDBOX_LOG_GROUP: '/backenly/staging/import-worker',
  IMPORT_SANDBOX_ORIGIN: 'https://staging.backenly.com',
  AWS_REGION: 'ap-south-1',
}

// A real bcrypt shape: $2b$, a two-digit cost, 53 characters of salt and hash.
const hashAt = (cost: string) => `$2b$${cost}$${'a'.repeat(22)}${'b'.repeat(31)}`

describe('where a source is read', () => {
  afterEach(() => setSandboxLauncherForTests(null))

  it('reads the sandbox settings only when every one is there and well formed', () => {
    const cfg = sandboxConfig(SANDBOX_ENV)
    expect(cfg).toMatchObject({ subnets: ['subnet-0a1b2c3d', 'subnet-4e5f6a7b'], securityGroup: 'sg-0123abcd', cpu: '1024', memory: '2048' })
    for (const missing of Object.keys(SANDBOX_ENV)) {
      expect(sandboxConfig({ ...SANDBOX_ENV, [missing]: '' })).toBeNull()
    }
    // The task calls back over https only, to an origin, never a path or plain http.
    expect(sandboxConfig({ ...SANDBOX_ENV, IMPORT_SANDBOX_ORIGIN: 'http://staging.backenly.com' })).toBeNull()
    expect(sandboxConfig({ ...SANDBOX_ENV, IMPORT_SANDBOX_ORIGIN: 'https://staging.backenly.com/api' })).toBeNull()
    expect(sandboxConfig({ ...SANDBOX_ENV, IMPORT_SANDBOX_SUBNETS: 'subnet-0a1b2c3d,10.0.0.0/24' })).toBeNull()
  })

  it('never reads a source in a production web process: the sandbox, or nothing', () => {
    expect(importReading({ NODE_ENV: 'production' })).toBe('unavailable')
    expect(importReading({ NODE_ENV: 'production', ...SANDBOX_ENV })).toBe('sandbox')
    expect(importReading({ NODE_ENV: 'test' })).toBe('in-process')
  })
})

describe('the job token', () => {
  it('is proven by its hash alone, in constant time', () => {
    const { token, hash } = newJobToken()
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(hash).toBe(tokenHash(token))
    expect(tokenMatches(token, hash)).toBe(true)
    expect(tokenMatches(newJobToken().token, hash)).toBe(false)
    // An ended job has no hash: its token proves nothing.
    expect(tokenMatches(token, null)).toBe(false)
    expect(tokenMatches(token, 'not-a-hash')).toBe(false)
  })
})

describe('what a moved user may carry', () => {
  const user = {
    id: '6f1c2c1e-7a3b-4b9e-9f00-1c2d3e4f5a6b',
    email: 'ana@example.com',
    password: hashAt('10'),
    verified: true,
    name: 'Ana',
    avatar_url: null,
    created_at: '2025-01-02T03:04:05.000Z',
    last_sign_in_at: null,
    banned: false,
    provider: null,
    provider_id: null,
  }

  it('keeps a password only as a bcrypt hash sign-in reads', () => {
    expect(KEPT_BCRYPT_HASH.test(hashAt('10'))).toBe(true)
    expect(KEPT_BCRYPT_HASH.test(`$2a$10$${'a'.repeat(53)}`)).toBe(true)
    for (const bad of ['$1$abc', `$2b$1$${'a'.repeat(53)}`, `$2b$10$${'a'.repeat(52)}`, `$2b$10$${'a'.repeat(52)}"`, 'plain text']) {
      expect(KEPT_BCRYPT_HASH.test(bad)).toBe(false)
    }
    expect(keptAuthUser(user)?.password).toBe(user.password)
    // Anything else arrives as no password: its owner sets one.
    expect(keptAuthUser({ ...user, password: 'plain text' })).toMatchObject({ email: 'ana@example.com', password: null })
  })

  it('refuses a user with no uuid id or no email, and empties a field past its length', () => {
    expect(keptAuthUser({ ...user, id: '1; DROP TABLE users' })).toBeNull()
    expect(keptAuthUser({ ...user, email: '' })).toBeNull()
    expect(keptAuthUser({ ...user, name: 'x'.repeat(513) })?.name).toBeNull()
    expect(keptAuthUser({ ...user, created_at: 'not a date' })?.created_at).toBeNull()
    expect(keptAuthUser(null)).toBeNull()
  })
})

describe('the arguments a sandbox task may send', () => {
  const rows = { table: 'posts', columns: ['id', 'title'], rows: [['1', 'hello'], ['2', null]] }

  it('takes rows of text or null into a table named like a PostgreSQL table', () => {
    expect(opArgsAccepted('pg.insertRows', rows)).toBe(true)
  })

  it("refuses Backenly's own tables, names that are not names, and values that are not text", () => {
    expect(opArgsAccepted('pg.insertRows', { ...rows, table: 'users' })).toBe(false)
    expect(opArgsAccepted('pg.insertRows', { ...rows, table: 'USERS' })).toBe(false)
    expect(opArgsAccepted('pg.insertRows', { ...rows, table: '_token_blacklist' })).toBe(false)
    expect(opArgsAccepted('pg.insertRows', { ...rows, table: 'posts"; DROP SCHEMA x; --' })).toBe(false)
    expect(opArgsAccepted('pg.insertRows', { ...rows, columns: ['id', 'ti"tle'] })).toBe(false)
    expect(opArgsAccepted('pg.insertRows', { ...rows, rows: [[1, 'hello']] })).toBe(false)
    expect(opArgsAccepted('pg.insertRows', { ...rows, schema: 'workspace_other' })).toBe(false)
  })

  it('takes Firestore columns only of the types the driver makes, which reach a cast', () => {
    const ok = { table: 'posts', columns: [{ name: 'title', type: 'text', source: { kind: 'field' } }], rows: [['a']] }
    expect(opArgsAccepted('fb.insertRows', ok)).toBe(true)
    expect(opArgsAccepted('fb.insertRows', { ...ok, columns: [{ name: 'title', type: 'text); DROP TABLE x; --', source: { kind: 'field' } }] })).toBe(false)
  })

  it('takes a table to create only with declared columns, and a foreign key only as one', () => {
    const table = { name: 'posts', columns: [{ name: 'id', type: 'UUID', sqlType: 'uuid', notNull: true }] }
    expect(opArgsAccepted('pg.createTables', { tables: [table], title: 'Move in', usersTable: null })).toBe(true)
    expect(opArgsAccepted('pg.createTables', { tables: [{ ...table, name: 'users' }], title: 'Move in', usersTable: null })).toBe(false)
    expect(
      opArgsAccepted('pg.createTables', {
        tables: [{ ...table, columns: [{ name: 'author', type: 'UUID', references: { table: 'x"; --', onDelete: 'CASCADE', onUpdate: 'NO ACTION' } }] }],
        title: 'Move in',
        usersTable: null,
      }),
    ).toBe(false)
  })
})

describe('the sandbox task', () => {
  it('runs only with its three settings', () => {
    const token = newJobToken().token
    expect(workerEnv({ IMPORT_ORIGIN: 'https://backenly.com', IMPORT_JOB_ID: '6f1c2c1e-7a3b-4b9e-9f00-1c2d3e4f5a6b', IMPORT_JOB_TOKEN: token })).toEqual({
      origin: 'https://backenly.com',
      jobId: '6f1c2c1e-7a3b-4b9e-9f00-1c2d3e4f5a6b',
      token,
    })
    expect(() => workerEnv({ IMPORT_ORIGIN: 'https://backenly.com/x', IMPORT_JOB_ID: '6f1c2c1e-7a3b-4b9e-9f00-1c2d3e4f5a6b', IMPORT_JOB_TOKEN: token })).toThrow()
    expect(() => workerEnv({})).toThrow()
  })

  it('says why it stopped without the source credentials', () => {
    const secret = 's3cr3t-pa55w0rd-value'
    const said = failureOf(new Error(`password authentication failed: ${secret}`), [secret])
    expect(said.message).not.toContain(secret)
    expect(failureOf(new ImportInputError('Use the Session pooler.', 'connectionString'), [])).toMatchObject({ input: true, field: 'connectionString' })
    expect(failureOf(new ImportAborted('canceled'), [])).toMatchObject({ aborted: 'canceled' })
  })

  it('sends its progress as one patch: tables by name, in the order first met', () => {
    const merged = mergePatches(
      { phase: 'rows', tables: [{ name: 'a', sourceRows: 10, copiedRows: 1, verified: false }] },
      { tables: [{ name: 'b', sourceRows: 5, copiedRows: 0, verified: false }, { name: 'a', sourceRows: 10, copiedRows: 4, verified: false }] },
    )
    expect(merged.phase).toBe('rows')
    expect(merged.tables?.map((t) => [t.name, t.copiedRows])).toEqual([
      ['a', 4],
      ['b', 0],
    ])
  })
})
