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

const read = (file: string) => fs.readFileSync(path.join(__dirname, '..', '..', file), 'utf8')
/** The source with comments removed, so a sentence explaining what was removed does not count as code. */
const code = (file: string) => read(file).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

const WRITERS = [
  'lib/ai/infra-intelligence.ts',
  'lib/ai/frontend-coevolution.ts',
  'lib/ai/build-runtime/post-build-orchestrator.ts',
  'lib/services/workspace-observer.ts',
]

describe('the passes that used to change schemas on their own', () => {
  it.each(WRITERS.map((file) => ({ file })))('$file applies no SQL a detector suggested', ({ file }) => {
    const src = code(file)
    // The removed shapes, each a raw statement run outside the change ledger.
    expect(src).not.toMatch(/\.query\(\s*sig\.sqlFix/)
    expect(src).not.toMatch(/_applyAutoFixes/)
    expect(src).not.toMatch(/applyReconciliationMigrations/)
    expect(src).not.toMatch(/executeInWorkspaceSchema\(/)
    expect(src).not.toMatch(/\.query\(\s*`\s*(CREATE|ALTER|DROP)\b/)
  })

  it('nothing still asks the inline-repair permit, which only a schema writer needed', () => {
    for (const file of [...WRITERS, 'lib/authority/gate.ts']) expect(code(file)).not.toMatch(/permitInlineRepair/)
  })

  it('the repair loop and the fix loop ask the one freeze', () => {
    expect(code('lib/autonomy/reconciler.ts')).toMatch(/heldForIncident\(projectId, \{ loop: 'reconciler'/)
    expect(code('lib/ai/agentic-fix-loop.ts')).toMatch(/heldForIncident\(projectId, \{ loop: 'reconciler', via: 'agentic_fix_loop'/)
    expect(code('lib/services/workspace-observer.ts')).toMatch(/heldForIncident\(projectId, \{ loop: 'maintenance', via: 'function_heal'/)
  })
})
