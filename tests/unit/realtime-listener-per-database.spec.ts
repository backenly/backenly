/**
 * The listener hub keeps one LISTEN connection per database
 * (lib/realtime/listener-hub.ts): a region's own database's for shared
 * projects, kept as it always was, and a project's own database's for a project
 * that has one, opened with its first stream and closed a while after its last.
 * A process keeps a bounded number of the latter; past that a stream is refused
 * in so many words, never opened on a listener that would hear nothing.
 *
 * Database-free: the LISTEN connection, the plan check and where each project's
 * channel is kept are stubbed, the connection strings are the real ones built
 * from the environment. What a real NOTIFY reaches, and that a listener's
 * connection really closes, is tests/integration/project-database-sessions.spec.ts.
 */

jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] })

interface FakeClient {
  connectionString: string
  sent: string[]
  ended: boolean
  connect: jest.Mock
  query: jest.Mock
  on: jest.Mock
  end: jest.Mock
}
const mockClients: FakeClient[] = []
jest.mock('pg', () => ({
  Client: jest.fn((config: { connectionString: string }) => {
    const client: FakeClient = {
      connectionString: config.connectionString,
      sent: [],
      ended: false,
      connect: jest.fn(async () => {}),
      query: jest.fn(async (sql: string) => {
        client.sent.push(sql)
        return {}
      }),
      on: jest.fn(),
      end: jest.fn(async () => {
        client.ended = true
      }),
    }
    mockClients.push(client)
    return client
  }),
}))
jest.mock('@/lib/quota/kernel', () => ({ enforceRealtimeConnection: jest.fn(async () => ({ allowed: true })) }))

const DB_A = `p_${'a1'.repeat(16)}`
const DB_B = `p_${'b2'.repeat(16)}`
const SHARED = '11111111-2222-4333-8444-555555555555'
const OWN_A = '22222222-3333-4444-8555-666666666666'
const OWN_B = '33333333-4444-4555-8666-777777777777'
const mockDatabases: Record<string, string | null> = { [SHARED]: null, [OWN_A]: DB_A, [OWN_B]: DB_B }
const mockChannelOf = (projectId: string) => `bkn_rt_${projectId.replace(/-/g, '').slice(0, 24).padEnd(48, '0')}`

jest.mock('@/lib/realtime/channels', () => {
  const actual = jest.requireActual('@/lib/realtime/channels')
  return {
    realtimeDatabaseKey: actual.realtimeDatabaseKey,
    projectRealtimeDatabase: jest.fn(async (projectId: string) => ({ region: 'ap-south-1', database: mockDatabases[projectId] ?? null })),
    projectChannel: jest.fn(async (projectId: string) => mockChannelOf(projectId)),
    currentProjectChannel: jest.fn(async (projectId: string) => mockChannelOf(projectId)),
    channelsOfSchemas: jest.fn(async () => new Map()),
    bringFunctionsCurrent: jest.fn(async () => ({ states: new Map(), failures: [] })),
    bringProjectFunctionsCurrent: jest.fn(async () => ({ notify: 'current', presence: 'current' })),
    realtimeDatabasePool: jest.fn(async () => ({})),
    realtimePool: jest.fn(),
  }
})

import { HOME_REGION } from '@/lib/regions'
import { REALTIME_BUSY_MESSAGE, listenerHub } from '@/lib/realtime/listener-hub'

const DATA_URL = 'postgresql://app:data-secret@data.example.test:5432/postgres'
const ENV_NAMES = ['DATA_DATABASE_URL', 'DATA_DIRECT_URL', 'REALTIME_LISTENER_IDLE_CLOSE_MS', 'REALTIME_DATABASE_LISTENERS_MAX'] as const
const saved = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]))

const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve))
}
const clientOn = (database: string) => mockClients.filter((c) => new URL(c.connectionString).pathname === `/${database}`)

async function subscribe(projectId: string) {
  const result = await listenerHub.subscribe(projectId, () => {})
  if (!result.ok) throw new Error(`refused: ${result.code}`)
  return result
}

beforeEach(() => {
  process.env.DATA_DATABASE_URL = DATA_URL
  delete process.env.DATA_DIRECT_URL
  process.env.REALTIME_LISTENER_IDLE_CLOSE_MS = '1000'
  delete process.env.REALTIME_DATABASE_LISTENERS_MAX
})

afterAll(() => {
  for (const name of ENV_NAMES) {
    if (saved[name] === undefined) delete process.env[name]
    else process.env[name] = saved[name]
  }
})

