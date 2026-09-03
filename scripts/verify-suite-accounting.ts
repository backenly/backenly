#!/usr/bin/env tsx
/**
 * Prove every jest suite is accounted for exactly once.
 *
 * The suite manifests under .github/ were written when the tree held 156
 * suites. The tree grew. Nothing recomputed the arithmetic, so suites added
 * since then belong to no category at all: not on a blocking job, not in the
 * baseline, not in the excluded list with a reason. They are simply invisible,
 * which is the exact defect .github/suites-not-in-ci.txt was created to fix
 * ("they were not excluded, they were simply never named anywhere, so nothing
 * could report them missing"). A list that is not reconciled against reality
 * decays back into that state on its own.
 *
 * `jest --listTests` is the ONLY canonical set. Manifests are claims about it,
 * and this script is what makes them falsifiable:
 *
 *   union(all categories)  == canonical set
 *   every pairwise intersection == empty
 *
 * Categories resolve the same way CI selects them, by asking jest rather than
 * reimplementing its path matching, so a divergence between this script and
 * ci.yml cannot hide in a regex.
 *
 * Usage: tsx scripts/verify-suite-accounting.ts [--json]
 */
import { execFileSync } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'

const ROOT = process.cwd()

interface Category {
  key: string
  label: string
  /** How CI selects it: jest path patterns, or a manifest file. */
  patterns?: string[]
  manifest?: string
  /** Whether the job requires these to PASS, or only to not regress. */
  posture: 'must pass' | 'no new failures' | 'not run'
}

const CATEGORIES: Category[] = [
  { key: 'unit', label: 'blocking CI: tests/unit', patterns: ['tests/unit'], posture: 'must pass' },
  {
    key: 'db-free',
    label: 'blocking CI: database-free',
    manifest: '.github/database-free-suites.txt',
    posture: 'must pass',
  },
  {
    key: 'db-backed',
    label: 'blocking CI: database-backed',
    manifest: '.github/database-backed-suites.txt',
    posture: 'must pass',
  },
  { key: 'probes', label: 'blocking CI: probe fixtures', patterns: ['tests/probes'], posture: 'must pass' },
  {
    key: 'autonomy',
    label: 'blocking CI: autonomy guards',
    patterns: ['tests/core', '__tests__/autonomy'],
    posture: 'must pass',
  },
  {
    key: 'baseline',
    label: 'blocking CI: known-failure baseline',
    manifest: '.github/baseline-suites.txt',
    posture: 'no new failures',
  },
  {
    key: 'excluded',
    label: 'not run, with a stated reason',
    manifest: '.github/suites-not-in-ci.txt',
    posture: 'not run',
  },
]

/** Repo-relative, forward slashes, so Windows and Linux agree. */
function norm(p: string): string {
  const abs = p.replace(/\\/g, '/').trim()
  const root = ROOT.replace(/\\/g, '/')
  return abs.startsWith(root) ? abs.slice(root.length).replace(/^\/+/, '') : abs
}

/**
 * Invoke jest's own entrypoint through node rather than `npx ... shell: true`.
 * The shell form concatenates arguments instead of escaping them, which Node
 * warns about (DEP0190), and it would also break the moment a suite path
 * contained a space. This repository lives under "OneDrive\Desktop\Nexabackend
 * workspace", so that is not hypothetical.
 */
const JEST_BIN = path.join(ROOT, 'node_modules', 'jest', 'bin', 'jest.js')

function jestListTests(patterns: string[]): string[] {
  if (!fs.existsSync(JEST_BIN)) {
    console.error(`cannot find jest at ${path.relative(ROOT, JEST_BIN)} - run npm ci first`)
    process.exit(2)
  }
  const out = execFileSync(process.execPath, [JEST_BIN, '--listTests', ...patterns], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  // jest prints config warnings on stdout alongside the paths, and some of them
  // name a .js file ("* <rootDir>/tests/__mocks__/server-only.js"), which a
  // bare extension test happily accepts as a suite. Require a real absolute
  // path so advisory output cannot inflate the canonical set.
  const ABSOLUTE = /^([A-Za-z]:[\\/]|\/)/
  return out
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0 && ABSOLUTE.test(l) && !l.includes('<rootDir>') && /\.(t|j)sx?$/.test(l))
    .map(norm)
    .sort()
}

function readManifest(file: string): string[] {
  const full = path.join(ROOT, file)
  if (!fs.existsSync(full)) {
    console.error(`missing manifest: ${file}`)
    process.exit(2)
  }
  return fs
    .readFileSync(full, 'utf8')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0 && !l.startsWith('#'))
    .map(norm)
    .sort()
}

function main(): void {
  const asJson = process.argv.includes('--json')

  const canonical = new Set(jestListTests([]))
  const resolved = new Map<string, string[]>()
  const problems: string[] = []

  for (const cat of CATEGORIES) {
    const members = cat.manifest ? readManifest(cat.manifest) : jestListTests(cat.patterns!)
    resolved.set(cat.key, members)

    // A manifest entry naming a suite jest does not resolve is stale. Left
    // alone it reads as coverage that does not exist.
    if (cat.manifest) {
      for (const m of members) {
        if (!canonical.has(m)) {
          problems.push(`${cat.manifest} names a suite jest does not resolve: ${m}`)
        }
      }
    }
  }

  // Pairwise overlap. A suite in two categories is counted twice, so the totals
  // can add up to the canonical size while leaving something uncovered.
  const keys = CATEGORIES.map(c => c.key)
  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) {
      const a = new Set(resolved.get(keys[i])!)
      const shared = resolved.get(keys[j])!.filter(s => a.has(s))
      for (const s of shared) {
        problems.push(`${keys[i]} and ${keys[j]} both claim: ${s}`)
      }
    }
  }

  const claimed = new Set<string>()
  for (const list of resolved.values()) for (const s of list) claimed.add(s)

  const unaccounted = [...canonical].filter(s => !claimed.has(s)).sort()

  // Report
  const rows = CATEGORIES.map(c => ({
    label: c.label,
    posture: c.posture,
    count: resolved.get(c.key)!.length,
  }))
  const total = rows.reduce((n, r) => n + r.count, 0)

  if (asJson) {
    console.log(JSON.stringify({ canonical: canonical.size, rows, total, unaccounted, problems }, null, 2))
  } else {
    const width = Math.max(...rows.map(r => r.label.length))
    console.log('')
    console.log(`canonical jest --listTests set: ${canonical.size} suite(s)`)
    console.log('')
    for (const r of rows) {
      console.log(`  ${r.label.padEnd(width)}  ${String(r.count).padStart(4)}   (${r.posture})`)
    }
    console.log(`  ${''.padEnd(width, ' ')}  ----`)
    console.log(`  ${'TOTAL'.padEnd(width)}  ${String(total).padStart(4)}`)
    console.log('')
  }

  if (unaccounted.length > 0) {
    console.error(`${unaccounted.length} suite(s) belong to NO category:`)
    for (const s of unaccounted) console.error(`  - ${s}`)
    console.error('')
    console.error('Every runnable suite must be exactly one of: on a blocking job,')
    console.error('in the known-failure baseline, or excluded with a stated reason.')
    console.error('An unlisted suite is not "extra coverage", it is coverage nobody')
    console.error('can report as missing.')
  }

  if (problems.length > 0) {
    console.error('')
    console.error(`${problems.length} accounting problem(s):`)
    for (const p of problems) console.error(`  - ${p}`)
  }

  if (unaccounted.length > 0 || problems.length > 0) process.exit(1)

  console.log(`accounting balances: ${total} categorised == ${canonical.size} canonical`)
}

main()
