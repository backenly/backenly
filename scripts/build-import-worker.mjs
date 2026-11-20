/**
 * Bundle the import sandbox task (lib/import/worker/entry.ts) into one file the
 * web image carries at /opt/backenly-import/import-worker.cjs (docker/web.Dockerfile),
 * run by the task definition the web registers (lib/import/sandbox.ts).
 *
 *   node scripts/build-import-worker.mjs [--out dist-import]
 *
 * The bundle is held to the sandbox's boundary, and the build fails rather
 * than cross it:
 *   - of Backenly's own modules under @/lib, only the few the drivers read a
 *     source with are bundled (READS_SOURCES); every other one, the database
 *     client, the governed kernel, storage, becomes a stub that throws, so the
 *     task cannot reach them even by accident (a driver's destination-side code
 *     reaches them only through a destination, which in the task is remote);
 *   - the control plane's import modules (CONTROL_PLANE) may not be reached at
 *     all: one that is fails the build;
 *   - neither may @prisma/client or the AWS SDK.
 */

import * as esbuild from 'esbuild'
import { mkdirSync, rmSync, statSync } from 'fs'
import { join, resolve } from 'path'

const argv = process.argv.slice(2)
const out = argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : 'dist-import'

/** The @/lib modules a driver needs to read a source: pure code, no credentials, no clients. */
const READS_SOURCES = new Set([
  '@/lib/auth/firebase-scrypt',
  '@/lib/db/declared-foreign-key',
  '@/lib/security/outbound-guard',
  '@/lib/storage/body-limits',
  '@/lib/storage/upload-policy',
])

/** Control-plane modules: they hold or reach Backenly's own resources. */
const CONTROL_PLANE = [
  'lib/import/jobs.ts',
  'lib/import/sandbox-jobs.ts',
  'lib/import/worker-api.ts',
  'lib/import/http.ts',
  'lib/import/local-destination.ts',
  'lib/import/sandbox.ts',
].map((p) => resolve(p))

const boundary = {
  name: 'import-sandbox-boundary',
  setup(build) {
    build.onResolve({ filter: /^@\/lib\// }, (args) => {
      const spec = args.path.replace(/\.(ts|js)$/, '')
      if (READS_SOURCES.has(spec)) return { path: resolve(`${spec.slice(2)}.ts`) }
      return { path: spec, namespace: 'not-in-sandbox' }
    })
    build.onResolve({ filter: /^(@prisma\/client|@aws-sdk\/.*)$/ }, (args) => ({ path: args.path, namespace: 'not-in-sandbox' }))
    build.onLoad({ filter: /.*/, namespace: 'not-in-sandbox' }, (args) => ({
      loader: 'js',
      contents:
        `const why = ${JSON.stringify(`${args.path} is not available in the import sandbox`)};\n` +
        `module.exports = new Proxy({}, { get(_t, key) { if (key === '__esModule') return true; if (typeof key === 'symbol' || key === 'then') return undefined; throw new Error(why) } });\n`,
    }))
    build.onLoad({ filter: /\.ts$/ }, (args) => {
      if (CONTROL_PLANE.includes(resolve(args.path))) {
        return { errors: [{ text: `${args.path} is control-plane code; the import sandbox must not reach it` }] }
      }
      return undefined
    })
  },
}

rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })

const outfile = join(out, 'import-worker.cjs')
const result = await esbuild.build({
  entryPoints: ['lib/import/worker/entry.ts'],
  outfile,
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  // pg loads its native binding only when asked to; the task never does.
  external: ['pg-native'],
  plugins: [boundary],
  tsconfig: 'tsconfig.json',
  legalComments: 'none',
  logLevel: 'warning',
  metafile: true,
})

const stubbed = Object.keys(result.metafile.inputs).filter((p) => p.startsWith('not-in-sandbox:'))
console.log(`import worker: ${outfile} (${Math.round(statSync(outfile).size / 1024)} KB); stubbed: ${stubbed.length ? stubbed.map((p) => p.slice('not-in-sandbox:'.length)).join(', ') : 'none'}`)
