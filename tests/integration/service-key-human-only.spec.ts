/**
 * A service-role key is never minted by an agent (medium finding CON-12).
 *
 * create_api_key with serviceRole: true minted an RLS-bypassing svc_live_ key
 * on either agent door with no human in the loop: CREATE_KEY rated low risk,
 * and approval is decided by tool name. Parking it for approval would not
 * help: the plaintext exists once, and an approved call's stored result
 * withholds it, so the key would be minted and never seen (the same reason
 * rotate_api_key is off the typed surface). It is the escalation granting
 * 'admin' already is, which SET_KEY_PERMISSIONS leaves to Settings. So the
 * executor refuses it on every door and names where a person creates one;
 * publishable keys are unchanged.
 *
 * Through the real /api/mcp/tool route with a real MCP key, the brain's
 * dispatcher, and real key rows.
 */

import '../helpers/next-request-polyfill'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db/prisma'
import { hashApiKey } from '@/lib/auth/apiKeyAuth'
import { dispatchTool } from '@/lib/ai/brain/tools'
import { resetSingleTenantCache } from '@/lib/edition/single-tenant/project-resolver'
import { POST } from '@/app/api/mcp/tool/route'

const KEY = `mcp_live_${crypto.randomBytes(20).toString('hex')}`
const ROOT = process.cwd()
const originalEdition = process.env.BACKENLY_EDITION
let ownerId = ''
let projectId = ''

async function call(tool: string, args: Record<string, unknown>) {
  const res = await POST(new NextRequest('https://backenly.test/api/mcp/tool', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': KEY },
    body: JSON.stringify({ tool, args }),
  }))
  return { status: res.status, body: (await res.json()) as any }
}

const serviceKeys = () => prisma.apiKey.count({ where: { projectId, serviceRole: true } })

beforeAll(async () => {
  process.env.BACKENLY_EDITION = 'cloud'
  resetSingleTenantCache()
  ownerId = (await prisma.user.create({
    data: { email: `svc-${crypto.randomBytes(6).toString('hex')}@test.invalid`, password: 'not-a-real-hash', name: 'svc' },
    select: { id: true },
  })).id
  projectId = (await prisma.project.create({ data: { name: 'service-key-human-only', userId: ownerId }, select: { id: true } })).id
  await prisma.apiKey.create({
    data: {
      name: 'agent', keyPrefix: KEY.slice(0, 12), keyHash: hashApiKey(KEY), userId: ownerId, projectId,
      scope: 'mcp', mcpReadOnly: false, permissions: [], capabilities: [],
    },
  })
}, 60_000)

afterAll(async () => {
  if (originalEdition === undefined) delete process.env.BACKENLY_EDITION
  else process.env.BACKENLY_EDITION = originalEdition
  resetSingleTenantCache()
  await prisma.apiKey.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.project.deleteMany({ where: { id: projectId } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: ownerId } }).catch(() => {})
}, 60_000)

it('the typed MCP door refuses a service-role key, names where a person makes one, and mints nothing', async () => {
  const r = await call('connect', { action: 'create_api_key', description: 'worker', serviceRole: true })
  expect(r.status).toBe(400)
  expect(r.body.ok).toBe(false)
  expect(r.body.code).toBe('SERVICE_KEY_REQUIRES_HUMAN')
  expect(r.body.error).toContain('Settings → API keys → New key → Admin')
  expect(JSON.stringify(r.body)).not.toMatch(/svc_live_[0-9a-f]{8}/)
  expect(await serviceKeys()).toBe(0)
}, 60_000)

it('the brain’s door refuses it the same way', async () => {
  const out = await dispatchTool('create_api_key' as any, { description: 'worker', serviceRole: true }, {
    projectId, userId: ownerId, createdThisTurn: new Set<string>(),
  } as any)
  expect(out.ok).toBe(false)
  expect(out.code).toBe('SERVICE_KEY_REQUIRES_HUMAN')
  expect(await serviceKeys()).toBe(0)
}, 60_000)

it('a publishable key is still the agent’s to create (control)', async () => {
  const before = await serviceKeys()
  const r = await call('connect', { action: 'create_api_key', description: 'web app' })
  expect(r.status).toBe(200)
  expect(r.body.ok).toBe(true)
  expect(JSON.stringify(r.body)).toMatch(/proj_live_[0-9a-f]/)
  expect(await serviceKeys()).toBe(before)
}, 60_000)

it('no agent-facing text still offers to mint one', () => {
  const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8')
  const tools = read('lib/ai/brain/tools.ts')
  expect(tools).toContain('`serviceRole: true` is refused with SERVICE_KEY_REQUIRES_HUMAN')
  expect(tools).not.toContain('`serviceRole: true` — a SECRET key')
  expect(read('lib/ai/minimal-executor.ts')).not.toContain('create a service-role key deliberately with create_api_key')
  expect(read('lib/security/key-placement.ts')).not.toContain('Pass serviceRole: true')
  expect(read('lib/mcp/protocol/shared.ts')).not.toContain('serviceRole: true only for server code')
  for (const doc of ['public/docs/agents/connect.md', 'public/docs/agents/client-setup.md']) {
    expect(read(doc)).toContain('SERVICE_KEY_REQUIRES_HUMAN')
  }
})
