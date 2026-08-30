/**
 * Analytics posture gate.
 *
 * WHY THIS EXISTS
 * ---------------
 * components/app/AmplitudeAnalytics.tsx is mounted in the ROOT layout, so
 * whatever it initializes applies to the authenticated console at /app/* as
 * well as the marketing pages. It used to call `initAll()` from
 * `@amplitude/unified` with `sessionReplay: { sampleRate: 1 }` and
 * `autocapture: true`. That is 100% session replay plus element-interaction
 * and network capture over the data browser, the schema editor and the SQL
 * surface — table names, column names, and whatever customer rows were on
 * screen — none of it disclosed in the privacy policy.
 *
 * The route-based fix does not work and is deliberately not attempted: the
 * component initializes once per browser session and never re-evaluates, and
 * there is no marketing route group, so a visitor who lands on /pricing and
 * then client-navigates to /app carries the plugin across. The fix is
 * structural instead — the replay plugin is not a dependency, so it cannot be
 * imported. This file is what keeps that true.
 *
 * WHAT IT CHECKS
 * --------------
 *   1. No session-replay or unified Amplitude package is depended on. This is
 *      the load-bearing check: with the package absent, replay cannot be
 *      enabled by any amount of configuration.
 *   2. Nothing in the app imports those packages, or calls `initAll(`.
 *   3. The initializer passes `autocapture` as an object, never the boolean.
 *      `autocapture: true` short-circuits every capability gate in the SDK
 *      (`if (typeof autocapture === 'boolean') return autocapture`), which
 *      turns on the five options that default to false — including
 *      elementInteractions and networkTracking.
 *   4. The capture options we deliberately disabled are still disabled, and
 *      are stated explicitly rather than left to an upstream default.
 *
 * This is a structural gate, not a style gate: every assertion is about which
 * code can run, and each one has a concrete privacy consequence. Changing the
 * posture means editing the ALLOWED/DENIED lists here in the same commit,
 * which is the point — it makes the decision visible in review.
 *
 * Deliberately dependency-free so it can run as a build gate, matching
 * verify-content-integrity.ts.
 *
 * Run: npx tsx scripts/verify-analytics-posture.ts   (wired into `npm run build`)
 */

import { readFileSync, readdirSync, statSync } from 'fs'
import { join, extname, sep } from 'path'

const ROOT = join(__dirname, '..')
const INITIALIZER = 'components/app/AmplitudeAnalytics.tsx'

const failures: string[] = []
const fail = (m: string) => failures.push(m)

/**
 * Remove comments so the checks below read CODE, not prose.
 *
 * This matters more than it looks. The initializer carries a long comment
 * explaining what it used to do — it names `initAll`, `autocapture: true` and
 * `sessionReplay` precisely so the next reader understands why the current
 * shape is what it is. A plain text scan flags that comment as a violation and
 * the only way to pass becomes deleting the explanation, which is the opposite
 * of what a gate should incentivise.
 *
 * String and template literals are skipped rather than stripped, so a literal
 * containing `//` cannot swallow the rest of a real line and hide a violation
 * behind it. False negatives are the failure mode that matters here: a gate
 * that quietly stops looking is worse than no gate.
 */
function stripComments(src: string): string {
  let out = ''
  let i = 0
  while (i < src.length) {
    const c = src[i]
    const next = src[i + 1]

    if (c === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') i++
      continue
    }
    if (c === '/' && next === '*') {
      i += 2
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++
      i += 2
      continue
    }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c
      out += c
      i++
      while (i < src.length) {
        if (src[i] === '\\') {
          out += src[i] + (src[i + 1] ?? '')
          i += 2
          continue
        }
        out += src[i]
        if (src[i] === quote) {
          i++
          break
        }
        i++
      }
      continue
    }

    out += c
    i++
  }
  return out
}

// ── 1. Banned packages ───────────────────────────────────────────────────────
//
// `@amplitude/unified` is banned rather than merely unused: it exports no
// `init`, only `initAll`, and it depends on the session replay plugin at its
// module top level — so importing it puts replay in the bundle whatever the
// configuration says.

