#!/usr/bin/env tsx
/**
 * A Project row is not a project.
 *
 * Without a workspace schema, a PostgREST registration, a backend graph and a
 * signing secret, the row exists and every data-plane request against it
 * answers PGRST106 forever. Two live paths shipped exactly that:
 * /api/connect/replace-backend and /api/connect/url both created a bare row,
 * so a user connecting a frontend got a project whose database never worked.
 * One of them owned it to `userId: 'system'`, which is not a user id.
 *
 * Neither was sabotage. They were written before the provisioning sequence
 * existed and never revisited, which is what happens when that sequence lives
 * inline in one route rather than behind a function anyone can call. It now
 * lives in lib/projects/provision.ts, and this keeps the next inline copy from
 * being written.
 *
 * The same holds for a project's database. An older path created one per
 * workspace with `CREATE DATABASE` on the platform's own connection and wrote
 * its connection string into Workspace.postgresSchema, where every reader
 * expects a schema name; it was reachable from two workspace routes and the
 * executor, and it was removed. The second check below keeps creating and
 * dropping databases to one module, lib/data-plane/project-databases.ts.
 *
 * Application code only. Tests and scripts legitimately construct bare rows
 * and scratch databases to exercise a specific state, and forcing full
 * provisioning on a fixture would make the fixtures slower and less precise
 * without protecting a user.
 *
 * Usage: tsx scripts/verify-project-provisioning.ts [--root <dir>]
 */
import * as fs from 'fs'
import * as path from 'path'
import ts from 'typescript'

function rootFromArgs(argv: string[]): string {
  const i = argv.indexOf('--root')
  return i >= 0 && argv[i + 1] ? path.resolve(argv[i + 1]) : process.cwd()
}

const ROOT = rootFromArgs(process.argv.slice(2))
const APPLICATION_ROOTS = ['app', 'lib', 'server']
/**
 * Never application code. The repository's own `workspace/` directory (project
 * files) sits at the root, outside every application root, so it needs no entry:
 * naming it here would also skip app/api/workspace and lib/workspace.
 */
const SKIP_DIRS = ['node_modules', '.next', '.git', 'dist', 'coverage']

/**
 * Modules allowed to insert a Project row directly.
 *
 * Each is a place that performs the FULL sequence or is not application code
 * at all. Adding a third means writing a third provisioning path, which is the
 * thing this check exists to prevent.
 *
 * app/api/projects/route.ts used to be listed here, because it carried a second
 * complete implementation inline. Phase 7 converged it onto the provisioner
 * through ProjectLifecycle, and the stale-allowance check below is what forced
 * this entry to be removed rather than left behind as a standing permission.
 */
const ALLOWED: Record<string, string> = {
  'lib/projects/provision.ts':
    'The provisioner itself: row, graph, schema, PostgREST registration, jwtSecret.',
  'lib/testing/connection-manager.ts':
    'A test harness that builds throwaway projects, not a request path.',
}

const CREATE = /\b(?:prisma|tx)\.project\.create\s*\(/g

/**
 * The one module allowed to create or drop a database. It does not exist yet:
 * it is where a project's own database will be created and dropped, as a
 * role the web and runtime processes never hold. Until then no application
 * code creates or drops a database at all.
 */
const DATABASE_DDL_ALLOWED: Record<string, string> = {
  'lib/data-plane/project-databases.ts':
    "A project's own database: created from the template, dropped when the project is purged.",
}

/** `CREATE DATABASE` or `DROP DATABASE`, in any case and spacing. */
const DATABASE_DDL = /\b(?:create|drop)\s+database\b/i

const CODE_FILE = /\.(?:tsx?|jsx?|mjs|cjs)$/
const SQL_FILE = /\.sql$/

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue
    if (SKIP_DIRS.includes(entry.name)) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (CODE_FILE.test(entry.name) || SQL_FILE.test(entry.name)) out.push(full)
  }
  return out
}

