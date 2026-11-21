/**
 * Bundle the PostgREST host (services/pgrst-host/main.ts) into one file its
 * image runs: services/pgrst-host/Dockerfile.
 *
 *   node services/pgrst-host/build.mjs [--out dist-pgrst-host]
 *
 * The bundle may contain this directory's own modules and Node's built-ins,
 * nothing else: no package and no Backenly module outside services/pgrst-host.
 * The build fails if it would, so the host can never carry a platform client
 * or credential by accident.
 */

import * as esbuild from 'esbuild'
import { mkdirSync, rmSync, statSync } from 'fs'
import { dirname, isAbsolute, join, relative, resolve } from 'path'
import { fileURLToPath } from 'url'

const here = dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const out = resolve(argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : 'dist-pgrst-host')

rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })

const outfile = join(out, 'pgrst-host.cjs')
const result = await esbuild.build({
  absWorkingDir: here,
  entryPoints: ['main.ts'],
  outfile,
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  // No tsconfig lookup: nothing here uses path aliases.
  tsconfigRaw: '{}',
  legalComments: 'none',
  logLevel: 'warning',
  metafile: true,
})

const outside = Object.keys(result.metafile.inputs).filter((input) => {
  const path = isAbsolute(input) ? relative(here, input) : input
  return path.startsWith('..') || path.includes('node_modules')
})
if (outside.length > 0) {
  rmSync(out, { recursive: true, force: true })
  console.error(`pgrst-host: the bundle may only contain services/pgrst-host and Node built-ins; it reached ${outside.join(', ')}`)
  process.exit(1)
}

console.log(
  `pgrst-host: ${relative(process.cwd(), outfile)} (${Math.round(statSync(outfile).size / 1024)} KB, ` +
    `${Object.keys(result.metafile.inputs).length} modules)`,
)
