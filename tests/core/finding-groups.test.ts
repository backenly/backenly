/**
 * FINDING GROUPS — root-cause folding (pure, no DB)
 * -------------------------------------------------
 * Locks the contract the review surfaces depend on:
 *
 *   • One cause spread over N tables folds to ONE group carrying all N ids,
 *     so a single "Approve & fix all" repairs the whole defect.
 *   • Different causes never merge, even within one finding type.
 *   • Nothing is ever lost: countFindings(groups) === findings.length, always.
 *   • A group that cannot be titled honestly is NOT formed (rule 4) — the fold
 *     may never invent a sentence that misdescribes the backend.
 *
 * The fixtures mirror the real detector payloads (lib/core/drift-detector
 * writes tableName + policyName + a PER-TABLE reason), because the first
 * version of causeSignature keyed on `reason` and would have silently grouped
 * nothing at all while looking correct.
 */

import { describe, test, expect } from '@jest/globals'
import {
  groupFindings,
  countFindings,
  categoryOf,
  type GroupableFinding,
} from '@/lib/core/finding-groups'

// ── Fixtures ─────────────────────────────────────────────────────────────────

/** The real shape drift-detector emits: shared policy, per-table reason. */
function rls(table: string, policyName = 'bkn_direct_read'): GroupableFinding {
  return {
    id: `rls-${table}`,
    type: 'rls_expression_invalid',
    severity: 'warning',
    details: {
      tableName: table,
      policyName,
      schemaName: 'workspace_x',
      reason: `RLS is enabled on "${table}" but a policy exposes every row (USING true) — protection is effectively off`,
    },
  }
}

/** contract_surface_broken: shared probe error, per-surface subject. */
function surface(name: string, detail = 'probe error: fetch failed'): GroupableFinding {
  return {
    id: `surf-${name}`,
    type: 'contract_surface_broken',
    severity: 'warning',
    details: { surface: name, detail },
  }
}

const missingFk: GroupableFinding = {
  id: 'fk-1',
  type: 'missing_fk',
  severity: 'warning',
  details: { tableName: 'hx_ext_id' },
}

// ── The fold ─────────────────────────────────────────────────────────────────

describe('groupFindings — one cause, one row', () => {
  test('folds one bad policy across many tables into a single group', () => {
    const findings = ['g_categories', 'g_accounts', 'ext_id', 'errq', 'claim_rls'].map(t => rls(t))
    const groups = groupFindings(findings)

    expect(groups).toHaveLength(1)
    expect(groups[0].members).toHaveLength(5)
    // Every id travels with the group — this is what makes "approve all" real.
    expect(groups[0].findingIds.sort()).toEqual(findings.map(f => f.id).sort())
    expect(groups[0].subjects).toEqual(['g_categories', 'g_accounts', 'ext_id', 'errq', 'claim_rls'])
  })

  test('the group title states the count and names the shared cause', () => {
    const groups = groupFindings([rls('a'), rls('b'), rls('c')])
    expect(groups[0].title).toBe('RLS policies on 3 tables are ineffective (`bkn_direct_read`)')
  })

  test('per-table `reason` does not defeat grouping', () => {
    // Each fixture carries a DIFFERENT reason string (it embeds the table
    // name). If the cause signature ever keys on it again, this returns 3.
    const groups = groupFindings([rls('a'), rls('b'), rls('c')])
    expect(groups).toHaveLength(1)
  })

  test('different policies are different causes and never merge', () => {
    const groups = groupFindings([
      rls('a', 'bkn_direct_read'),
      rls('b', 'bkn_direct_read'),
      rls('c', 'some_other_policy'),
    ])
    expect(groups).toHaveLength(2)
    expect(groups.map(g => g.members.length).sort()).toEqual([1, 2])
  })

  test('folds probe failures sharing one error, splits ones that differ', () => {
    const same = groupFindings([surface('storage'), surface('auth'), surface('functions'), surface('healthz')])
    expect(same).toHaveLength(1)
    expect(same[0].title).toBe('4 live API surfaces are failing: probe error: fetch failed')

    const differing = groupFindings([
      surface('storage', 'probe error: fetch failed'),
      surface('auth', 'returned 500'),
    ])
    expect(differing).toHaveLength(2)
  })

  test('a lone finding renders exactly as it did before grouping existed', () => {
    const groups = groupFindings([missingFk])
    expect(groups).toHaveLength(1)
    expect(groups[0].members).toHaveLength(1)
    expect(groups[0].title).toBe('`hx_ext_id` has a relation with no foreign key constraint')
  })
})

