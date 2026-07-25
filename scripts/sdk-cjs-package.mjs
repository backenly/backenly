/**
 * Mark the CJS build output as CommonJS.
 *
 * `packages/sdk/package.json` declares `"type": "module"`, which makes every
 * `.js` file under the package ESM by default — including the CommonJS build.
 * Node would then throw `Cannot use import statement outside a module` (or its
 * mirror image) the moment a `require("@backenly/sdk")` resolved into
 * `dist/cjs/`.
 *
 * The fix Node sanctions is a nested package.json that overrides `type` for that
 * subtree only. One file, three lines, and the dual build is correct for
 * bundlers, for `require`, and for TypeScript's `node16`/`bundler` resolution.
 */

import { writeFileSync, existsSync, mkdirSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CJS_DIR = path.join(ROOT, 'packages', 'sdk', 'dist', 'cjs')

if (!existsSync(CJS_DIR)) mkdirSync(CJS_DIR, { recursive: true })

writeFileSync(
  path.join(CJS_DIR, 'package.json'),
  `${JSON.stringify({ type: 'commonjs' }, null, 2)}\n`,
  'utf8',
)

console.log('✔ dist/cjs/package.json written ({ "type": "commonjs" })')
