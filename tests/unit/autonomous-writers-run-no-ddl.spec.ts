/**
 * The passes that used to change a project's schema on their own run no DDL of
 * their own: every autonomous repair goes through the governed kernel
 * (runAutoFix), held during an incident (lib/autonomy/change-freeze.ts).
 *
 * Read from the source, because the infra pass needs a measured hot table
 * (pg_stat_statements and hundreds of thousands of rows) to reach the code that
 * applied its index, and a guard on the source holds for every input. The
 * behaviour of the other passes is asserted against a real database in
 * tests/core/autonomous-writers-are-governed.test.ts.
 */

import fs from 'node:fs'
import path from 'node:path'

import { LOOP_TICK_ACTIONS } from '@/lib/autonomy/loop-tick'
import { LOOP_HELD, REPAIR_HELD } from '@/lib/autonomy/change-freeze'

const read = (file: string) => fs.readFileSync(path.join(__dirname, '..', '..', file), 'utf8')
/** The source with comments removed, so a sentence explaining what was removed does not count as code. */
const code = (file: string) => read(file).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

/** A top-level function's text, from its declaration to its closing brace at the start of a line. */
function bodyOf(src: string, name: string): string {
  const start = src.search(new RegExp(`^(export )?(async )?function ${name}\\(`, 'm'))
  if (start < 0) throw new Error(`no function ${name}`)
  return src.slice(start, src.indexOf('\n}\n', start))
}

/**
 * What the autonomous passes run, by file and function. The whole file where
 * all of it is the pass; only the pass where a file also holds a path a person
 * triggers (coevolution's /coevolution?apply=true).
 */
const PASSES: Array<{ file: string; fns?: string[] }> = [
  { file: 'lib/ai/infra-intelligence.ts' },
  { file: 'lib/ai/frontend-coevolution.ts', fns: ['runAndStoreFrontendCoevolution', 'analyzeAuditLogSignals', 'analyzeCoevolutionGaps'] },
  { file: 'lib/ai/build-runtime/post-build-orchestrator.ts' },
  { file: 'lib/services/workspace-observer.ts' },
]

const sourceOf = ({ file, fns }: { file: string; fns?: string[] }) =>
  fns ? fns.map((fn) => bodyOf(code(file), fn)).join('\n') : code(file)

/**
 * How each query call in `src` begins: its first argument, typed calls
 * (`.query<Row>(`) included, and Prisma's raw reads alike. A variable, an
 * object or a literal that writes would each show here.
 */
const queryHeads = (src: string): string[] => [
  ...[...src.matchAll(/(?:\.query|\$queryRawUnsafe)(?:<[^()]*?>)?\(\s*(\S[\s\S]{0,80})/g)].map((m) => m[1]),
  ...[...src.matchAll(/\$queryRaw(?:<[^()]*?>)?(`[\s\S]{0,80})/g)].map((m) => m[1]),
]

describe('the passes that used to change schemas on their own', () => {
  it.each(PASSES.map((p) => ({ ...p, label: p.fns ? `${p.file} (${p.fns.join(', ')})` : p.file })))('$label runs no DDL of its own', (pass) => {
    const src = sourceOf(pass)
    // No raw statement of any kind, and no helper that runs one.
    expect(src).not.toMatch(/\$executeRaw/)
    expect(src).not.toMatch(/executeInWorkspaceSchema\(/)
    expect(src).not.toMatch(/applyReconciliationMigrations/)
    // Every query it sends is a literal read: never a variable or an object
    // holding SQL a detector suggested, never a literal that writes.
    for (const head of queryHeads(src)) expect(head).toMatch(/^[`'"]\s*(SELECT|WITH)\b/i)
  })

  it('sees the query calls these passes do make, typed ones included', () => {
    // The guard above is only as good as its pattern.
    const heads = PASSES.flatMap((p) => queryHeads(sourceOf(p)))
    expect(heads.length).toBeGreaterThanOrEqual(6)
    expect(queryHeads('await pool.query<{ n: number }>(\n  `SELECT 1`)')).toEqual(['`SELECT 1`)'])
    // What it exists to catch, each shape a write could take.
    for (const write of ['pool.query(sig.sqlFix)', 'pool.query({ text: sql })', 'pool.query(`CREATE INDEX i ON t (c)`)', 'db.$queryRawUnsafe(sql)', 'db.$queryRaw`ALTER TABLE t ADD c int`']) {
      expect(queryHeads(write).every((h) => /^[`'"]\s*(SELECT|WITH)\b/i.test(h))).toBe(false)
    }
  })

  it('nothing still asks the inline-repair permit, which only a schema writer needed', () => {
    for (const file of [...PASSES.map((p) => p.file), 'lib/authority/gate.ts']) expect(code(file)).not.toMatch(/permitInlineRepair/)
  })

  it('the repair loop, the fix loop and the function heal ask the one freeze', () => {
    expect(code('lib/autonomy/reconciler.ts')).toMatch(/heldForIncident\(projectId, \{ loop: 'reconciler', wouldHaveApplied/)
    expect(code('lib/ai/agentic-fix-loop.ts')).toMatch(/heldForIncident\(projectId, \{ loop: 'reconciler', via: 'agentic_fix_loop'/)
    expect(code('lib/services/workspace-observer.ts')).toMatch(/heldForIncident\(projectId, \{ loop: 'maintenance', via: 'function_heal'/)
  })

  it("a hold on another path is not one of the loop's ticks", () => {
    expect(LOOP_TICK_ACTIONS).toContain(LOOP_HELD)
    expect(LOOP_TICK_ACTIONS as readonly string[]).not.toContain(REPAIR_HELD)
  })
})