/** Blank comments and template literals, preserving length for line numbers. */
function blankNonCode(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, m => ' '.repeat(m.length))
    .replace(/`(?:\\.|[^`\\])*`/g, m => m.replace(/[^\n]/g, ' '))
}

interface Finding {
  file: string
  line: number
}

/**
 * Where a file's string literals spell database DDL. SQL reaches PostgreSQL as
 * a string, so the strings are what is read, through TypeScript's own parser:
 * a comment that says CREATE DATABASE is not a finding, a template literal
 * that runs it is, whatever it interpolates.
 */
function databaseDdlSites(rel: string, raw: string): number[] {
  if (SQL_FILE.test(rel)) {
    return raw.split('\n').flatMap((text, i) => (DATABASE_DDL.test(text.replace(/--.*$/, '')) ? [i + 1] : []))
  }
  const kind = /\.tsx$/.test(rel)
    ? ts.ScriptKind.TSX
    : /\.ts$/.test(rel)
      ? ts.ScriptKind.TS
      : /\.jsx$/.test(rel)
        ? ts.ScriptKind.JSX
        : ts.ScriptKind.JS
  const source = ts.createSourceFile(rel, raw, ts.ScriptTarget.Latest, true, kind)
  const lines: number[] = []
  const visit = (node: ts.Node): void => {
    let text: string | null = null
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) text = node.text
    else if (ts.isTemplateExpression(node)) {
      text = node.head.text + node.templateSpans.map(s => ` \${} ${s.literal.text}`).join('')
    }
    if (text !== null && DATABASE_DDL.test(text)) {
      lines.push(source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1)
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return lines
}

function main(): void {
  const roots = APPLICATION_ROOTS.map(d => path.join(ROOT, d)).filter(fs.existsSync)
  const files: string[] = []
  for (const r of roots) walk(r, files)

  const findings: Finding[] = []
  const used = new Set<string>()
  const ddlFindings: Finding[] = []
  const ddlUsed = new Set<string>()

  for (const file of files) {
    const rel = path.relative(ROOT, file).replace(/\\/g, '/')
    const raw = fs.readFileSync(file, 'utf8')

    // Only a cheap filter: the source may spell the space as an escape (\t).
    if (/database/i.test(raw)) {
      for (const line of databaseDdlSites(rel, raw)) {
        if (DATABASE_DDL_ALLOWED[rel]) ddlUsed.add(rel)
        else ddlFindings.push({ file: rel, line })
      }
    }

    if (!/\.tsx?$/.test(rel) || !raw.includes('project.create')) continue
    const src = blankNonCode(raw)

    CREATE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = CREATE.exec(src)) !== null) {
      if (ALLOWED[rel]) {
        used.add(rel)
        continue
      }
      findings.push({ file: rel, line: src.slice(0, m.index).split('\n').length })
    }
  }

  const stale = [
    ...Object.keys(ALLOWED).filter(f => !used.has(f) && fs.existsSync(path.join(ROOT, f))),
    ...Object.keys(DATABASE_DDL_ALLOWED).filter(f => !ddlUsed.has(f) && fs.existsSync(path.join(ROOT, f))),
  ]

  if (findings.length === 0 && ddlFindings.length === 0 && stale.length === 0) {
    console.log(`project provisioning: one creation path, ${files.length} file(s) scanned`)
    console.log('project databases: created and dropped in one module only')
    return
  }

  if (findings.length > 0) {
    console.error('')
    console.error(`${findings.length} site(s) create a Project row without provisioning it:`)
    for (const f of findings) console.error(`  ${f.file}:${f.line}`)
    console.error('')
    console.error('A bare row has no workspace schema and no PostgREST registration, so')
    console.error('every data-plane request against it answers PGRST106, forever. Use:')
    console.error('')
    console.error("  import { createProvisionedProject } from '@/lib/projects/provision'")
    console.error('')
    console.error('It refuses on a single-tenant deployment, where the one project is')
    console.error('provisioned by `npm run bootstrap` and a second is not supported.')
  }

  if (ddlFindings.length > 0) {
    console.error('')
    console.error(`${ddlFindings.length} site(s) create or drop a database outside the one module that may:`)
    for (const f of ddlFindings) console.error(`  ${f.file}:${f.line}`)
    console.error('')
    console.error("A project's data lives in its workspace schema, created by createProvisionedProject")
    console.error("(lib/projects/provision.ts). A project's own database is created and dropped only in")
    console.error(`${Object.keys(DATABASE_DDL_ALLOWED).join(', ')}, never with the platform's connection.`)
  }

  if (stale.length > 0) {
    console.error('')
    console.error(`${stale.length} allowance(s) are no longer used:`)
    for (const f of stale) console.error(`  ${f}`)
    console.error('Remove them.')
  }

  process.exit(1)
}

main()
