/**
 * A PROJECT'S ALLOWED ADDRESSES: THE CONSOLE'S ROUTE AND MCP
 * =========================================================
 *
 * Where a region's database endpoint admits only allowed addresses (owner's
 * decision, 2026-11-17), each project keeps the addresses its direct Postgres
 * logins may connect from (lib/services/direct-access-addresses.ts):
 *
 *   - one public IPv4 address or a range no wider than /16, normalised;
 *     0.0.0.0/0, wider ranges, private ranges and IPv6 are refused with what
 *     to send instead, and nothing is stored;
 *   - up to the plan's number: Free 2, Pro 10, Enterprise 50;
 *   - "Allow my address" allows the address the load balancer saw, never one
 *     the client wrote into X-Forwarded-For;
 *   - each add and remove reaches the region's allowlist at once;
 *   - until one is allowed, the status and MCP say "Allow an address first",
 *     before anything about the login;
 *   - over MCP, database_credentials takes allowAddress and removeAddress,
 *     validated the same way, with a plain refusal;
 *   - where the region does not limit addresses, there is no list to change.
 *
 * Real platform database; the EC2 prefix list is a stand-in
 * (tests/helpers/fake-prefix-list.ts) and no AWS call is made.
 */

let mockProjectId = ''
let mockUserId = ''
let mockPlan = 'SANDBOX'
jest.mock('@/lib/middleware/projectValidation', () => ({
  withProjectValidation: (_req: any, handler: any) => handler({ projectId: mockProjectId, userId: mockUserId }),
}))
jest.mock('@cloud/entitlements', () => {
  const actual = jest.requireActual('@cloud/entitlements')
  const { selfHostedEntitlements } = jest.requireActual('@/lib/entitlements/self-hosted')
  return { ...actual, cloudEntitlements: async () => ({ ...selfHostedEntitlements(), planName: mockPlan }) }
})
jest.mock('@aws-sdk/client-ec2', () => jest.requireActual('../helpers/fake-prefix-list').mockEc2Module())

import '../helpers/real-web-standard'
import { randomUUID } from 'crypto'
import { prisma } from '@/lib/db/prisma'
import { encryptValue } from '@/lib/security/projectEnvCrypto'
import { prefixLists, type FakePrefixList } from '../helpers/fake-prefix-list'
import { directAccessRoleNames, getDirectAccessStatus } from '@/lib/services/direct-access'
import { dispatchTool } from '@/lib/ai/brain/tools'
import { DELETE, GET, POST } from '@/app/api/projects/[id]/database-access/allowed-addresses/route'
import { GET as statusRoute } from '@/app/api/projects/[id]/database-access/route'

const LIST = 'pl-0a1b2c3d4e5f60003'
const ORIGINAL = { edition: process.env.BACKENLY_EDITION, list: process.env.DIRECT_DB_ALLOWLIST_PREFIX_LIST_ID }
let list: FakePrefixList

function request(body: unknown = {}, opts: { forwardedFor?: string; query?: string } = {}): any {
  const headers = new Headers()
  if (opts.forwardedFor) headers.set('x-forwarded-for', opts.forwardedFor)
  const url = `http://localhost:3000/api/projects/${mockProjectId}/database-access/allowed-addresses${opts.query ?? ''}`
  return { method: 'POST', url, headers, json: async () => body }
}
const post = async (body: unknown, opts?: { forwardedFor?: string }) => {
  const res = await POST(request(body, opts))
  return { status: res.status, body: await res.json() }
}
const stored = () => prisma.directAccessAddress.findMany({ where: { projectId: mockProjectId }, orderBy: { cidr: 'asc' } }).then((r) => r.map((a) => a.cidr))

beforeAll(async () => {
  process.env.BACKENLY_EDITION = 'cloud'
  mockUserId = (await prisma.user.create({ data: { email: `addresses-${randomUUID()}@example.test`, name: 'addresses' }, select: { id: true } })).id
  mockProjectId = (await prisma.project.create({ data: { name: 'allowed-addresses', userId: mockUserId }, select: { id: true } })).id
  // A read-only login, so the status and MCP have one to describe.
  const enc = encryptValue('not-a-real-password-' + 'x'.repeat(12))
  await prisma.databaseCredential.create({
    data: {
      projectId: mockProjectId,
      mode: 'READ_ONLY',
      roleName: directAccessRoleNames(mockProjectId).ro,
      passwordCipher: enc.valueCipher,
      passwordIv: enc.valueIv,
      passwordTag: enc.valueTag,
    },
  })
})

beforeEach(async () => {
  process.env.DIRECT_DB_ALLOWLIST_PREFIX_LIST_ID = LIST
  mockPlan = 'SANDBOX'
  prefixLists.reset()
  list = prefixLists.add(LIST, 'ap-south-1')
  await prisma.directAccessAddress.deleteMany({ where: { projectId: mockProjectId } })
})

