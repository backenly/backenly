/**
 * The integrations connect door keeps its contract
 * (medium findings INT-04, INT-05, INT-06).
 *
 * INT-05: store_integration_key filed ANY id verbatim — "hubspot" was
 * reported connected with a ctx.integrations surface that does not exist,
 * and "Stripe" was stored under a key the runtime, receiver and console all
 * look up lowercased.
 *
 * INT-04: disconnect deleted the vault row but never touched
 * project.activeIntegrations, so the console showed the provider as
 * Connected ("N of 5 connected") forever.
 *
 * INT-06: OneSignal needs a REST key AND an App ID; only a chat-only tool
 * could store the App ID, so the typed door could connect OneSignal and
 * still never send a push.
 *
 * PostHog carries the connect tests: its keys are stored as unverifiable
 * (no live provider call), so CI never depends on an external API.
 */
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'

import { prisma } from '@/lib/db/prisma'
import { executeAction } from '@/lib/ai/minimal-executor'
import { TOOL_TO_ACTION } from '@/lib/ai/brain/tools'
import { hasIntegrationKey } from '@/lib/services/integrationKeyStore'

const ROOT = process.cwd()

let ownerId: string

async function freshProject(name: string): Promise<string> {
  return (
    await prisma.project.create({ data: { name, userId: ownerId }, select: { id: true } })
  ).id
}

const act = (action: string, params: Record<string, unknown>, projectId: string) =>
  executeAction({ action, params } as any, projectId, undefined, 0, undefined, false)

beforeAll(async () => {
  ownerId = (
    await prisma.user.create({
      data: {
        email: `int-contract-${crypto.randomBytes(6).toString('hex')}@example.test`,
        password: 'not-a-real-hash',
        name: 'Integrations Contract Suite',
      },
      select: { id: true },
    })
  ).id
}, 120_000)

afterAll(async () => {
  const projects = await prisma.project.findMany({ where: { userId: ownerId }, select: { id: true } })
  for (const p of projects) {
    await prisma.projectIntegrationKey.deleteMany({ where: { projectId: p.id } }).catch(() => {})
    await prisma.aiFunction.deleteMany({ where: { projectId: p.id } }).catch(() => {})
    await prisma.healthFinding?.deleteMany({ where: { projectId: p.id } }).catch(() => {})
  }
  await prisma.project.deleteMany({ where: { userId: ownerId } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: ownerId } }).catch(() => {})
}, 120_000)

describe('INT-05: only known providers, under their canonical id', () => {
  it('refuses an id the runtime does not serve, naming the real list', async () => {
    const projectId = await freshProject('int05-unknown')
    const out = await act('STORE_INTEGRATION_KEY', { integrationId: 'hubspot', apiKey: 'phx_x' }, projectId)
    expect(out.success).toBe(false)
    expect(out.error).toBe('UNKNOWN_INTEGRATION')
    expect(out.message).toContain('stripe')
    expect(await prisma.projectIntegrationKey.count({ where: { projectId } })).toBe(0)
  }, 60_000)

  it('a capitalised id lands under the canonical key everything looks up', async () => {
    const projectId = await freshProject('int05-case')
    // Long enough to pass the length check, visibly synthetic, built at
    // runtime so no key-shaped literal sits in the repository.
    const out = await act('STORE_INTEGRATION_KEY', { integrationId: 'PostHog', apiKey: `  phc_${'test'.repeat(10)}  ` }, projectId)
    expect(out.success).toBe(true)
    const rows = await prisma.projectIntegrationKey.findMany({
      where: { projectId },
      select: { integrationId: true },
    })
    expect(rows.map((r) => r.integrationId)).toContain('posthog')
    expect(rows.map((r) => r.integrationId)).not.toContain('PostHog')
    const proj = await prisma.project.findUnique({ where: { id: projectId }, select: { activeIntegrations: true } })
    expect(((proj?.activeIntegrations as any) ?? {}).posthog?.enabled).toBe(true)
    expect(await hasIntegrationKey(projectId, 'posthog')).toBe(true)
  }, 60_000)
})

describe('INT-04: disconnect clears what the console reads', () => {
  it('removing a key flips activeIntegrations off, through the alias too', async () => {
    const projectId = await freshProject('int04-disconnect')
    await act('STORE_INTEGRATION_KEY', { integrationId: 'posthog', apiKey: `phc_${'gone'.repeat(10)}` }, projectId)
    const out = await act('REMOVE_INTEGRATION_KEY', { integrationId: 'PostHog', confirmed: true }, projectId)
    expect(out.success).toBe(true)
    expect(await prisma.projectIntegrationKey.count({ where: { projectId } })).toBe(0)
    const proj = await prisma.project.findUnique({ where: { id: projectId }, select: { activeIntegrations: true } })
    expect(((proj?.activeIntegrations as any) ?? {}).posthog?.enabled).toBe(false)
  }, 60_000)

  it('the console DELETE route carries the same sync', () => {
    const route = fs.readFileSync(path.join(ROOT, 'app', 'api', 'projects', '[id]', 'integrations', 'keys', 'route.ts'), 'utf8')
    expect(route).toContain('enabled: false')
    expect(route).toContain('disconnectedAt')
  })
})

describe('INT-06: OneSignal is reachable through the typed door', () => {
  it('connect stores the App ID alongside the REST key', async () => {
    const projectId = await freshProject('int06-both')
    const out = await act(
      'STORE_INTEGRATION_KEY',
      { integrationId: 'onesignal', apiKey: 'os_rest_key', appId: 'os-app-id-123' },
      projectId,
    )
    expect(out.success).toBe(true)
    expect((out.data as any).oneSignalAppIdPending).toBe(false)
    expect(await hasIntegrationKey(projectId, 'onesignal_app_id')).toBe(true)
  }, 60_000)

  it('the App ID survives the tool layer an agent actually calls', async () => {
    // The test above hands params straight to the executor, which is how the
    // tool mapper once dropped appId unseen: the docs showed a call whose
    // App ID never arrived.
    const projectId = await freshProject('int06-tool')
    const mapped = TOOL_TO_ACTION.store_integration_key({
      integrationId: 'onesignal', apiKey: 'os_rest_key', appId: 'os-app-id-456',
    })
    const out = await executeAction(mapped, projectId, undefined, 0, undefined, false)
    expect(out.success).toBe(true)
    expect((out.data as any).oneSignalAppIdPending).toBe(false)
    expect(await hasIntegrationKey(projectId, 'onesignal_app_id')).toBe(true)
  }, 60_000)

  it('connect without the App ID says push is not active and names the exact call', async () => {
    const projectId = await freshProject('int06-missing')
    const out = await act('STORE_INTEGRATION_KEY', { integrationId: 'onesignal', apiKey: 'os_rest_key' }, projectId)
    expect(out.success).toBe(true)
    expect((out.data as any).oneSignalAppIdPending).toBe(true)
    expect(out.message).toContain('appId')
  }, 60_000)

  it('send_push names the missing half and the typed remedy, not a chat phrase', async () => {
    const projectId = await freshProject('int06-push')
    const out = await act('SEND_PUSH', { message: 'hello' }, projectId)
    expect(out.success).toBe(false)
    expect(out.message).toContain('integrations { "action": "connect"')
    expect(out.message).not.toContain('Say "connect OneSignal"')
  }, 60_000)
})
