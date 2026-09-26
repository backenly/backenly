/**
 * BOTH IMAGES CAN COMPILE A FUNCTION
 * ==================================
 *
 * Route-module functions are TypeScript, compiled with esbuild when they are
 * deployed (validateRouteModule, in the web process) and again on every
 * invocation (executeRouteModuleFunction, in the runtime). esbuild is a native
 * binary, so lib/services/ai-functions/route-module-runner.ts loads it through a
 * require that neither Next's output tracing nor the runtime bundler can see.
 * Neither image carried it. Measured on AWS staging 2026-09-26 with the MCP
 * harness: deploy_code answered "Compile error: Cannot find module 'esbuild'",
 * and `require('esbuild')` failed inside the web, runtime and production v7
 * images alike. CI never saw it, because every CI job runs from a checkout with
 * the whole node_modules present.
 *
 * So each image copies esbuild in explicitly and ASSERTS at build time that it
 * compiles TypeScript. This pins both halves, and runs the assertion itself: a
 * check that passes whether or not esbuild is present would be decoration.
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(__dirname, '..', '..')

/** The lines of a Dockerfile's final stage: everything after its last FROM. */
function finalStage(file: string): string[] {
  const lines = readFileSync(join(ROOT, 'docker', file), 'utf8').split(/\r?\n/)
  const from = lines.map((l, i) => (/^FROM\s/.test(l) ? i : -1)).filter(i => i >= 0).pop()
  if (from === undefined) throw new Error(`${file} has no FROM`)
  return lines.slice(from)
}

/** The `node -e` program the final stage runs to prove esbuild works. */
function assertion(stage: string[]): string {
  const run = stage.find(l => /^RUN node -e ".*require\('esbuild'\)/.test(l))
  if (!run) throw new Error('no esbuild assertion in the final stage')
  return run.replace(/^RUN node -e "/, '').replace(/"$/, '')
}

describe.each(['web.Dockerfile', 'runtime.Dockerfile'])('%s', (file) => {
  const stage = finalStage(file)

  it('copies esbuild and its platform binary into the final image', () => {
    expect(stage).toContain('COPY --from=build /src/node_modules/esbuild ./node_modules/esbuild')
    expect(stage).toContain('COPY --from=build /src/node_modules/@esbuild ./node_modules/@esbuild')
  })

  it('asserts after copying, so a missing binary fails the build', () => {
    const copied = stage.findIndex(l => l.includes('./node_modules/@esbuild'))
    const asserted = stage.findIndex(l => /^RUN node -e ".*require\('esbuild'\)/.test(l))
    expect(copied).toBeGreaterThan(-1)
    expect(asserted).toBeGreaterThan(copied)
  })

  it('has an assertion that passes where esbuild resolves', () => {
    const out = execFileSync(process.execPath, ['-e', assertion(stage)], { cwd: ROOT, encoding: 'utf8' })
    expect(out).toMatch(/^esbuild \d+\.\d+\.\d+ compiles TypeScript in this image/)
  })

  it('has an assertion that fails where esbuild does not resolve', () => {
    const dir = mkdtempSync(join(tmpdir(), 'no-esbuild-'))
    try {
      expect(() =>
        execFileSync(process.execPath, ['-e', assertion(stage)], {
          cwd: dir,
          env: { ...process.env, NODE_PATH: '' },
          stdio: 'pipe',
        }),
      ).toThrow()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('package.json', () => {
  it('declares esbuild as a runtime dependency, not a dev one', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
    expect(pkg.dependencies?.esbuild).toBeTruthy()
    expect(pkg.devDependencies?.esbuild).toBeUndefined()
  })
})