afterAll(async () => {
  await prisma.databaseCredential.deleteMany({ where: { projectId: mockProjectId } }).catch(() => {})
  await prisma.project.deleteMany({ where: { id: mockProjectId } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: mockUserId } }).catch(() => {})
  if (ORIGINAL.edition === undefined) delete process.env.BACKENLY_EDITION
  else process.env.BACKENLY_EDITION = ORIGINAL.edition
  if (ORIGINAL.list === undefined) delete process.env.DIRECT_DB_ALLOWLIST_PREFIX_LIST_ID
  else process.env.DIRECT_DB_ALLOWLIST_PREFIX_LIST_ID = ORIGINAL.list
})

describe('what can be allowed', () => {
  it('refuses 0.0.0.0/0 and any range wider than /16, says what to send instead, and stores nothing', async () => {
    const everything = await post({ address: '0.0.0.0/0' })
    expect(everything.status).toBe(400)
    expect(everything.body).toEqual({
      code: 'ADDRESS_RANGE_TOO_WIDE',
      error: '0.0.0.0/0 is every address on the internet. Allow only the addresses you connect from: one address, or a range no wider than /16.',
    })
    const wide = await post({ address: '203.0.0.0/8' })
    expect(wide.status).toBe(400)
    expect(wide.body.error).toBe(
      '203.0.0.0/8 covers 16,777,216 addresses. A range can be at most /16 (65,536 addresses): allow only the addresses you connect from.',
    )
    expect((await post({ address: '198.50.0.0/15' })).body.code).toBe('ADDRESS_RANGE_TOO_WIDE')
    expect(await stored()).toEqual([])
    expect(list.modifications()).toEqual([])
  })

  it('refuses a private range, an IPv6 address and anything that is not an address', async () => {
    expect((await post({ address: '10.1.0.0/16' })).body).toEqual({
      code: 'ADDRESS_NOT_PUBLIC',
      error: '10.1.0.0/16 is a private network range, which never connects from the internet. Allow the public IPv4 address you connect from.',
    })
    expect((await post({ address: '192.168.1.5' })).body.code).toBe('ADDRESS_NOT_PUBLIC')
    expect((await post({ address: '127.0.0.1' })).body.code).toBe('ADDRESS_NOT_PUBLIC')
    expect((await post({ address: '2001:db8::1' })).body.code).toBe('IPV6_NOT_SUPPORTED')
    expect((await post({ address: 'db.example.com' })).body.code).toBe('INVALID_ADDRESS')
    expect(await stored()).toEqual([])
  })

  it('allows one address or a /16 at most, normalised, once, and the region’s allowlist takes it at once', async () => {
    const one = await post({ address: ' 203.0.113.77/24 ' })
    expect(one.status).toBe(201)
    expect(one.body).toMatchObject({ address: { cidr: '203.0.113.0/24' }, added: true, applied: true })
    expect(list.cidrs()).toEqual(['203.0.113.0/24'])

    const again = await post({ address: '203.0.113.0/24' })
    expect(again.status).toBe(200)
    expect(again.body).toMatchObject({ address: { cidr: '203.0.113.0/24' }, added: false })

    expect((await post({ address: '198.51.0.0/16' })).status).toBe(201)
    expect(await stored()).toEqual(['198.51.0.0/16', '203.0.113.0/24'])
    expect(list.cidrs()).toEqual(['198.51.0.0/16', '203.0.113.0/24'])

    const read = await (await GET(request())).json()
    expect(read).toMatchObject({ enforced: true, limit: 2, planName: 'Free' })
    expect(read.addresses.map((a: { cidr: string }) => a.cidr)).toEqual(['203.0.113.0/24', '198.51.0.0/16'])
  })

  it('removes an address, and the region’s allowlist lets it go', async () => {
    await post({ address: '203.0.113.7' })
    const res = await DELETE(request({}, { query: '?address=203.0.113.7/32' }))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ removed: '203.0.113.7/32', applied: true })
    expect(await stored()).toEqual([])
    expect(list.cidrs()).toEqual([])

    const missing = await DELETE(request({}, { query: '?address=192.0.2.1' }))
    expect(missing.status).toBe(404)
    expect((await missing.json()).code).toBe('ADDRESS_NOT_ALLOWED')
  })
})

describe('the plan’s number of addresses', () => {
  it.each([
    ['SANDBOX', 2, 'Free', ', or move to Pro for up to 10'],
    ['BUILDER', 10, 'Pro', ', or ask about Enterprise for up to 50'],
    ['SCALE', 50, 'Enterprise', ''],
  ])('%s allows %i per project, and no more', async (plan, limit, name, more) => {
    mockPlan = plan
    await prisma.directAccessAddress.createMany({
      data: Array.from({ length: limit }, (_, i) => ({ projectId: mockProjectId, cidr: `198.51.100.${i + 1}/32` })),
    })
    const over = await post({ address: '203.0.113.9' })
    expect(over.status).toBe(409)
    expect(over.body).toEqual({
      code: 'ADDRESS_LIMIT_REACHED',
      error: `This project already allows ${limit} addresses, the most the ${name} plan includes. Remove one first${more}.`,
    })
    expect(await prisma.directAccessAddress.count({ where: { projectId: mockProjectId } })).toBe(limit)

    await prisma.directAccessAddress.deleteMany({ where: { projectId: mockProjectId, cidr: '198.51.100.1/32' } })
    expect((await post({ address: '203.0.113.9' })).status).toBe(201)
  })
})

