/**
 * WORKSPACE_DIR must move every workspace reader and writer together.
 *
 * Roughly twenty call sites each computed `path.join(process.cwd(), 'workspace',
 * projectId)` independently, and only lib/projects/purge.ts honoured
 * WORKSPACE_DIR. Its own comment recorded what that asymmetry meant: setting the
 * variable in a real deployment would aim project deletion at a directory
 * nothing writes to. So the override existed but could not safely be used, and
 * the location was pinned to the current working directory.
 *
 * `process.cwd()` is the wrong anchor regardless. The Next standalone server
 * calls `process.chdir(__dirname)`, so the same code resolves a different
 * directory under `next dev`, under the standalone bundle, and under tsx. That
 * is exactly how workspace backups ended up stranded in
 * `.next/standalone/backups`.
 *
 * These tests pin the contract that makes WORKSPACE_DIR=/app/workspace safe:
 * every writer and the cleanup agree, and nothing touches cwd/workspace when
 * the override is set.
 */
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import { generatePrismaSchema } from '@/lib/execution/schema-writer'
import { purgeProjectExternals } from '@/lib/projects/purge'
import { projectWorkspaceDir, workspaceRoot } from '@/lib/workspace/paths'

const PROJECT_A = '11111111-1111-4111-8111-111111111111'
const PROJECT_B = '22222222-2222-4222-8222-222222222222'

const saved = {
  WORKSPACE_DIR: process.env.WORKSPACE_DIR,
  BACKUP_DIR: process.env.BACKUP_DIR,
  STORAGE_DIR: process.env.STORAGE_DIR,
  STORAGE_DRIVER: process.env.STORAGE_DRIVER,
}

let tmp: string

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-contract-'))
  process.env.WORKSPACE_DIR = path.join(tmp, 'workspace')
  // Keep purge's other roots inside the temp tree too, so nothing it does can
  // reach a real directory.
  process.env.BACKUP_DIR = path.join(tmp, 'backups')
  process.env.STORAGE_DIR = path.join(tmp, 'storage')
  process.env.STORAGE_DRIVER = 'local'
})

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  fs.rmSync(tmp, { recursive: true, force: true })
})

/**
 * A minimal graph the schema writer accepts. `entities` and `fields` are both
 * Records keyed by name, not arrays — an array fixture silently produces
 * `model 0`, which is how it can look like it worked.
 */
function graphWith(entity: string) {
  return {
    entities: {
      [entity]: { fields: { title: { type: 'String', required: true } } },
    },
  } as any
}

describe('the resolver', () => {
  it('uses WORKSPACE_DIR when set', () => {
    expect(workspaceRoot()).toBe(path.resolve(path.join(tmp, 'workspace')))
    expect(projectWorkspaceDir(PROJECT_A)).toBe(
      path.join(path.resolve(path.join(tmp, 'workspace')), PROJECT_A),
    )
  })

  it('falls back to cwd/workspace when WORKSPACE_DIR is unset', () => {
    delete process.env.WORKSPACE_DIR
    expect(workspaceRoot()).toBe(path.join(process.cwd(), 'workspace'))
  })

  it('ignores an empty or whitespace WORKSPACE_DIR rather than resolving to /', () => {
    process.env.WORKSPACE_DIR = '   '
    expect(workspaceRoot()).toBe(path.join(process.cwd(), 'workspace'))
  })

  it('resolves a relative WORKSPACE_DIR to an absolute path', () => {
    process.env.WORKSPACE_DIR = 'rel-workspace'
    expect(path.isAbsolute(workspaceRoot())).toBe(true)
  })

  it('is read per call, so a later change takes effect', () => {
    const first = workspaceRoot()
    process.env.WORKSPACE_DIR = path.join(tmp, 'moved')
    expect(workspaceRoot()).not.toBe(first)
  })
})

describe('writers honour the override', () => {
  it('the schema writer writes under WORKSPACE_DIR', async () => {
    const result = await generatePrismaSchema(graphWith('post'), PROJECT_A)
    expect(result.success).toBe(true)

    const expected = path.join(projectWorkspaceDir(PROJECT_A), 'prisma', 'schema.prisma')
    expect(result.schemaPath).toBe(expected)
    expect(fs.existsSync(expected)).toBe(true)
    expect(fs.readFileSync(expected, 'utf-8')).toContain('Post')
  })

  it('does not write into cwd/workspace when the override is set', async () => {
    const cwdWorkspace = path.join(process.cwd(), 'workspace', PROJECT_A)
    const existedBefore = fs.existsSync(cwdWorkspace)

    await generatePrismaSchema(graphWith('note'), PROJECT_A)

    expect(fs.existsSync(cwdWorkspace)).toBe(existedBefore)
    expect(fs.existsSync(path.join(projectWorkspaceDir(PROJECT_A), 'prisma'))).toBe(true)
  })
})

describe('purge deletes the same directory the writers created', () => {
  it('removes the project workspace under WORKSPACE_DIR', async () => {
    await generatePrismaSchema(graphWith('post'), PROJECT_A)
    const dir = projectWorkspaceDir(PROJECT_A)
    expect(fs.existsSync(dir)).toBe(true)

    const report = await purgeProjectExternals(PROJECT_A)

    expect(report.workspace).toBe('purged')
    expect(fs.existsSync(dir)).toBe(false)
  })

  it('leaves every other project untouched', async () => {
    await generatePrismaSchema(graphWith('post'), PROJECT_A)
    await generatePrismaSchema(graphWith('user'), PROJECT_B)

    await purgeProjectExternals(PROJECT_A)

    expect(fs.existsSync(projectWorkspaceDir(PROJECT_A))).toBe(false)
    expect(fs.existsSync(projectWorkspaceDir(PROJECT_B))).toBe(true)
    expect(
      fs.existsSync(path.join(projectWorkspaceDir(PROJECT_B), 'prisma', 'schema.prisma')),
    ).toBe(true)
  })

  it('reports an absent workspace as already purged rather than failing', async () => {
    const report = await purgeProjectExternals(PROJECT_B)
    expect(report.workspace).toBe('alreadyAbsent')
  })
})

describe('every workspace module resolves through the shared helper', () => {
  // A module that rebuilt the path itself would silently keep writing to
  // cwd/workspace under a configured deployment, which is the whole defect.
  const MODULES = [
    'app/api/database/setup-workspace/route.ts',
    'app/api/workspace/download/route.ts',
    'app/api/workspace/files/content/route.ts',
    'app/api/workspace/files/route.ts',
    'lib/ai/execution-engine.ts',
    'lib/ai/execution-journal.ts',
    'lib/execution/schema-writer.ts',
    'lib/projects/purge.ts',
    'lib/services/aiWorkspace.ts',
    'lib/services/preflight.ts',
    'lib/services/workerLifecycle.ts',
    'lib/services/workspaceAuth.ts',
    'lib/services/workspaceDatabaseSetup.ts',
    'lib/services/workspaceOAuth.ts',
  ]

  it.each(MODULES)('%s imports the shared resolver', (rel) => {
    const src = fs.readFileSync(path.join(process.cwd(), rel), 'utf-8')
    expect(src).toContain('@/lib/workspace/paths')
  })

  it.each(MODULES)('%s does not build a workspace path from process.cwd()', (rel) => {
    const src = fs.readFileSync(path.join(process.cwd(), rel), 'utf-8')
    const offenders = src
      .split('\n')
      .filter((l) => /process\.cwd\(\)/.test(l) && /['"]workspace['"]/.test(l))
    expect(offenders).toEqual([])
  })
})
