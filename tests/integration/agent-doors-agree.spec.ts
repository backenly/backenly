/**
 * An operation means one thing on every agent door
 * (medium findings AUTH-F8, AUTH-F5 and CON-07).
 *
 * AUTH-F8: add_oauth_provider accepted 'apple', stored the owner's client
 * secret and answered "Routes activated", while the runtime serves only
 * Google, GitHub, Discord and Facebook, so every Apple sign-in was a 404.
 *
 * AUTH-F5: RESET_PASSWORD was a medium-risk executor action. Over the typed
 * MCP door (owner-held key, pre-confirmed) it ran at once, as the docs say;
 * over backend_chat the executor parked it for approval. The reset only
 * emails the account's own address a link and changes no credential, so it
 * is low risk on both doors now.
 *
 * CON-07: connect_frontend's schema promised a "type CONNECT" prompt that the
 * typed door never shows, and binding the first origin silently made the
 * CORS allowlist exclusive. The descriptions now say which door prompts, and
 * the first bind says that other origins are now refused.
 */
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'

import { prisma } from '@/lib/db/prisma'
import { executeAction } from '@/lib/ai/minimal-executor'
import { BRAIN_TOOLS, dispatchTool } from '@/lib/ai/brain/tools'
import { riskLevelForExecutorAction } from '@/lib/operational-memory/ledger'
import { SERVED_OAUTH_PROVIDERS } from '@/lib/services/oauth-providers'

const ROOT = process.cwd()
const read = (...p: string[]) => fs.readFileSync(path.join(ROOT, ...p), 'utf8')

let ownerId: string
const projectIds: string[] = []

async function freshProject(name: string): Promise<string> {
  const id = (await prisma.project.create({ data: { name, userId: ownerId }, select: { id: true } })).id
  projectIds.push(id)
  return id
}

const act = (projectId: string, action: string, params: Record<string, unknown>) =>
  executeAction({ action, params } as any, projectId, undefined, 0, undefined, false)

const toolProperty = (tool: string, prop: string): any =>
  (BRAIN_TOOLS.find((t) => t.function.name === tool)?.function.parameters as any)?.properties?.[prop]

beforeAll(async () => {
  ownerId = (
    await prisma.user.create({
      data: {
        email: `doors-${crypto.randomBytes(6).toString('hex')}@example.test`,
        password: 'not-a-real-hash',
        name: 'Agent Doors Suite',
      },
      select: { id: true },
    })
  ).id
}, 60_000)