describe('“Allow my address”', () => {
  // The client wrote 1.2.3.4; the load balancer appended what it saw, and the
  // VPC hop after it is a trusted proxy (lib/security/client-ip.ts).
  const forwardedFor = '1.2.3.4, 198.51.100.23, 10.0.0.5'

  it('shows and allows the address the load balancer saw, not the one the client wrote', async () => {
    const read = await (await GET(request({}, { forwardedFor }))).json()
    expect(read.you).toEqual({ address: '198.51.100.23', allowable: true })
    const status = await (await statusRoute(request({}, { forwardedFor }))).json()
    expect(status.you).toEqual({ address: '198.51.100.23', allowable: true })

    const mine = await post({ mine: true, address: '1.2.3.4' }, { forwardedFor })
    expect(mine.status).toBe(201)
    expect(mine.body.address.cidr).toBe('198.51.100.23/32')
    expect(await stored()).toEqual(['198.51.100.23/32'])
  })

  it('says why when the address it came from cannot be allowed, and allows nothing', async () => {
    const read = await (await GET(request({}, { forwardedFor: '127.0.0.1' }))).json()
    expect(read.you).toMatchObject({ address: '127.0.0.1', allowable: false })
    expect(read.you.reason).toMatch(/is a loopback range \(this computer only\), which never connects from the internet/)
    const mine = await post({ mine: true }, { forwardedFor: '127.0.0.1' })
    expect(mine.status).toBe(400)
    expect(mine.body.code).toBe('ADDRESS_NOT_ALLOWABLE')
    expect(await stored()).toEqual([])
  })
})

describe('until an address is allowed', () => {
  it('the status says none is, and MCP says “Allow an address first” before anything about the login', async () => {
    const status = await getDirectAccessStatus(mockProjectId)
    expect(status.allowlist).toMatchObject({ enforced: true, addresses: [], limit: 2 })

    const res = await dispatchTool('get_database_credentials', { mode: 'READ_ONLY' }, { projectId: mockProjectId })
    expect(res.ok).toBe(true)
    expect(res.summary.startsWith('Allow an address first: this project allows no address yet')).toBe(true)
    expect(res.summary.indexOf('Allow an address first')).toBeLessThan(res.summary.indexOf('read-only Postgres access'))
    expect(res.data).toMatchObject({ allowlistEnforced: true, allowedAddresses: [], addressLimit: 2 })
  })

  it('MCP stops saying it once an address is allowed', async () => {
    await post({ address: '203.0.113.7' })
    const res = await dispatchTool('get_database_credentials', { mode: 'READ_ONLY' }, { projectId: mockProjectId })
    expect(res.summary).not.toContain('Allow an address first')
    expect(res.data).toMatchObject({ allowedAddresses: ['203.0.113.7/32'] })
  })
})

describe('over MCP (connect database_credentials)', () => {
  it('refuses a range wider than /16 in plain words, stores nothing and hands out no string', async () => {
    const res = await dispatchTool('get_database_credentials', { allowAddress: '0.0.0.0/0' }, { projectId: mockProjectId })
    expect(res.ok).toBe(false)
    expect(res.code).toBe('ADDRESS_RANGE_TOO_WIDE')
    expect(res.summary).toBe(
      '0.0.0.0/0 is every address on the internet. Allow only the addresses you connect from: one address, or a range no wider than /16.',
    )
    expect(JSON.stringify(res)).not.toContain('postgresql://')
    expect(await stored()).toEqual([])
  })

  it('allows an address, says so, and the region’s allowlist takes it; removeAddress takes it off', async () => {
    const res = await dispatchTool('get_database_credentials', { allowAddress: '198.51.100.23' }, { projectId: mockProjectId })
    expect(res.ok).toBe(true)
    expect(res.summary.split('\n')[0]).toBe('Allowed 198.51.100.23/32 to connect.')
    expect(res.data).toMatchObject({ allowlistEnforced: true, allowedAddresses: ['198.51.100.23/32'] })
    expect(list.cidrs()).toEqual(['198.51.100.23/32'])

    const off = await dispatchTool('get_database_credentials', { removeAddress: '198.51.100.23/32' }, { projectId: mockProjectId })
    expect(off.summary.split('\n')[0]).toBe('Removed 198.51.100.23/32 from the allowed addresses.')
    expect(list.cidrs()).toEqual([])
  })
})

describe('where the region does not limit addresses', () => {
  it('there is no list to change, and the status says it is not enforced', async () => {
    delete process.env.DIRECT_DB_ALLOWLIST_PREFIX_LIST_ID
    const res = await post({ address: '203.0.113.7' })
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('ALLOWLIST_NOT_ENFORCED')
    expect(await stored()).toEqual([])
    expect((await getDirectAccessStatus(mockProjectId)).allowlist).toMatchObject({ enforced: false })
    const mcp = await dispatchTool('get_database_credentials', { mode: 'READ_ONLY' }, { projectId: mockProjectId })
    expect(mcp.summary).not.toContain('Allow an address first')
  })
})
