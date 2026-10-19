/**
 * A PLATFORM ROW ABOUT A REGIONAL PROJECT'S WORK QUOTES NONE OF WHAT IT CARRIED
 * =============================================================================
 * The platform database is in the home region. For a project kept in another
 * region, the execution timeline and the operational-memory ledger keep the
 * names, kinds, counts and ids of what was done, never the request, the
 * agent's result, a tool's arguments or an error, any of which can quote its
 * rows or an end user's email (lib/data-plane/residency.ts). Its security
 * events keep its end users' networks, not their addresses, and no query
 * string or user agent; its monthly active users are counted under a stable
 * per-project stand-in, not their ids. A home project's rows are unchanged.
 *
 * Database-free: the platform client is a recorder, and the project's region
 * is whatever the test says it is.
 */

const mockRegions = new Map<string, string | null>()
const mockTimelineRows: any[] = []
const mockTimelineUpdates: any[] = []
const mockEvents: any[] = []
const mockReceipts: any[] = []
const mockSecurityEvents: any[] = []
const mockActiveUserValues: unknown[][] = []

jest.mock('@/lib/db/prisma', () => ({
  prisma: {
    project: {
      findUnique: jest.fn(async ({ where }: any) => {
        if (where.id === 'p-broken') throw new Error('connection refused')
        return mockRegions.has(where.id) ? { region: mockRegions.get(where.id) } : null
      }),
    },
    executionTimelineEntry: {
      create: jest.fn(async ({ data }: any) => { mockTimelineRows.push(data); return { id: `t${mockTimelineRows.length}` } }),
      update: jest.fn(async ({ data }: any) => { mockTimelineUpdates.push(data); return data }),
    },
    securityEvent: {
      create: jest.fn(async ({ data }: any) => { mockSecurityEvents.push(data); return data }),
    },
    // trackEndUserActive's upsert: the tagged template's values, in order.
    $queryRaw: jest.fn(async (_sql: unknown, ...values: unknown[]) => { mockActiveUserValues.push(values); return [{ inserted: false }] }),
  },
}))

// The quota kernel's billing neighbours, which this suite does not exercise.
jest.mock('@/lib/entitlements', () => ({ accountOfUser: jest.fn(), getAccountEntitlements: jest.fn() }))
jest.mock('@/lib/usage/account', () => ({ accountOf: jest.fn(), accountProjectsWhere: jest.fn() }))
jest.mock('@/lib/usage/ledger', () => ({ recordUsage: jest.fn() }))
jest.mock('@/lib/usage/alerts', () => ({ recordQuotaWarning: jest.fn() }))
jest.mock('@/lib/usage/overage', () => ({ effectiveCap: jest.fn() }))
jest.mock('@/lib/services/end-user-auth-table', () => ({
  isReservedTestEmail: (email: string | null | undefined) => /@backenly\.internal$/i.test(email ?? ''),
}))

jest.mock('@/lib/db', () => ({
  prisma: {
    backendEvent: {
      create: jest.fn(async ({ data }: any) => { mockEvents.push(data); return { id: `e${mockEvents.length}`, ...data } }),
      updateMany: jest.fn(async () => ({ count: 0 })),
    },
    changeReceipt: {
      create: jest.fn(async ({ data }: any) => { mockReceipts.push(data); return { id: `r${mockReceipts.length}`, ...data } }),
    },
    backendPattern: { upsert: jest.fn(async () => ({})) },
  },
}))

import {
  NOT_QUOTED,
  addressNetwork,
  argumentShape,
  endUserPseudonym,
  pathWithoutQuery,
  quotesKeptHere,
} from '@/lib/data-plane/residency'
import { trackAction } from '@/lib/ai/execution-timeline'
import { recordBackendExecutionMemory, recordToolExecutionMemory } from '@/lib/operational-memory/ledger'
import { recordSecurityEvent } from '@/lib/platform-controls/security-events'
import { trackEndUserActive } from '@/lib/quota/kernel'

