/**
 * @jest-environment jsdom
 */

/**
 * Every copy of the frontend connection status on a page shares one request
 * and one poll (production QA, 2026-11-09: /connection-health went out two to
 * five times per console page, and each copy then polled every 15 s on its
 * own).
 */
import React from 'react'
import { act, render } from '@testing-library/react'
import { FrontendConnectionPill } from '@/components/inspector/FrontendConnectionPill'
import { forgetSharedReads } from '@/lib/client/shared-read'

const health = {
  failures: [],
  successes: [{ origin: 'shop.example.com', count: 12, lastSeen: '2026-11-10T10:00:00.000Z' }],
  probes: { count: 0, lastSeen: null },
  totals: { failures24h: 0, failures1h: 0, bootstraps24h: 12, requests24h: 12, distinctOriginsFailing: 0, distinctOriginsConnected: 1 },
  summaryText: '',
}

const fetchMock = jest.fn(async (_url: string) => ({ ok: true, status: 200, json: async () => health }))
const connectionHealthCalls = () => fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/connection-health')).length
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve() })

beforeEach(() => {
  jest.useFakeTimers()
  forgetSharedReads()
  fetchMock.mockClear()
  ;(global as any).fetch = fetchMock
})

afterEach(() => {
  jest.useRealTimers()
})

it('reads once for two pills, and polls once every 15 s for both', async () => {
  const { getAllByText } = render(
    <>
      <FrontendConnectionPill projectId="project-1" />
      <FrontendConnectionPill projectId="project-1" variant="full" />
    </>,
  )
  await flush()
  expect(connectionHealthCalls()).toBe(1)
  expect(getAllByText(/shop\.example\.com/).length).toBeGreaterThanOrEqual(2)

  await act(async () => { jest.advanceTimersByTime(15_000) })
  await flush()
  expect(connectionHealthCalls()).toBe(2)
})

it('still reads each project on its own', async () => {
  render(
    <>
      <FrontendConnectionPill projectId="project-1" />
      <FrontendConnectionPill projectId="project-2" />
    </>,
  )
  await flush()
  expect(connectionHealthCalls()).toBe(2)
})
