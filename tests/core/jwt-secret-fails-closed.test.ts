/**
 * SIGNING SECRETS FAIL CLOSED
 * ===========================
 * This repository is public. Eight sites resolved their signing key as
 * `process.env.JWT_SECRET || 'your-secret-key-change-in-production'`, so any
 * environment missing the variable would sign AND VERIFY tokens with a string
 * anyone can read on GitHub — a forged token would have been accepted as real.
 *
 * The grep test is the important one: it is what stops the pattern reappearing
 * in a file nobody thought to check.
 */

import fs from 'fs'
import path from 'path'
import { requireJwtSecret, requirePreviewTokenSecret, jwtSecretStatus } from '@/lib/auth/jwt-secret'

const REPO = path.resolve(__dirname, '../..')
const SCAN_DIRS = ['app', 'lib', 'server']
const SKIP_FILE = path.join('lib', 'auth', 'jwt-secret.ts') // documents the pattern

function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.next') continue
      walk(full, out)
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      out.push(full)
    }
  }
  return out
}

describe('no published default signing secret anywhere in the tree', () => {
  it('has no `SECRET || "literal"` fallback', () => {
    const offenders: string[] = []
    for (const dir of SCAN_DIRS) {
      for (const file of walk(path.join(REPO, dir))) {
        const rel = path.relative(REPO, file)
        if (rel === SKIP_FILE) continue
        const src = fs.readFileSync(file, 'utf8')
        // `process.env.<ANYTHING>SECRET ... || '<literal>'` on one line
        const re = /process\.env\.[A-Z_]*SECRET[A-Z_]*\s*(\?\?|\|\|)\s*(process\.env\.[A-Z_]+\s*(\?\?|\|\|)\s*)?['"][^'"]+['"]/g
        for (const m of src.matchAll(re)) {
          const line = src.slice(0, m.index ?? 0).split('\n').length
          offenders.push(`${rel}:${line} -> ${m[0].slice(0, 90)}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('has no known placeholder secret used as a real value', () => {
    const banned = ['your-secret-key', 'preview-secret-change-in-production', 'change-in-production']
    const offenders: string[] = []
    for (const dir of SCAN_DIRS) {
      for (const file of walk(path.join(REPO, dir))) {
        const rel = path.relative(REPO, file)
        if (rel === SKIP_FILE) continue
        const src = fs.readFileSync(file, 'utf8')
        for (const b of banned) {
          if (!src.includes(b)) continue
          for (const [i, line] of src.split('\n').entries()) {
            if (!line.includes(b)) continue
            // A placeholder inside generated .env EXAMPLE text is fine — it is
            // documentation for a value the developer supplies. A placeholder
            // being ASSIGNED to a secret variable is not.
            if (/^[^=]*JWT_SECRET=\S+/.test(line.trim())) continue
            if (/(\|\||\?\?)\s*['"]/.test(line)) {
              offenders.push(`${rel}:${i + 1} -> ${line.trim().slice(0, 90)}`)
            }
          }
        }
      }
    }
    expect(offenders).toEqual([])
  })
})

describe('requireJwtSecret refuses rather than defaulting', () => {
  const saved = process.env.JWT_SECRET
  const savedPreview = process.env.PREVIEW_TOKEN_SECRET
  afterEach(() => {
    if (saved === undefined) delete process.env.JWT_SECRET
    else process.env.JWT_SECRET = saved
    if (savedPreview === undefined) delete process.env.PREVIEW_TOKEN_SECRET
    else process.env.PREVIEW_TOKEN_SECRET = savedPreview
  })

  it('throws when unset', () => {
    delete process.env.JWT_SECRET
    expect(() => requireJwtSecret('sign a test token')).toThrow(/JWT_SECRET is not set/)
  })

  it('throws when empty or whitespace', () => {
    process.env.JWT_SECRET = '   '
    expect(() => requireJwtSecret()).toThrow(/is not set/)
  })

  it('throws on a short, low-entropy secret', () => {
    process.env.JWT_SECRET = 'short'
    expect(() => requireJwtSecret()).toThrow(/only 5 characters/)
  })

  it('returns a valid secret unchanged', () => {
    const good = 'x'.repeat(48)
    process.env.JWT_SECRET = good
    expect(requireJwtSecret()).toBe(good)
  })

  it('preview tokens prefer their own secret but never a constant', () => {
    process.env.JWT_SECRET = 'j'.repeat(40)
    process.env.PREVIEW_TOKEN_SECRET = 'p'.repeat(40)
    expect(requirePreviewTokenSecret()).toBe('p'.repeat(40))
    delete process.env.PREVIEW_TOKEN_SECRET
    expect(requirePreviewTokenSecret()).toBe('j'.repeat(40))
    delete process.env.JWT_SECRET
    expect(() => requirePreviewTokenSecret()).toThrow(/is not set/)
  })

  it('jwtSecretStatus reports without throwing, for readiness surfaces', () => {
    delete process.env.JWT_SECRET
    expect(jwtSecretStatus()).toEqual({ configured: false, tooShort: false })
    process.env.JWT_SECRET = 'short'
    expect(jwtSecretStatus()).toEqual({ configured: true, tooShort: true })
    process.env.JWT_SECRET = 'y'.repeat(40)
    expect(jwtSecretStatus()).toEqual({ configured: true, tooShort: false })
  })
})

describe('generated customer backends refuse to boot without a secret', () => {
  it('the server template throws instead of defaulting', () => {
    const tpl = fs.readFileSync(path.join(REPO, 'lib/templates/server.template.ts'), 'utf8')
    expect(tpl).not.toContain("process.env.JWT_SECRET || 'your-secret-key'")
    // Every generated JWT_SECRET declaration is followed by a hard guard.
    const decls = tpl.match(/const JWT_SECRET = process\.env\.JWT_SECRET;/g) ?? []
    expect(decls.length).toBeGreaterThan(0)
    const guards = tpl.match(/if \(!JWT_SECRET \|\| JWT_SECRET\.length < 32\) \{/g) ?? []
    expect(guards.length).toBe(decls.length)
  })
})
