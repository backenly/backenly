/**
 * The deploy guard must refuse, and must refuse for the right reason.
 *
 * A guard that rejects everything is as useless as one that accepts
 * everything, so every refusal below is paired with an accept that differs by
 * exactly the condition under test. Each case builds a synthetic composed
 * checkout in a temp git repository: `overlay-allowlist.json` is what
 * findRepoRoot() looks for, so the script treats it as the repo root.
 *
 * The case that matters most is the pin mismatch. loadCloudExtension() happily
 * accepts an overlay built for a different public commit, so nothing else in
 * the codebase catches it.
 */
import { execFileSync, spawnSync } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

jest.setTimeout(120000)

const REAL_ROOT = process.cwd()
const SCRIPT = path.join(REAL_ROOT, 'scripts', 'verify-deploy-preflight.ts')
const TSX = path.join(REAL_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs')

let tmpRoot: string

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

/** A composed checkout whose manifest pin matches its own HEAD. */
function makeComposedRepo(): { dir: string; head: string } {
  const dir = fs.mkdtempSync(path.join(tmpRoot, 'repo-'))
  fs.writeFileSync(path.join(dir, 'overlay-allowlist.json'), JSON.stringify({ ownership: [] }))
  fs.mkdirSync(path.join(dir, 'lib', 'cloud'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'lib', 'cloud', 'extension.ts'), 'export const x = 1\n')

  git(dir, ['init', '-q'])
  git(dir, ['config', 'user.email', 'test@example.com'])
  git(dir, ['config', 'user.name', 'Test'])
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-q', '-m', 'base'])
  const head = git(dir, ['rev-parse', 'HEAD'])

  writeManifest(dir, head)
  return { dir, head }
}

function writeManifest(dir: string, sha: string): void {
  fs.writeFileSync(
    path.join(dir, 'lib', 'cloud', 'manifest.json'),
    JSON.stringify({ schema: 1, publicBaseSha: sha, extension: 'lib/cloud/extension.ts', capabilities: ['presence'] }),
  )
}

function run(dir: string, env: NodeJS.ProcessEnv, args: string[] = []) {
  // cwd stays the real repo so tsx resolves this project's tsconfig; the
  // checkout under test is named with --root.
  const child = spawnSync(process.execPath, [TSX, SCRIPT, '--root', dir, ...args], {
    cwd: REAL_ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  })
  return { code: child.status, out: (child.stdout || '') + (child.stderr || '') }
}

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-'))
})
afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true })
})

describe('accepts only a correctly composed, correctly pinned Cloud deploy', () => {
  it('accepts when everything holds', () => {
    const { dir } = makeComposedRepo()
    // The manifest is untracked at this point, which is what a real composed
    // release looks like; only TRACKED modifications are a dirty tree.
    const r = run(dir, { BACKENLY_EDITION: 'cloud' })
    expect(r.out).toContain('ACCEPTED')
    expect(r.code).toBe(0)
  })
})

describe('refuses an unsafe deploy, and says which check failed', () => {
  it('refuses when BACKENLY_EDITION is unset', () => {
    const { dir } = makeComposedRepo()
    const env = { ...process.env }
    delete env.BACKENLY_EDITION
    const child = spawnSync(process.execPath, [TSX, SCRIPT, '--root', dir], { cwd: REAL_ROOT, encoding: 'utf8', env })
    const out = (child.stdout || '') + (child.stderr || '')
    expect(child.status).toBe(1)
    expect(out).toContain('REFUSING DEPLOY')
    expect(out).toMatch(/UNSET/)
  })

  it('refuses an explicit single-tenant edition on a Cloud host', () => {
    const { dir } = makeComposedRepo()
    const r = run(dir, { BACKENLY_EDITION: 'single-tenant' })
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/REFUSE.*edition is explicitly cloud/s)
  })

  it('refuses when the overlay was never applied', () => {
    const { dir } = makeComposedRepo()
    fs.rmSync(path.join(dir, 'lib', 'cloud', 'manifest.json'))
    const r = run(dir, { BACKENLY_EDITION: 'cloud' })
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/overlay was never applied|does not exist/)
  })

  it('refuses an overlay pinned to a DIFFERENT public commit', () => {
    // The check nothing else performs: this manifest is structurally valid and
    // names a module that exists, so loadCloudExtension() reports it present.
    const { dir } = makeComposedRepo()
    writeManifest(dir, '0'.repeat(40))
    const r = run(dir, { BACKENLY_EDITION: 'cloud' })
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/different public commit/)
  })

  it('refuses when a tracked file has been modified', () => {
    const { dir } = makeComposedRepo()
    fs.writeFileSync(path.join(dir, 'lib', 'cloud', 'extension.ts'), 'export const x = 2\n')
    const r = run(dir, { BACKENLY_EDITION: 'cloud' })
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/tracked file\(s\) modified/)
  })

  it('refuses when the private PUBLIC_BASE_SHA disagrees', () => {
    const { dir } = makeComposedRepo()
    const priv = fs.mkdtempSync(path.join(tmpRoot, 'private-'))
    fs.writeFileSync(path.join(priv, 'PUBLIC_BASE_SHA'), '0'.repeat(40) + '\n')
    const r = run(dir, { BACKENLY_EDITION: 'cloud' }, ['--private-root', priv])
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/PUBLIC_BASE_SHA .* != HEAD/)
  })

  it('accepts when the private PUBLIC_BASE_SHA agrees', () => {
    const { dir, head } = makeComposedRepo()
    const priv = fs.mkdtempSync(path.join(tmpRoot, 'private-ok-'))
    fs.writeFileSync(path.join(priv, 'PUBLIC_BASE_SHA'), head + '\n')
    const r = run(dir, { BACKENLY_EDITION: 'cloud' }, ['--private-root', priv])
    expect(r.out).toContain('ACCEPTED')
    expect(r.code).toBe(0)
  })

  it('exits 2 on a usage error rather than pretending to pass', () => {
    const { dir } = makeComposedRepo()
    const r = run(dir, { BACKENLY_EDITION: 'cloud' }, ['--nonsense'])
    expect(r.code).toBe(2)
  })
})
