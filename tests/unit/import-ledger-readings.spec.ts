/**
 * The import ledger's readings (lib/import/client.ts), held to what the Move
 * screen promises: a table gets its check only once the server has counted
 * both sides (`verified`), equal counts are still "counting"; a job that
 * stopped never leaves a spinner turning; progress never passes 100%; and the
 * flow's address carries a job or a source, never a credential.
 */
import type { ImportProgress } from '@/lib/import/contract'
import { countPhase, fractionOf, importPath, isImportSource, tablePhase } from '@/lib/import/client'

function job(patch: Partial<ImportProgress> = {}): ImportProgress {
  return {
    jobId: 'job_1', projectId: 'p_1', orgId: 'org_1', source: 'supabase', status: 'running', phase: 'rows',
    startedAt: '2026-11-16T10:00:00Z', finishedAt: null,
    tables: [
      { name: 'bookings', sourceRows: 1000, copiedRows: 1000, verified: true },
      { name: 'payments', sourceRows: 1000, copiedRows: 1000, verified: false },
      { name: 'reviews', sourceRows: 1000, copiedRows: 500, verified: false },
      { name: 'courts', sourceRows: 1000, copiedRows: 0, verified: false },
    ],
    users: { total: 100, copied: 0 }, files: { total: 10, copied: 0, bytes: 1e6, copiedBytes: 0 },
    rulesPending: 0, warnings: [], error: null, ...patch,
  }
}

describe('a table row', () => {
  it('is matched only once verified; equal counts are still being counted', () => {
    const j = job()
    expect(j.tables.map((t) => tablePhase(t, j))).toEqual(['matched', 'checking', 'copying', 'waiting'])
  })

  it('never spins once the job has stopped', () => {
    for (const status of ['failed', 'canceled'] as const) {
      const j = job({ status })
      expect(j.tables.map((t) => tablePhase(t, j))).toEqual(['matched', 'stopped', 'stopped', 'stopped'])
    }
  })
})

describe('users and files', () => {
  it('wait, copy, then match once their phase is over', () => {
    expect(countPhase(0, 100, job({ phase: 'rows' }), 'users')).toBe('waiting')
    expect(countPhase(40, 100, job({ phase: 'users' }), 'users')).toBe('copying')
    expect(countPhase(100, 100, job({ phase: 'files' }), 'users')).toBe('matched')
    expect(countPhase(4, 10, job({ status: 'failed', phase: 'files' }), 'files')).toBe('stopped')
  })
})

describe('how far it is', () => {
  it('counts rows, users and files, and never passes 100%', () => {
    expect(fractionOf(job())).toBeCloseTo(2500 / 4110)
    const over = job({ tables: [{ name: 't', sourceRows: 10, copiedRows: 12, verified: false }], users: null, files: null })
    expect(fractionOf(over)).toBe(1)
    expect(fractionOf(job({ status: 'done' }))).toBe(1)
  })
})

describe("the flow's address", () => {
  it('names a job or a source, and only the three sources', () => {
    expect(importPath('org 1', { job: 'job/1' })).toBe('/app/org/org%201/import?job=job%2F1')
    expect(importPath('org_1', { source: 'firebase' })).toBe('/app/org/org_1/import?source=firebase')
    expect(isImportSource('postgres')).toBe(true)
    expect(isImportSource('mysql')).toBe(false)
  })
})
