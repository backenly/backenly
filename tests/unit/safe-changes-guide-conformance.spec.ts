/**
 * The safe-changes guide restates the engine's design and one production
 * record. Both can change after the guide is written, so the guide is held to
 * them here instead of being trusted to keep up:
 *
 *   recovery outcomes     lib/changes/recovery.ts   the RecoverySafety union
 *   ladder steps          lib/autonomy/maintenance/step.ts   EXECUTOR_CAPABILITY
 *   production figures    docs/maintenance-production-acceptance.md
 *   destructive refusal   lib/mcp/migration-parser.ts   DESTRUCTIVE_REFUSED
 */

import fs from 'fs'
import path from 'path'
import { EXECUTOR_CAPABILITY } from '@/lib/autonomy/maintenance/step'
import { CHANGE_STEPS, LADDER_RUN, READER_HASHES, RECOVERY_SAFETY } from '@/app/guides/safe-ai-database-changes/content'

const read = (file: string) => fs.readFileSync(path.join(process.cwd(), file), 'utf8')
const RECOVERY = read('lib/changes/recovery.ts')
const RECORD = read('docs/maintenance-production-acceptance.md')
const PARSER = read('lib/mcp/migration-parser.ts')

describe('the safe-changes guide matches the engine', () => {
  it('lists exactly the restore-plan outcomes the recovery planner can return', () => {
    const union = /export type RecoverySafety = ([^\n]+)/.exec(RECOVERY)![1]
    const names = [...union.matchAll(/'([a-z_]+)'/g)].map((m) => m[1])
    expect(RECOVERY_SAFETY.map((r) => r.safety)).toEqual(names)
  })

  it('names the ladder steps the executor has, with contract left to a person', () => {
    const rungs = LADDER_RUN.map((r) => r.rung)
    expect([...rungs].sort()).toEqual(Object.keys(EXECUTOR_CAPABILITY).sort())
    expect(EXECUTOR_CAPABILITY.contract).toBe('human_only')
    expect(LADDER_RUN.find((r) => r.rung === 'contract')!.outcome).toMatch(/Never executed/)
  })

  it('names the refusal code apply_migration really returns for a DROP', () => {
    expect(CHANGE_STEPS.some((s) => s.body.includes('DESTRUCTIVE_REFUSED'))).toBe(true)
    expect(PARSER).toContain("'DESTRUCTIVE_REFUSED'")
  })
})

describe('the production case study quotes the acceptance record', () => {
  it.each([
    ['80 rows preserved'],
    ['80 compared, none disagreed'],
    ['9 Backenly-authored readers switched'],
    ['3 consumer classes cannot be enumerated'],
    ['Recorded 2026-09-16'],
    ['Seven defects'],
  ])('the record still says "%s"', (fact) => {
    expect(RECORD).toContain(fact)
  })

  it('uses the record’s code hashes, and the revert matches the original', () => {
    for (const r of READER_HASHES) expect(RECORD).toContain(r.hash)
    expect(READER_HASHES[2].hash).toBe(READER_HASHES[0].hash)
  })
})
