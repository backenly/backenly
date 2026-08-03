/**
 * A hot-table finding must never render a "Fix now" button that fails on click.
 *
 * ── The reported bug ────────────────────────────────────────────────────────
 * infra-intelligence emits `infra_hot_table_<table>`. That type was registered
 * in neither ALL_FINDING_TYPES nor PREFIX_MAP, so normalizeFindingType returned
 * null and buildFixAction fell through to "no automatic repair for it yet".
 * The Autonomy panel drew an enabled Fix now button on three findings anyway,
 * under copy reading "Backenly found these and can fix them itself — they are
 * queued for its next pass". All three clicks failed.
 *
 * This is the THIRD time an emitted type was missing from the registry
 * (contract_surface_broken 2026-07-29, runtime_engine_mismatch 2026-07-30), and
 * the first one a user reported rather than a test.
 *
 * Two halves have to hold together, which is why they are tested together:
 *   - a finding WITH a verified column is genuinely repairable, and
 *   - a finding WITHOUT one is honestly notify-only,
 * because "always fixable" and "never fixable" both pass a one-sided test.
 */

import { normalizeFindingType } from '@/lib/core/types'
import { buildFixAction, getManualRemediationHint } from '@/lib/core/fix-actions'
import { classifyFix } from '@/lib/core/fix-classifier'
import { groupFindings } from '@/lib/core/finding-groups'

const REPAIRABLE = {
  table: 'notes',
  tableName: 'notes',
  columnName: 'user_id',
  seqScans: 1259,
  idxHitPct: 13,
}

// The real shape of the `users` finding in production: heavy scans, but none of
// created_at / user_id / owner_id / updated_at exists on the table.
const NOT_REPAIRABLE = {
  table: 'users',
  tableName: 'users',
  columnName: null,
  seqScans: 4403,
  idxHitPct: 4,
}

describe('infra_hot_table is a registered, dispatchable finding type', () => {
  it('resolves through the registry instead of returning null', () => {
    const norm = normalizeFindingType('infra_hot_table_notes', REPAIRABLE)
    expect(norm).not.toBeNull()
    expect(norm!.base).toBe('infra_hot_table')
    expect(norm!.tableName).toBe('notes')
  })

  it('builds a CREATE_INDEX on the column the detector verified', () => {
    const action = buildFixAction('infra_hot_table_notes', REPAIRABLE)
    expect(action).toEqual({
      action: 'CREATE_INDEX',
      params: { tableName: 'notes', columnName: 'user_id' },
    })
  })

  it('is classified auto only when there is a column to index', () => {
    expect(classifyFix('infra_hot_table_notes', REPAIRABLE).decision).toBe('auto')
    expect(classifyFix('infra_hot_table_users', NOT_REPAIRABLE).decision).toBe('notify_only')
  })

  it('never invents a column when the detector could not name one', () => {
    // The production failure was SQL naming a column the table does not have.
    // Reconstructing one from the type suffix or defaulting to created_at would
    // reintroduce it, so the absence of a fix action here is the assertion.
    expect(buildFixAction('infra_hot_table_users', NOT_REPAIRABLE)).toBeNull()
  })

  it('always has something to say when it has nothing to run', () => {
    const hint = getManualRemediationHint('infra_hot_table_users' as any, NOT_REPAIRABLE)
    expect(hint).toBeTruthy()
    // The hint must carry the measurement, or the owner cannot judge urgency.
    expect(hint).toContain('4,403')
    expect(hint).toContain('users')
  })
})

describe('the panel cannot render a button that would fail', () => {
  const asFinding = (id: string, type: string, details: object) => ({
    id,
    type,
    severity: 'error',
    status: 'open',
    details,
    detectedAt: new Date().toISOString(),
  })

  it('marks the repairable finding actionable', () => {
    const groups = groupFindings([
      asFinding('a', 'infra_hot_table_notes', REPAIRABLE),
    ] as any)
    expect(groups).toHaveLength(1)
    expect(groups[0].actionable).toBe(true)
  })

  it('marks the unrepairable finding NOT actionable, with a hint to show instead', () => {
    // This is the exact assertion that would have caught the reported bug.
    const groups = groupFindings([
      asFinding('b', 'infra_hot_table_users', NOT_REPAIRABLE),
    ] as any)
    expect(groups).toHaveLength(1)
    expect(groups[0].actionable).toBe(false)
    expect(groups[0].hint ?? groups[0].manualHint).toBeTruthy()
  })
})
