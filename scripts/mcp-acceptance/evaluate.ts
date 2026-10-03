/**
 * The acceptance matrix's rules, kept apart from the CLI so they are tested.
 *
 * A case is PASS only when every test named as its evidence ran and passed.
 * Evidence that did not run, matched nothing, or was skipped is a FAIL, never
 * a PASS: a green that nothing proved is the failure this matrix exists to
 * refuse. DEFERRED_TO_FINAL_STAGING_RELEASE_GATE stays DEFERRED until results
 * from the final staging run are supplied, and becomes PASS or FAIL only from
 * those results.
 */

export type Status = 'PASS' | 'FAIL' | 'SKIP_WITH_REASON' | 'DEFERRED_TO_FINAL_STAGING_RELEASE_GATE'

export type Suite = 'unit' | 'integration'

export interface Deferral {
  /** What to run on the final staging gate, exactly. */
  command: string
  /** Environment variables the command reads. */
  env: string[]
  preconditions: string
  expected: string
  cleanup: string
  /** Why it cannot run before the final staging image exists. */
  why: string
  /** Live harness case ids whose results decide the case once supplied (scripts/mcp-harness). */
  harness?: string[]
}

export type Evidence =
  | { kind: 'jest'; suite: Suite; file: string; tests: RegExp[] }
  | { kind: 'job'; job: string; what: string }
  | { kind: 'deferred'; deferral: Deferral }
  | { kind: 'skip'; reason: string }

export interface AcceptanceCase {
  id: string
  area: string
  title: string
  evidence: Evidence
}

export interface JestResult {
  /** Repository-relative, forward slashes. */
  file: string
  tests: Array<{ fullName: string; status: string }>
}

export interface Inputs {
  jest: Partial<Record<Suite, JestResult[]>>
  jobs: Record<string, string>
  live: Record<string, string> | null
  /** In CI every source must be supplied; a missing one fails its cases. */
  requireAll: boolean
}

export interface Outcome {
  id: string
  area: string
  title: string
  status: Status
  detail: string
  deferral?: Deferral
}

