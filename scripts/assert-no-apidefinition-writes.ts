/**
 * ApiDefinition write gate — fails the build when any code path can create an
 * `ApiDefinition` row.
 *
 * WHY THIS EXISTS
 * ---------------
 * PostgREST is the only data plane. Under it the API *is* the schema: `GET
 * /posts` is reachable because the table exists and the role holds a grant,
 * resolved from the PostgreSQL catalog on every request. `checkExposure`
 * (lib/postgrest/exposure.ts) stopped consulting `ApiDefinition` on 2026-07-21,
 * which means these rows decide nothing at runtime.
 *
 * A row that decides nothing is not harmless. It is a second, writable
 * description of a fact the database already owns, and the only thing a second
 * copy can do is disagree:
 *
 *   - The APIs page advertised full CRUD on `_email_verifications` — internal
 *     auth plumbing that the runtime 404s and Postgres has revoked. A developer
 *     or an agent reading that page as the contract would call endpoints that
 *     cannot exist.
 *   - The Publish page counted "29 endpoints" for a project whose only real
 *     table is the auth `users` table, which is never CRUD-exposed.
 *   - The autonomy loop invented repairs for the drift ("Backenly fixed missing
 *     api on _token_blacklist"), which is how unprotected auth-token tables got
 *     REST APIs generated on them in the first place.
 *
 * Every writer was deleted on 2026-07-21. Deleting a writer does not stop the
 * next one from being added, which is what this gate is for: the guarantee has
 * to be structural, not "nobody calls that any more".
 *
 * IF THIS FIRES
 * -------------
 * Do not add your file to ALLOWLIST. The catalog already knows which tables
 * exist — read it (`lib/mcp/schema-introspection.ts` → `listExposedTables`,
 * `getTableSchema`) instead of writing a row that describes it. If you need
 * per-operation restriction, express it as a Postgres grant, which the database
 * enforces and which cannot be bypassed by reaching the table another way.
 *
 * Run: npx tsx scripts/assert-no-apidefinition-writes.ts   (wired into `npm run build` and CI)
 */

import fs from 'fs'
import path from 'path'

const ROOT = path.resolve(__dirname, '..')

/** Production source roots. A writer anywhere here is a real runtime path. */
const SCAN_DIRS = ['app', 'lib', 'server', 'components', 'packages', 'scripts', 'tests']

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.next', 'coverage', 'results'])

/**
 * Fixture builders that construct a violating state ON PURPOSE so a probe can be
 * observed firing against it. Listed file-by-file rather than by directory: a
 * NEW writer under tests/ or scripts/ must still fail this gate and get read,
 * because "it's only a script" is how the last one got in.
 */
const ALLOWLIST = new Set([
  // Builds tables-with-and-without-definitions so the drift probes have
  // something to detect. Asserts detection, never production behaviour.
  path.join('tests', 'probes', 'probe-fixtures.spec.ts'),
  // Seeds a rollback fixture for the Tier-1 autonomy verification run.
  path.join('scripts', 'verify-autonomy-tier1.ts'),
])

/** Writes that would mint a row, plus the service helper that used to wrap them. */
const BANNED = [
  { re: /prisma\s*\.\s*apiDefinition\s*\.\s*(create|createMany|upsert)\b/, label: 'prisma.apiDefinition.create/createMany/upsert' },
  { re: /\bcreateApiDefinition\s*\(/, label: 'createApiDefinition(...)' },
  { re: /\bensureApiDefinition\s*\(/, label: 'ensureApiDefinition(...)' },
]

interface Violation {
  file: string
  line: number
  label: string
  code: string
}

const violations: Violation[] = []

/**
 * Prose describing the ban is not a violation of it. This is deliberately crude
 * — it only skips whole-line comments, so a real call cannot hide behind a
 * trailing comment on the same line.
 */
function isCommentLine(line: string): boolean {
  const t = line.trim()
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')
}

/** This file defines the banned patterns, so it necessarily contains them. */
const SELF = path.relative(ROOT, __filename)

function checkFile(absPath: string) {
  const rel = path.relative(ROOT, absPath)
  if (rel === SELF || ALLOWLIST.has(rel)) return

  const lines = fs.readFileSync(absPath, 'utf8').split('\n')
  lines.forEach((line, i) => {
    if (isCommentLine(line)) return
    for (const { re, label } of BANNED) {
      if (re.test(line)) {
        violations.push({ file: rel, line: i + 1, label, code: line.trim() })
      }
    }
  })
}

function scan(dir: string) {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue
      scan(full)
    } else if (e.name.endsWith('.ts') || e.name.endsWith('.tsx')) {
      checkFile(full)
    }
  }
}

for (const d of SCAN_DIRS) scan(path.join(ROOT, d))

if (violations.length > 0) {
  console.error(`\n✖ ApiDefinition write gate FAILED — ${violations.length} write path(s) found\n`)
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}`)
    console.error(`    ${v.label}`)
    console.error(`    ${v.code}\n`)
  }
  console.error(
    'ApiDefinition rows decide nothing under PostgREST — the PostgreSQL catalog does.\n' +
      'Read the catalog (lib/mcp/schema-introspection.ts) instead of writing a row that\n' +
      'describes it, and express per-operation limits as Postgres grants.\n' +
      'See the header of scripts/assert-no-apidefinition-writes.ts.\n',
  )
  process.exit(1)
}

console.log('✓ ApiDefinition write gate: no create paths in app/, lib/, server/, components/, packages/, scripts/, tests/')