describe('a listener per database', () => {
  it('hears a project with a database of its own on that database, and a shared one on its region’s', async () => {
    const shared = await subscribe(SHARED)
    const own = await subscribe(OWN_A)
    expect(listenerHub.listenerKeys().sort()).toEqual([`${HOME_REGION}:${DB_A}`, `${HOME_REGION}:control`].sort())

    const [onA] = clientOn(DB_A)
    expect(onA).toBeDefined()
    // The data instance's server and credentials, the project's database.
    expect(new URL(onA.connectionString).host).toBe('data.example.test:5432')
    expect(onA.sent).toContain(`LISTEN "${mockChannelOf(OWN_A)}"`)
    // The shared project's channel is LISTENed on the region's connection only.
    const regionClient = mockClients.find((c) => c.sent.includes(`LISTEN "${mockChannelOf(SHARED)}"`))
    expect(regionClient).toBeDefined()
    expect(regionClient).not.toBe(onA)
    expect(onA.sent).not.toContain(`LISTEN "${mockChannelOf(SHARED)}"`)

    shared.unsubscribe()
    own.unsubscribe()
    jest.advanceTimersByTime(1_000)
    await settle()
  })

  it('uses the data instance’s direct connection when one is set', async () => {
    process.env.DATA_DIRECT_URL = 'postgresql://app:data-secret@direct.example.test:5432/postgres'
    const own = await subscribe(OWN_B)
    const [onB] = clientOn(DB_B).filter((c) => !c.ended)
    expect(new URL(onB.connectionString).host).toBe('direct.example.test:5432')
    own.unsubscribe()
    jest.advanceTimersByTime(1_000)
    await settle()
  })

  it('closes a project database’s listener a while after its last stream, and only then', async () => {
    const first = await subscribe(OWN_A)
    const second = await subscribe(OWN_A)
    const [onA] = clientOn(DB_A).filter((c) => !c.ended)

    first.unsubscribe()
    jest.advanceTimersByTime(5_000)
    await settle()
    expect(onA.ended).toBe(false)

    second.unsubscribe()
    jest.advanceTimersByTime(999)
    await settle()
    expect(onA.ended).toBe(false)
    expect(listenerHub.listenerKeys()).toContain(`${HOME_REGION}:${DB_A}`)

    jest.advanceTimersByTime(1)
    await settle()
    expect(onA.ended).toBe(true)
    expect(listenerHub.listenerKeys()).not.toContain(`${HOME_REGION}:${DB_A}`)

    // The next stream opens a listener of its own again.
    const again = await subscribe(OWN_A)
    expect(clientOn(DB_A).filter((c) => !c.ended)).toHaveLength(1)
    again.unsubscribe()
    jest.advanceTimersByTime(1_000)
    await settle()
  })

  it('keeps a listener a stream arrives at during its grace', async () => {
    const first = await subscribe(OWN_A)
    const [onA] = clientOn(DB_A).filter((c) => !c.ended)
    first.unsubscribe()
    jest.advanceTimersByTime(500)
    const second = await subscribe(OWN_A)
    jest.advanceTimersByTime(5_000)
    await settle()
    expect(onA.ended).toBe(false)
    expect(clientOn(DB_A).filter((c) => !c.ended)).toEqual([onA])
    second.unsubscribe()
    jest.advanceTimersByTime(1_000)
    await settle()
    expect(onA.ended).toBe(true)
  })

  it('keeps the region’s listener after its last stream, as always', async () => {
    const shared = await subscribe(SHARED)
    shared.unsubscribe()
    jest.advanceTimersByTime(10 * 60_000)
    await settle()
    expect(listenerHub.listenerKeys()).toContain(`${HOME_REGION}:control`)
    expect(mockClients.filter((c) => new URL(c.connectionString).pathname !== `/${DB_A}` && new URL(c.connectionString).pathname !== `/${DB_B}` && c.ended)).toEqual([])
  })
})

describe('the cap on project databases’ listeners', () => {
  it('refuses a stream in so many words when every listener is in use, and counts nothing for it', async () => {
    process.env.REALTIME_DATABASE_LISTENERS_MAX = '1'
    const own = await subscribe(OWN_A)
    const before = mockClients.length

    const refused = await listenerHub.subscribe(OWN_B, () => {})
    expect(refused).toEqual({ ok: false, code: 'REALTIME_BUSY', message: REALTIME_BUSY_MESSAGE })
    expect(listenerHub.connectionCount(OWN_B)).toBe(0)
    expect(mockClients.length).toBe(before)
    expect(listenerHub.listenerKeys()).not.toContain(`${HOME_REGION}:${DB_B}`)

    // Shared projects are never refused by it.
    const shared = await subscribe(SHARED)
    shared.unsubscribe()

    own.unsubscribe()
    jest.advanceTimersByTime(1_000)
    await settle()
  })

  it('closes a listener waiting out its grace to make room', async () => {
    process.env.REALTIME_DATABASE_LISTENERS_MAX = '1'
    process.env.REALTIME_LISTENER_IDLE_CLOSE_MS = '60000'
    const own = await subscribe(OWN_A)
    const [onA] = clientOn(DB_A).filter((c) => !c.ended)
    own.unsubscribe()

    const other = await subscribe(OWN_B)
    expect(onA.ended).toBe(true)
    expect(listenerHub.listenerKeys()).toContain(`${HOME_REGION}:${DB_B}`)
    expect(listenerHub.listenerKeys()).not.toContain(`${HOME_REGION}:${DB_A}`)
    expect(listenerHub.connectionCount(OWN_B)).toBe(1)
    other.unsubscribe()
    jest.advanceTimersByTime(60_000)
    await settle()
  })
})
