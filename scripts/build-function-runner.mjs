/**
 * Build what an image needs to run function code in processes of its own.
 *
 *   <out>/function-runner.cjs      the runner, bundled with what it loads (pg,
 *                                  jsonwebtoken, bcryptjs), so it needs nothing
 *                                  from the app's own node_modules
 *   <out>/function-supervisor.cjs  the root supervisor (node built-ins only)
 *   <out>/node_modules/            the packages a sandbox body may ctx.require()
 *                                  (pdfkit, csv-parse, date-fns, qrcode,
 *                                  nodemailer, archiver) and their dependencies,
 *                                  at the versions package-lock.json pins
 *
 * Both images copy <out> to /opt/backenly-fn. It has to be self-contained:
 * the uids function code runs as cannot traverse /app (0750 root:node), so the
 * runner cannot load anything from the app's tree, and the app's tree is where
 * EFS volumes holding every project's files are mounted.
 *
 *   node scripts/build-function-runner.mjs [--out dist-fn] [--no-packages]
 *
 * Source: lib/services/ai-functions/isolation/.
 */
import * as esbuild from 'esbuild'
import { cpSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'

const argv = process.argv.slice(2)
const out = argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : 'dist-fn'
const withPackages = !argv.includes('--no-packages')
const SOURCE = 'lib/services/ai-functions/isolation'

/** What a sandbox body may ctx.require(); the runner's WHITELISTED_PACKAGES, by package. */
const SANDBOX_PACKAGES = ['pdfkit', 'csv-parse', 'date-fns', 'qrcode', 'nodemailer', 'archiver']

rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })

await esbuild.build({
  entryPoints: [join(SOURCE, 'function-runner.cjs')],
  outfile: join(out, 'function-runner.cjs'),
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  legalComments: 'none',
  logLevel: 'error',
  // Never present, and never reached: pg's native and Cloudflare transports.
  // A sandbox package is required by name at run time and resolves from
  // <out>/node_modules, so the bundler leaves those requires alone.
  external: ['pg-native', 'pg-cloudflare', 'cloudflare:sockets', ...SANDBOX_PACKAGES],
})
copyFileSync(join(SOURCE, 'function-supervisor.cjs'), join(out, 'function-supervisor.cjs'))

if (withPackages) {
  const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'))
  const packages = lock.packages ?? {}

  /** Node's resolution, over the lock's paths: `name` as required from the package at `from`. */
  const resolveFrom = (from, name) => {
    let dir = from
    for (;;) {
      const candidate = `${dir ? `${dir}/` : ''}node_modules/${name}`
      if (packages[candidate] && !packages[candidate].link) return candidate
      if (!dir) return null
      const at = dir.lastIndexOf('/node_modules/')
      dir = at < 0 ? '' : dir.slice(0, at)
    }
  }

  const needed = new Set()
  const queue = []
  for (const name of SANDBOX_PACKAGES) {
    const found = resolveFrom('', name)
    if (!found) throw new Error(`package-lock.json has no ${name}; a sandbox body could not load it`)
    queue.push(found)
  }
  while (queue.length) {
    const at = queue.shift()
    if (needed.has(at)) continue
    needed.add(at)
    const entry = packages[at] ?? {}
    for (const name of Object.keys({ ...entry.dependencies, ...entry.optionalDependencies, ...entry.peerDependencies })) {
      const dep = resolveFrom(at, name)
      // An optional or peer dependency the lock did not install is not needed.
      if (dep && existsSync(dep)) queue.push(dep)
    }
  }
  for (const at of [...needed].sort()) {
    if (!existsSync(at)) throw new Error(`${at} is in package-lock.json but not installed; run npm ci first`)
    cpSync(at, join(out, at), { recursive: true, dereference: true })
  }
  console.log(`[function-runner] ${needed.size} packages for sandbox bodies`)
}

console.log(`[function-runner] built ${out}/function-runner.cjs and ${out}/function-supervisor.cjs`)
