/**
 * EVERY ALLOWED ADDRESS IS IN THE PROJECT'S HISTORY, AND COMES BACK OR GOES WITH A RESTORE
 * ========================================================================================
 *
 * An allowed address lets a project's direct Postgres logins connect from it
 * (lib/services/direct-access-addresses.ts). That changes who can reach the
 * database, so adding or removing one is a governed change with its own
 * History entry, by whoever made it, recorded by the `addresses` resource
 * (lib/changes/resources/addresses.ts), as an allowed origin is:
 *
 *   - adding one is an entry; restoring it takes the address off the list,
 *     and the region's network allowlist lets it go;
 *   - removing one is an entry; restoring it puts the address back, on the
 *     list and on the region's allowlist;
 *   - an address refused (too wide, or past the plan's number) leaves no
 *     entry, and nothing changes.
 *
 * Real database, the real ledger and restore; the EC2 prefix list is a
 * stand-in (tests/helpers/fake-prefix-list.ts).
 */

jest.mock('@cloud/entitlements', () => {
  const actual = jest.requireActual('@cloud/entitlements')
  const { selfHostedEntitlements } = jest.requireActual('@/lib/entitlements/self-hosted')
  return { ...actual, cloudEntitlements: async () => ({ ...selfHostedEntitlements(), planName: 'SANDBOX', logRetentionDays: 7 }) }
})
jest.mock('@/lib/postgrest/registration', () => {
  const actual = jest.requireActual('@/lib/postgrest/registration')
  return {
    ...actual,
    registerSchemaByName: async (schema: string) => ({ registered: true, schema }),
    ensureSchemaRegistered: async (projectId: string) => ({ registered: true, schema: `workspace_${projectId}` }),
    unregisterSchema: async () => {},
  }
})
jest.mock('@aws-sdk/client-ec2', () => jest.requireActual('../helpers/fake-prefix-list').mockEc2Module())

import crypto from 'crypto'
import { prisma } from '@/lib/db/prisma'
import { createProvisionedProject } from '@/lib/projects/provision'
import { recoverChange } from '@/lib/changes/recovery'
import { closeChangeLockPool } from '@/lib/changes/lock'
import { AllowedAddressError, allowAddress, removeAddress } from '@/lib/services/direct-access-addresses'
import { prefixLists, type FakePrefixList } from '../helpers/fake-prefix-list'
import { installChangeLedgerGuard } from '../helpers/change-ledger-guard'

const LIST = 'pl-0a1b2c3d4e5f60004'
const ORIGINAL = {
  edition: process.env.BACKENLY_EDITION,
  engine: process.env.ENGINE_MODE,
  list: process.env.DIRECT_DB_ALLOWLIST_PREFIX_LIST_ID,
}
let ownerId = ''
let projectId = ''
let schema = ''
let list: FakePrefixList

const latest = () => prisma.backendChange.findFirstOrThrow({ where: { projectId }, orderBy: { createdAt: 'desc' } })
const restore = (id: string) => recoverChange(projectId, id, { mode: 'manual', actorUserId: ownerId, acknowledged: null })
const stored = () => prisma.directAccessAddress.findMany({ where: { projectId } }).then((r) => r.map((a) => a.cidr).sort())

beforeAll(async () => {
  process.env.BACKENLY_EDITION = 'cloud'
  process.env.ENGINE_MODE = 'runtime'
  process.env.DIRECT_DB_ALLOWLIST_PREFIX_LIST_ID = LIST
  await installChangeLedgerGuard()
  ownerId = (await prisma.user.create({
    data: { email: `address-history-${crypto.randomBytes(6).toString('hex')}@example.test`, password: 'not-a-real-hash', name: 'owner' },
  })).id
  const project = await createProvisionedProject({ name: 'address-history', userId: ownerId })
  projectId = project.id
  schema = project.postgresSchema
}, 120_000)

beforeEach(async () => {
  prefixLists.reset()
  list = prefixLists.add(LIST, 'ap-south-1')
})

afterAll(async () => {
  const vaults = await prisma.$queryRawUnsafe<Array<{ nspname: string }>>(
    `SELECT nspname FROM pg_namespace WHERE nspname LIKE 'workspace_${projectId}_r%'`,
  ).catch(() => [])
  for (const v of vaults) await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${v.nspname}" CASCADE`).catch(() => {})
  if (schema) await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
  if (projectId) await prisma.project.delete({ where: { id: projectId } }).catch(() => {})
  if (ownerId) await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
  await closeChangeLockPool()
  for (const [key, value] of [
    ['BACKENLY_EDITION', ORIGINAL.edition],
    ['ENGINE_MODE', ORIGINAL.engine],
    ['DIRECT_DB_ALLOWLIST_PREFIX_LIST_ID', ORIGINAL.list],
  ] as const) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

it('adding an address is one entry, by that person; restoring it takes the address off, and the region’s allowlist lets it go', async () => {
  await allowAddress(projectId, '203.0.113.7', { userId: ownerId })
  expect(list.cidrs()).toEqual(['203.0.113.7/32'])
  const c = await latest()
  expect(c).toMatchObject({
    title: 'Allow 203.0.113.7/32 to connect to Postgres',
    summary: 'Added allowed address 203.0.113.7/32',
    resources: ['addresses'],
    actorUserId: ownerId,
    status: 'healthy',
  })

  expect(await restore(c.id)).toMatchObject({ ok: true })
  expect(await stored()).toEqual([])
  expect(list.cidrs()).toEqual([])
}, 60_000)

it('removing one is an entry; restoring it puts the address back, and on the region’s allowlist', async () => {
  await allowAddress(projectId, '198.51.100.0/24', { userId: ownerId })
  await removeAddress(projectId, '198.51.100.0/24', { userId: ownerId })
  expect(list.cidrs()).toEqual([])
  const c = await latest()
  expect(c).toMatchObject({
    title: 'Remove 198.51.100.0/24 from the allowed addresses',
    summary: 'Removed allowed address 198.51.100.0/24',
    resources: ['addresses'],
  })

  expect(await restore(c.id)).toMatchObject({ ok: true })
  expect(await stored()).toEqual(['198.51.100.0/24'])
  expect(list.cidrs()).toEqual(['198.51.100.0/24'])
}, 60_000)

it('an address refused, as too wide or past the plan’s number, leaves no entry and changes nothing', async () => {
  await prisma.directAccessAddress.deleteMany({ where: { projectId } })
  const before = await prisma.backendChange.count({ where: { projectId } })

  await expect(allowAddress(projectId, '0.0.0.0/0', { userId: ownerId })).rejects.toMatchObject({ code: 'ADDRESS_RANGE_TOO_WIDE' })
  await allowAddress(projectId, '192.0.2.1', { userId: ownerId })
  await allowAddress(projectId, '192.0.2.2', { userId: ownerId })
  const after = await prisma.backendChange.count({ where: { projectId } })
  expect(after).toBe(before + 2)

  // Free allows two.
  const refused = await allowAddress(projectId, '192.0.2.3', { userId: ownerId }).catch((e) => e)
  expect(refused).toBeInstanceOf(AllowedAddressError)
  expect(refused.code).toBe('ADDRESS_LIMIT_REACHED')
  expect(await prisma.backendChange.count({ where: { projectId } })).toBe(after)
  expect(await stored()).toEqual(['192.0.2.1/32', '192.0.2.2/32'])
}, 60_000)
