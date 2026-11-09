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
 *
 * The hub's warnings print the values they carry as they are, placeholders and
 * all: a value is never part of console.warn's first argument, which Node reads
 * as a format string (CodeQL js/tainted-format-string).
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
// Off, the hub checks a project id as it does in production. On, any value
// passes, which is what CodeQL assumes of an id read from a request.
let mockAcceptAnyProjectId = false
jest.mock('@/lib/security/workspace-schema', () => {
  const actual = jest.requireActual('@/lib/security/workspace-schema')
  return {
    ...actual,
    workspaceChannelName: (projectId: unknown) =>
      mockAcceptAnyProjectId ? `workspace_${projectId}_changes` : actual.workspaceChannelName(projectId),
  }
})

import { format } from 'util'
import { listenerHub } from '@/lib/realtime/listener-hub'

const PROJECT = '11111111-2222-4333-8444-555555555555'
// Every placeholder Node's util.format reads in a format string.
const PLACEHOLDERS = '%s %d %i %f %j %o %O %c %%'
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
    // As Node prints it: the project id and the reason, with a constant format.
    expect(warn.mock.calls.map((call) => format(...call))).toEqual([
      `[ListenerHub] could not bring the realtime notify function of ${PROJECT} up to date: region unreachable`,
    ])
    if (subscription.ok) subscription.unsubscribe()
  } finally {
    warn.mockRestore()
  }
})

describe('the hub\'s warnings print outside values as they are', () => {
  it.each([
    ['an error', new Error(`region unreachable ${PLACEHOLDERS}`), `region unreachable ${PLACEHOLDERS}`],
    ['a thrown string', `region unreachable ${PLACEHOLDERS}`, `region unreachable ${PLACEHOLDERS}`],
    ['a thrown object', { code: 'ECONNRESET', detail: PLACEHOLDERS }, `{ code: 'ECONNRESET', detail: '${PLACEHOLDERS}' }`],
  ])('when the notify function cannot be brought up to date: a project id and %s full of placeholders', async (_, reason, printed) => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    mockAcceptAnyProjectId = true
    try {
      const projectId = `project ${PLACEHOLDERS}`
      mockEnsure.mockRejectedValue(reason)
      const subscription = await listenerHub.subscribe(projectId, () => {})
      await settle()
      await settle()
      expect(subscription.ok).toBe(true)
      expect(warn.mock.calls.map((call) => format(...call))).toEqual([
        `[ListenerHub] could not bring the realtime notify function of project ${PLACEHOLDERS} up to date: ${printed}`,
      ])
      if (subscription.ok) subscription.unsubscribe()
    } finally {
      mockAcceptAnyProjectId = false
      warn.mockRestore()
    }
  })

  it('a project id that is not one is refused before the notify function or its warning', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const subscription = await listenerHub.subscribe(`project ${PLACEHOLDERS}`, () => {})
      await settle()
      await settle()
      expect(subscription).toEqual({ ok: false, code: 'INVALID_PROJECT', message: 'Invalid project ID' })
      expect(mockEnsure).not.toHaveBeenCalled()
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  it('when a notification is not JSON: its text, which carries the project\'s row data, full of placeholders', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      mockEnsure.mockResolvedValue('current')
      const subscription = await listenerHub.subscribe(PROJECT, () => {})
      await settle()
      if (!subscription.ok) throw new Error('subscribe refused')
      const onNotification = mockClient.on.mock.calls.find(([event]) => event === 'notification')![1] as (msg: object) => void
      onNotification({ channel: subscription.channel, payload: `{"data": "${PLACEHOLDERS}"` })
      expect(warn.mock.calls.map((call) => format(...call))).toEqual([
        `[ListenerHub] Malformed NOTIFY on workspace_${PROJECT}_changes — {"data": "${PLACEHOLDERS}"`,
      ])
      subscription.unsubscribe()
    } finally {
      warn.mockRestore()
    }
  })
})
