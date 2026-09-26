/**
 * The acceptance matrix can only say what its evidence says.
 *
 * scripts/mcp-acceptance/evaluate.ts turns CI's own results into PASS, FAIL,
 * SKIP_WITH_REASON or DEFERRED_TO_FINAL_STAGING_RELEASE_GATE. These hold its
 * rules: nothing is a PASS without an executed, passing test behind it, and a
 * deferred case stays deferred until the final staging run reports on it. The
 * manifest is checked too: every case names evidence that exists and runs.
 */

import fs from 'fs'
import path from 'path'
import { ACCEPTANCE_CASES } from '../../scripts/mcp-acceptance/cases'
import { evaluate, fromJestJson, repoRelative, type AcceptanceCase, type Inputs } from '../../scripts/mcp-acceptance/evaluate'

const ROOT = process.cwd()

const jestCase: AcceptanceCase = {
  id: 'X', area: 'A', title: 't',
  evidence: { kind: 'jest', suite: 'integration', file: 'tests/integration/x.spec.ts', tests: [/does the thing/, /refuses the other/] },
}
const deferred: AcceptanceCase = {
  id: 'D', area: 'A', title: 't',
  evidence: { kind: 'deferred', deferral: { command: 'c', env: [], preconditions: 'p', expected: 'e', cleanup: 'x', why: 'w', harness: ['H-1', 'H-2'] } },
}
const inputs = (over: Partial<Inputs> = {}): Inputs => ({ jest: {}, jobs: {}, live: null, requireAll: true, ...over })
const run = (tests: Array<[string, string]>) => ({
  integration: [{ file: 'tests/integration/x.spec.ts', tests: tests.map(([fullName, status]) => ({ fullName, status })) }],
})

describe('the rules', () => {
  it('passes a case only when every named test ran and passed', () => {
    expect(evaluate(jestCase, inputs({ jest: run([['it does the thing', 'passed'], ['it refuses the other', 'passed']]) })).status).toBe('PASS')
  })

  it('fails a case when a named test failed, was skipped, or matched nothing', () => {
    expect(evaluate(jestCase, inputs({ jest: run([['it does the thing', 'passed'], ['it refuses the other', 'failed']]) })).status).toBe('FAIL')
    expect(evaluate(jestCase, inputs({ jest: run([['it does the thing', 'passed'], ['it refuses the other', 'pending']]) })).status).toBe('FAIL')
    expect(evaluate(jestCase, inputs({ jest: run([['it does the thing', 'passed']]) })).status).toBe('FAIL')
  })

  it('fails a case whose file did not run, and one whose results were not supplied in CI', () => {
    expect(evaluate(jestCase, inputs({ jest: { integration: [] } })).status).toBe('FAIL')
    expect(evaluate(jestCase, inputs()).status).toBe('FAIL')
  })

  it('outside CI, says results were not supplied rather than passing or failing', () => {
    expect(evaluate(jestCase, inputs({ requireAll: false })).status).toBe('SKIP_WITH_REASON')
  })

  it('never turns a deferral into a PASS without the final staging results', () => {
    expect(evaluate(deferred, inputs()).status).toBe('DEFERRED_TO_FINAL_STAGING_RELEASE_GATE')
    expect(evaluate(deferred, inputs({ live: { 'H-1': 'pass' } })).status).toBe('DEFERRED_TO_FINAL_STAGING_RELEASE_GATE')
  })

  it('decides a deferral from the final staging results once every harness case reported', () => {
    expect(evaluate(deferred, inputs({ live: { 'H-1': 'pass', 'H-2': 'pass' } })).status).toBe('PASS')
    expect(evaluate(deferred, inputs({ live: { 'H-1': 'pass', 'H-2': 'fail' } })).status).toBe('FAIL')
    expect(evaluate(deferred, inputs({ live: { 'H-1': 'pass', 'H-2': 'skip' } })).status).toBe('FAIL')
  })

  it('reads a job result, and fails anything but success', () => {
    const c: AcceptanceCase = { id: 'J', area: 'A', title: 't', evidence: { kind: 'job', job: 'mcp-server', what: 'w' } }
    expect(evaluate(c, inputs({ jobs: { 'mcp-server': 'success' } })).status).toBe('PASS')
    expect(evaluate(c, inputs({ jobs: { 'mcp-server': 'failure' } })).status).toBe('FAIL')
    expect(evaluate(c, inputs({ jobs: { 'mcp-server': 'skipped' } })).status).toBe('FAIL')
    expect(evaluate(c, inputs()).status).toBe('FAIL')
  })

  it('reads jest paths from Windows and Linux runners alike', () => {
    expect(repoRelative('F:\\wt-mcp\\tests\\unit\\a.spec.ts')).toBe('tests/unit/a.spec.ts')
    expect(repoRelative('/home/runner/work/backenly/backenly/tests/integration/b.spec.ts')).toBe('tests/integration/b.spec.ts')
    expect(repoRelative('/x/__tests__/database/c.test.ts')).toBe('__tests__/database/c.test.ts')
    const parsed = fromJestJson({ testResults: [{ name: '/r/tests/unit/a.spec.ts', assertionResults: [{ ancestorTitles: ['d'], title: 't', fullName: 'd t', status: 'passed' }] }] })
    expect(parsed).toEqual([{ file: 'tests/unit/a.spec.ts', tests: [{ fullName: 'd t', status: 'passed' }] }])
  })
})

