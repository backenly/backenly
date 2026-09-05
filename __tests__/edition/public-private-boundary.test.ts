/**
 * The structural boundary: what public source is allowed to import.
 *
 * Every seam in Phase 6 can be undone by one import. Re-adding
 * `from '@/lib/trust/email-trust'` to a public route compiles, passes every
 * behavioural test, works perfectly in Cloud, and quietly recouples the public
 * product to a module that is leaving the repository. Nothing else in the suite
 * notices, because nothing else is looking at the import graph.
 *
 * So this looks at the import graph.
 *
 * It reads TRACKED files via git rather than walking the filesystem, so build
 * output, node_modules and a stray local scratch file cannot produce a finding,
 * and a file that is not tracked cannot hide one.
 */
import { execFileSync } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'

const ROOT = process.cwd()

/** Tracked source files, excluding the ones allowed to hold the seam. */
function trackedSources(exclude: string[]): string[] {
  const out = execFileSync(
    'git',
    ['ls-files', '*.ts', '*.tsx'],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  )
  return out
    .split(/\r?\n/)
    .filter(Boolean)
    .map((p) => p.replace(/\\/g, '/'))
    .filter((p) => !exclude.some((e) => p === e || p.startsWith(e)))
}

/** Import/require/dynamic-import specifiers in a file. */
function specifiersIn(file: string): string[] {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8')
  const found: string[] = []
  const re = /(?:from|import|require)\s*\(?\s*['"]([^'"]+)['"]/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) found.push(m[1])
  return found
}

function importersOf(prefix: string, exclude: string[]): string[] {
  return trackedSources(exclude).filter((f) =>
    specifiersIn(f).some((s) => s === prefix || s.startsWith(prefix + '/')),
  )
}

describe('public source does not import the private back office', () => {
  it('nothing public imports @/lib/trust', () => {
    // app/api/users/route.ts is founder-only platform administration and moves
    // to the private overlay with lib/trust itself, so a private-to-private
    // import is correct there and does not need a seam.
    const allowed = [
      'lib/trust/',
      'lib/edition/oss/', // the Cloud provider fallback, which is what the seam is
      'app/api/users/route.ts',
      '__tests__/',
      'tests/',
    ]
    expect(importersOf('@/lib/trust', allowed)).toEqual([])
  })

  it('nothing public imports the founder analytics logger', () => {
    const allowed = ['lib/analytics/', 'lib/edition/oss/', '__tests__/', 'tests/']
    expect(importersOf('@/lib/analytics/logger', allowed)).toEqual([])
  })

  it('nothing public imports the Amplitude component directly', () => {
    // app/layout.tsx is public and single-copy, so it must reach the mount
    // through the overlay-first alias rather than naming the component.
    const allowed = ['components/app/AmplitudeAnalytics.tsx', 'lib/cloud/', '__tests__/', 'tests/', 'scripts/']
    expect(importersOf('@/components/app/AmplitudeAnalytics', allowed)).toEqual([])
  })

  it('nothing public imports the founder control writer', () => {
    // Reading and enforcing a kill switch is public. Backenly's admin mutation
    // surface is not, and its only caller is the admin console.
    const allowed = ['lib/platform/', 'app/api/admin/', '__tests__/', 'tests/']
    expect(importersOf('@/lib/platform/controls', allowed)).toEqual([])
  })
})

describe('the public layout reaches analytics through the alias', () => {
  it('imports @cloud/analytics-mount, not the implementation', () => {
    const src = fs.readFileSync(path.join(ROOT, 'app/layout.tsx'), 'utf8')

    expect(src).toContain("@cloud/analytics-mount")
    expect(src).not.toContain('components/app/AmplitudeAnalytics')
  })

  it('the OSS mount renders nothing', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { CloudAnalyticsMount } = require('@/lib/edition/oss/analytics-mount')
    expect(CloudAnalyticsMount()).toBeNull()
  })
})

describe('the @cloud alias covers every seam it is asked to', () => {
  it('every @cloud/* specifier has an OSS fallback file', () => {
    // A seam whose fallback is missing builds in composed Cloud and fails only
    // in a public checkout, which is the one place nobody runs it first.
    const specs = new Set<string>()
    for (const f of trackedSources(['__tests__/', 'tests/'])) {
      for (const s of specifiersIn(f)) {
        if (s.startsWith('@cloud/')) specs.add(s.slice('@cloud/'.length))
      }
    }

    expect(specs.size).toBeGreaterThan(0)
    const missing = [...specs].filter(
      (name) =>
        !['.ts', '.tsx'].some((ext) => fs.existsSync(path.join(ROOT, 'lib/edition/oss', name + ext))),
    )
    expect(missing).toEqual([])
  })
})
