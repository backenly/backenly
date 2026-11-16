/**
 * The Functions console shows what runs and says what a run does
 * (medium findings FN-16, FN-17).
 *
 * FN-16: deploy_code promises "stored code is shown on the dashboard" and
 * hands the human a codeSha256 receipt — but the console rendered no source
 * anywhere, so there was nothing to compare the receipt against.
 *
 * FN-17: "Test run" and "Run all once" execute functions for real (admin
 * privileges, live database, real emails, real quota) while the UI framed
 * them as harmless; the run route also flipped any function to 'active'
 * BEFORE running it, silently re-enabling functions the owner switched off.
 */

import fs from 'fs'
import path from 'path'

const ROOT = process.cwd()
// The page was split (project console rebuild, 2026-11-16): the workbench, its
// model (triggers, states, the classifiers), the Code view and the Test run
// dialog. The truths below are read across all four.
const read = (file: string) => fs.readFileSync(path.join(ROOT, 'components', 'functions', file), 'utf8')
const workbench = ['FunctionsWorkbench.tsx', 'model.ts', 'CodeView.tsx', 'TestRunDialog.tsx'].map(read).join('\n')
const runRoute = fs.readFileSync(
  path.join(ROOT, 'app', 'api', 'projects', '[id]', 'ai-functions', '[functionId]', 'run', 'route.ts'),
  'utf8',
)

describe('FN-16: the console shows the deployed source', () => {
  it('renders a read-only Code view from the stored generatedCode', () => {
    expect(workbench).toContain('fn.generatedCode')
    expect(workbench).toContain('export function CodeView')
    expect(workbench).toContain("setTab(v === 'code' ? 'code' : 'runs')")
  })

  it('computes the sha256 of the stored bytes for the deploy_code receipt', () => {
    expect(workbench).toContain("digest('SHA-256'")
    expect(workbench).toContain('deploy_code receipt')
  })
})

describe('FN-17: a test run is a real run and says so', () => {
  it('the run route never flips status before executing', () => {
    expect(runRoute).not.toContain("data: { status: 'active' }")
    expect(runRoute).not.toContain('Re-activate for manual run')
  })

  it('the Test run dialog and the bulk confirm say the run has real side effects', () => {
    expect(workbench).toContain('for real. Writes, emails and quota count.')
    expect(workbench).toContain('Each runs once, for real, with an empty request: writes, emails and quota count.')
  })

  it('bulk run only covers endpoint-style functions', () => {
    expect(workbench).toContain('runnableUntestedFns')
    expect(workbench).toContain('isBulkRunnable(f)')
    expect(workbench).toMatch(/kind === 'manual' \|\| kind === 'http'/)
  })

  it('a 400 is reported as the response it was, not as proof of validation', () => {
    expect(workbench).not.toContain('The endpoint ran and validated its input.')
    expect(workbench).toContain('It answered 400 to this payload: its own validation, not a failure.')
  })

  it('a test run sends the payload typed into the dialog, not an empty event', () => {
    expect(workbench).toContain('body: JSON.stringify({ event })')
  })
})

describe("FN-18: 'Remove all' cannot classify agent code as cleanup fodder", () => {
  it('the schema-helper classifier requires the server to say Backenly generated it, not just a name shape', () => {
    // An agent-deployed function named `invoices-schema` with no run yet
    // matched the bare name heuristic, and the bulk cleanup deleted it as an
    // "auto-generated validation-schema endpoint". The server's `generated`
    // flag never marks agent code, nor an endpoint an agent asked Backenly to
    // write (tests/unit/generated-endpoint.spec.ts).
    expect(workbench).toMatch(/fn\.generated === true && SCHEMA_FN_RE\.test\(fn\.name\)/)
  })
})
