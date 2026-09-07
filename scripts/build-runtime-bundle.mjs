/**
 * Bundle the Runtime server for its container.
 *
 * Production on Hetzner runs `tsx server/index.ts`, which needs the TypeScript
 * sources, a 1.3 GB node_modules and a compiler at boot. That is the wrong
 * shape for a 0.25 vCPU / 512 MB ECS task: it pays compile cost on every cold
 * start and carries build tooling into a runtime image.
 *
 * Output is ESM with code splitting, and both of those are load-bearing:
 *
 *   splitting  The Runtime reaches the AI executor, object storage, sharp,
 *              OpenAI and Next only through dynamic import() on paths it never
 *              takes. Split, they land in chunks that are present but never
 *              loaded and the eager entry is ~1.4 MB. Bundled into one CJS
 *              file it is ~12 MB AND crashes at boot, because sharp's native
 *              initialiser runs at module scope.
 *
 *   banner     Bundled CJS dependencies (mongodb, pg) call require() for Node
 *              builtins at module scope. ESM has no require, and esbuild's own
 *              shim throws `Dynamic require of "timers" is not supported`.
 *              createRequire gives them a real one.
 *
 * @prisma/client stays external: it is generated code paired with a
 * platform-specific query engine binary, so it is installed in the image
 * rather than inlined.
 *
 * Aliases (@/* and @cloud/*) come from tsconfig.server.json, so a COMPOSED
 * checkout resolves @cloud/* to the private overlay and a public one falls
 * back to lib/edition/oss — the same resolution order the app itself uses.
 */
import * as esbuild from 'esbuild'
import { mkdirSync } from 'fs'

const outdir = process.env.RUNTIME_BUNDLE_DIR || 'dist-runtime'
mkdirSync(outdir, { recursive: true })

const result = await esbuild.build({
  entryPoints: ['server/index.ts'],
  outdir,
  bundle: true,
  splitting: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  outExtension: { '.js': '.mjs' },
  sourcemap: false,
  minify: false,
  legalComments: 'none',
  logLevel: 'warning',
  metafile: true,
  tsconfig: 'tsconfig.server.json',
  banner: {
    js: [
      "import { createRequire as __createRequire } from 'module';",
      "import { fileURLToPath as __fileURLToPath } from 'url';",
      "import { dirname as __dirnameOf } from 'path';",
      'const require = __createRequire(import.meta.url);',
      'const __filename = __fileURLToPath(import.meta.url);',
      'const __dirname = __dirnameOf(__filename);',
    ].join(' '),
  },
  external: [
    '@prisma/client',
    '.prisma/client',
    'prisma',
    'pg-native',
    // Optional native accelerators pulled in transitively. Absent at runtime,
    // and every require of them is already guarded.
    'bufferutil',
    'utf-8-validate',
  ],
})

const entry = Object.entries(result.metafile.outputs).find(([f]) => /index\.mjs$/.test(f))
let total = 0
for (const o of Object.values(result.metafile.outputs)) total += o.bytes

console.log(`[runtime-bundle] modules      ${Object.keys(result.metafile.inputs).length}`)
console.log(`[runtime-bundle] chunks       ${Object.keys(result.metafile.outputs).length}`)
console.log(`[runtime-bundle] eager entry  ${entry ? entry[1].bytes : 0} bytes`)
console.log(`[runtime-bundle] all chunks   ${total} bytes`)

if (!entry) {
  console.error('[runtime-bundle] FAILED: no index.mjs entry produced')
  process.exit(1)
}
