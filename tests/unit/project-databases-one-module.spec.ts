/**
 * A DATABASE IS CREATED OR DROPPED IN ONE MODULE ONLY
 * ===================================================
 * scripts/verify-project-provisioning.ts (CI: "One creation path for
 * projects") keeps CREATE DATABASE and DROP DATABASE in application code to
 * lib/data-plane/project-databases.ts. The path it replaced created a database
 * per workspace on the platform's own connection and wrote the connection
 * string into Workspace.postgresSchema.
 *
 * A guard nobody has watched fail is not known to work, so every case here
 * runs the real script against a small tree of its own (--root).
 */
import { spawnSync } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

jest.setTimeout(60_000)

const ROOT = process.cwd()
const GUARD = 'scripts/verify-project-provisioning.ts'

function guardOn(files: Record<string, string>): { status: number; out: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'project-databases-guard-'))
  try {
    for (const [rel, body] of Object.entries(files)) {
      const full = path.join(dir, rel)
      fs.mkdirSync(path.dirname(full), { recursive: true })
      fs.writeFileSync(full, body)
    }
    const res = spawnSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', GUARD, '--root', dir], {
      cwd: ROOT,
      encoding: 'utf8',
    })
    return { status: res.status ?? -1, out: `${res.stdout ?? ''}${res.stderr ?? ''}` }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

/** The removed path's shape: a template literal on a pg client, the name interpolated. */
const CREATES_A_DATABASE = [
  "import { Client } from 'pg'",
  'export async function make(client: Client, name: string) {',
  '  await client.query(`CREATE DATABASE "${name}" WITH ENCODING = \'UTF8\'`)',
  '}',
  '',
].join('\n')

describe('verify-project-provisioning: databases', () => {
  it('refuses a database created anywhere else in application code, naming the file and line', () => {
    const { status, out } = guardOn({ 'lib/db/workspace-databases.ts': CREATES_A_DATABASE })
    expect(status).toBe(1)
    expect(out).toContain('lib/db/workspace-databases.ts:3')
  })

  it('lets the one module do it', () => {
    const { status, out } = guardOn({ 'lib/data-plane/project-databases.ts': CREATES_A_DATABASE })
    expect(out).toContain('created and dropped in one module only')
    expect(status).toBe(0)
  })

  it('counts dropping too, in any case and spacing, in plain strings, in app, lib/workspace and server', () => {
    const { status, out } = guardOn({
      'app/api/things/route.ts': "export const sql = 'drop database if exists things'\n",
      'lib/workspace/reset.ts': 'export const sql = "Create  Database scratch"\n',
      'server/lib/cleanup.cjs': "module.exports = { sql: 'DROP\\tDATABASE old' }\n",
    })
    expect(status).toBe(1)
    expect(out).toContain('app/api/things/route.ts:1')
    expect(out).toContain('lib/workspace/reset.ts:1')
    expect(out).toContain('server/lib/cleanup.cjs:1')
  })

  it('does not count a comment that names it', () => {
    const { status } = guardOn({
      'lib/notes.ts': [
        '// CREATE DATABASE cannot run inside a transaction block',
        '/* DROP DATABASE needs the owner */',
        "export const label = 'Create an index on the database'",
        '',
      ].join('\n'),
    })
    expect(status).toBe(0)
  })

  it('leaves tests and scripts alone: they build scratch databases', () => {
    const { status } = guardOn({
      'tests/integration/fixture.spec.ts': CREATES_A_DATABASE,
      'scripts/setup-test-db.ts': CREATES_A_DATABASE,
    })
    expect(status).toBe(0)
  })

  it('calls the allowance stale once that module creates and drops nothing', () => {
    const { status, out } = guardOn({ 'lib/data-plane/project-databases.ts': 'export const nothing = 1\n' })
    expect(status).toBe(1)
    expect(out).toContain('no longer used')
    expect(out).toContain('lib/data-plane/project-databases.ts')
  })
})
