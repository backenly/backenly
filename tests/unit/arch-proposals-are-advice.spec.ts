/**
 * An architecture proposal is advice with its statement, never a repair.
 *
 * Production QA (2026-11-09): "Proposed migration: Add composite indexes on
 * high-traffic query patterns" showed Fix now, under copy saying it was queued
 * for Backenly's next pass with no approval needed, and was still open six days
 * later. The type `arch_migration_*` was aliased to `shadow_mutation`, whose
 * repair is FIX_API: Fix now would have regenerated API definitions, not built
 * the indexes the proposal named, and nothing ever queued it.
 */
import { buildFixAction, getManualRemediationHint, hasExecutableFix } from '@/lib/core/fix-actions'
import { classifyFix } from '@/lib/core/fix-classifier'
import { groupFindings } from '@/lib/core/finding-groups'

const TYPE = 'arch_migration_add_composite_indexes_on_high_traffic_qu'
const SQL = 'CREATE INDEX CONCURRENTLY idx_orders_user_status ON orders (user_id, status);'
const details = {
  title: 'Add composite indexes on high-traffic query patterns',
  description: 'Queries filter orders by user and status together.',
  source: 'architecture_evolution',
  sqlFix: SQL,
}

describe('an architecture proposal', () => {
  it('has no repair Backenly runs, so no Fix now', () => {
    expect(buildFixAction(TYPE, details)).toBeNull()
    expect(hasExecutableFix(TYPE, details)).toBe(false)
    expect(classifyFix(TYPE, details).decision).toBe('notify_only')
  })

  it('hands its statement to the coding agent instead', () => {
    expect(getManualRemediationHint(TYPE, details)).toBe(
      'This is a proposal from Backenly’s architecture review, not a fault, and Backenly does not apply it ' +
        'on its own. To apply it, ask your coding agent to run it with apply_migration:\n\n' + SQL,
    )
    expect(getManualRemediationHint(TYPE, { ...details, sqlFix: null })).toBe(
      'This is a proposal from Backenly’s architecture review, not a fault, and Backenly does not apply it ' +
        'on its own. If you want it, ask your coding agent to plan and apply it.',
    )
  })

  it('reaches the panel as advice, with the hint and no button', () => {
    const [group] = groupFindings([{ id: 'f1', type: TYPE, severity: 'warning', status: 'open', details } as any])
    expect(group.actionable).toBe(false)
    expect(group.manualHint).toContain('apply_migration')
  })
})
