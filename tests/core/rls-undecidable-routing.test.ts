/**
 * UNDECIDABLE RLS — asks for the rule on tick one, never fails four times first
 * -----------------------------------------------------------------------------
 * The ownership inference can honestly answer "I cannot tell who owns a row in
 * this table", and when it does the detector marks the finding not auto-fixable.
 * Nothing read that. `classifyFix` rated every RLS type `auto` from the type
 * alone, so:
 *
 *   1. the reconciler planned WOULD_AUTO_APPLY
 *   2. it called SET_PERMISSION with template 'auto'
 *   3. applyPermissionPolicy refused — correctly, because RLS with no derivable
 *      policy makes the table read empty for everyone
 *   4. the finding was recorded as an attempted fix that did not hold, and
 *      re-attempted on a four-step backoff ladder across four days
 *
 * The refusal in step 3 is the product's best behaviour. It was being surfaced
 * as its worst: a broken repair rather than a question only the owner can
 * answer. These pin the routing so it cannot regress into a dead-end button.
 */

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals'
import { prisma } from '@/lib/db/prisma'
import { detectMissingRls } from '@/lib/services/workspace-observer'
import { classifyFix } from '@/lib/core/fix-classifier'
import { deriveTier } from '@/lib/autonomy/desired-state'
import {
  buildFixAction,
  getManualRemediationHint,
  hasExecutableFix,
} from '@/lib/core/fix-actions'

let userId: string
let projectId: string
let schema: string
let findings: Awaited<ReturnType<typeof detectMissingRls>>

const forTable = (t: string) => findings.find(f => (f.details as any).tableName === t)!

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `rls-undecidable-${Date.now()}@example.test`, password: 'x', name: 'rls' },
  })
  userId = user.id
  const project = await prisma.project.create({ data: { name: 'rls-undecidable-test', userId } })
  projectId = project.id
  schema = `workspace_${projectId}`

  const raw = (sql: string) => prisma.$executeRawUnsafe(sql)
  await raw(`CREATE SCHEMA "${schema}"`)
  await raw(`CREATE TABLE "${schema}"."users" (id uuid primary key default gen_random_uuid(), email text)`)
  // Ownership declared by a foreign key → decidable.
  await raw(`CREATE TABLE "${schema}"."posts" (
    id serial primary key, user_id uuid REFERENCES "${schema}"."users"(id), title text
  )`)
  // No owner column, no owned parent, not reference-shaped → undecidable.
  await raw(`CREATE TABLE "${schema}"."widgets" (id serial primary key, label text)`)

  // Exposure is decided by grants: the probe only reports tables an API client
  // can actually reach, so the grant is part of the fixture, not decoration.
  await raw(`GRANT USAGE ON SCHEMA "${schema}" TO authenticated`).catch(() => {})
  await raw(`GRANT SELECT ON "${schema}"."posts", "${schema}"."widgets" TO authenticated`).catch(() => {})

  findings = await detectMissingRls(projectId)
}, 60_000)

afterAll(async () => {
  await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
  await prisma.project.delete({ where: { id: projectId } }).catch(() => {})
  await prisma.user.delete({ where: { id: userId } }).catch(() => {})
})

describe('a derivable owner still heals silently', () => {
  test('an FK-owned table is auto-fixable and keeps its executable repair', () => {
    const f = forTable('posts')
    const d = f.details as any
    expect(d.rlsBasis).toBe('foreign_key')
    expect(f.autoFixable).toBe(true)
    expect(classifyFix(f.type, d).decision).toBe('auto')
    expect(buildFixAction(f.type, d)).toEqual({
      action: 'SET_PERMISSION',
      params: { tableName: 'posts', template: 'own_rows' },
    })
  })
})

describe('an undecidable owner asks instead of failing', () => {
  test('the detector marks it not auto-fixable', () => {
    const f = forTable('widgets')
    expect((f.details as any).rlsBasis).toBe('undecidable')
    expect(f.autoFixable).toBe(false)
  })

  test('the classifier agrees — this is the check that used to disagree', () => {
    const f = forTable('widgets')
    const c = classifyFix(f.type, f.details as any)
    expect(c.decision).toBe('notify_only')
    // notify_only rather than approval: an approval queue implies a repair is
    // waiting behind a yes. Here what is missing is the rule itself.
    expect(c.reason).toMatch(/will not guess/i)
  })

  test('the reconciler never plans it as an auto-apply', () => {
    // Tier 3 = escalate to the owner. Tier 0/1 would be planned WOULD_AUTO_APPLY
    // and burn the escalation retry ladder on a fix that cannot succeed.
    expect(deriveTier(forTable('widgets').type, forTable('widgets').details as any)).toBe(3)
  })

  test('no dead-end button is offered', () => {
    const f = forTable('widgets')
    expect(buildFixAction(f.type, f.details as any)).toBeNull()
    expect(hasExecutableFix(f.type, f.details as any)).toBe(false)
  })

  test('the hint names what was checked and what is needed', () => {
    const hint = getManualRemediationHint(forTable('widgets').type, forTable('widgets').details as any)
    expect(hint).toBeTruthy()
    expect(hint).toContain('widgets')
    // The probe's own rationale lists the columns it looked for. Repeating it is
    // what makes the request answerable rather than just a refusal.
    expect(hint).toMatch(/no column references|cannot tell who owns/i)
    expect(hint).toMatch(/set_rls/i)
  })

  test('the severity stays honest — the table really is exposed', () => {
    expect(forTable('widgets').severity).toBe('critical')
  })
})

describe('the routing is keyed on explicit evidence, not a missing field', () => {
  test('a legacy finding with no rlsBasis still heals', () => {
    // Rows written before rlsBasis existed are decidable far more often than
    // not. Treating "field absent" as undecidable would stop the loop healing
    // real exposures on every one of them.
    const c = classifyFix('missing_rls', { tableName: 'legacy_table' })
    expect(c.decision).toBe('auto')
    expect(buildFixAction('missing_rls', { tableName: 'legacy_table' })).toEqual({
      action: 'SET_PERMISSION',
      params: { tableName: 'legacy_table', template: 'auto' },
    })
  })

  test.each(['unprotected_user_data', 'rls_expression_invalid', 'rls_denies_everything'])(
    '%s follows the same rule — same repair, same failure mode',
    (type) => {
      expect(classifyFix(type, { tableName: 't', rlsBasis: 'undecidable' }).decision)
        .toBe('notify_only')
      expect(buildFixAction(type, { tableName: 't', rlsBasis: 'undecidable' })).toBeNull()
      expect(getManualRemediationHint(type, { tableName: 't', rlsBasis: 'undecidable' }))
        .toBeTruthy()
    },
  )
})
