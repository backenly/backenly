/**
 * Read version from package.json at runtime.
 *
 * Why not embed at build time: tsc doesn't have a built-in way to inject the
 * version, and we want a single source of truth (package.json). Reading the
 * adjacent file once at startup costs nothing.
 *
 * The dist layout after `tsc` is:
 *   packages/mcp-server/
 *     package.json
 *     dist/
 *       version.js     ← __dirname here, so package.json is ../package.json
 *
 * Source layout during `tsx`/dev:
 *   packages/mcp-server/
 *     package.json
 *     src/
 *       version.ts     ← __dirname here, so also ../package.json
 *
 * Both layouts resolve to the same relative path.
 */

import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

let cached: string | null = null

export function getPackageVersion(): string {
  if (cached) return cached
  try {
    const pkgPath = join(__dirname, '..', 'package.json')
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
    cached = String(pkg.version || '0.0.0')
    return cached
  } catch {
    // If we can't read the manifest (very weird), fall back to a sentinel so
    // the user sees "0.0.0-unknown" in the banner rather than crashing boot.
    cached = '0.0.0-unknown'
    return cached
  }
}
