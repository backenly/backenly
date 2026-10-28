/**
 * History write gate — fails the build when code can change the backend
 * without the change reaching the project's history.
 *
 * WHY THIS EXISTS
 * ---------------
 * A project has one history (docs/CHANGE_RECOVERY.md): every change to its
 * schema, buckets, functions, webhooks, environment, keys, sign-in and
 * integrations is an entry, restorable from one place. That is only true while
 * every writer goes through a governed change (lib/changes/ledger.ts). A writer
 * that does not is a change the history never shows and a restore never sees,
 * and the next restore of a neighbouring change can then undo it silently or
 * be refused for a reason nobody can find.
 *
 * The rows checked here are exactly the ones the history records: the models
 * the resource adapters read (lib/changes/resources/*.ts, read from the source
 * so the gate follows them), and Project.activeIntegrations.
 *
 * A write passes when one of these is true:
 *   - a governed call (`governedChange(`, `withGovernedChange(`, `governed(`,
 *     `runMutation(`) opens within WINDOW lines above it in the same file;
 *   - a `// history: <reason>` comment sits within MARK_WINDOW lines above it,
 *     saying why it is not, or not here, a change. Two kinds of reason are
 *     checked, because they are claims about other code:
 *       `GOVERNED_ACTIONS (X)`   X must be in GOVERNED_ACTIONS
 *                                (lib/ai/minimal-executor.ts);
 *       `governed by NAME`       NAME must be a function in the same file
 *                                that makes a governed call.
 *
 * IF THIS FIRES
 * -------------
 * Wrap the write: `governedChange(projectId, 'Create bucket avatars', () => …)`
 * from lib/changes/ledger.ts. Inside another governed change it joins that
 * one, so wrapping a write that is sometimes already governed costs nothing.
 * Keep a model call or any slow network call outside the wrap: only the write
 * holds the project's change lock. Use a `// history:` comment only for a
 * write that is not configuration (a last-used stamp, how a run went) or that
 * belongs to something else's lifecycle, and say which.
 *
 * Run: npm run verify:history-writes   (part of `npm run build`, which CI runs)
 */

import fs from 'fs'
import path from 'path'

const ROOT = path.resolve(__dirname, '..')
const SCAN_DIRS = ['app', 'lib', 'server', 'packages']
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.next', 'coverage', '__tests__'])
/** The history itself, which writes these rows when it restores them. */
const OWN = 'lib/changes/'
const WINDOW = 25
const MARK_WINDOW = 4

const GOVERNED_CALL = /\b(governedChange|withGovernedChange|governed|runMutation)\(/
const MARK = /\/\/ history: (.+)$/

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8')
}

/** The models the resource adapters capture, read from their source. */
function recordedModels(): string[] {
  const dir = path.join(ROOT, 'lib/changes/resources')
  const models = new Set<string>()
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.ts')) continue
    for (const m of read(`lib/changes/resources/${f}`).matchAll(/\bprisma\.(\w+)\.find(?:Many|First|Unique)\(/g)) models.add(m[1])
  }
  models.delete('project') // only its activeIntegrations is recorded; checked on its own
  models.delete('storageFile') // a bucket's contents are data, counted, never restored
  models.delete('multipartUpload')
  if (models.size === 0) throw new Error('no recorded models found in lib/changes/resources: the gate would check nothing')
  return [...models].sort()
}

function governedActions(): Set<string> {
  const src = read('lib/ai/minimal-executor.ts')
  const block = /const GOVERNED_ACTIONS = new Set<[^>]+>\(\[([\s\S]*?)\]\)/.exec(src)
  if (!block) throw new Error('GOVERNED_ACTIONS not found in lib/ai/minimal-executor.ts')
  return new Set([...block[1].replace(/\/\/.*$/gm, '').matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]))
}

function walk(dir: string, out: string[]): void {
  const abs = path.join(ROOT, dir)
  if (!fs.existsSync(abs)) return
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    const rel = path.posix.join(dir, e.name)
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(rel, out)
    } else if (/\.(ts|tsx)$/.test(e.name) && !/\.(test|spec)\.tsx?$/.test(e.name) && !rel.startsWith(OWN)) {
      out.push(rel)
    }
  }
}

/** Whether NAME is a function in `lines` whose first few lines make a governed call. */
function governsByName(lines: string[], name: string): boolean {
  const decl = new RegExp(`\\b(function\\s+${name}\\b|${name}\\s*\\(.*\\)\\s*(:[^{]*)?\\{\\s*$|${name}\\s*=\\s*async)`)
  return lines.some((l, i) => decl.test(l) && lines.slice(i, i + 8).some((x) => GOVERNED_CALL.test(x)))
}

function main(): void {
  const models = recordedModels()
  const write = new RegExp(`\\b\\w+\\.(${models.join('|')})\\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\\(`)
  const actions = governedActions()
  const files: string[] = []
  for (const d of SCAN_DIRS) walk(d, files)

  const failures: string[] = []
  for (const rel of files) {
    const lines = read(rel).split('\n')
    lines.forEach((line, at) => {
      // A Project.activeIntegrations write is judged at its update call.
      let i = at
      if (!write.test(line)) {
        if (!/\bactiveIntegrations\s*:/.test(line)) return
        const call = lines.slice(Math.max(0, at - 8), at + 1).map((l) => /\.project\.(update|updateMany|upsert)\(/.test(l)).lastIndexOf(true)
        if (call < 0) return
        i = Math.max(0, at - 8) + call
      }
      const where = `${rel}:${at + 1}`
      const mark = lines.slice(Math.max(0, i - MARK_WINDOW), i + 1).map((l) => MARK.exec(l)?.[1]).filter(Boolean).pop()
      if (mark) {
        const action = /^GOVERNED_ACTIONS \(([A-Z_]+)\)/.exec(mark)?.[1]
        if (action && !actions.has(action)) failures.push(`${where}  says GOVERNED_ACTIONS (${action}), which is not in GOVERNED_ACTIONS`)
        const by = /^governed by (\w+)/.exec(mark)?.[1]
        if (by && !governsByName(lines, by)) failures.push(`${where}  says governed by ${by}, which makes no governed call in this file`)
        return
      }
      if (lines.slice(Math.max(0, i - WINDOW), i + 1).some((l) => GOVERNED_CALL.test(l))) return
      failures.push(`${where}  ${line.trim().slice(0, 120)}`)
    })
  }

  if (failures.length > 0) {
    console.error(`✗ ${failures.length} write(s) would change the backend outside its history:\n`)
    for (const f of failures) console.error(`  ${f}`)
    console.error('\nWrap each in governedChange (lib/changes/ledger.ts), or say why it is not a change with a `// history:` comment. See the header of scripts/assert-history-writes.ts.')
    process.exit(1)
  }
  console.log(`✓ Every write to ${models.length} recorded models and activeIntegrations reaches the history (${files.length} files).`)
}

main()
