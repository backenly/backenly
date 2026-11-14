/**
 * BOTH IMAGES CAN PARSE SQL
 * =========================
 *
 * Every read-only SQL statement (run_query, the console's SQL tab, the CLI
 * console) is checked with libpg-query, PostgreSQL's own parser built as
 * WebAssembly, before it runs (lib/mcp/read-query-ast.ts). Its loader reads
 * libpg-query.wasm from beside its own file at run time, so neither Next's
 * output tracing nor the runtime bundler can be trusted to carry the .wasm, the
 * same way neither carried esbuild's binary (esbuild-ships-in-images.spec.ts).
 * Without it the check fails closed and no read query runs at all, and CI never
 * sees that, because every CI job runs from a checkout with the whole
 * node_modules present.
 *
 * So the package stays external to both bundles, each image copies it in, and
 * each ASSERTS at build time that it parses with the PostgreSQL 16 grammar. This
 * pins all of that, and runs the assertion itself: a check that passes whether
 * or not the parser is present would be decoration.
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

const ASSERTION = /^RUN node -e ".*require\('libpg-query'\)/

/** The `node -e` program the final stage runs to prove the parser works. */
function assertion(stage: string[]): string {
  const run = stage.find(l => ASSERTION.test(l))
  if (!run) throw new Error('no libpg-query assertion in the final stage')
  return run.replace(/^RUN node -e "/, '').replace(/"$/, '')
}

describe.each(['web.Dockerfile', 'runtime.Dockerfile'])('%s', (file) => {
  const stage = finalStage(file)

  it('copies libpg-query and the package it requires into the final image', () => {
    expect(stage).toContain('COPY --from=build /src/node_modules/libpg-query ./node_modules/libpg-query')
    expect(stage).toContain('COPY --from=build /src/node_modules/@pgsql/types ./node_modules/@pgsql/types')
  })

  it('asserts after copying, so a missing parser fails the build', () => {
    const copied = stage.findIndex(l => l.includes('./node_modules/@pgsql/types'))
    const asserted = stage.findIndex(l => ASSERTION.test(l))
    expect(copied).toBeGreaterThan(-1)
    expect(asserted).toBeGreaterThan(copied)
  })

  it('has an assertion that passes where the parser loads', () => {
    const out = execFileSync(process.execPath, ['-e', assertion(stage)], { cwd: ROOT, encoding: 'utf8' })
    expect(out).toMatch(/^libpg-query 16\.\d+\.\d+ parses PostgreSQL 16 SQL in this image/)
  })

  it('has an assertion that fails where the parser does not resolve', () => {
    const dir = mkdtempSync(join(tmpdir(), 'no-libpg-query-'))
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
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

  it('pins the PostgreSQL 16 build exactly, as a runtime dependency', () => {
    // The pg16 dist-tag: libpg_query 16-5.x, the grammar RDS PostgreSQL 16 runs.
    // Exact, because a range would let the parser that guards the catalogs
    // change under a release without anyone choosing it.
    expect(pkg.dependencies?.['libpg-query']).toMatch(/^16\.\d+\.\d+$/)
    expect(pkg.devDependencies?.['libpg-query']).toBeUndefined()
  })
})

describe('the bundlers leave it external', () => {
  it('the runtime bundle requires it from node_modules', () => {
    const script = readFileSync(join(ROOT, 'scripts', 'build-runtime-bundle.mjs'), 'utf8')
    const external = /external:\s*\[([\s\S]*?)\]/.exec(script)
    expect(external?.[1]).toMatch(/'libpg-query'/)
  })

  it('Next requires it from node_modules and traces the whole package', () => {
    // Read as text: requiring next.config.js would also load its Sentry wrapper.
    const config = readFileSync(join(ROOT, 'next.config.js'), 'utf8')
    expect(config).toMatch(/serverExternalPackages:\s*\[[^\]]*'libpg-query'[^\]]*\]/)
    expect(config).toMatch(/'\/api\/\*\*\/\*':\s*\[[^\]]*'\.\/node_modules\/libpg-query\/\*\*\/\*'/)
  })

  it('the check imports it lazily, so the runtime does not compile it at boot', () => {
    const source = readFileSync(join(ROOT, 'lib', 'mcp', 'read-query-ast.ts'), 'utf8')
    expect(source).toMatch(/await import\('libpg-query'\)/)
    expect(source).not.toMatch(/^import [^\n]* from 'libpg-query'/m)
  })
})
