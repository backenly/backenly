/**
 * BACKENLY NEVER CHOOSES A SELF-WRITABLE RULE FOR A TABLE WHOSE ROWS GRANT ACCESS
 * ==============================================================================
 * Inference already gives a table like user_roles, team_members or
 * conversation_participants owner_read_only (lib/services/rls-ownership.ts,
 * isGrantTable): each user reads their own rows, only the server writes them.
 * The other places Backenly picks a rule by itself named owner_read_write
 * outright, which lets a signed-in user insert the row that grants them access:
 *
 *   the architect's spec, which defaults every table to owner_read_write;
 *   the chat and social blueprints, on conversation_participants;
 *   the scan harvest's repair for a table without row-level security;
 *   the authority gate, when a declared ownership intent authorizes a repair.
 *
 * Only the scan harvest's data sources are stood in for.
 */

jest.mock('@/lib/ai/proof-system', () => ({ collectProof: jest.fn(async () => null) }))
jest.mock('@/lib/ai/production-intelligence', () => ({
  analyzeProductionReadiness: jest.fn(async () => ({
    issues: [{ type: 'weak_rls', location: 'user_roles', table: 'user_roles' }],
  })),
}))
jest.mock('@/lib/deployment/readiness-scorer', () => ({ scoreReadiness: jest.fn(async () => null) }))
jest.mock('@/lib/ai/build-ledger', () => ({ loadBuildLedger: jest.fn(async () => null) }))
jest.mock('@/lib/integrations/readiness', () => ({ checkAllIntegrationReadiness: jest.fn(async () => []) }))

import { isGrantTable } from '@/lib/services/rls-ownership'
import { validateAndEnrichSpec } from '@/lib/ai/blueprints/validate'
import { CHAT_APP_BLUEPRINT } from '@/lib/ai/blueprints/chat-app'
import { SOCIAL_MEDIA_BLUEPRINT } from '@/lib/ai/blueprints/social-media'
import { BLOG_BLUEPRINT } from '@/lib/ai/blueprints/blog'
import { SAAS_BLUEPRINT } from '@/lib/ai/blueprints/saas'
import { MARKETPLACE_BLUEPRINT } from '@/lib/ai/blueprints/marketplace'
import { PROJECT_MGMT_BLUEPRINT } from '@/lib/ai/blueprints/project-mgmt'
import { harvestScanFixes } from '@/lib/ai/scan/scan-to-fixes'
import { applyIntentToFixDetails } from '@/lib/authority/gate'
import type { Blueprint } from '@/lib/ai/blueprints/types'

const rulesOf = (b: Blueprint) =>
  new Map(b.steps.filter((s) => s.tool === 'add_rls').map((s) => [String(s.args.tableName), String(s.args.policy)]))

describe('the architect\'s spec', () => {
  const spec = {
    domain: 'team-notes',
    title: 'Team notes',
    tables: [
      { name: 'team_members', columns: [{ name: 'team_id', type: 'uuid' }, { name: 'role', type: 'text' }] },
      { name: 'user_roles', columns: [{ name: 'user_id', type: 'uuid' }, { name: 'role', type: 'text' }] },
      { name: 'notes', columns: [{ name: 'body', type: 'text' }] },
    ],
    rls: [{ tableName: 'user_roles', policy: 'owner_read_write' }],
  }

  it('gives a table whose rows grant access owner_read_only, by default and when it named owner_read_write', () => {
    const r = validateAndEnrichSpec(spec)
    if (!r.ok) throw new Error(r.errors.join('; '))
    const rules = rulesOf(r.blueprint)
    expect(rules.get('team_members')).toBe('owner_read_only')
    expect(rules.get('user_roles')).toBe('owner_read_only')
    expect(rules.get('notes')).toBe('owner_read_write')
  })

  it('still gives such a table the user_id its rule reads', () => {
    const r = validateAndEnrichSpec(spec)
    if (!r.ok) throw new Error(r.errors.join('; '))
    const create = r.blueprint.steps.find((s) => s.tool === 'create_table' && s.args.tableName === 'team_members')!
    expect((create.args.columns as Array<{ name: string }>).map((c) => c.name)).toContain('user_id')
  })
})

describe('the curated blueprints', () => {
  it.each([CHAT_APP_BLUEPRINT, SOCIAL_MEDIA_BLUEPRINT, BLOG_BLUEPRINT, SAAS_BLUEPRINT, MARKETPLACE_BLUEPRINT, PROJECT_MGMT_BLUEPRINT])(
    '$domain gives no table whose rows grant access owner_read_write',
    (b) => {
      for (const [table, policy] of rulesOf(b)) {
        if (isGrantTable(table)) expect([table, policy]).toEqual([table, expect.not.stringMatching(/^owner_read_write$/)])
      }
    },
  )

  it('chat and social give conversation_participants owner_read_only', () => {
    expect(rulesOf(CHAT_APP_BLUEPRINT).get('conversation_participants')).toBe('owner_read_only')
    expect(rulesOf(SOCIAL_MEDIA_BLUEPRINT).get('conversation_participants')).toBe('owner_read_only')
  })
})

describe('the scan harvest\'s repair for a table without row-level security', () => {
  it('installs the rule the schema implies, not owner_read_write on user_id', async () => {
    const { candidates } = await harvestScanFixes('0b9e3a52-7a5d-4c1e-9a2b-1f2e3d4c5b6a')
    const fix = candidates.find((c) => c.action === 'SET_PERMISSION')!
    expect(fix.params).toEqual({ template: 'auto', table: 'user_roles' })
  })
})

describe('the authority gate\'s repair from a declared ownership intent', () => {
  const decision = {
    decision: 'AUTO_EXECUTE',
    actionClassId: 'tighten_policy',
    intent: { satisfied: true, ownerColumn: 'user_id' },
  } as any

  it('lets the owner read, and only the server write, a row that grants access', () => {
    expect(applyIntentToFixDetails(decision, { tableName: 'team_members' })).toMatchObject({ rlsTemplate: 'own_rows_read', userIdColumn: 'user_id' })
  })

  it('still gives an ordinary owned table its owner\'s rows', () => {
    expect(applyIntentToFixDetails(decision, { tableName: 'notes' })).toMatchObject({ rlsTemplate: 'own_rows', userIdColumn: 'user_id' })
  })
})
