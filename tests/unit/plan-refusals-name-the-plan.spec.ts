/**
 * A refusal for want of a plan names the plans as they are sold.
 *
 * The credit refusals an agent reads (/api/mcp/chat, /v1/{projectId}/ai/generate)
 * carried only the plan codes, currentPlan "SANDBOX" and requiredPlan
 * "BUILDER", where Billing and Pricing say Free and Pro (production QA re-test
 * 2026-11-16, #111). The codes stay for anything that decides on them; the
 * names are added beside them: currentPlanName and requiredPlanName.
 *
 * The key, the gates and the credits are stubbed: the plan's answer is the
 * input, the body is the property.
 */
import '../helpers/next-request-polyfill'

jest.mock('@/lib/mcp/guard', () => ({
  mcpGuard: jest.fn(async () => ({
    auth: { keyId: 'k1', projectId: 'p1', userId: 'u-agent', scope: 'mcp', readOnly: false },
  })),
  recordMcpCall: jest.fn(),
  refuseIfReadOnly: jest.fn(() => null),
}))
jest.mock('@/lib/ai/brain/agent', () => ({ runBrain: jest.fn() }))
jest.mock('@/lib/mcp/approvals', () => ({
  createApprovalRequest: jest.fn(),
  RestoreRequestRefusedError: class RestoreRequestRefusedError extends Error {},
}))
jest.mock('@/lib/platform-controls', () => ({ assertAiAllowed: jest.fn(async () => ({ ok: true })) }))
jest.mock('@/lib/entitlements/policy', () => ({
  enforceAiCredits: jest.fn(async () => ({
    code: 'PLAN_LIMIT_EXCEEDED',
    upgradeRequired: true,
    currentPlan: 'SANDBOX',
    requiredPlan: 'BUILDER',
    message: "You've used all 50 AI credits this month on the Free plan.",
  })),
}))
jest.mock('@/lib/entitlements/credit-holds', () => ({ closeCreditTurn: jest.fn(async () => {}) }))
jest.mock('@/lib/usage/account', () => ({ creditAccountOf: jest.fn(async () => 'account-1') }))

import { NextRequest } from 'next/server'
import { POST as chat } from '@/app/api/mcp/chat/route'
import { generateForProject } from '@/lib/ai/runtime-generate'
import { planDisplayName, planNamesOf } from '@/lib/entitlements/plan-names'

const NAMED = { currentPlan: 'SANDBOX', requiredPlan: 'BUILDER', currentPlanName: 'Free', requiredPlanName: 'Pro' }

it("an agent's build request out of credits names the plans beside their codes", async () => {
  const res = await chat(new NextRequest('https://backenly.test/api/mcp/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'mcp_live_test' },
    body: JSON.stringify({ message: 'build my store' }),
  }))
  expect(res.status).toBe(402)
  expect(await res.json()).toMatchObject({ ok: false, code: 'AI_CREDITS_EXHAUSTED', ...NAMED })
})

it("an app's generate request out of credits names the plans beside their codes", async () => {
  const r = await generateForProject({ projectId: 'p1', prompt: 'write a haiku' })
  expect(r).toMatchObject({ ok: false, code: 'AI_CREDITS_EXHAUSTED', status: 402, details: NAMED })
})

it('names every plan a refusal can carry, and leaves a name it does not know as it is', () => {
  expect(planNamesOf({ currentPlan: 'SANDBOX', requiredPlan: 'BUILDER' })).toEqual({ currentPlanName: 'Free', requiredPlanName: 'Pro' })
  expect(planNamesOf({ currentPlan: 'BUILDER', requiredPlan: 'SCALE' })).toEqual({ currentPlanName: 'Pro', requiredPlanName: 'Enterprise' })
  // The webhooks gate asks for the legacy PRO code.
  expect(planNamesOf({ currentPlan: 'SANDBOX', requiredPlan: 'PRO' })).toEqual({ currentPlanName: 'Free', requiredPlanName: 'Pro' })
  expect(planDisplayName('SELF_HOSTED')).toBe('Self-hosted')
})
