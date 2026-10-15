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
const workbench = fs.readFileSync(
  path.join(ROOT, 'components', 'functions', 'FunctionsWorkbench.tsx'),
  'utf8',
)
const runRoute = fs.readFileSync(
  path.join(ROOT, 'app', 'api', 'projects', '[id]', 'ai-functions', '[functionId]', 'run', 'route.ts'),
  'utf8',
)

describe('FN-16: the console shows the deployed source', () => {
  it('renders a read-only Code tab from the stored generatedCode', () => {
    expect(workbench).toContain('generatedCode')
    expect(workbench).toContain('function CodeTab')
    expect(workbench).toContain("setTab('code')")
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

  it('the banner and button say the run has real side effects', () => {
    expect(workbench).toContain('Test runs execute for real')
    expect(workbench).toContain('writes, emails and quota count')
  })

  it('bulk run only covers endpoint-style functions', () => {
    expect(workbench).toContain('runnableUntestedFns')
    expect(workbench).toMatch(/kind === 'manual' \|\| kind === 'http'/)
  })

  it('a 400 is reported as the response it was, not as proof of validation', () => {
    expect(workbench).not.toContain('The endpoint ran and validated its input.')
    expect(workbench).toContain('answered 400 to the empty test event')
  })
})

describe("FN-18: 'Remove all' cannot classify agent code as cleanup fodder", () => {
  it('the schema-helper classifier requires a non-agent codeOrigin, not just a name shape', () => {
    // An agent-deployed function named `invoices-schema` with no run yet
    // matched the bare name heuristic, and the bulk cleanup deleted it as an
    // "auto-generated validation-schema endpoint".
    expect(workbench).toContain("fn.codeOrigin !== 'agent'")
    expect(workbench).toMatch(/codeOrigin !== 'agent'[\s\S]{0,160}SCHEMA_FN_RE\.test\(fn\.name\)/)
  })
})