/** "F:\\repo\\tests\\unit\\x.spec.ts" or "/home/runner/work/x/x/tests/unit/x.spec.ts" -> "tests/unit/x.spec.ts". */
export function repoRelative(path: string): string {
  const p = path.replace(/\\/g, '/')
  const at = p.search(/(^|\/)(tests|__tests__)\//)
  return at === -1 ? p : p.slice(at === 0 ? 0 : at + 1)
}

/** jest's --json output, reduced to what the matrix reads. */
export function fromJestJson(json: any): JestResult[] {
  return (json?.testResults ?? []).map((r: any) => ({
    file: repoRelative(String(r.name ?? r.testFilePath ?? '')),
    tests: (r.assertionResults ?? []).map((a: any) => ({
      fullName: String(a.fullName ?? [...(a.ancestorTitles ?? []), a.title].join(' ')),
      status: String(a.status),
    })),
  }))
}

/** The harness's --json output, as id -> pass | fail | skip. */
export function fromHarnessJson(json: any): Record<string, string> {
  const out: Record<string, string> = {}
  for (const c of json?.cases ?? []) out[String(c.id)] = String(c.status)
  return out
}

function judgeJest(e: Extract<Evidence, { kind: 'jest' }>, inputs: Inputs): { status: Status; detail: string } {
  const results = inputs.jest[e.suite]
  if (!results) {
    return inputs.requireAll
      ? { status: 'FAIL', detail: `the ${e.suite} results were not supplied, so nothing proved this` }
      : { status: 'SKIP_WITH_REASON', detail: `the ${e.suite} results were not supplied to this run` }
  }
  const file = results.find((r) => r.file === e.file)
  if (!file) return { status: 'FAIL', detail: `${e.file} did not run` }
  let matched = 0
  for (const re of e.tests) {
    const hits = file.tests.filter((t) => re.test(t.fullName))
    if (hits.length === 0) return { status: 'FAIL', detail: `no test in ${e.file} matched ${re}` }
    const bad = hits.filter((t) => t.status !== 'passed')
    if (bad.length) return { status: 'FAIL', detail: `${bad.length} ${bad[0].status}: ${bad[0].fullName}` }
    matched += hits.length
  }
  return { status: 'PASS', detail: `${matched} test(s) passed in ${e.file}` }
}

export function evaluate(c: AcceptanceCase, inputs: Inputs): Outcome {
  const base = { id: c.id, area: c.area, title: c.title }
  const e = c.evidence
  switch (e.kind) {
    case 'jest':
      return { ...base, ...judgeJest(e, inputs) }
    case 'job': {
      const result = inputs.jobs[e.job]
      if (!result) {
        return inputs.requireAll
          ? { ...base, status: 'FAIL', detail: `the ${e.job} job result was not supplied` }
          : { ...base, status: 'SKIP_WITH_REASON', detail: `the ${e.job} job result was not supplied to this run` }
      }
      return result === 'success'
        ? { ...base, status: 'PASS', detail: `the ${e.job} job passed: ${e.what}` }
        : { ...base, status: 'FAIL', detail: `the ${e.job} job was ${result}: ${e.what}` }
    }
    case 'skip':
      return { ...base, status: 'SKIP_WITH_REASON', detail: e.reason }
    case 'deferred': {
      const ids = e.deferral.harness ?? []
      if (inputs.live && ids.length && ids.every((id) => inputs.live![id] !== undefined)) {
        const failed = ids.filter((id) => inputs.live![id] !== 'pass')
        return failed.length
          ? { ...base, status: 'FAIL', detail: `on the final staging run: ${failed.map((id) => `${id} ${inputs.live![id]}`).join(', ')}`, deferral: e.deferral }
          : { ...base, status: 'PASS', detail: `on the final staging run: ${ids.join(', ')} passed`, deferral: e.deferral }
      }
      return { ...base, status: 'DEFERRED_TO_FINAL_STAGING_RELEASE_GATE', detail: e.deferral.why, deferral: e.deferral }
    }
  }
}

export function summarise(outcomes: Outcome[]): Record<Status, number> {
  const counts: Record<Status, number> = { PASS: 0, FAIL: 0, SKIP_WITH_REASON: 0, DEFERRED_TO_FINAL_STAGING_RELEASE_GATE: 0 }
  for (const o of outcomes) counts[o.status]++
  return counts
}

export function renderMarkdown(outcomes: Outcome[], sources: string[]): string {
  const counts = summarise(outcomes)
  const lines = [
    '# MCP acceptance matrix',
    '',
    `PASS ${counts.PASS} · FAIL ${counts.FAIL} · SKIP_WITH_REASON ${counts.SKIP_WITH_REASON} · DEFERRED_TO_FINAL_STAGING_RELEASE_GATE ${counts.DEFERRED_TO_FINAL_STAGING_RELEASE_GATE}`,
    '',
    `Sources: ${sources.join(', ') || 'none'}`,
    '',
  ]
  for (const area of [...new Set(outcomes.map((o) => o.area))]) {
    lines.push(`## ${area}`, '', '| Case | Status | Detail |', '| --- | --- | --- |')
    for (const o of outcomes.filter((x) => x.area === area)) {
      lines.push(`| ${o.id}: ${o.title.replace(/\|/g, '\\|')} | ${o.status} | ${o.detail.replace(/\|/g, '\\|')} |`)
    }
    lines.push('')
  }
  const deferred = outcomes.filter((o) => o.status === 'DEFERRED_TO_FINAL_STAGING_RELEASE_GATE' && o.deferral)
  if (deferred.length) {
    lines.push('## Deferred to the final staging release gate', '')
    for (const o of deferred) {
      const d = o.deferral!
      lines.push(
        `### ${o.id}`, '',
        `- **Command:** \`${d.command}\``,
        `- **Environment:** ${d.env.length ? d.env.map((v) => `\`${v}\``).join(', ') : 'none'}`,
        `- **Preconditions:** ${d.preconditions}`,
        `- **Expected:** ${d.expected}`,
        `- **Cleanup:** ${d.cleanup}`,
        `- **Why staging:** ${d.why}`,
        '',
      )
    }
  }
  return lines.join('\n')
}
