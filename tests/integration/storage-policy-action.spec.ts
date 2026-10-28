/**
 * The agent can set the access policy the runtime actually enforces
 * (medium finding STO-13).
 *
 * The serving path, upload clamping and the console all enforce the
 * four-value accessPolicy, but the only writer the agent had was
 * set_bucket_public — a two-state flip — so owner_only and cdn_cacheable
 * were unreachable from the agent lane, and the console's own suggested
 * prompt ("only the owner can read their files") asked for a policy no
 * tool could set. set_bucket_policy closes that, and the docs state the
 * four-policy contract.
 */
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'

import { prisma } from '@/lib/db/prisma'
import { executeAction } from '@/lib/ai/minimal-executor'

const ROOT = process.cwd()

let ownerId: string
let projectId: string
let bucketId: string

const setPolicy = (params: Record<string, unknown>) =>
  executeAction({ action: 'SET_BUCKET_POLICY', params } as any, projectId, undefined, 0, undefined, false)

beforeAll(async () => {
  ownerId = (
    await prisma.user.create({
      data: {
        email: `sto-policy-${crypto.randomBytes(6).toString('hex')}@example.test`,
        password: 'not-a-real-hash',
        name: 'Storage Policy Suite',
      },
      select: { id: true },
    })
  ).id
  projectId = (
    await prisma.project.create({
      data: { name: 'storage-policy', userId: ownerId },
      select: { id: true },
    })
  ).id
  bucketId = (
    await prisma.storageBucket.create({
      data: { name: 'avatars', projectId, isPublic: false, accessPolicy: 'private' },
      select: { id: true },
    })
  ).id
}, 120_000)

afterAll(async () => {
  await prisma.storageBucket.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.project.deleteMany({ where: { id: projectId } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: ownerId } }).catch(() => {})
}, 60_000)

describe('STO-13: set_bucket_policy writes the enforced field', () => {
  it('owner_only lands on the row with the derived label', async () => {
    const out = await setPolicy({ bucketName: 'avatars', policy: 'owner_only' })
    expect(out.success).toBe(true)
    const row = await prisma.storageBucket.findUnique({
      where: { id: bucketId },
      select: { accessPolicy: true, isPublic: true },
    })
    expect(row).toEqual({ accessPolicy: 'owner_only', isPublic: false })
  }, 60_000)

  it('cdn_cacheable derives a public label, like the other door would', async () => {
    const out = await setPolicy({ bucketName: 'avatars', policy: 'cdn_cacheable' })
    expect(out.success).toBe(true)
    const row = await prisma.storageBucket.findUnique({
      where: { id: bucketId },
      select: { accessPolicy: true, isPublic: true },
    })
    expect(row).toEqual({ accessPolicy: 'cdn_cacheable', isPublic: true })
  }, 60_000)

  it('an unknown policy is refused naming the enforced vocabulary', async () => {
    const out = await setPolicy({ bucketName: 'avatars', policy: 'secret' })
    expect(out.success).toBe(false)
    expect(out.error).toBe('UNKNOWN_ACCESS_POLICY')
    expect(out.message).toContain('owner_only')
  }, 60_000)
})

describe('STO-13: the surfaces advertise the real contract', () => {
  it('the MCP catalog tiers the new tool as build', () => {
    const catalog = fs.readFileSync(path.join(ROOT, 'lib', 'mcp', 'catalog.ts'), 'utf8')
    expect(catalog).toContain("'set_bucket_policy'")
  })

  it('storage.md states the four-policy contract and the set_policy action', () => {
    const doc = fs.readFileSync(path.join(ROOT, 'public', 'docs', 'agents', 'storage.md'), 'utf8')
    expect(doc).toContain('owner_only')
    expect(doc).toContain('`set_policy`')
    expect(doc).not.toContain('A bucket is private unless it is made public.')
  })
})
