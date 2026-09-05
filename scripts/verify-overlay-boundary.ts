#!/usr/bin/env tsx
/**
 * Prove the public/private ownership boundary holds.
 *
 * Backenly ships as one public repository plus a private Cloud overlay that
 * ADDS files to it. The overlay is add-only by construction: if it were ever
 * allowed to overwrite a tracked public file, the public repository would stop
 * being a truthful description of what Cloud runs, and a reader of the OSS tree
 * could no longer tell which behaviour is theirs. `overlay-allowlist.json` is
 * the map of what the overlay may own; this script is what makes that map
 * falsifiable.
 *
 * Ownership is WHOLE-DIRECTORY. A private subsystem gets a directory to itself
 * rather than scattering private files among public ones, because a mixed
 * directory has no reviewable boundary: every new file in it is a judgement
 * call, and the overlay would eventually need to overwrite something.
 *
 * -- Why there is a transition mode ------------------------------------------
 *
 * The allowlist is written in Phase 4, but the subsystems it names do not move
 * private until Phase 6 (back office) and Phase 7 (org + fleet control plane).
 * So on the day this script lands, 73 public files sit under paths the overlay
 * will one day own. That is expected, not a violation.
 *
 * Enforcing strict no-collision immediately would have exactly one way to go
 * green: move all of admin, billing and org private right now, collapsing three
 * phases into one. So the default mode grandfathers that set BY NAME, from
 * `transition.grandfathered`, and fails on anything NEW. The list may shrink,
 * never grow. Phase 6/7 delete files and prune entries; when it empties, CI
 * switches to --strict and the transition key is deleted. The verifier does not
 * need to be rewritten for that to happen.
 *
 * An exact file list, not a count: Phase 1 established that "the same number of
 * failures" is not evidence that the same things failed.
 *
 * -- Modes -------------------------------------------------------------------
 *
 *   verify-overlay-boundary.ts
 *       Transition mode (what CI runs today). Allowlist shape + no NEW public
 *       file under a private-owned path.
 *
 *   verify-overlay-boundary.ts --strict
 *       Phase 8 mode. Ignores the grandfather list entirely: ANY public file
 *       under a private-owned path is a violation.
 *
 *   verify-overlay-boundary.ts --overlay <dir>
 *       Checks a real private overlay tree WITHOUT applying it. Every file must
 *       fall inside an allowlisted path and must not collide with a tracked
 *       public file. Applying an overlay is Phase 5's job and is not done here.
 *
 *   verify-overlay-boundary.ts --allowlist <file>
 *       Reads a different ownership map. This exists so the guard's own tests
 *       can feed it deliberately broken maps and prove it rejects them: a guard
 *       nothing has ever seen fail is not known to work. CI uses the default.
 *
 * Usage:
 *   tsx scripts/verify-overlay-boundary.ts
 *       [--strict] [--overlay <dir>] [--allowlist <file>] [--json]
 */
import { execFileSync } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'

const ROOT = process.cwd()
const ALLOWLIST = 'overlay-allowlist.json'

/**
 * Shared infrastructure that stays ONE public copy, forever.
 *
 * These are hardcoded here rather than read from the allowlist on purpose: a
 * deny-list that lives inside the file it constrains can be edited away in the
 * same commit that violates it. Cloud-only dependency names may sit in the
 * public package.json -- a dependency name is not a secret, and a second
 * lockfile is a permanent merge conflict.
 */
const SHARED_PUBLIC_FILES = [
  'package.json',
  'package-lock.json',
  'next.config.js',
  'next.config.mjs',
  'next.config.ts',
  'middleware.ts',
  'ecosystem.config.js',
  'prisma/schema.prisma',
  'app/layout.tsx',
]

/**
 * Public product. Cloud value is managed infrastructure, operations and
 * governance -- never withholding backend functionality -- so none of this can
 * be privately owned no matter how convenient it would be.
 *
 * lib/autonomy and lib/postgrest are here because the PER-PROJECT reconciler
 * and the data plane are OSS. Fleet fan-out ACROSS projects is control plane
 * and lives in scripts/fleet, which is allowlisted.
 */