describe('the cases', () => {
  const dbSuites = fs.readFileSync(path.join(ROOT, '.github', 'database-backed-suites.txt'), 'utf8')
    .split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))

  it('gives every case a unique id', () => {
    const ids = ACCEPTANCE_CASES.map((c) => c.id)
    expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([])
  })

  it('covers every area the acceptance brief names', () => {
    const areas = new Set(ACCEPTANCE_CASES.map((c) => c.area))
    for (const a of ['Protocol', 'Transports', 'Keys', 'Database', 'Auth', 'RLS', 'Storage', 'Functions', 'Realtime', 'Integrations',
      'Webhooks', 'Monitoring', 'Autonomy', 'Branches', 'Deploy', 'Connect', 'Approvals', 'Failure recovery', 'Golden workflows']) {
      expect([a, areas.has(a)]).toEqual([a, true])
    }
  })

  it.each(ACCEPTANCE_CASES.filter((c) => c.evidence.kind === 'jest').map((c) => [c.id, c] as const))('%s names a suite that exists and runs on a CI job', (_id, c) => {
    const e = c.evidence as Extract<AcceptanceCase['evidence'], { kind: 'jest' }>
    expect(fs.existsSync(path.join(ROOT, e.file))).toBe(true)
    if (e.suite === 'unit') expect(e.file.startsWith('tests/unit/')).toBe(true)
    else expect(dbSuites).toContain(e.file)
    // Every name it matches on is written in that file, so a rename breaks here first.
    const source = fs.readFileSync(path.join(ROOT, e.file), 'utf8').replace(/\\(['"`])/g, '$1')
    expect(e.tests.length).toBeGreaterThan(0)
    for (const re of e.tests) {
      const literal = re.source.replace(/\\(.)/g, '$1')
      const words = literal.split(/\s+/).filter((w) => w.length > 3).slice(0, 3)
      for (const w of words) expect([re.source, w, source.includes(w)]).toEqual([re.source, w, true])
    }
  })

  it.each(ACCEPTANCE_CASES.filter((c) => c.evidence.kind === 'deferred').map((c) => [c.id, c] as const))('%s says exactly how the release session runs it', (_id, c) => {
    const d = (c.evidence as Extract<AcceptanceCase['evidence'], { kind: 'deferred' }>).deferral
    for (const field of ['command', 'preconditions', 'expected', 'cleanup', 'why'] as const) expect([field, d[field].length > 10]).toEqual([field, true])
    for (const v of d.env) expect(d.command.includes(`$${v}`) || d.command.includes(`"$${v}"`) || v.startsWith('BACKENLY_')).toBe(true)
  })

  it('names only harness cases the harness has', () => {
    const harness = fs.readFileSync(path.join(ROOT, 'scripts', 'mcp-harness', 'cases.ts'), 'utf8')
    const named = ACCEPTANCE_CASES.flatMap((c) => (c.evidence.kind === 'deferred' ? c.evidence.deferral.harness ?? [] : []))
    expect(named.length).toBeGreaterThan(3)
    for (const id of named) expect([id, harness.includes(`id: '${id}'`)]).toEqual([id, true])
  })

  it('names only CI jobs that exist', () => {
    const ci = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8')
    for (const c of ACCEPTANCE_CASES) if (c.evidence.kind === 'job') expect(ci).toMatch(new RegExp(`^  ${c.evidence.job}:$`, 'm'))
  })
})
