/**
 * A PLAN IS NAMED AS PEOPLE KNOW IT
 * =================================
 * Production QA (2026-11-09): Usage and the agent's usage answer called the
 * Free plan "SANDBOX", its internal code, while Billing and Pricing say "Free".
 * The quota refusals an app and its users read named the code too.
 *
 * Against a real database: a refusal for a project on the Free plan names it
 * "Free". The plan's code still keys everything that decides (the quotas, the
 * overage rules); only the words change.
 */

jest.mock('@cloud/entitlements', () => {
  const actual = jest.requireActual('@cloud/entitlements')
  const { selfHostedEntitlements } = jest.requireActual('@/lib/entitlements/self-hosted')
  return {
    ...actual,
    cloudEntitlements: async () => ({ ...selfHostedEntitlements(), planName: 'SANDBOX', apiRateLimitPerMin: 100 }),
  }
})

import crypto from 'crypto'
import { prisma } from '@/lib/db/prisma'
import { apiKeyRateCeilingViolation } from '@/lib/quota/kernel'

let ownerId: string
let projectId: string
const originalEdition = process.env.BACKENLY_EDITION

beforeAll(async () => {
  process.env.BACKENLY_EDITION = 'cloud'
  ownerId = (await prisma.user.create({
    data: { email: `plan-names-${crypto.randomBytes(6).toString('hex')}@example.test`, password: 'not-a-real-hash', name: 'owner' },
  })).id
  projectId = (await prisma.project.create({ data: { name: 'plan-names', userId: ownerId }, select: { id: true } })).id
})

afterAll(async () => {
  await prisma.project.delete({ where: { id: projectId } }).catch(() => {})
  await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
  process.env.BACKENLY_EDITION = originalEdition
})

it('a key asking for more than the plan allows is told the plan by its name', async () => {
  const refusal = await apiKeyRateCeilingViolation(projectId, ownerId, 1000, 60)
  expect(refusal).toBe(
    'The Free plan allows up to 100 requests per minute per API key. For a 60-second window that is at most 100 requests.',
  )
})
