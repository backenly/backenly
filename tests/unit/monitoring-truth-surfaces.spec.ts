/**
 * Monitoring tells the truth about what it measures (MON-05, MON-06).
 *
 * MON-05: the Anomaly table is written only by a POST nothing calls — no
 * cron, no autonomy module, no UI caller. The workbench rail and three doc
 * sites still claimed running anomaly detection. The rail section and the
 * claims are gone; unusual-behaviour detection is the autonomy loop's job
 * and the docs now say where it lives. (The deliberate decision that
 * Monitoring stays neutral — no auto-triggered detectors, no badges — is
 * recorded product policy; the words had drifted ahead of it.)
 *
 * MON-06: a failed /api/monitoring/stats fetch rendered the same zeros as a
 * genuinely quiet backend ("Nothing to watch yet"), because every fetch error
 * collapsed to defaults. A failed read now keeps the last known values and
 * says how old they are, and a failed first read is an error row, never
 * zeros. (Rebuilt 2026-11-16: the reads live in components/monitoring/data.ts
 * and the Overview's states in OverviewPane.tsx.)
 */

import fs from 'fs'
import path from 'path'

const ROOT = process.cwd()
const workbench = fs.readFileSync(
  path.join(ROOT, 'components', 'monitoring', 'MonitoringWorkbench.tsx'),
  'utf8',
)
const data = fs.readFileSync(path.join(ROOT, 'components', 'monitoring', 'data.ts'), 'utf8')
const overviewPane = fs.readFileSync(path.join(ROOT, 'components', 'monitoring', 'OverviewPane.tsx'), 'utf8')
const docsContent = fs.readFileSync(path.join(ROOT, 'app', 'docs', 'content.ts'), 'utf8')
const agentDoc = fs.readFileSync(path.join(ROOT, 'public', 'docs', 'agents', 'monitoring.md'), 'utf8')

describe('MON-05: no claimed detector without a detector', () => {
  it('the workbench no longer fetches or renders the dead anomalies store', () => {
    expect(workbench).not.toContain('getAnomalies')
    expect(workbench).not.toContain("'anomaly' : 'anomalies'")
  })

  it('the console docs stop claiming anomalies appear beside the charts', () => {
    expect(docsContent).not.toContain('Anomalies and system events appear beside the charts')
    expect(docsContent).toContain('Unusual behaviour is the autonomy loop')
  })

  it('the agent docs route unusual-behaviour detection to Autonomy', () => {
    expect(agentDoc).not.toContain('anomaly detection')
    expect(agentDoc).toContain('autonomy loop')
  })
})

describe('MON-06: a failed read is not zero traffic', () => {
  it('a stats answer without totals is a failed read, not zeros, and the first one shows an error row', () => {
    expect(data).toContain("throw new Error('The stats answer had no totals')")
    expect(workbench).toContain('setOverviewFailed(true)')
    expect(overviewPane).toMatch(/if \(!overview\) \{\s*if \(failed\) \{/)
    expect(overviewPane).toContain('<ErrorRow things="traffic"')
  })

  it('a failed re-read keeps the last known values and says how old they are', () => {
    // The old catch rewrote metrics with { value: 0, ... } stubs.
    expect(workbench).not.toContain("responseTime: { value: 0, change: 0, status: 'healthy' }")
    expect(overviewPane).toContain('staleAt={readAt}')
  })

  it("the 'No requests yet' empty state never covers a failed read", () => {
    // It is reached only once the totals were read (a failed first read returned the error row above).
    expect(overviewPane).toContain('total === 0 && requests && requests.length === 0')
  })
})
