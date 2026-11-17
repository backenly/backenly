/**
 * EACH REGION'S NETWORK ALLOWLIST IS EXACTLY ITS PROJECTS' ALLOWED ADDRESSES
 * ========================================================================
 *
 * A region's database endpoint admits port 5432 only from a prefix list, and
 * Backenly keeps that list equal to the union of the addresses every project
 * in the region allows (lib/services/direct-access-allowlist.ts; owner's
 * decision, 2026-11-17). So:
 *
 *   - every allowed address of a project in the region is on its list, and no
 *     address of a project elsewhere;
 *   - an address leaves the list only when no project there allows it, so one
 *     project removing it never cuts off another;
 *   - an entry nobody allows (added by hand) is taken off;
 *   - a deleted project's addresses stop counting, come back if it is
 *     restored, and go with its purge;
 *   - each modification names the version it read (CurrentVersion), and one
 *     refused because the list changed, or because it is still applying an
 *     earlier one, is read again and retried; a list already right is not
 *     modified at all;
 *   - at most 100 entries go each way per modification, and a list too small
 *     for every address keeps the earliest allowed and says so;
 *   - a region with no list configured has nothing to sync, says so, and
 *     calls nothing.
 *
 * Real platform database; EC2 is a stand-in that keeps EC2's rules
 * (tests/helpers/fake-prefix-list.ts). No AWS call is made.
 */

jest.mock('@aws-sdk/client-ec2', () => jest.requireActual('../helpers/fake-prefix-list').mockEc2Module())

import { randomUUID } from 'crypto'
import { prisma } from '@/lib/db/prisma'
import { prefixLists, type FakePrefixList } from '../helpers/fake-prefix-list'
import { syncAllowlist, syncDirectAccessAllowlists } from '@/lib/services/direct-access-allowlist'
import { purgeDeletedProjects, requestProjectDeletion, restoreDeletedProject } from '@/lib/projects/deletion'

const HOME_LIST = 'pl-0a1b2c3d4e5f60001'
const EAST_LIST = 'pl-0a1b2c3d4e5f60002'
const DAY = 24 * 60 * 60 * 1000

let ownerId = ''
const projects: string[] = []
let homeA = ''
let homeB = ''
let east = ''
let home: FakePrefixList
let eastList: FakePrefixList

async function project(region: string | null): Promise<string> {
  const p = await prisma.project.create({ data: { name: `allowlist-${randomUUID().slice(0, 8)}`, userId: ownerId, region }, select: { id: true } })
  projects.push(p.id)
  return p.id
}

const allow = (projectId: string, ...cidrs: string[]) =>
  prisma.directAccessAddress.createMany({ data: cidrs.map((cidr) => ({ projectId, cidr })) })
const disallow = (projectId: string, cidr: string) => prisma.directAccessAddress.deleteMany({ where: { projectId, cidr } })

const SETTINGS = { DIRECT_DB_ALLOWLIST_PREFIX_LIST_ID: HOME_LIST, DIRECT_DB_ALLOWLIST_PREFIX_LIST_ID_US_EAST_1: EAST_LIST }
const saved = Object.fromEntries(Object.keys(SETTINGS).map((k) => [k, process.env[k]]))

beforeAll(async () => {
  Object.assign(process.env, SETTINGS)
  // The table is this feature's; nothing else in the test database writes it.
  await prisma.directAccessAddress.deleteMany({})
  ownerId = (await prisma.user.create({ data: { email: `allowlist-${randomUUID()}@example.test`, name: 'allowlist' }, select: { id: true } })).id
  homeA = await project(null)
  homeB = await project('ap-south-1')
  east = await project('us-east-1')
})

beforeEach(async () => {
  prefixLists.reset()
  home = prefixLists.add(HOME_LIST, 'ap-south-1')
  eastList = prefixLists.add(EAST_LIST, 'us-east-1')
  await prisma.directAccessAddress.deleteMany({ where: { projectId: { in: projects } } })
})