const BANNED_PACKAGES = [
  '@amplitude/plugin-session-replay-browser',
  '@amplitude/unified',
]

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const declared = { ...pkg.dependencies, ...pkg.devDependencies }

for (const banned of BANNED_PACKAGES) {
  if (declared[banned]) {
    fail(`package.json depends on ${banned} — session replay must not be installable`)
  }
}

const lock = readFileSync(join(ROOT, 'package-lock.json'), 'utf8')
for (const banned of BANNED_PACKAGES) {
  if (lock.includes(`node_modules/${banned}`)) {
    fail(`package-lock.json resolves ${banned} — it is reachable in the installed tree`)
  }
}

// ── 2. No import of a banned package, and no initAll() anywhere ──────────────

const SCAN_DIRS = ['app', 'components', 'lib', 'server', 'packages']
const SCAN_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs'])
const SKIP_DIRS = new Set(['node_modules', 'dist', '.next', 'build', 'coverage'])

function* walk(dir: string): Generator<string> {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) yield* walk(full)
    else if (SCAN_EXTS.has(extname(full))) yield full
  }
}

for (const dir of SCAN_DIRS) {
  for (const file of walk(join(ROOT, dir))) {
    const rel = file.slice(ROOT.length + 1).split(sep).join('/')
    const code = stripComments(readFileSync(file, 'utf8'))

    for (const banned of BANNED_PACKAGES) {
      if (code.includes(`'${banned}'`) || code.includes(`"${banned}"`)) {
        fail(`${rel} imports ${banned}`)
      }
    }

    // The test file spies on initAll by name to prove it is never called.
    if (rel.includes('__tests__')) continue
    if (code.includes('initAll(')) {
      fail(`${rel} calls initAll( — that entry point loads the session replay plugin`)
    }
  }
}

// ── 3 & 4. The initializer's own capture options ─────────────────────────────

const initializer = stripComments(readFileSync(join(ROOT, INITIALIZER), 'utf8'))

if (/autocapture\s*:\s*(true|false)\b/.test(initializer)) {
  fail(
    `${INITIALIZER}: autocapture is a boolean. The SDK short-circuits every ` +
      `capability gate on a boolean, enabling elementInteractions, ` +
      `networkTracking, frustrationInteractions, webVitals and ` +
      `performanceTracking. Pass an object with each option stated.`,
  )
}

if (/sessionReplay/.test(initializer)) {
  fail(`${INITIALIZER}: mentions sessionReplay`)
}

// Every option that must be present AND false. Absent is not good enough: the
// SDK's defaults are upstream and can change, and an option that is merely
// omitted gives a reader no evidence the choice was made on purpose.
const MUST_BE_DISABLED = [
  'attribution',
  'elementInteractions',
  'formInteractions',
  'fileDownloads',
  'frustrationInteractions',
  'networkTracking',
  'webVitals',
  'performanceTracking',
]

// Whitespace-insensitive without needing an escape-heavy regex: collapse the
// source once, then look for the literal `option:false`.
const compact = initializer.split(/\s+/).join('')

for (const option of MUST_BE_DISABLED) {
  if (!compact.includes(`${option}:false`)) {
    fail(`${INITIALIZER}: ${option} must be stated explicitly as false`)
  }
}

// The two we do collect, so that a silent removal is also caught — this gate
// describes the agreed posture in both directions.
const MUST_BE_ENABLED = ['pageViews', 'sessions']
for (const option of MUST_BE_ENABLED) {
  if (!compact.includes(`${option}:true`)) {
    fail(`${INITIALIZER}: ${option} is no longer enabled — intended, or a mistake?`)
  }
}

// ── Report ───────────────────────────────────────────────────────────────────

if (failures.length > 0) {
  console.error(`\n✗ Analytics posture: ${failures.length} problem(s)\n`)
  for (const f of failures) console.error(`  • ${f}`)
  console.error('')
  process.exit(1)
}

console.log(
  `✓ Analytics posture: no session-replay dependency · no initAll call site · ` +
    `autocapture stated as an object · ${MUST_BE_ENABLED.length} option(s) on, ` +
    `${MUST_BE_DISABLED.length} explicitly off`,
)
