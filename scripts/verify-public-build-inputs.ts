/**
 * NEXT_PUBLIC_* ARE BUILD INPUTS, AND CI SAYS SO BEFORE THE IMAGE IS PUSHED
 * ========================================================================
 *
 *   npx tsx scripts/verify-public-build-inputs.ts            # inputs + artifact
 *   npx tsx scripts/verify-public-build-inputs.ts --inputs   # before next build
 *   npx tsx scripts/verify-public-build-inputs.ts --artifact # after next build
 *
 * `next build` COMPILES every `process.env.NEXT_PUBLIC_*` into the output as a
 * string literal. It does not read them at run time. The ECS task definition
 * passes NEXT_PUBLIC_APP_URL=https://backenly.com to the web container and that
 * value is inert: by then the redirect targets are already frozen.
 *
 * This is not a theory. A release build was started without --build-arg, took
 * the Dockerfile's ARG defaults, and would have produced an image whose every
 * OAuth redirect and password-reset link pointed at http://localhost:3000, with
 * signup CAPTCHA and error reporting silently off. Nothing about that image
 * looks wrong from the outside: it boots, it serves, it passes a health check,
 * and the task definition still says https://backenly.com.
 *
 * ── Why this checks inputs AND the artifact ─────────────────────────────────
 *
 * The input check is precise: it can say WHICH variable is wrong and why.
 * The artifact check is the one that cannot be fooled: it proves the value
 * actually reached the compiled output, which is the only thing that ships.
 *
 * The artifact check is deliberately POSITIVE - it asserts the production URL
 * is present, rather than asserting localhost is absent. Absence is not
 * checkable here: several modules carry a literal `|| 'http://localhost:3000'`
 * fallback, so that string legitimately appears in a correct build. Asking
 * "did the real value get compiled in" has one answer; asking "is the fallback
 * missing" has two, and only one of them is about this bug.
 */

import { readdirSync, readFileSync, statSync, existsSync } from 'fs'
import { join } from 'path'

const SOURCE_DIRS = ['app', 'lib', 'components', 'hooks']
const SOURCE_FILES = ['middleware.ts', 'instrumentation.ts', 'next.config.js']

/**
 * What a production Cloud build must have, and what "correct" means for each.
 *
 * `check` returns an error string, or null when the value is acceptable. It
 * never receives an empty value - absence is reported before it is called.
 */
const REQUIRED: Record<string, { why: string; check?: (v: string) => string | null }> = {
  NEXT_PUBLIC_APP_URL: {
    why: 'every OAuth redirect, password-reset link and absolute URL is built from it',
    check: v => {
      if (!/^https:\/\//.test(v)) return 'must be https:// in a production build'
      if (/localhost|127\.0\.0\.1|0\.0\.0\.0/.test(v)) return 'points at a local address'
      return null
    },
  },
  NEXT_PUBLIC_TURNSTILE_SITE_KEY: {
    why: 'the signup CAPTCHA does not render without it, and abuse defense is off',
  },
  NEXT_PUBLIC_SENTRY_DSN: {
    why: 'client-side errors are reported nowhere without it',
    check: v => (/^https:\/\//.test(v) ? null : 'must be an https DSN'),
  },
}

interface Use {
  file: string
  line: number
  guarded: boolean
}

/**
 * Is this use the one that breaks silently when the value is absent?
 *
 * `undefined` is survivable nearly everywhere: `typeof v !== 'string'` rejects
 * it, `normalizeCandidate(v) || ...` falls through, `v ?? 'https://...'` picks
 * the default. It is NOT survivable inside a template literal, where it is
 * stringified: `${process.env.NEXT_PUBLIC_URL}/api/proxy` becomes the literal
 * text "undefined/api/proxy" and is handed to a caller as a URL.
 *
 * So the rule is narrow on purpose. A checker that flagged every unsupplied
 * variable would have flagged three safe call sites here and taught everyone to
 * ignore it, which is how a guard stops being one.
 */
function interpolatedWithoutFallback(text: string, at: number): boolean {
  // Walk back to an unclosed `${`.
  let open = -1
  let depth = 0
  for (let i = at - 1; i >= 1; i--) {
    if (text[i] === '}') depth++
    else if (text[i] === '{' && text[i - 1] === '$') {
      if (depth === 0) {
        open = i + 1
        break
      }
      depth--
    }
  }
  if (open === -1) return false

  // Forward to its matching `}`.
  let close = -1
  depth = 0
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++
    else if (text[i] === '}') {
      if (depth === 0) {
        close = i
        break
      }
      depth--
    }
  }
  const inner = text.slice(open, close === -1 ? text.length : close)
  return !/\|\||\?\?/.test(inner)
}

/** Every `process.env.NEXT_PUBLIC_X` in the source, and whether it has a fallback. */
function discoverUses(): Map<string, Use[]> {
  const uses = new Map<string, Use[]>()

  const walk = (dir: string): string[] => {
    const out: string[] = []
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return out
    }
    for (const entry of entries) {
      if (entry === 'node_modules' || entry === '.next') continue
      const path = join(dir, entry)
      const st = statSync(path)
      if (st.isDirectory()) out.push(...walk(path))
      else if (/\.(ts|tsx|js|jsx|mjs)$/.test(entry)) out.push(path)
    }
    return out
  }

  const files = [...SOURCE_DIRS.flatMap(walk), ...SOURCE_FILES.filter(f => existsSync(f))]

  for (const file of files) {
    const source = readFileSync(file, 'utf8')
    if (!source.includes('NEXT_PUBLIC_')) continue

    const lines = source.split('\n')
    lines.forEach((text, i) => {
      const re = /process\.env\.(NEXT_PUBLIC_[A-Z0-9_]+)/g
      let m: RegExpExecArray | null
      while ((m = re.exec(text))) {
        const name = m[1]
        const guarded = !interpolatedWithoutFallback(text, m.index)
        if (!uses.has(name)) uses.set(name, [])
        uses.get(name)!.push({ file, line: i + 1, guarded })
      }
    })
  }

  return uses
}

