#!/usr/bin/env tsx
/**
 * One authority for "may this caller reach this project".
 *
 * The repository accumulated roughly seventy independent answers to that
 * question. Two of them disagreed outright, and the owner-only one won on
 * volume, so an invited organization member was denied storage, logs,
 * monitoring, security issues, end-user auth and env vars. Worse, a request
 * that named no project resolved to the caller's OLDEST OWNED one, answering
 * 200 with a different project's data.
 *
 * Those are fixed. This exists so they cannot come back, because they will not
 * come back as a rewrite. They come back one route at a time, each looking
 * locally reasonable:
 *
 *   const project = await prisma.project.findFirst({
 *     where: { id: projectId, userId },     // <- the whole defect
 *   })
 *   if (!project) return 404
 *
 * WHAT THIS BANS, precisely: a `prisma.project.find*` whose WHERE clause
 * carries a userId. That shape is only ever an access-control shortcut.
 *
 * WHAT THIS DELIBERATELY DOES NOT BAN, because owners are a real part of the
 * domain and a guard that flags legitimate business logic gets switched off:
 *
 *   - `userId` in a SELECT. Reading who owns a project is data.
 *   - `project.userId` compared in application code, which is how
 *     app/api/projects/[id]/access decides that a solo project's owner is its
 *     OWNER before consulting organization roles.
 *   - any query on a model other than Project.
 *
 * Two files are allowed the banned shape and both are listed below with the
 * reason. Adding a third should be an argued decision, which is the point of
 * making the list explicit rather than inferring intent.
 *
 * Usage: tsx scripts/verify-project-authorization.ts
 */
import { execFileSync } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'

const ROOT = process.cwd()

/**
 * Files permitted to query Project with an id AND userId predicate.
 *
 * EMPTY, and that is the finding rather than an oversight. The rule was written
 * expecting the authority itself to need an exemption, and it does not:
 * verifyProjectAccess loads the project BY ID and then decides in application
 * code, consulting organization membership and project-scoped grants. So does
 * the single-tenant resolver. Nothing legitimate needs to ask the database
 * "does this row belong to this user" as a precondition for reading it.
 *
 * The two places that genuinely read ownership do not match either, which is
 * the test of whether this rule is drawn in the right place:
 *
 *   app/api/projects/[id]/access      selects userId, compares it in code to
 *                                     decide a solo project's owner is OWNER
 *                                     before consulting org roles
 *   app/api/v1/[projectId]/bootstrap  selects userId to attribute the API key
 *                                     it creates and the security event it
 *                                     records, on an unauthenticated endpoint
 *
 * Adding an entry here should therefore be an argued decision, not a shortcut
 * for making this check pass.
 */
const ALLOWED: Record<string, string> = {}

/** Directories that are not application code. */
const SKIP_DIRS = ['node_modules', '.next', 'workspace', '.git', 'dist', 'coverage']

