/**
 * A function is one Backenly generated for a table only when the generator
 * gives one of the project's tables that name and route, with the manual
 * trigger GENERATE_API registers, and no agent deployed code over it.
 *
 * Production QA (2026-11-09): the Overview said "Functions 9" for a project
 * with two, counting the endpoints generated for its tables.
 */
import { generatedEndpointRoutes, isGeneratedEndpoint } from '@/lib/services/domain-endpoints'

const P = 'p-0000'
const routes = generatedEndpointRoutes(P, ['orders', 'jobs'])
const fn = (name: string, extra: Partial<{ triggerType: string; triggerTable: string | null; codeOrigin: string }> = {}) => ({
  name,
  triggerType: 'manual',
  triggerTable: `GET /api/v1/${P}/fn/${name}`,
  codeOrigin: 'generated',
  ...extra,
})

describe('isGeneratedEndpoint', () => {
  it('knows the endpoints generated for the tables, by their registered routes', () => {
    expect(isGeneratedEndpoint(fn('orders-schema'), routes)).toBe(true)
    expect(routes.get('jobs-create')).toBeDefined()
    const [jobsCreate] = [...routes.get('jobs-create')!]
    expect(isGeneratedEndpoint(fn('jobs-create', { triggerTable: jobsCreate }), routes)).toBe(true)
  })

  it('never counts code an agent deployed over a generated name', () => {
    expect(isGeneratedEndpoint(fn('orders-schema', { codeOrigin: 'agent' }), routes)).toBe(false)
  })

  it('never counts an endpoint an agent asked Backenly to write, whatever its name looks like', () => {
    // GENERATE_FUNCTION stores the same trigger and the same shape of route.
    expect(isGeneratedEndpoint(fn('order-totals', { triggerTable: `POST /api/v1/${P}/fn/order-totals` }), routes)).toBe(false)
    expect(isGeneratedEndpoint(fn('invoices-schema'), routes)).toBe(false) // no invoices table
  })

  it('needs the registered trigger and route, for this project', () => {
    expect(isGeneratedEndpoint(fn('orders-schema', { triggerType: 'http' }), routes)).toBe(false)
    expect(isGeneratedEndpoint(fn('orders-schema', { triggerTable: null }), routes)).toBe(false)
    expect(isGeneratedEndpoint(fn('orders-schema', { triggerTable: 'GET /api/v1/p-other/fn/orders-schema' }), routes)).toBe(false)
    expect(isGeneratedEndpoint(fn('orders-schema', { triggerTable: `POST /api/v1/${P}/fn/orders-schema` }), routes)).toBe(false)
  })
})
