/**
 * Candidates that run outside the change ledger are proposed as needing a person.
 *
 * The agentic fix loop applies candidates from three proposers: the curated
 * mapping of failed checks, the scan harvest and the fix author (a model).
 * FIX_API, FIX_WORKFLOW, ADOPT_EXTERNAL_SCHEMA and REGISTER_SCHEMA run outside
 * the change ledger, so History could not undo them. The curated mapping and
 * the harvest mark them as needing approval, and the author no longer proposes
 * FIX_API at all. The loop also refuses them on its own account; that half is
 * proven against a real database in
 * tests/core/fix-loop-leaves-ledger-repairs.test.ts.
 *
 * Only the model call and the harvest's five data sources are stood in for.
 */

const mockReply: { json: unknown } = { json: null }
jest.mock('@/lib/ai/llm/chat', () => ({
  chat: jest.fn(async () => ({
    text: JSON.stringify(mockReply.json),
    json: mockReply.json,
    result: { model: 'stand-in', usage: { promptTokens: 1, outputTokens: 1 } },
  })),
}))

jest.mock('@/lib/ai/proof-system', () => ({ collectProof: jest.fn(async () => null) }))
jest.mock('@/lib/ai/production-intelligence', () => ({
  analyzeProductionReadiness: jest.fn(async () => ({
    issues: [{ type: 'missing_index', location: 'line_items.order_id', table: 'line_items' }],
  })),
}))
jest.mock('@/lib/deployment/readiness-scorer', () => ({ scoreReadiness: jest.fn(async () => null) }))
jest.mock('@/lib/ai/build-ledger', () => ({
  loadBuildLedger: jest.fn(async () => ({
    failed: [
      { type: 'api', name: 'notes' },
      { type: 'realtime', name: 'feed' },
    ],
    blocked: [],
  })),
}))
jest.mock('@/lib/integrations/readiness', () => ({ checkAllIntegrationReadiness: jest.fn(async () => []) }))

import { mapCheckToFixes, type FixCandidate } from '@/lib/ai/behavioral-check-to-fixes'
import type { BehavioralCheck } from '@/lib/ai/behavioral-verifier'
import { harvestScanFixes } from '@/lib/ai/scan/scan-to-fixes'
import { authorFixForCheck } from '@/lib/ai/agentic-fix-author'
import { runsOutsideChangeLedger } from '@/lib/core/fix-actions'

const PROJECT = '0b9e3a52-7a5d-4c1e-9a2b-1f2e3d4c5b6a'

const failed = (id: string, error: string): BehavioralCheck => ({
  id,
  name: id,
  passed: false,
  skipped: false,
  error,
  details: [],
})

const summary = (cs: FixCandidate[]) => cs.map((c) => [c.action, !!c.requiresApproval])

describe('the curated mapping of failed checks', () => {
  it('marks the FIX_API it proposes as needing approval', () => {
    expect(summary(mapCheckToFixes(failed('crud_lifecycle', 'update returned 404')))).toEqual([['FIX_API', true]])
    expect(summary(mapCheckToFixes(failed('live_api_endpoints', 'GET /db/notes returned 404')))).toEqual([['FIX_API', true]])
  })

  it('leaves the repairs inside the ledger as they were', () => {
    expect(summary(mapCheckToFixes(failed('rls_isolation', 'user B read user A row')))).toEqual([['SET_PERMISSION', false]])
    expect(summary(mapCheckToFixes(failed('trigger_execution', 'trigger did not fire')))).toEqual([['FIX_REALTIME', false]])
    expect(summary(mapCheckToFixes(failed('auth_flow', 'signin failed')))).toEqual([['FIX_AUTH', false]])
  })

  it('never proposes one of the four without asking, for any check it knows', () => {
    const checks = [
      failed('auth_flow', 'jwt signature invalid'),
      failed('rls_isolation', 'violates foreign key constraint'),
      failed('trigger_execution', 'violates foreign key constraint'),
      failed('webhook_hmac', 'no webhook'),
      failed('live_api_endpoints', 'signup returned HTTP 500: row-level security'),
      failed('live_api_endpoints', 'GET /db/notes returned 404'),
      failed('crud_lifecycle', 'update returned 404'),
    ]
    for (const c of checks.flatMap(mapCheckToFixes)) {
      if (runsOutsideChangeLedger(c.action)) expect([c.action, c.requiresApproval]).toEqual([c.action, true])
    }
  })
})

describe('the scan harvest', () => {
  it('marks a failed API build step as needing approval and leaves the rest as they were', async () => {
    const { candidates } = await harvestScanFixes(PROJECT)
    expect(summary(candidates).sort()).toEqual([
      ['CREATE_INDEX', false],
      ['FIX_API', true],
      ['FIX_REALTIME', false],
    ])
  })
})

describe('the fix author', () => {
  const ask = () => authorFixForCheck({ check: failed('contract_shape', 'unexpected shape'), projectId: PROJECT, authoredSoFar: 0 })

  it('does not propose FIX_API', async () => {
    mockReply.json = { fix: { action: 'FIX_API', params: {}, reason: 'regenerate the endpoints for this table' } }
    const out = await ask()
    expect(out.candidate).toBeNull()
    expect(out.reason).toMatch(/schema validation/)
  })

  it('still proposes the FIX_* repairs inside the ledger, to apply on their own', async () => {
    mockReply.json = { fix: { action: 'FIX_REALTIME', params: {}, reason: 'reinstall the NOTIFY triggers on this table' } }
    const out = await ask()
    expect(out.candidate).toMatchObject({ action: 'FIX_REALTIME', requiresApproval: false })
  })
})
