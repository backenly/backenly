/**
 * The listener hub brings a project's realtime notify function up to date when
 * a stream subscribes, and that never decides the stream (#620).
 *
 * A schema whose realtime was enabled before the notify function last changed
 * keeps the old body until something replaces it (lib/realtime/channels.ts
 * bringProjectFunctionsCurrent; what replacing it does to a real schema is in
 * tests/integration/realtime-large-changes.spec.ts and
 * tests/integration/realtime-channel-per-project.spec.ts). The hub asks for
 * that on every subscribe. Database-free: the LISTEN connection, the plan
 * check, the region and the project's channel are stubbed.
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
// The channel the platform keeps for the project: what the hub must LISTEN on.
const mockChannel = 'bkn_rt_' + 'a1'.repeat(24)
jest.mock('@/lib/realtime/channels', () => ({
  projectChannel: jest.fn(async () => mockChannel),
  currentProjectChannel: jest.fn(async () => mockChannel),
  channelsOfSchemas: jest.fn(async () => new Map()),
  bringFunctionsCurrent: jest.fn(async () => ({ states: new Map(), failures: [] })),
  bringProjectFunctionsCurrent: (...args: unknown[]) => mockEnsure(...args),
  realtimePool: jest.fn(),
}))
// Off, the hub checks a project id as it does in production. On, any value
// passes, which is what CodeQL assumes of an id read from a request.
let mockAcceptAnyProjectId = false
jest.mock('@/lib/security/workspace-schema', () => {
  const actual = jest.requireActual('@/lib/security/workspace-schema')
  return {
    ...actual,
    workspaceChannelName: (projectId: unknown) =>
      mockAcceptAnyProjectId ? `workspace_${projectId}_changes` : actual.workspaceChannelName(projectId),
    workspaceSchemaName: (projectId: unknown) =>
      mockAcceptAnyProjectId ? `workspace_${projectId}` : actual.workspaceSchemaName(projectId),
  }
})

import { format } from 'util'
import { listenerHub } from '@/lib/realtime/listener-hub'

const PROJECT = '11111111-2222-4333-8444-555555555555'
// Every placeholder Node's util.format reads in a format string.
const PLACEHOLDERS = '%s %d %i %f %j %o %O %c %%'
const settle = () => new Promise((resolve) => setImmediate(resolve))

afterEach(() => {
  mockEnsure.mockReset()
  mockClient.query.mockClear()
})

it('listens on the channel the platform keeps for the project, and hands out only the stream\'s label', async () => {
  mockEnsure.mockResolvedValue('current')
  const subscription = await listenerHub.subscribe(PROJECT, () => {})
  if (!subscription.ok) throw new Error('subscribe refused')
  const sent = mockClient.query.mock.calls.map((call: unknown[]) => String(call[0]))
  expect(sent).toContain(`LISTEN "${mockChannel}"`)
  expect(sent.some((sql) => sql.includes('_changes'))).toBe(false)
  expect(subscription.channel).toBe(`workspace_${PROJECT}_changes`)
  subscription.unsubscribe()
  expect(mockClient.query.mock.calls.map((call: unknown[]) => String(call[0]))).toContain(`UNLISTEN "${mockChannel}"`)
})

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
      onNotification({ channel: mockChannel, payload: `{"data": "${PLACEHOLDERS}"` })
      expect(warn.mock.calls.map((call) => format(...call))).toEqual([
        `[ListenerHub] Malformed NOTIFY on workspace_${PROJECT}_changes — {"data": "${PLACEHOLDERS}"`,
      ])
      subscription.unsubscribe()
    } finally {
      warn.mockRestore()
    }
  })
})