const CALL = /prisma\.project\.(?:findFirst|findUnique|findMany|count)\s*\(\s*\{/g

/** Index just past the brace/paren matching the one at `i`. */
function matchBrace(s: string, i: number): number {
  const open = s[i]
  const close = open === '{' ? '}' : ')'
  let depth = 0
  for (let j = i; j < s.length; j++) {
    if (s[j] === open) depth++
    else if (s[j] === close) {
      depth--
      if (depth === 0) return j + 1
    }
  }
  return -1
}

/**
 * The where-clause of a Project read, brace-matched.
 *
 * Regex alone cannot do this. A lazy span from `where: {` runs straight past
 * the closing brace into `select: { userId: true }`, which flagged 66 sites
 * the first time this was written, nearly all of them innocent reads of the
 * ownership column.
 */
function whereClause(src: string, callBraceIndex: number): string | null {
  const end = matchBrace(src, callBraceIndex)
  if (end < 0) return null
  const args = src.slice(callBraceIndex, end)
  const w = args.search(/\bwhere\s*:\s*\{/)
  if (w < 0) return null
  const wBrace = args.indexOf('{', w + 5)
  const wEnd = matchBrace(args, wBrace)
  if (wEnd < 0) return null
  return args.slice(wBrace, wEnd)
}

/**
 * The defect shape: a where naming BOTH a specific project and a caller.
 *
 * `where: { id: projectId, userId }` authorizes access to a NAMED project by
 * ownership, which is the shortcut that denies every organization member.
 *
 * `where: { userId }` alone is NOT that. It lists the projects a user owns,
 * which is ordinary data access and stays legal — the distinction that keeps
 * this guard worth leaving switched on.
 */
function isOwnershipGate(where: string): boolean {
  const hasId = /\bid\s*:/.test(where)
  const hasUserId = /\buserId\b/.test(where)
  if (!hasId || !hasUserId) return false

  // A where that also consults organization membership or a project-scoped
  // grant is asking the RIGHT question, just inline. lib/middleware/
  // projectValidation.ts does exactly this. It is redundant beside the
  // resolver rather than wrong, so flagging it would be crying wolf.
  if (/\borganization\b|\bprojectMembers\b|\borganizationId\b/.test(where)) return false

  return true
}

/**
 * Blank out comments and string literals before scanning.
 *
 * Lengths are preserved so reported line numbers stay true. Without this the
 * guard flags its own documentation: the example of the banned shape in
 * lib/edition/guard.ts is a comment, and a guard that fails on a comment
 * explaining the guard is exactly the kind of false positive that gets a check
 * disabled.
 */
function blankNonCode(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, m => ' '.repeat(m.length))
    .replace(/`(?:\\.|[^`\\])*`/g, m => m.replace(/[^\n]/g, ' '))
}

interface Finding {
  file: string
  line: number
  snippet: string
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '.github') continue
    if (SKIP_DIRS.includes(entry.name)) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (/\.tsx?$/.test(entry.name)) out.push(full)
  }
  return out
}

function main(): void {
  // Application code only. Scripts and tests deliberately construct ownership
  // states and are not request-path authorization.
  const roots = ['app', 'lib', 'server'].map(d => path.join(ROOT, d)).filter(fs.existsSync)
  const files: string[] = []
  for (const r of roots) walk(r, files)

  const findings: Finding[] = []
  const usedAllowances = new Set<string>()

  for (const file of files) {
    const rel = path.relative(ROOT, file).replace(/\\/g, '/')
    const raw = fs.readFileSync(file, 'utf8')
    if (!raw.includes('prisma.project.find') && !raw.includes('prisma.project.count')) continue
    const src = blankNonCode(raw)

    CALL.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = CALL.exec(src)) !== null) {
      const braceIndex = m.index + m[0].lastIndexOf('{')
      const where = whereClause(src, braceIndex)
      if (!where || !isOwnershipGate(where)) continue

      if (ALLOWED[rel]) {
        usedAllowances.add(rel)
        continue
      }
      const line = src.slice(0, m.index).split('\n').length
      findings.push({
        file: rel,
        line,
        snippet: where.replace(/\s+/g, ' ').slice(0, 100),
      })
    }
  }

  // An allowance nobody needs any more is stale, and a stale allowance is a
  // hole somebody can walk through later without arguing for it.
  const stale = Object.keys(ALLOWED).filter(f => !usedAllowances.has(f) && fs.existsSync(path.join(ROOT, f)))

  if (findings.length === 0 && stale.length === 0) {
    console.log(`project authorization: one authority, ${files.length} file(s) scanned`)
    return
  }

  if (findings.length > 0) {
    console.error('')
    console.error(`${findings.length} project query authorizes by owner instead of asking the resolver:`)
    for (const f of findings) {
      console.error(`  ${f.file}:${f.line}`)
      console.error(`    ${f.snippet}`)
    }
    console.error('')
    console.error('A userId in a Project where-clause is an access-control shortcut. It')
    console.error('denies every invited organization member, because they are not the')
    console.error('owner, and it cannot see project-scoped grants at all.')
    console.error('')
    console.error('Use the guards in lib/edition/guard.ts, which ask the resolver:')
    console.error('')
    console.error('  canAccessProject(userId, projectId)       VIEWER and above')
    console.error('  canWriteProject(userId, projectId)        DEVELOPER and above')
    console.error('  canAdministerProject(userId, projectId)   ADMIN and above')
    console.error('')
    console.error('Choose by what the endpoint GRANTS, not by its HTTP method: a GET that')
    console.error('returns a credential is administration.')
    console.error('')
    console.error('Reading who owns a project is fine. `select: { userId: true }` and')
    console.error('comparing project.userId in application code are not flagged; only a')
    console.error('userId in the WHERE is.')
  }

  if (stale.length > 0) {
    console.error('')
    console.error(`${stale.length} allowance(s) in this script are no longer used:`)
    for (const f of stale) console.error(`  ${f}`)
    console.error('Remove them. An unused allowance is a hole nobody has to argue for.')
  }

  process.exit(1)
}

main()
