/**
 * @jest-environment jsdom
 */
/**
 * The account usage description names the plan as it is sold (`planName`,
 * "Pro") and carries its code beside it (`planCode`, "BUILDER"), since the agent's
 * usage read said "SANDBOX" where Billing says Free (production QA re-test
 * 2026-11-16, #111). Whether usage may pass the plan is decided on the code, so
 * the Usage page's "Past the plan" section reads `planCode`.
 */
import { act, render, screen } from '@testing-library/react'
import { UsageView } from '@/components/usage/UsageView'

const router = { push: jest.fn(), replace: jest.fn(), prefetch: jest.fn(), back: jest.fn(), refresh: jest.fn() }
jest.mock('next/navigation', () => ({
  useRouter: () => router,
  useParams: () => ({}),
  usePathname: () => '/app/usage',
  useSearchParams: () => new URLSearchParams(),
}))
jest.mock('@/components/shell/OrgShell', () => ({ OrgShell: ({ children }: { children: React.ReactNode }) => <>{children}</> }))
jest.mock('@cloud/org-routing', () => ({ useOrgHrefs: () => ({ billing: '/app/billing', usage: '/app/usage' }) }))

const axis = (a: string, label: string, unit: string) => ({
  axis: a, label, unit, used: 0, included: 1000, cap: 2000, projected: 0, billable: true,
  estimatedCents: 0, projectedCents: 0, grace: null, measuredAt: null,
})

function json(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response
}

beforeEach(() => {
  global.fetch = jest.fn(async (url: any) => {
    const path = String(url).split('?')[0]
    if (path === '/api/billing/usage') {
      return json(200, { planName: 'BUILDER', aiCreditsUsed: 0, monthlyAiCredits: 1000, apiRequestsUsed: '0', resetAt: '2026-12-01T00:00:00.000Z', canManage: true })
    }
    if (path === '/api/usage/account') {
      return json(200, {
        period: '2026-11',
        planName: 'Pro',
        planCode: 'BUILDER',
        overage: { mode: 'enforce', spendLimitCents: 5_000, active: true, estimatedCents: 0, projectedCents: 0 },
        graceDays: 7,
        axes: [axis('mau', 'Monthly active users', 'users'), axis('fn_runs', 'Function runs', 'runs')],
      })
    }
    if (path === '/api/account/autonomy-activity') return json(200, { runsThisCycle: 0, perDay: [], cycleStart: '2026-11-01T00:00:00.000Z', lastAt: null })
    return json(404, {})
  }) as any
})

it('shows what past-the-plan usage costs on Pro, read from the plan code', async () => {
  render(<UsageView />)
  await act(async () => { for (let i = 0; i < 20; i++) await Promise.resolve() })
  expect(screen.getByText('Included in Pro')).toBeTruthy()
  expect(screen.getByText('Past the plan')).toBeTruthy()
})
