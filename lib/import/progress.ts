/**
 * Merging what a driver reports into the job's progress, the way driver.ts
 * promises: tables are keyed by name and keep their first-seen order; copied
 * counts only go up (a late or repeated report can never move a bar back);
 * totals are facts and take the latest value; warnings are kept once each.
 *
 * Pure. Tested in __tests__/import/progress.test.ts.
 */

import type { ImportJobStatus, ImportPhase, ImportProgress, ImportProgressTable, ImportSourceId } from './contract'
import type { RunContext } from './driver'

export type ProgressPatch = Parameters<RunContext['progress']>[0]

export function initialProgress(input: {
  jobId: string
  projectId: string
  projectName: string
  region: string
  orgId: string
  source: ImportSourceId
  startedAt: Date
  status?: ImportJobStatus
  phase?: ImportPhase
}): ImportProgress {
  return {
    jobId: input.jobId,
    projectId: input.projectId,
    projectName: input.projectName,
    region: input.region,
    orgId: input.orgId,
    source: input.source,
    status: input.status ?? 'running',
    phase: input.phase ?? 'creating_project',
    startedAt: input.startedAt.toISOString(),
    finishedAt: null,
    tables: [],
    users: null,
    files: null,
    rulesPending: 0,
    warnings: [],
    error: null,
  }
}

const up = (a: number | undefined, b: number | undefined) => Math.max(Number(a) || 0, Number(b) || 0)

function mergeTable(prev: ImportProgressTable | undefined, next: ImportProgressTable): ImportProgressTable {
  if (!prev) return { name: next.name, sourceRows: Number(next.sourceRows) || 0, copiedRows: Number(next.copiedRows) || 0, verified: !!next.verified }
  return {
    name: prev.name,
    sourceRows: next.sourceRows === undefined ? prev.sourceRows : Number(next.sourceRows) || 0,
    copiedRows: up(prev.copiedRows, next.copiedRows),
    verified: next.verified === undefined ? prev.verified : !!next.verified,
  }
}

export function mergeProgress(current: ImportProgress, patch: ProgressPatch): ImportProgress {
  const out: ImportProgress = { ...current }
  if (patch.phase) out.phase = patch.phase
  if (patch.tables) {
    const byName = new Map(current.tables.map((t) => [t.name, t]))
    const order = current.tables.map((t) => t.name)
    for (const t of patch.tables) {
      if (!t || typeof t.name !== 'string') continue
      if (!byName.has(t.name)) order.push(t.name)
      byName.set(t.name, mergeTable(byName.get(t.name), t))
    }
    out.tables = order.map((n) => byName.get(n)!)
  }
  if (patch.users !== undefined) {
    out.users =
      patch.users === null
        ? null
        : { total: Number(patch.users.total) || 0, copied: up(current.users?.copied, patch.users.copied) }
  }
  if (patch.files !== undefined) {
    out.files =
      patch.files === null
        ? null
        : {
            total: Number(patch.files.total) || 0,
            copied: up(current.files?.copied, patch.files.copied),
            bytes: Number(patch.files.bytes) || 0,
            copiedBytes: up(current.files?.copiedBytes, patch.files.copiedBytes),
          }
  }
  if (patch.rulesPending !== undefined) out.rulesPending = Math.max(0, Number(patch.rulesPending) || 0)
  if (patch.warnings) {
    const seen = new Set(current.warnings)
    out.warnings = [...current.warnings]
    for (const w of patch.warnings) {
      if (typeof w === 'string' && w && !seen.has(w)) {
        seen.add(w)
        out.warnings.push(w)
      }
    }
  }
  if (patch.error !== undefined) out.error = patch.error
  return out
}