const PUBLIC_CORE_PREFIXES = [
  'lib/ai/brain/',
  'lib/autonomy/',
  'lib/postgrest/',
  'lib/services/',
  'lib/edition/',
  'lib/quota/',
  'server/',
  'packages/',
  'prisma/schema.prisma',
]

interface Allowlist {
  version: number
  private: string[]
  transition?: { grandfathered: string[]; expiresAfterPhase?: number }
}

const violations: string[] = []
const notes: string[] = []

function fail(msg: string): void {
  violations.push(msg)
}

function trackedFiles(): string[] {
  return execFileSync('git', ['ls-files'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
    .split('\n')
    .filter(Boolean)
}

/** Every path here is compared in git's form: forward slashes, repo-relative. */
function normalise(p: string): string {
  return p.split(path.sep).join('/').replace(/^\.\//, '')
}

// -- 1. allowlist shape ------------------------------------------------------

function readAllowlist(file: string): Allowlist {
  const abs = path.isAbsolute(file) ? file : path.join(ROOT, file)
  if (!fs.existsSync(abs)) {
    console.error(`ownership map not found: ${file}`)
    process.exit(1)
  }
  let parsed: Allowlist
  try {
    parsed = JSON.parse(fs.readFileSync(abs, 'utf8'))
  } catch (e) {
    console.error(`${file} is not valid JSON: ${(e as Error).message}`)
    process.exit(1)
  }
  if (!Array.isArray(parsed.private)) {
    console.error(`${file}: "private" must be an array of ownership paths`)
    process.exit(1)
  }
  return parsed
}

/**
 * An entry is either a whole directory (suffixed with the doubled star) or one
 * explicitly named file. Anything else -- a mid-path wildcard, a bare
 * directory, a traversal, an absolute path -- is rejected, because it either
 * breaks whole-directory ownership or cannot be reasoned about mechanically.
 */
function checkEntryShape(entries: string[]): void {
  const seen = new Set<string>()
  const DIR_SUFFIX = '/**'

  for (const entry of entries) {
    if (typeof entry !== 'string' || entry.length === 0) {
      fail(`allowlist entry is not a non-empty string: ${JSON.stringify(entry)}`)
      continue
    }
    if (seen.has(entry)) fail(`allowlist entry is listed twice: ${entry}`)
    seen.add(entry)

    if (entry !== normalise(entry)) fail(`allowlist entry must use forward slashes: ${entry}`)
    if (entry.startsWith('/') || /^[A-Za-z]:/.test(entry)) {
      fail(`allowlist entry must be repo-relative: ${entry}`)
    }
    if (entry.split('/').includes('..')) fail(`allowlist entry must not traverse upward: ${entry}`)

    const isDir = entry.endsWith(DIR_SUFFIX)
    const body = isDir ? entry.slice(0, -DIR_SUFFIX.length) : entry

    if (body.includes('*')) {
      fail(`allowlist entry may only wildcard a whole trailing directory: ${entry}`)
      continue
    }
    if (!isDir && !path.extname(body)) {
      // A bare path with no extension is a directory someone forgot to suffix,
      // which would silently own nothing at all.
      fail(`allowlist entry looks like a directory but is missing the "${DIR_SUFFIX}" suffix: ${entry}`)
      continue
    }

    // Deny-lists, checked against the DECLARED path, so a violation is caught
    // when it is written rather than when a file later appears under it.
    for (const shared of SHARED_PUBLIC_FILES) {
      if (body === shared || (isDir && shared.startsWith(body + '/'))) {
        fail(`allowlist entry would privately own shared public infrastructure "${shared}": ${entry}`)
      }
    }
    for (const pub of PUBLIC_CORE_PREFIXES) {
      const target = isDir ? body + '/' : body
      if (target.startsWith(pub) || pub.startsWith(target)) {
        fail(`allowlist entry would privately own public product code "${pub}": ${entry}`)
      }
    }
  }
}

// -- 2. public files under private-owned paths --------------------------------

function ownsPath(entries: string[], file: string): string | null {
  for (const entry of entries) {
    if (entry.endsWith('/**')) {
      if (file.startsWith(entry.slice(0, -2))) return entry
    } else if (file === entry) {
      return entry
    }
  }
  return null
}

function checkPublicCollisions(list: Allowlist, strict: boolean): void {
  const grandfathered = new Set(list.transition?.grandfathered ?? [])
  const stillPresent = new Set<string>()

  for (const file of trackedFiles()) {
    const owner = ownsPath(list.private, file)
    if (!owner) continue

    if (strict) {
      fail(`--strict: public file still tracked under private-owned "${owner}": ${file}`)
      continue
    }
    if (!grandfathered.has(file)) {
      fail(
        `new public file under private-owned "${owner}": ${file}\n` +
          '    Private ownership is whole-directory. Either put this file in a ' +
          'public directory, or move the subsystem private in its scheduled phase.',
      )
      continue
    }
    stillPresent.add(file)
  }

  if (strict) return

  // The grandfather list may only shrink. A stale entry means Phase 6/7 removed
  // the file but left the transition state behind, and a transition state that
  // outlives its contents is how a temporary exemption becomes permanent.
  for (const file of grandfathered) {
    if (!stillPresent.has(file)) {
      fail(
        `stale grandfather entry, no longer tracked: ${file}\n` +
          `    Remove it from ${ALLOWLIST} "transition.grandfathered".`,
      )
    }
  }

  notes.push(`${stillPresent.size} public file(s) still under private-owned paths, all grandfathered`)
  if (stillPresent.size === 0) {
    notes.push('grandfather list is empty: delete "transition" and move CI to --strict')
  }
}

// -- 3. a real overlay tree ---------------------------------------------------

function walk(dir: string, base: string, out: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git') continue
    const abs = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(abs, base, out)
    else out.push(normalise(path.relative(base, abs)))
  }
}

function checkOverlay(list: Allowlist, overlayDir: string): void {
  if (!fs.existsSync(overlayDir)) {
    console.error(`overlay directory does not exist: ${overlayDir}`)
    process.exit(1)
  }
  const files: string[] = []
  walk(overlayDir, overlayDir, files)
  const tracked = new Set(trackedFiles())

  for (const file of files.sort()) {
    const owner = ownsPath(list.private, file)
    if (!owner) {
      fail(`overlay file is outside every allowlisted private path: ${file}`)
      continue
    }
    // Add-only. Checked even for an allowlisted path, because during the
    // transition an allowlisted path can still hold public files.
    if (tracked.has(file)) {
      fail(`overlay file would overwrite a tracked public file: ${file}`)
    }
  }
  notes.push(`overlay: ${files.length} file(s) checked against ${list.private.length} ownership path(s)`)
}

// -- main ---------------------------------------------------------------------

function main(): void {
  const argv = process.argv.slice(2)
  const strict = argv.includes('--strict')
  const asJson = argv.includes('--json')
  const overlayIdx = argv.indexOf('--overlay')
  const overlayDir = overlayIdx >= 0 ? argv[overlayIdx + 1] : null
  const allowlistIdx = argv.indexOf('--allowlist')
  const allowlistFile = allowlistIdx >= 0 ? argv[allowlistIdx + 1] : ALLOWLIST

  if (overlayIdx >= 0 && !overlayDir) {
    console.error('--overlay requires a directory argument')
    process.exit(1)
  }
  if (allowlistIdx >= 0 && !argv[allowlistIdx + 1]) {
    console.error('--allowlist requires a file argument')
    process.exit(1)
  }

  const list = readAllowlist(allowlistFile)
  checkEntryShape(list.private)

  // Shape errors make every downstream answer meaningless, so stop here.
  if (violations.length === 0) {
    if (overlayDir) checkOverlay(list, overlayDir)
    else checkPublicCollisions(list, strict)
  }

  if (asJson) {
    console.log(JSON.stringify({ ok: violations.length === 0, violations, notes }, null, 2))
  } else if (violations.length > 0) {
    console.error(`\noverlay boundary: ${violations.length} violation(s)\n`)
    for (const v of violations) console.error(`  x ${v}`)
    console.error('')
  } else {
    const mode = overlayDir ? `overlay ${overlayDir}` : strict ? 'strict' : 'transition'
    console.log(`overlay boundary: ok (${mode})`)
    for (const n of notes) console.log(`  ${n}`)
  }

  process.exit(violations.length > 0 ? 1 : 0)
}

main()
