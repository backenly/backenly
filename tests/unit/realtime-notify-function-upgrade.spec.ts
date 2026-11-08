/**
 * The listener hub brings a project's realtime notify function up to date when
 * it first streams for the project, and that never decides the stream (#620).
 *
 * A schema whose realtime was enabled before the notify function last changed
 * keeps the old body, which sends a large change with no row key, until
 * something replaces it (lib/services/realtimeTriggers.ts
 * ensureRealtimeFunctionCurrent; what replacing it does to a real schema is in
 * tests/integration/realtime-large-changes.spec.ts). The hub asks for that on
 * every subscribe, and the check runs once per project per process. Database-
 * free: the LISTEN connection, the plan check and the region are stubbed.
 */

jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] })

const mockClient = { connect: jest.fn(async () => {}), query: jest.fn(async () => ({})), on: jest.fn(), end: jest.fn(async () => {}) }
jest.mock('pg', () => ({ Client: jest.fn(() => mockClient) }))
jest.mock('@/lib/quota/kernel', () => ({ enforceRealtimeConnection: jest.fn(async () => ({ allowed: true })) }))
jest.mock('@/lib/data-plane/regional', () => ({
  projectRegion: jest.fn(async () => 'home'),
  regionDatabaseUrl: jest.fn(() => 'postgres://listener.test/db'),
  requireRegionDatabaseUrl: jest.fn(() => 'postgres://listener.test/db'),
}))
const mockEnsure = jest.fn()
jest.mock('@/lib/services/realtimeTriggers', () => ({ ensureRealtimeFunctionCurrent: (...args: unknown[]) => mockEnsure(...args) }))

import { listenerHub } from '@/lib/realtime/listener-hub'

const PROJECT = '11111111-2222-4333-8444-555555555555'
const settle = () => new Promise((resolve) => setImmediate(resolve))

afterEach(() => mockEnsure.mockReset())

it('asks for the project\'s notify function to be brought up to date when a stream subscribes', async () => {
  mockEnsure.mockResolvedValue('upgraded')
  const subscription = await listenerHub.subscribe(PROJECT, () => {})
  await settle()
  await settle()
  expect(subscription.ok).toBe(true)
  expect(mockEnsure).toHaveBeenCalledWith(PROJECT)
  if (subscription.ok) subscription.unsubscribe()
})

it('opens the stream even when the function cannot be brought up to date, and says why in the log', async () => {
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
  try {
    mockEnsure.mockRejectedValue(new Error('region unreachable'))
    const subscription = await listenerHub.subscribe(PROJECT, () => {})
    await settle()
    await settle()
    expect(subscription.ok).toBe(true)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(PROJECT), 'region unreachable')
    if (subscription.ok) subscription.unsubscribe()
  } finally {
    warn.mockRestore()
  }
})