afterAll(async () => {
  for (const id of projectIds) {
    await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "workspace_${id}" CASCADE`).catch(() => {})
  }
  await prisma.workspaceOAuthConfig.deleteMany({ where: { projectId: { in: projectIds } } }).catch(() => {})
  await prisma.connectedApp.deleteMany({ where: { projectId: { in: projectIds } } }).catch(() => {})
  await prisma.healthFinding.deleteMany({ where: { projectId: { in: projectIds } } }).catch(() => {})
  await prisma.auditLog.deleteMany({ where: { projectId: { in: projectIds } } }).catch(() => {})
  await prisma.project.deleteMany({ where: { id: { in: projectIds } } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: ownerId } }).catch(() => {})
}, 60_000)

describe('AUTH-F8: only providers the runtime serves are offered', () => {
  it('the served list is exactly the runtime OAuth routes', () => {
    const oauth = read('server', 'routes', 'oauth.ts')
    const block = oauth.match(/const PROVIDER_AUTH_URLS[^{]*\{([\s\S]*?)\n\}/)?.[1] ?? ''
    const runtime = [...block.matchAll(/^\s*([a-z]+):/gm)].map((m) => m[1]).sort()
    expect(runtime.length).toBeGreaterThan(0)
    expect([...SERVED_OAUTH_PROVIDERS].sort()).toEqual(runtime)
  })

  it('the agent schemas and docs offer the served list and nothing else', () => {
    for (const tool of ['add_oauth_provider', 'disable_oauth_provider']) {
      expect([...toolProperty(tool, 'provider').enum].sort()).toEqual([...SERVED_OAUTH_PROVIDERS].sort())
    }
    expect(read('public', 'docs', 'agents', 'auth.md')).not.toMatch(/\bApple\b/)
    expect(read('lib', 'mcp', 'domains.ts')).not.toMatch(/\bApple\b/)
  })

  it('an Apple provider is refused at the executor and nothing is stored', async () => {
    const projectId = await freshProject('doors-apple-exec')
    const out = await act(projectId, 'ADD_PROVIDER', {
      provider: 'apple', clientId: 'apple-client-id', clientSecret: `apple-${crypto.randomBytes(8).toString('hex')}`,
    })
    expect(out.success).toBe(false)
    expect(out.error).toBe('UNSUPPORTED_PROVIDER')
    expect(out.message).toContain('google, github, discord, facebook')
    expect(await prisma.workspaceOAuthConfig.count({ where: { projectId, provider: 'apple' } })).toBe(0)
  }, 60_000)

  it('the brain door refuses Apple instead of asking the owner for credentials', async () => {
    const projectId = await freshProject('doors-apple-brain')
    const out = await dispatchTool('add_oauth_provider', { provider: 'apple' }, { projectId, userId: ownerId } as any)
    expect(out.ok).toBe(false)
    expect(out.code).toBe('UNSUPPORTED_PROVIDER')
    expect(out.summary).not.toMatch(/paste the \*\*Client ID\*\*/)
  }, 60_000)
})

describe('AUTH-F5: a password reset is not parked on one door and run on the other', () => {
  it('RESET_PASSWORD is low risk, so the executor gate never parks it', async () => {
    expect(riskLevelForExecutorAction('RESET_PASSWORD')).toBe('low')

    const projectId = await freshProject('doors-reset')
    const schema = `workspace_${projectId}`
    const email = `reset-${crypto.randomBytes(4).toString('hex')}@example.test`
    await prisma.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "${schema}"`)
    await prisma.$executeRawUnsafe(
      `CREATE TABLE "${schema}"."users" (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text UNIQUE NOT NULL, password text)`,
    )
    await prisma.$executeRawUnsafe(`INSERT INTO "${schema}"."users" (email, password) VALUES ($1, 'x')`, email)

    // The backend_chat door: no confirmation flags in the dispatch context.
    const chat = await dispatchTool('reset_end_user_password', { email }, { projectId, userId: ownerId } as any)
    expect(chat.code).not.toBe('APPROVAL_REQUIRED')
    expect(JSON.stringify(chat)).not.toContain('APPROVAL_REQUIRED')

    // The executor directly, unconfirmed: runs (the send itself may fail
    // without SMTP, which is the tool's own honest answer), never parks.
    const direct = await act(projectId, 'RESET_PASSWORD', { email })
    expect(direct.error).not.toBe('APPROVAL_REQUIRED')
    expect(await prisma.healthFinding.count({ where: { projectId } })).toBe(0)
  }, 60_000)
})

describe('CON-07: connect_frontend says what each door does', () => {
  it('the first bind says the allowlist is now exclusive; a later bind does not', async () => {
    const projectId = await freshProject('doors-connect')
    // confirmed: what the typed MCP door sets for an owner-held key.
    const first = await act(projectId, 'CONNECT_FRONTEND', { url: 'https://app.example.test', confirmed: true })
    expect(first.success).toBe(true)
    expect((first.data as any).firstConnectedOrigin).toBe(true)
    expect(first.message).toContain('first connected origin')
    expect(first.message).toContain('refused')

    const second = await act(projectId, 'CONNECT_FRONTEND', { url: 'https://staging.example.test', confirmed: true })
    expect(second.success).toBe(true)
    expect((second.data as any).firstConnectedOrigin).toBe(false)
    expect(second.message).not.toContain('first connected origin')
  }, 60_000)

  it('the schema no longer promises a prompt the typed door never shows', () => {
    const tool = BRAIN_TOOLS.find((t) => t.function.name === 'connect_frontend')!
    expect(tool.function.description).toContain('the typed MCP door, acting on an owner-held key, binds at once')
    expect(tool.function.description).toContain('CORS allowlist')
    expect(toolProperty('connect_frontend', 'force').description).toContain('The typed MCP door binds without a prompt')
    expect(read('public', 'docs', 'agents', 'connect.md')).toContain('CORS allowlist')
  })
})
