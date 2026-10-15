/**
 * API keys live an honest lifecycle (medium findings CON-08, SET-08, SET-09).
 *
 * CON-08/SET-08: create_api_key stamped a silent 365-day expiry that no
 * message, doc, or console column mentioned (dashboard keys default to never
 * expiring), the runtime then refused the key a year later, and the console
 * rendered agent keys as raw 'custom' with a "Full access" subtitle derived
 * from empty capabilities.
 *
 * SET-09: set_key_permissions wrote any array verbatim — unknown values
 * silently matched no gate, 'admin' made a key pass EVERY permission gate,
 * and service-role keys could be "narrowed" without anything changing.
 */
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'

import { prisma } from '@/lib/db/prisma'
import { executeAction } from '@/lib/ai/minimal-executor'
import { riskLevelForExecutorAction } from '@/lib/operational-memory/ledger'

const ROOT = process.cwd()

let ownerId: string
let projectId: string

beforeAll(async () => {
  ownerId = (
    await prisma.user.create({
      data: {
        email: `key-lifecycle-${crypto.randomBytes(6).toString('hex')}@example.test`,
        password: 'not-a-real-hash',
        name: 'Key Lifecycle Suite',
      },
      select: { id: true },
    })
  ).id
  projectId = (
    await prisma.project.create({
      data: { name: 'key-lifecycle', userId: ownerId },
      select: { id: true },
    })
  ).id
}, 120_000)

afterAll(async () => {
  await prisma.apiKey.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.project.deleteMany({ where: { id: projectId } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: ownerId } }).catch(() => {})
}, 60_000)

const createKey = (params: Record<string, unknown> = {}) =>
  executeAction({ action: 'CREATE_KEY', params } as any, projectId, undefined, 0, undefined, false)

const setPermissions = (params: Record<string, unknown>) =>
  executeAction({ action: 'SET_KEY_PERMISSIONS', params } as any, projectId, undefined, 0, undefined, false)

describe('CON-08 / SET-08: no silent expiry', () => {
  it('a default key never expires, and says so', async () => {
    const out = await createKey({ description: 'web frontend' })
    expect(out.success).toBe(true)
    expect(out.message).toContain('No expiry')
    expect((out.data as any).expiresAt).toBeNull()
    const row = await prisma.apiKey.findUnique({ where: { id: (out.data as any).keyId }, select: { expiresAt: true } })
    expect(row?.expiresAt).toBeNull()
  }, 60_000)

  it('an opted-in expiry is stored, returned and named in the message', async () => {
    const out = await createKey({ description: 'short-lived', expiresInDays: 30 })
    expect(out.success).toBe(true)
    expect(out.message).toContain('Expires')
    const expiresAt = new Date((out.data as any).expiresAt).getTime()
    const expected = Date.now() + 30 * 24 * 60 * 60 * 1000
    expect(Math.abs(expiresAt - expected)).toBeLessThan(60_000)
    const row = await prisma.apiKey.findUnique({ where: { id: (out.data as any).keyId }, select: { expiresAt: true } })
    expect(row?.expiresAt).not.toBeNull()
  }, 60_000)
})

describe('SET-09: set_key_permissions is gated, validated and cannot escalate', () => {
  it('an unapproved call parks for the owner instead of running (it used to be ungated)', async () => {
    const created = await createKey({ description: 'park-me' })
    const keyId = (created.data as any).keyId
    const out = await setPermissions({ keyId, permissions: ['read'] })
    expect(out.success).toBe(false)
    expect(out.error).toBe('APPROVAL_REQUIRED')
    const row = await prisma.apiKey.findUnique({ where: { id: keyId }, select: { permissions: true } })
    expect(row?.permissions).toEqual(['read', 'write']) // untouched
  }, 60_000)

  // `confirmed: true` is what an owner-approved (or chat-confirmed) run
  // carries — the validation below is what even an APPROVED call enforces.
  it('refuses values outside the runtime vocabulary', async () => {
    const created = await createKey({ description: 'vocab' })
    const out = await setPermissions({ keyId: (created.data as any).keyId, permissions: ['read:posts'], confirmed: true })
    expect(out.success).toBe(false)
    expect(out.error).toBe('UNKNOWN_PERMISSION')
  }, 60_000)

  it("refuses granting 'admin' even on an approved run — Settings is the one door", async () => {
    const created = await createKey({ description: 'escalation-target' })
    const keyId = (created.data as any).keyId
    const out = await setPermissions({ keyId, permissions: ['read', 'admin'], confirmed: true })
    expect(out.success).toBe(false)
    expect(out.error).toBe('ADMIN_ESCALATION_REQUIRES_HUMAN')
    const row = await prisma.apiKey.findUnique({ where: { id: keyId }, select: { permissions: true } })
    expect(row?.permissions).not.toContain('admin')
  }, 60_000)

  it('refuses editing a service-role key, whose access is not permission-driven', async () => {
    // A person creates a service-role key in Settings; the agent tool refuses
    // to mint one (CON-12, service-key-human-only.spec.ts), so it is made here
    // the way the Settings route stores it.
    const svc = await prisma.apiKey.create({
      data: {
        name: 'worker', keyHash: `test:${crypto.randomBytes(16).toString('hex')}`, keyPrefix: 'svc_live_test',
        projectId, userId: ownerId, permissions: ['read', 'write'], keyType: 'public', scope: 'runtime',
        role: 'admin', serviceRole: true,
      },
      select: { id: true },
    })
    const out = await setPermissions({ keyId: svc.id, permissions: ['read'], confirmed: true })
    expect(out.success).toBe(false)
    expect(out.error).toBe('SERVICE_ROLE_KEY_NOT_PERMISSION_DRIVEN')
  }, 60_000)

  it('an approved narrowing works and names before → after', async () => {
    const created = await createKey({ description: 'narrow-me' })
    const keyId = (created.data as any).keyId
    const out = await setPermissions({ keyId, permissions: ['read'], confirmed: true })
    expect(out.success).toBe(true)
    expect(out.message).toContain('read, write')
    const row = await prisma.apiKey.findUnique({ where: { id: keyId }, select: { permissions: true } })
    expect(row?.permissions).toEqual(['read'])
  }, 60_000)

  it('the risk ledger holds SET_KEY_PERMISSIONS at medium', () => {
    expect(riskLevelForExecutorAction('SET_KEY_PERMISSIONS')).toBe('medium')
  })
})

describe('the console and docs say the same thing', () => {
  it('the keys panel labels agent keys and shows an Expires column', () => {
    const panel = fs.readFileSync(path.join(ROOT, 'components', 'hub', 'ClientKeysPanel.tsx'), 'utf8')
    expect(panel).toContain("custom: 'Publishable'")
    expect(panel).toContain('>Expires</th>')
    expect(panel).not.toContain(": 'Full access'")
    expect(panel).toContain('Service role — bypasses row security')
  })

  it('connect.md states the no-silent-expiry contract', () => {
    const doc = fs.readFileSync(path.join(ROOT, 'public', 'docs', 'agents', 'connect.md'), 'utf8')
    expect(doc).toContain('Keys never expire unless you pass `expiresInDays`')
  })

  it('the tool schema stopped advertising per-table permission shapes', () => {
    const tools = fs.readFileSync(path.join(ROOT, 'lib', 'ai', 'brain', 'tools.ts'), 'utf8')
    expect(tools).not.toContain('read:posts')
    expect(tools).toContain("enum: ['read', 'write', 'ai-only']")
  })
})