/** Compiled JS emitted by `next build`, server chunks and browser bundle both. */
function compiledFiles(): string[] {
  const roots = [join('.next', 'server'), join('.next', 'static')]
  const out: string[] = []
  const walk = (dir: string) => {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(dir, entry)
      const st = statSync(path)
      if (st.isDirectory()) walk(path)
      // .map files carry the ORIGINAL source, in which the variable still
      // appears by name. Reading them would report success for a build that
      // inlined nothing.
      else if (entry.endsWith('.js')) out.push(path)
    }
  }
  roots.forEach(walk)
  return out
}

/** Shape, never the value: these are public, but a log is not a place for them. */
function describe(name: string, value: string): string {
  // The URL and the pricing publication switch are recorded verbatim: a
  // release record must say whether an image advertises usage pricing.
  if (['NEXT_PUBLIC_APP_URL', 'NEXT_PUBLIC_USAGE_PRICING'].includes(name)) return value
  return `configured, ${value.length} chars`
}

const problems: string[] = []
const notes: string[] = []

const mode = process.argv[2]
const wantInputs = mode !== '--artifact'
const wantArtifact = mode !== '--inputs' && existsSync('.next')

console.log('')
console.log('  NEXT_PUBLIC_* build inputs for a production Cloud image')
console.log('')

// ── Inputs ──────────────────────────────────────────────────────────────────
if (wantInputs) {
  for (const [name, spec] of Object.entries(REQUIRED)) {
    const value = process.env[name]
    if (!value) {
      problems.push(`${name} is absent or empty - ${spec.why}`)
      continue
    }
    const err = spec.check?.(value)
    if (err) problems.push(`${name} ${err} - ${spec.why}`)
    else console.log(`  ok        ${name} (${describe(name, value)})`)
  }

  // Anything the source READS but nobody supplies. The Dockerfile's ARG list is
  // not the authority here; the source is.
  const uses = discoverUses()
  for (const [name, sites] of [...uses.entries()].sort()) {
    if (name in REQUIRED) continue
    if (process.env[name]) {
      console.log(`  ok        ${name} (${describe(name, process.env[name]!)}, ${sites.length} use site(s))`)
      continue
    }
    const unguarded = sites.filter(s => !s.guarded)
    if (unguarded.length > 0) {
      problems.push(
        `${name} is read without a fallback and is not supplied, so it compiles to ` +
          `the literal text "undefined": ` +
          unguarded.map(s => `${s.file}:${s.line}`).join(', '),
      )
    } else {
      notes.push(`${name} is not supplied, but every use site has a fallback`)
    }
  }

  // Declared for the build and read by nobody. Dead configuration, reported so
  // it can be removed rather than carried forward release after release.
  for (const name of Object.keys(process.env).filter(k => k.startsWith('NEXT_PUBLIC_'))) {
    if (!uses.has(name) && !(name in REQUIRED)) notes.push(`${name} is supplied but unused`)
  }
}

// ── Artifact ────────────────────────────────────────────────────────────────
if (wantArtifact) {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL
  if (appUrl && !problems.some(p => p.startsWith('NEXT_PUBLIC_APP_URL'))) {
    const files = compiledFiles()
    const found = files.some(f => {
      try {
        return readFileSync(f, 'utf8').includes(appUrl)
      } catch {
        return false
      }
    })
    if (found) console.log(`  ok        compiled output contains ${appUrl} (${files.length} files)`)
    else
      problems.push(
        `the compiled output does not contain ${appUrl} anywhere in ${files.length} ` +
          `emitted file(s). next build did not receive it, so the value that shipped ` +
          `is whatever the ARG default was.`,
      )
  }
}

console.log('')
for (const n of notes) console.log(`  note      ${n}`)
if (notes.length > 0) console.log('')

if (problems.length === 0) {
  console.log('  build inputs are production-correct')
  console.log('')
  process.exit(0)
}

for (const p of problems) console.error(`  FAIL      ${p}`)
console.error('')
console.error(
  `  ${problems.length} problem(s). next build COMPILES these values in - the task\n` +
    `  definition cannot correct them afterwards. Pass them as --build-arg:\n` +
    `    docker build --build-arg NEXT_PUBLIC_APP_URL ... -f docker/web.Dockerfile .\n`,
)
process.exit(1)