const EMAIL = 'alice@example.com'
const flush = () => new Promise((resolve) => setImmediate(resolve))
const savedKeys = { ENV_VAR_ENCRYPTION_KEY: process.env.ENV_VAR_ENCRYPTION_KEY, JWT_SECRET: process.env.JWT_SECRET }

beforeAll(() => {
  mockRegions.set('p-home', null)
  mockRegions.set('p-mumbai', 'ap-south-1')
  mockRegions.set('p-virginia', 'us-east-1')
  mockRegions.set('p-frankfurt', 'eu-central-1')
  mockRegions.set('p-unknown', 'xx-nowhere-1')
  delete process.env.ENV_VAR_ENCRYPTION_KEY
  process.env.JWT_SECRET = 'not-a-real-residency-key'
})

afterAll(() => {
  for (const [name, value] of Object.entries(savedKeys)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
})

beforeEach(() => {
  mockTimelineRows.length = 0
  mockTimelineUpdates.length = 0
  mockEvents.length = 0
  mockReceipts.length = 0
  mockSecurityEvents.length = 0
  mockActiveUserValues.length = 0
})

describe('whether a platform row may quote a project', () => {
  it('quotes a home project, recorded as the home region or as none', async () => {
    expect(await quotesKeptHere('p-home')).toBe(true)
    expect(await quotesKeptHere('p-mumbai')).toBe(true)
  })

  it('quotes nothing for a project kept in another region', async () => {
    expect(await quotesKeptHere('p-virginia')).toBe(false)
    expect(await quotesKeptHere('p-frankfurt')).toBe(false)
  })

  it('quotes nothing when the region cannot be read, or names no region this build knows', async () => {
    expect(await quotesKeptHere('p-broken')).toBe(false)
    expect(await quotesKeptHere('p-unknown')).toBe(false)
  })
})

describe("a tool's arguments, as a regional project's platform rows keep them", () => {
  it("keeps an insert's table and how many rows, never the rows", () => {
    expect(argumentShape({ table: 'customers', rows: [{ email: EMAIL }, { email: 'bob@example.com' }] }))
      .toEqual({ table: 'customers', rows: { count: 2 } })
  })

  it('keeps an opaque id, and no email, even one passed as an id', () => {
    const id = '2b1c3d4e-0000-4000-8000-000000000001'
    expect(argumentShape({ userId: id, email: EMAIL })).toEqual({ userId: id, email: '[string]' })
    expect(argumentShape({ userId: EMAIL })).toEqual({ userId: '[string]' })
  })

  it('keeps numbers and flags, and anything else only as its kind', () => {
    expect(argumentShape({ limit: 10, cascade: true, values: { name: 'Alice' }, where: `email = '${EMAIL}'` }))
      .toEqual({ limit: 10, cascade: true, values: '[object]', where: '[string]' })
  })

  it('drops a structural name whose value is not an identifier', () => {
    expect(argumentShape({ table: 'customers; drop table x' })).toEqual({ table: '[string]' })
  })
})

describe('the execution timeline', () => {
  const insert = { action: 'INSERT_DATA', params: { table: 'customers', rows: [{ email: EMAIL }] } }

  it('keeps a home project’s arguments and messages as before', async () => {
    await trackAction('p-home', 'run-1', insert, async () => ({ success: false, error: `Key (email)=(${EMAIL}) already exists` }))
    await flush()
    expect(mockTimelineRows[0].actionParams).toEqual(insert.params)
    expect(mockTimelineUpdates[0].errorMessage).toContain(EMAIL)
  })

  // A home project's success is pinned the same way in
  // tests/integration/execution-timeline-outcomes.spec.ts.
  it('keeps a regional project’s argument shape and no failure message, and a success keeps no message in any region', async () => {
    await trackAction('p-virginia', 'run-2', insert, async () => ({ success: false, error: `Key (email)=(${EMAIL}) already exists` }))
    await trackAction('p-virginia', 'run-3', insert, async () => ({ success: true, message: `Inserted ${EMAIL}` }))
    await expect(
      trackAction('p-virginia', 'run-4', insert, async () => { throw new Error(`duplicate ${EMAIL}`) }),
    ).rejects.toThrow(EMAIL) // the caller still gets the real error
    await flush()

    expect(mockTimelineRows.map((row) => row.actionParams)).toEqual([
      { table: 'customers', rows: { count: 1 } },
      { table: 'customers', rows: { count: 1 } },
      { table: 'customers', rows: { count: 1 } },
    ])
    expect(mockTimelineUpdates.map((update) => update.errorMessage)).toEqual([NOT_QUOTED, null, NOT_QUOTED])
    expect(JSON.stringify([mockTimelineRows, mockTimelineUpdates])).not.toContain(EMAIL)
  })

  it('takes the text out of a regional project’s retry history too', async () => {
    const retryHistory = [{ attempt: 1, errorMessage: `bad ${EMAIL}`, errorClassification: 'UNKNOWN' as const, healingApplied: null, delayMs: 10, timestamp: 't' }]
    await trackAction('p-virginia', 'run-5', insert, async () => ({ success: true }), { retryHistory })
    await flush()
    expect(mockTimelineUpdates[0].healingApplied).toEqual([{ ...retryHistory[0], errorMessage: NOT_QUOTED }])
  })
})

describe('the operational-memory ledger', () => {
  const request = `Block ${EMAIL} and add a notes table`
  const result = `Blocked ${EMAIL}. Created table notes.`

  it('quotes a home project’s request and result as before', async () => {
    await recordToolExecutionMemory({ projectId: 'p-home', userMessage: request, tools: ['create_table'], summary: result })
    expect(mockEvents[0].summary).toContain(EMAIL)
    expect(mockReceipts[0].summary).toContain(request)
    expect(mockReceipts[0].summary).toContain('Result:')
  })

  it('records which tools ran for a regional project, never its request or result', async () => {
    await recordToolExecutionMemory({ projectId: 'p-virginia', userMessage: request, tools: ['create_table'], summary: result })
    expect(mockEvents.map((event) => event.summary)).toEqual(['User asked for a backend change.', expect.any(String)])
    expect(mockReceipts[0].summary).not.toContain('Result:')
    expect(JSON.stringify([mockEvents, mockReceipts])).not.toContain(EMAIL)
  })

  it('records what changed for a regional project, never the request or the intent read from it', async () => {
    await recordBackendExecutionMemory({
      projectId: 'p-frankfurt',
      userMessage: request,
      canonicalIntent: { blockUser: EMAIL },
      changes: [{ type: 'table', action: 'created', target: 'notes', details: { entityName: 'notes' } }],
    })
    expect(mockEvents[0]).toMatchObject({ summary: 'User asked for a backend change.' })
    expect(mockEvents[0].afterState).toBeUndefined()
    expect(mockEvents[1]).toMatchObject({ summary: 'Created table notes', reason: 'Backenly applied this because of the request.' })
    expect(mockReceipts[0]).toMatchObject({ title: 'Created notes backend resource' })
    expect(JSON.stringify([mockEvents, mockReceipts])).not.toContain(EMAIL)
  })
})

describe('an end user’s address, path and id, as a regional project’s platform rows keep them', () => {
  it('keeps the network of an address, never the address', () => {
    expect(addressNetwork('203.0.113.45')).toBe('203.0.113.0/24')
    expect(addressNetwork('::ffff:198.51.100.7')).toBe('198.51.100.0/24')
    expect(addressNetwork('2001:db8:85a3::8a2e:370:7334')).toBe('2001:db8:85a3::/48')
    expect(addressNetwork('2001:0db8::1')).toBe('2001:db8:0::/48')
  })

  it('keeps nothing of what is not an address', () => {
    expect(addressNetwork('not-an-address')).toBeNull()
    expect(addressNetwork('')).toBeNull()
    expect(addressNetwork(null)).toBeNull()
  })

  it('drops a query string and a fragment from a path', () => {
    expect(pathWithoutQuery(`/api/v1/p1/db/users?email=eq.${EMAIL}`)).toBe('/api/v1/p1/db/users')
    expect(pathWithoutQuery('/api/v1/p1/db/users#top')).toBe('/api/v1/p1/db/users')
    expect(pathWithoutQuery('/api/v1/p1/db/users')).toBe('/api/v1/p1/db/users')
  })

  it('gives each end user one stand-in per project, which names neither', () => {
    const once = endUserPseudonym('p-virginia', EMAIL)
    expect(endUserPseudonym('p-virginia', EMAIL)).toBe(once)
    expect(endUserPseudonym('p-frankfurt', EMAIL)).not.toBe(once)
    expect(endUserPseudonym('p-virginia', 'bob@example.com')).not.toBe(once)
    expect(once).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(once).not.toContain('alice')
  })

  it('refuses to make a stand-in without a key, which would protect nothing', () => {
    const key = process.env.JWT_SECRET
    delete process.env.JWT_SECRET
    try {
      expect(() => endUserPseudonym('p-virginia', EMAIL)).toThrow(/No key/)
    } finally {
      process.env.JWT_SECRET = key
    }
  })
})

describe('security events', () => {
  const failure = (projectId: string | null) => ({
    kind: 'auth_failure',
    projectId,
    ip: '203.0.113.45',
    summary: 'Auth failed (missing_key) from https://app.example.com',
    detail: { origin: 'https://app.example.com', path: `/api/v1/p1/db/users?email=eq.${EMAIL}`, method: 'GET', userAgent: 'Mozilla/5.0 (iPhone)' },
  })

  it('records a home project’s event as before', async () => {
    await recordSecurityEvent(failure('p-home'))
    expect(mockSecurityEvents[0]).toMatchObject({ ip: '203.0.113.45', detail: failure('p-home').detail })
  })

  it('records a regional project’s event with its network, its path without the query, and no user agent', async () => {
    await recordSecurityEvent(failure('p-virginia'))
    expect(mockSecurityEvents[0]).toMatchObject({
      kind: 'auth_failure',
      projectId: 'p-virginia',
      ip: '203.0.113.0/24',
      detail: { origin: 'https://app.example.com', path: '/api/v1/p1/db/users', method: 'GET' },
    })
    expect(mockSecurityEvents[0].detail).not.toHaveProperty('userAgent')
    expect(JSON.stringify(mockSecurityEvents)).not.toContain(EMAIL)
  })

  it('records an event about no project, the platform’s own, as before', async () => {
    await recordSecurityEvent(failure(null))
    expect(mockSecurityEvents[0]).toMatchObject({ ip: '203.0.113.45', detail: { userAgent: 'Mozilla/5.0 (iPhone)' } })
  })
})

describe('monthly active users', () => {
  // The upsert's values: id, projectId, endUserId, month.
  const countedAs = () => mockActiveUserValues.map((values) => values[2])

  it('counts a home project’s end user by their id, as before', async () => {
    await trackEndUserActive('p-home', 'user-1', EMAIL)
    expect(countedAs()).toEqual(['user-1'])
  })

  it('counts a regional project’s end user by their stand-in, the same each time', async () => {
    await trackEndUserActive('p-virginia', 'user-1', EMAIL)
    await trackEndUserActive('p-virginia', 'user-1', EMAIL)
    expect(countedAs()).toEqual([endUserPseudonym('p-virginia', 'user-1'), endUserPseudonym('p-virginia', 'user-1')])
    expect(JSON.stringify(mockActiveUserValues)).not.toContain('user-1')
  })

  it('does not count a regional end user at all without a key, rather than by their id', async () => {
    const key = process.env.JWT_SECRET
    delete process.env.JWT_SECRET
    try {
      await trackEndUserActive('p-frankfurt', 'user-2', EMAIL)
    } finally {
      process.env.JWT_SECRET = key
    }
    expect(countedAs()).toEqual([])
  })
})
