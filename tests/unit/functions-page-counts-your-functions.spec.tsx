/**
 * @jest-environment jsdom
 */
/**
 * The Functions page counts the project's own functions and lists the endpoints
 * Backenly generated for its tables apart, by the server's `generated` flag.
 *
 * Production QA (2026-11-09): the project's two functions were counted with
 * seven generated endpoints, which sat in the list as if someone had asked for
 * them. The page told them apart by a guess at their names, which also offered
 * to remove an endpoint an agent asked for when its name ended in "-schema".
 */
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { FunctionsWorkbench } from '@/components/functions/FunctionsWorkbench'
import { forgetProjectReads } from '@/lib/api/projects'
import { clearProjectRoleCache } from '@/lib/hooks/useProjectRole'

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), prefetch: jest.fn(), back: jest.fn(), refresh: jest.fn() }),
  useParams: () => ({ id: 'p1' }),
  usePathname: () => '/app/projects/p1/functions',
  useSearchParams: () => new URLSearchParams(),
}))

const fn = (name: string, extra: Record<string, unknown> = {}) => ({
  id: name,
  name,
  description: `What ${name} does`,
  triggerType: 'manual',
  triggerTable: `POST /api/v1/p1/fn/${name}`,
  status: 'active',
  lastRun: null,
  lastError: null,
  runCount: 0,
  createdAt: '2026-11-10T00:00:00.000Z',
  codeOrigin: 'generated',
  generated: false,
  ...extra,
})

const FUNCTIONS = [
  fn('order-totals'),
  fn('send-receipt', { codeOrigin: 'agent', runCount: 3 }),
  // An endpoint an agent asked for, named like a schema helper.
  fn('invoices-schema'),
  fn('orders-schema', { triggerTable: 'GET /api/v1/p1/fn/orders-schema', generated: true }),
  fn('customers-schema', { triggerTable: 'GET /api/v1/p1/fn/customers-schema', generated: true }),
]

function json(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response
}

const OWNER = { role: 'OWNER', canWrite: true, canAdminister: true }
const DEVELOPER = { role: 'DEVELOPER', canWrite: true, canAdminister: false }
let role: Record<string, unknown> = OWNER

beforeEach(() => {
  role = OWNER
  forgetProjectReads()
  clearProjectRoleCache()
  global.fetch = jest.fn((input: RequestInfo | URL) => {
    const path = String(input).split('?')[0]
    if (path === '/api/projects/p1') return Promise.resolve(json(200, { success: true, data: { id: 'p1', name: 'shop', organizationId: 'org_1', ...role } }))
    if (path.endsWith('/ai-functions')) return Promise.resolve(json(200, { functions: FUNCTIONS }))
    if (path.endsWith('/mcp/status')) return Promise.resolve(json(200, { connected: true, lastSeenAt: null, client: null }))
    return Promise.resolve(json(404, {}))
  }) as unknown as typeof fetch
})

async function renderPage() {
  render(<FunctionsWorkbench projectId="p1" />)
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve()
  })
}

it("counts the project's own functions, and asks only about those", async () => {
  await renderPage()
  // The bar counts what a person or an agent made, never the generated endpoints (QA 2026-11-09: "Functions 9" for two).
  expect(screen.getByText('3 functions')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'More actions for Functions' }))
  // The bulk test covers the project's own endpoints that never ran: two here, never the generated ones.
  expect(screen.getByRole('menuitem', { name: 'Test untested endpoints (2)…' })).toBeInTheDocument()
})

it('lists the endpoints generated for the tables apart, under their own heading', async () => {
  await renderPage()
  const group = screen.getByRole('region', { name: 'Generated for your tables' })
  fireEvent.click(within(group).getByRole('button', { name: /Generated for your tables/ }))
  const names = within(group).getAllByRole('button').map((b) => b.textContent ?? '')
  expect(names.some((n) => n.includes('orders-schema'))).toBe(true)
  expect(names.some((n) => n.includes('customers-schema'))).toBe(true)
  expect(names.some((n) => n.includes('invoices-schema'))).toBe(false)
})

it('offers to remove only the schema helpers Backenly generated, and only to an admin', async () => {
  await renderPage()
  fireEvent.click(screen.getByRole('button', { name: 'More actions for Functions' }))
  expect(screen.getByRole('menuitem', { name: 'Remove unused schema endpoints (2)…' })).toBeInTheDocument()
})

it('hides removing from a developer: deleting a function needs an admin', async () => {
  role = DEVELOPER
  await renderPage()
  fireEvent.click(screen.getByRole('button', { name: 'More actions for Functions' }))
  expect(screen.queryByRole('menuitem', { name: /Remove unused schema endpoints/ })).toBeNull()
  expect(screen.getByRole('menuitem', { name: 'Test untested endpoints (2)…' })).toBeInTheDocument()
})
