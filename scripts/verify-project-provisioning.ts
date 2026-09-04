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
 * Application code only. Tests and scripts legitimately construct bare rows to
 * exercise a specific state, and forcing full provisioning on a fixture would
 * make the fixtures slower and less precise without protecting a user.
 *
 * Usage: tsx scripts/verify-project-provisioning.ts
 */
import * as fs from 'fs'
import * as path from 'path'

const ROOT = process.cwd()
const SKIP_DIRS = ['node_modules', '.next', 'workspace', '.git', 'dist', 'coverage']

/**
 * Modules allowed to insert a Project row directly.
 *
 * Each is a place that performs the FULL sequence or is not application code
 * at all. Adding a fourth means writing a fourth provisioning path, which is
 * the thing this check exists to prevent.
 */
const ALLOWED: Record<string, string> = {
  'lib/projects/provision.ts':
    'The provisioner itself: row, graph, schema, PostgREST registration, jwtSecret.',
  'app/api/projects/route.ts':
    'The Cloud multi-project creation route, which performs the same sequence inline. ' +
    'It converges onto the provisioner when the project lifecycle moves to the private ' +
    'control plane; until then it is the other complete implementation, not a bypass.',
  'lib/testing/connection-manager.ts':
    'A test harness that builds throwaway projects, not a request path.',
}

const CREATE = /\b(?:prisma|tx)\.project\.create\s*\(/g

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue
    if (SKIP_DIRS.includes(entry.name)) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (/\.tsx?$/.test(entry.name)) out.push(full)
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

function main(): void {
  const roots = ['app', 'lib', 'server'].map(d => path.join(ROOT, d)).filter(fs.existsSync)
  const files: string[] = []
  for (const r of roots) walk(r, files)

  const findings: Array<{ file: string; line: number }> = []
  const used = new Set<string>()

  for (const file of files) {
    const rel = path.relative(ROOT, file).replace(/\\/g, '/')
    const raw = fs.readFileSync(file, 'utf8')
    if (!raw.includes('project.create')) continue
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

  const stale = Object.keys(ALLOWED).filter(f => !used.has(f) && fs.existsSync(path.join(ROOT, f)))

  if (findings.length === 0 && stale.length === 0) {
    console.log(`project provisioning: one creation path, ${files.length} file(s) scanned`)
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

  if (stale.length > 0) {
    console.error('')
    console.error(`${stale.length} allowance(s) are no longer used:`)
    for (const f of stale) console.error(`  ${f}`)
    console.error('Remove them.')
  }

  process.exit(1)
}

main()
