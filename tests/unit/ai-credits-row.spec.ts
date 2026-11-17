/**
 * The Usage page's AI credits row reads against everything the account has
 * this month (components/usage/UsageView.tsx aiCreditsQuota): the plan's
 * credits plus bonus and bought ones, as the credit gate counts them.
 * Production QA re-test, 2026-11-16, #98: it read "575 of 200, Over the limit"
 * while the gate, counting 500 bonus credits, rightly let calls through.
 */
import { aiCreditsQuota } from '@/components/usage/UsageView'

const billing = {
  planName: 'SANDBOX',
  aiCreditsUsed: 575,
  monthlyAiCredits: 200,
  apiRequestsUsed: '0',
  resetAt: '2026-12-01T00:00:00.000Z',
}

it('reads used against the plan, bonus and bought credits together, and names the parts', () => {
  expect(aiCreditsQuota(billing, { used: 575, plan: 200, bonus: 500, purchased: 0, cap: 700, left: 125 })).toMatchObject({
    used: 575,
    included: 700,
    tone: 'normal',
    fact: '200 plan + 500 bonus',
  })
})

it('says when every credit is used', () => {
  expect(aiCreditsQuota(billing, { used: 700, plan: 200, bonus: 400, purchased: 100, cap: 700, left: 0 })).toMatchObject({
    used: 700,
    included: 700,
    tone: 'over',
    fact: 'All credits used',
  })
})

it('CONTROL: without the allowance (an older server) it reads against the plan, as before', () => {
  expect(aiCreditsQuota(billing)).toMatchObject({ used: 575, included: 200, tone: 'over', fact: 'Plan credits used up' })
})