afterAll(async () => {
  await prisma.project.deleteMany({ where: { id: { in: projects } } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: ownerId } }).catch(() => {})
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

it('puts every address the region’s projects allow on its list, and none from another region', async () => {
  await allow(homeA, '203.0.113.7/32', '198.51.100.0/24')
  await allow(homeB, '203.0.113.7/32', '192.0.2.10/32')
  await allow(east, '192.0.2.99/32')

  expect(await syncAllowlist('ap-south-1')).toMatchObject({ status: 'synced', added: 3, removed: 0 })
  expect(home.cidrs()).toEqual(['192.0.2.10/32', '198.51.100.0/24', '203.0.113.7/32'])
  expect(home.modifications()).toHaveLength(1)
  expect(home.modifications()[0].CurrentVersion).toBe(1)

  expect(await syncAllowlist('us-east-1')).toMatchObject({ status: 'synced', added: 1 })
  expect(eastList.cidrs()).toEqual(['192.0.2.99/32'])
  // Each list is reached in its own AWS region.
  expect(prefixLists.clientRegions).toEqual(expect.arrayContaining(['ap-south-1', 'us-east-1']))
})

it('modifies nothing when the list already holds exactly the allowed addresses', async () => {
  await allow(homeA, '203.0.113.7/32')
  await syncAllowlist('ap-south-1')
  const before = home.modifications().length
  expect(await syncAllowlist('ap-south-1')).toMatchObject({ status: 'in_sync', entries: 1 })
  expect(home.modifications()).toHaveLength(before)
})

it('keeps an address on the list while another project still allows it', async () => {
  await allow(homeA, '203.0.113.7/32')
  await allow(homeB, '203.0.113.7/32')
  await syncAllowlist('ap-south-1')

  await disallow(homeA, '203.0.113.7/32')
  expect(await syncAllowlist('ap-south-1')).toMatchObject({ status: 'in_sync' })
  expect(home.cidrs()).toEqual(['203.0.113.7/32'])

  await disallow(homeB, '203.0.113.7/32')
  expect(await syncAllowlist('ap-south-1')).toMatchObject({ status: 'synced', removed: 1 })
  expect(home.cidrs()).toEqual([])
})

it('takes off an entry no project allows, such as one added by hand', async () => {
  await allow(homeA, '203.0.113.7/32')
  home.editElsewhere(['198.18.0.1/32'])
  expect(await syncAllowlist('ap-south-1')).toMatchObject({ status: 'synced', added: 1, removed: 1 })
  expect(home.cidrs()).toEqual(['203.0.113.7/32'])
})

it('stops counting a deleted project’s addresses, counts them again when it is restored, and its purge removes them', async () => {
  const doomed = await project(null)
  await allow(doomed, '192.0.2.50/32')
  await allow(homeA, '203.0.113.7/32')
  await syncAllowlist('ap-south-1')
  expect(home.cidrs()).toEqual(['192.0.2.50/32', '203.0.113.7/32'])

  const now = new Date()
  await requestProjectDeletion(doomed, { kind: 'system', label: 'test' }, now)
  expect(home.cidrs()).toEqual(['203.0.113.7/32'])

  expect(await restoreDeletedProject(doomed, { kind: 'system', label: 'test' }, now)).toEqual({ restored: true })
  expect(home.cidrs()).toEqual(['192.0.2.50/32', '203.0.113.7/32'])

  await requestProjectDeletion(doomed, { kind: 'system', label: 'test' }, now)
  const { purged } = await purgeDeletedProjects(new Date(now.getTime() + 8 * DAY))
  expect(purged).toContain(doomed)
  expect(await prisma.directAccessAddress.count({ where: { projectId: doomed } })).toBe(0)
  expect(home.cidrs()).toEqual(['203.0.113.7/32'])
}, 60_000)

it('reads the list again and retries when it changed between the read and the modification', async () => {
  await allow(homeA, '203.0.113.7/32')
  // Someone else modifies the list after the sync read version 1.
  home.beforeModify = () => home.editElsewhere(['198.18.0.1/32'])

  expect(await syncAllowlist('ap-south-1')).toMatchObject({ status: 'synced' })
  const [refused, applied] = home.modifications()
  expect(refused.CurrentVersion).toBe(1)
  expect(applied.CurrentVersion).toBe(2)
  // Read again: the entry added meanwhile is nobody's, and is taken off too.
  expect(home.cidrs()).toEqual(['203.0.113.7/32'])
})

it('waits while the list is still applying a modification, then carries on', async () => {
  await allow(homeA, '203.0.113.7/32')
  home.failNext = ['IncorrectState']
  expect(await syncAllowlist('ap-south-1')).toMatchObject({ status: 'synced', added: 1 })
  expect(home.cidrs()).toEqual(['203.0.113.7/32'])
})

it('adds and removes at most 100 entries per modification, each at the version it read', async () => {
  const many = Array.from({ length: 250 }, (_, i) => `203.0.${Math.floor(i / 250)}.${i}/32`)
  await allow(homeA, ...many)
  home.settleDescribes = 1

  expect(await syncAllowlist('ap-south-1')).toMatchObject({ status: 'synced', added: 250 })
  const mods = home.modifications()
  expect(mods.map((m) => m.AddEntries?.length ?? 0)).toEqual([100, 100, 50])
  expect(mods.map((m) => m.CurrentVersion)).toEqual([1, 2, 3])
  expect(home.cidrs()).toHaveLength(250)
}, 30_000)

it('keeps the earliest allowed addresses when the list cannot hold them all, and says how many cannot connect', async () => {
  home.maxEntries = 2
  await allow(homeA, '192.0.2.1/32')
  await allow(homeB, '192.0.2.2/32')
  await allow(homeA, '192.0.2.3/32')
  const said = jest.spyOn(console, 'error').mockImplementation(() => {})

  expect(await syncAllowlist('ap-south-1')).toMatchObject({ status: 'synced', added: 2, unapplied: 1 })
  expect(home.cidrs()).toEqual(['192.0.2.1/32', '192.0.2.2/32'])
  expect(said.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/holds at most 2, so 1 cannot connect until its MaxEntries is raised/)
  said.mockRestore()
})

it('says a region with no list configured has nothing to sync, and calls nothing', async () => {
  const said = jest.spyOn(console, 'log').mockImplementation(() => {})
  expect(await syncAllowlist('eu-central-1')).toEqual({ status: 'not_enforced', region: 'eu-central-1' })
  expect(said.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(
    /region=eu-central-1: no prefix list is configured \(DIRECT_DB_ALLOWLIST_PREFIX_LIST_ID_EU_CENTRAL_1\)/,
  )
  expect(prefixLists.clientRegions).not.toContain('eu-central-1')
  said.mockRestore()
})

it('answers a failure without throwing, so the scheduled pass can try again', async () => {
  prefixLists.lists.clear()
  const said = jest.spyOn(console, 'error').mockImplementation(() => {})
  expect(await syncAllowlist('ap-south-1')).toMatchObject({ status: 'failed', reason: 'InvalidPrefixListID.NotFound' })
  said.mockRestore()
})

it('syncs every region with a list on the scheduled pass, and only those', async () => {
  await allow(homeA, '203.0.113.7/32')
  await allow(east, '192.0.2.99/32')
  const results = await syncDirectAccessAllowlists()
  expect(results.map((r) => [r.region, r.status])).toEqual([
    ['ap-south-1', 'synced'],
    ['us-east-1', 'synced'],
  ])
  expect(home.cidrs()).toEqual(['203.0.113.7/32'])
  expect(eastList.cidrs()).toEqual(['192.0.2.99/32'])
})
