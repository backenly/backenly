/**
 * @jest-environment jsdom
 */
/**
 * Monitoring says a server error and a client error apart (production QA
 * re-test 2026-11-16, #73). The Endpoints table's "Error rate" counted a 4xx
 * as a failure, so an endpoint a stranger sent wrong keys to read as failing.
 * Server errors are the 5xx share; client errors (a refused key, a bad
 * request, a row that is not there) are their own column. The request log
 * keeps a 401 as the project's traffic and says what it was.
 */
import { fireEvent, render, screen, within } from '@testing-library/react'
import { OverviewPane } from '@/components/monitoring/OverviewPane'
import { RequestsPane } from '@/components/monitoring/RequestsPane'
import type { Overview } from '@/components/monitoring/data'

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), prefetch: jest.fn(), back: jest.fn(), refresh: jest.fn() }),
  useParams: () => ({ id: 'p1' }),
  usePathname: () => '/app/projects/p1/monitoring',
  useSearchParams: () => new URLSearchParams(),
}))
jest.mock('@/components/console/TimeSeriesChart', () => ({
  ...jest.requireActual('@/components/console/TimeSeriesChart'),
  TimeSeriesChart: () => null,
}))

const now = Date.parse('2026-11-16T12:00:00.000Z')
const overview: Overview = {
  range: '24h',
  start: now - 24 * 60 * 60 * 1000,
  end: now,
  stats: {
    requests: { value: 200, change: 0 },
    responseTime: { value: 40, change: 0 },
    errors: { value: 0, change: 0 },
    serverErrors: { value: 0, change: 0 },
    clientErrors: { value: 100, change: 0 },
  },
  volume: [],
  latency: [],
  endpoints: [
    { endpoint: 'GET /db/movies', requests: 200, avgResponseTime: 40, errorRate: 0, clientErrorRate: 50, p95: 90 },
  ],
}

it('puts a 4xx under client errors and keeps server errors at 0%', () => {
  render(
    <OverviewPane
      projectId="p1"
      range="24h"
      overview={overview}
      failed={false}
      readAt={now}
      onRetry={() => {}}
      retrying={false}
      serverErrors={null}
      markers={[]}
      requests={[]}
      published
      endpointUrl={null}
    />,
  )
  const table = screen.getByRole('table')
  const headers = within(table).getAllByRole('columnheader').map((h) => h.textContent)
  expect(headers).toEqual(['Route', 'Requests', 'Avg', 'p95', 'Client errors', 'Server errors'])
  const cells = within(within(table).getAllByRole('row')[1]).getAllByRole('cell').map((c) => c.textContent)
  expect(cells.slice(-2)).toEqual(['50%', '0%'])
})

it('says a 401 in the request log had no valid key or sign-in', () => {
  render(
    <RequestsPane
      projectId="p1"
      rows={[{ id: 'r1', method: 'GET', path: '/db/movies', status: 401, latency: 12, timestamp: '2026-11-16T11:59:00.000Z' }]}
      failed={false}
      readAt={now}
      onRetry={() => {}}
      retrying={false}
      status="all"
      path=""
      onFilter={() => {}}
      endpointUrl={null}
    />,
  )
  expect(screen.getAllByTitle('401: no valid key or sign-in').length).toBeGreaterThan(0)
  fireEvent.click(screen.getAllByText('/db/movies')[0])
  expect(screen.getByText(/Status\s+401, no valid key or sign-in/)).toBeTruthy()
})