describe('groupFindings — safety properties', () => {
  test('never loses a finding, whatever the mix', () => {
    const findings = [
      ...['a', 'b', 'c', 'd', 'e'].map(t => rls(t)),
      ...['storage', 'auth', 'functions', 'healthz'].map(s => surface(s)),
      missingFk,
    ]
    const groups = groupFindings(findings)
    expect(countFindings(groups)).toBe(findings.length)

    // and no id is duplicated across groups
    const ids = groups.flatMap(g => g.findingIds)
    expect(new Set(ids).size).toBe(findings.length)
  })

  test('a group is as severe as its worst member', () => {
    const groups = groupFindings([
      rls('a'),
      { ...rls('b'), id: 'rls-b', severity: 'critical' },
      rls('c'),
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0].severity).toBe('critical')
    // worst-first inside the group, so the expanded list leads with it
    expect(groups[0].members[0].id).toBe('rls-b')
  })

  test('groups are ordered most severe first', () => {
    const groups = groupFindings([
      rls('a'),
      { ...missingFk, severity: 'critical' },
    ])
    expect(groups[0].severity).toBe('critical')
  })

  test('rule 4 — an untitleable group stays split rather than guessing', () => {
    // Same unknown base, no curated title, and the members already say
    // different things. Folding would require inventing a sentence.
    const a: GroupableFinding = {
      id: 'x1', type: 'totally_unknown_type', severity: 'warning',
      details: { reason: 'the left thing broke' },
    }
    const b: GroupableFinding = {
      id: 'x2', type: 'totally_unknown_type', severity: 'warning',
      details: { reason: 'the right thing broke' },
    }
    const groups = groupFindings([a, b])
    expect(groups).toHaveLength(2)
    expect(groups.map(g => g.title).sort()).toEqual(['the left thing broke', 'the right thing broke'])
  })

  test('rule 3 — identical sentences de-duplicate into one row', () => {
    const a: GroupableFinding = {
      id: 'y1', type: 'totally_unknown_type', severity: 'warning',
      details: { reason: 'the same thing broke' },
    }
    const b: GroupableFinding = { ...a, id: 'y2' }
    const groups = groupFindings([a, b])
    expect(groups).toHaveLength(1)
    expect(groups[0].title).toBe('the same thing broke')
    expect(groups[0].members).toHaveLength(2)
  })

  test('keys are stable across identical inputs (safe as React keys)', () => {
    const findings = [rls('a'), rls('b'), surface('storage'), missingFk]
    expect(groupFindings(findings).map(g => g.key))
      .toEqual(groupFindings(findings).map(g => g.key))
  })

  test('empty in, empty out', () => {
    expect(groupFindings([])).toEqual([])
    expect(countFindings([])).toBe(0)
  })
})

describe('categoryOf — the single classifier both surfaces read', () => {
  test('routes RLS and auth findings to security', () => {
    expect(categoryOf(rls('a'))).toBe('security')
    expect(categoryOf({ id: 'a', type: 'auth_jwt_missing', severity: 'critical', details: null }))
      .toBe('security')
  })

  test('maps verification scenarios\' domain categories onto the lanes', () => {
    expect(categoryOf({ id: 'v', type: 'verification_failed', severity: 'warning', details: { category: 'rls' } }))
      .toBe('security')
  })

  test('index findings are performance, api findings are reliability', () => {
    expect(categoryOf({ id: 'i', type: 'missing_fk_index', severity: 'info', details: null }))
      .toBe('performance')
    expect(categoryOf(surface('storage'))).toBe('reliability')
  })
})
