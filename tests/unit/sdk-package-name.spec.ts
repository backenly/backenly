import { readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'

/**
 * Every published instruction must name the package that actually resolves.
 *
 * `@backenly/sdk` is the only SDK on npm. `backenly`, `backenly-js` and
 * `backenly-sdk` are all 404s, and a reader who follows one of them cannot tell
 * "wrong name" from "product does not work" — the reported outcome was a
 * hand-written client.
 */
const ROOT = process.cwd()
const SCAN_DIRS = ['lib', 'app', 'public', 'packages/sdk/src']
const EXT = /\.(ts|tsx|txt|md)$/
const SKIP = /node_modules|\.next|[\/]dist[\/]|tests?[\/]/

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[]
  try { entries = readdirSync(dir) } catch { return out }
  for (const e of entries) {
    const p = join(dir, e)
    if (SKIP.test(p)) continue
    let st
    try { st = statSync(p) } catch { continue }
    if (st.isDirectory()) walk(p, out)
    else if (EXT.test(p)) out.push(p)
  }
  return out
}

const FILES = SCAN_DIRS.flatMap((d) => walk(join(ROOT, d)))

/** An import or install naming a package that is not published. */
const DEAD_NAME =
  /(?:from\s+['"](backenly|backenly-js|backenly-sdk)['"]|npm\s+(?:install|i)\s+(backenly|backenly-js|backenly-sdk)(?![\w/-]))/

describe('published SDK instructions name the package that resolves (#9)', () => {
  it('scans a meaningful number of files', () => {
    expect(FILES.length).toBeGreaterThan(50)
  })

  it('no file tells a reader to import or install an unpublished package name', () => {
    const offenders: string[] = []
    for (const f of FILES) {
      const text = readFileSync(f, 'utf8')
      for (const [i, line] of text.split('\n').entries()) {
        if (DEAD_NAME.test(line)) {
          offenders.push(`${f.replace(ROOT, '.')}:${i + 1}  ${line.trim().slice(0, 110)}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('the SDK package is actually called @backenly/sdk', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'packages/sdk/package.json'), 'utf8'))
    expect(pkg.name).toBe('@backenly/sdk')
    expect(pkg.exports?.['./supabase']).toBeDefined()
  })
})
