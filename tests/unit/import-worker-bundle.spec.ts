/**
 * The import sandbox task's bundle holds to the sandbox's boundary
 * (scripts/build-import-worker.mjs): built from lib/import/worker/entry.ts, it
 * carries none of Backenly's clients (the database's, storage's, the AWS SDK)
 * and none of the control plane's import modules, and it runs only with its
 * settings. A change that pulls one of them into a driver fails here, not in
 * a sandbox in production.
 */

import { spawnSync } from 'child_process'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const out = mkdtempSync(join(tmpdir(), 'import-worker-'))
afterAll(() => rmSync(out, { recursive: true, force: true }))

it('bundles the task without Backenly clients or control-plane code', () => {
  const built = spawnSync(process.execPath, ['scripts/build-import-worker.mjs', '--out', out], { encoding: 'utf8', timeout: 120_000 })
  expect(built.status).toBe(0)
  const bundle = readFileSync(join(out, 'import-worker.cjs'), 'utf8')
  // The database client and the AWS SDK are never in it.
  expect(bundle).not.toMatch(/new PrismaClient|@prisma\/client\/runtime|ECSClient|S3Client/)
  // The control plane's modules are refused by the build itself; their markers never appear.
  expect(bundle).not.toContain('handleWorkerCall')
  expect(bundle).not.toContain('startSandboxImport')
  // Every Backenly module it does not bundle is a stub that throws if ever reached.
  expect(built.stdout).toMatch(/stubbed: .*@\/lib\/db\/prisma/)
  expect(built.stdout).not.toMatch(/stubbed: .*@\/lib\/import\//)
}, 180_000)

it('runs only with its settings, and says nothing else when they are missing', () => {
  const run = spawnSync(process.execPath, [join(out, 'import-worker.cjs')], {
    encoding: 'utf8',
    timeout: 30_000,
    env: { PATH: process.env.PATH ?? '' },
  })
  expect(run.status).toBe(64)
  expect(run.stderr).toContain('IMPORT_ORIGIN must be an origin')
})
