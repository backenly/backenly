/**
 * ONE HISTORY FOR THE WHOLE BACKEND, AGAINST A REAL DATABASE
 * ==========================================================
 *
 * A governed change records what it did to the rest of the backend beside the
 * schema (lib/changes/resources): sign-in settings and providers, buckets,
 * functions, webhooks and triggers, environment variables, API keys and
 * integrations. One change, one entry, one restore, whatever it touched:
 *
 *   each resource comes back exactly, and reapplying brings the change back
 *   a secret never comes back: a revoked or rotated key, a replaced signing
 *   secret, an environment variable's value; what keeps one says so, needs a
 *   person who approves exactly that, and a change that only did what cannot
 *   be undone offers no restore
 *   files the application wrote stay: a bucket that holds them is not removed
 *   a change that touched the schema and a bucket is restored as one, and its
 *   automatic recovery puts both back
 *   a later change to the same item blocks a restore and is named
 *   the platform's part and the schema's commit together: a failure in one
 *   leaves both as they were
 *   how a function's last run went is not a change, and does not block one;
 *   a function a model generated is in the history, a table's generated
 *   endpoint follows its table instead
 *   Backenly's own plumbing (row-event capture) is not part of a table: it
 *   never makes one look changed since, and a table a restore brings back
 *   gets it again
 *   an integration switched off with its key stays off with it
 *   the project's anon key and a preview branch's keys are not the history's
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

import crypto from 'crypto'
import { prisma } from '@/lib/db/prisma'
import { createProvisionedProject } from '@/lib/projects/provision'
import { withGovernedChange, withChangeAttribution } from '@/lib/changes/ledger'
import { previewRecovery, recoverChange } from '@/lib/changes/recovery'
import { listChanges } from '@/lib/changes/history'
import { closeChangeLockPool } from '@/lib/changes/lock'
import { storageAdapter } from '@/lib/changes/resources/storage'
import { syncWebhookCapture } from '@/lib/webhooks/capture'
import { installChangeLedgerGuard } from '../helpers/change-ledger-guard'

let ownerId: string
let projectId: string
let schema: string

const originalEdition = process.env.BACKENLY_EDITION
const originalEngineMode = process.env.ENGINE_MODE

const T = (table: string) => `"${schema}"."${table}"`
const ddl = (sql: string) => prisma.$executeRawUnsafe(sql)
const rows = <R = any>(sql: string) => prisma.$queryRawUnsafe<R[]>(sql)
const record = (id: string) => prisma.backendChange.findUniqueOrThrow({ where: { id } })
const hex = (n = 8) => crypto.randomBytes(n).toString('hex')

async function change(title: string, fn: () => Promise<unknown>, source: 'dashboard' | 'mcp' = 'dashboard') {
  const attr = source === 'dashboard' ? { source: 'dashboard' as const, actorUserId: ownerId } : { source: 'mcp' as const }
  const { change: closed } = await withChangeAttribution(attr, () => withGovernedChange({ projectId, title }, async () => { await fn() }))
  if (!closed) throw new Error(`"${title}" recorded nothing`)
  return closed
}
const restore = (id: string, acknowledged?: Record<string, number> | null) =>
  recoverChange(projectId, id, { mode: 'manual', actorUserId: ownerId, acknowledged: acknowledged ?? null })

const bucket = (name: string) => prisma.storageBucket.findFirst({ where: { projectId, name } })
const envVar = (key: string) => prisma.projectEnvVar.findFirst({ where: { projectId, key } })
const setEnv = (key: string, value: string) =>
  prisma.projectEnvVar.upsert({
    where: { projectId_key: { projectId, key } },
    create: { projectId, key, valueCipher: Buffer.from(value).toString('base64'), valueIv: hex(), valueTag: hex(), createdBy: ownerId },
    update: { valueCipher: Buffer.from(value).toString('base64'), valueIv: hex(), valueTag: hex() },
  })
const newKey = (name: string, permissions: string[]) =>
  prisma.apiKey.create({ data: { name, keyPrefix: `bk_${hex(3)}`, keyHash: hex(16), userId: ownerId, projectId, permissions, capabilities: [] } })

beforeAll(async () => {
  process.env.BACKENLY_EDITION = 'cloud'
  process.env.ENGINE_MODE = 'runtime'
  await installChangeLedgerGuard()
  ownerId = (await prisma.user.create({
    data: { email: `everything-${hex(6)}@example.test`, password: 'not-a-real-hash', name: 'owner' },
  })).id
  const project = await createProvisionedProject({ name: 'change-history-everything', userId: ownerId })
  projectId = project.id
  schema = project.postgresSchema
}, 120_000)

afterAll(async () => {
  const vaults = await rows<{ nspname: string }>(`SELECT nspname FROM pg_namespace WHERE nspname LIKE 'workspace_${projectId}_r%'`).catch(() => [])
  for (const v of vaults) await ddl(`DROP SCHEMA IF EXISTS "${v.nspname}" CASCADE`).catch(() => {})
  if (schema) await ddl(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
  if (projectId) await prisma.project.delete({ where: { id: projectId } }).catch(() => {})
  if (ownerId) await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
  await closeChangeLockPool()
  process.env.BACKENLY_EDITION = originalEdition
  process.env.ENGINE_MODE = originalEngineMode
})

// ── Storage ──────────────────────────────────────────────────────────────────

describe('a bucket', () => {
  it('created by a change is one entry; restoring it removes it, reapplying brings it back', async () => {
    const c = await change('create avatars', () => prisma.storageBucket.create({ data: { projectId, name: 'avatars' } }))
    expect(c).toMatchObject({ status: 'healthy', summary: 'Created bucket avatars', footprint: [] })
    expect((await record(c.id)).resources).toEqual(['storage'])
    expect((await previewRecovery(projectId, c.id))!).toMatchObject({ safety: 'lossless', details: { resourceSteps: ['Remove bucket avatars.'] } })
    const out = await restore(c.id)
    expect(out).toMatchObject({ ok: true, status: 'restored' })
    expect(await bucket('avatars')).toBeNull()
    expect(await restore((out as any).recoveryId)).toMatchObject({ ok: true })
    expect(await bucket('avatars')).toMatchObject({ name: 'avatars', isPublic: false })
    expect((await record(c.id)).status).toBe('healthy')
  })

  it('whose settings a change altered gets them back exactly', async () => {
    const c = await change('make avatars public', () =>
      prisma.storageBucket.updateMany({ where: { projectId, name: 'avatars' }, data: { isPublic: true, accessPolicy: 'public_read', maxFileSizeBytes: BigInt(1) } }))
    expect(c.summary).toMatch(/^Changed bucket avatars: is public, access policy, max file size bytes$/)
    expect(await restore(c.id)).toMatchObject({ ok: true })
    expect(await bucket('avatars')).toMatchObject({ isPublic: false, accessPolicy: 'private', maxFileSizeBytes: BigInt(10485760) })
  })

  it('a change created, which holds files now, stays with them, and says so', async () => {
    const c = await change('create uploads', () => prisma.storageBucket.create({ data: { projectId, name: 'uploads' } }))
    const b = (await bucket('uploads'))!
    await prisma.storageFile.create({ data: { bucketId: b.id, projectId, name: 'a.png', originalName: 'a.png', path: 'x/a.png', mimeType: 'image/png', size: BigInt(3) } })
    const p = (await previewRecovery(projectId, c.id))!
    expect(p.safety).toBe('needs_approval')
    expect(p.reason).toBe('Bucket uploads holds 1 file written since, so it stays, with them.')
    expect(await restore(c.id)).toMatchObject({ ok: false, code: 'NEEDS_APPROVAL' })
    expect(await restore(c.id, p.acknowledgement)).toMatchObject({ ok: true, status: 'restored' })
    expect(await bucket('uploads')).not.toBeNull()
    expect(await prisma.storageFile.count({ where: { bucketId: b.id } })).toBe(1)
  })
})

// ── Functions ────────────────────────────────────────────────────────────────

describe('a function', () => {
  let fnId: string
  it('created, rewritten and deleted: each restore puts the previous code and state back', async () => {
    const created = await change('create sendWelcome', async () => {
      fnId = (await prisma.aiFunction.create({ data: { projectId, name: 'sendWelcome', description: 'welcome', generatedCode: 'v1', triggerType: 'on_signup' } })).id
    })
    expect(created.summary).toBe('Created function sendWelcome')
    const rewritten = await change('rewrite sendWelcome', () => prisma.aiFunction.update({ where: { id: fnId }, data: { generatedCode: 'v2', status: 'inactive' } }))
    expect(rewritten.summary).toBe('Changed function sendWelcome: generated code, power')
    expect(await restore(rewritten.id)).toMatchObject({ ok: true })
    expect(await prisma.aiFunction.findUnique({ where: { id: fnId } })).toMatchObject({ generatedCode: 'v1', status: 'active' })

    const deleted = await change('delete sendWelcome', () => prisma.aiFunction.delete({ where: { id: fnId } }))
    expect(await restore(deleted.id)).toMatchObject({ ok: true })
    expect(await prisma.aiFunction.findUnique({ where: { id: fnId } })).toMatchObject({ name: 'sendWelcome', generatedCode: 'v1' })
  })

  it('that fails at runtime keeps its restore: how the last run went is not a change', async () => {
    const id = (await prisma.aiFunction.create({ data: { projectId, name: 'syncCrm', description: 'crm', generatedCode: 'v1', triggerType: 'manual' } })).id
    const rewritten = await change('rewrite syncCrm', () => prisma.aiFunction.update({ where: { id }, data: { generatedCode: 'v2' } }))
    // The runtime, outside any change: the next run threw.
    await prisma.aiFunction.update({ where: { id }, data: { status: 'error', lastError: 'boom' } })
    expect((await previewRecovery(projectId, rewritten.id))!.safety).toBe('lossless')
    expect(await restore(rewritten.id)).toMatchObject({ ok: true })
    // The code comes back; whether the last run failed stays as the runtime recorded it.
    expect(await prisma.aiFunction.findUnique({ where: { id } })).toMatchObject({ generatedCode: 'v1', status: 'error' })
  })

  it('a model generated on request is in the history; a table\'s generated endpoint follows its table instead', async () => {
    const route = (name: string) => `POST /api/v1/${projectId}/fn/${name}`
    const generated = await change('generate send-invoice', () =>
      prisma.aiFunction.create({ data: { projectId, name: 'send-invoice', description: 'Email an invoice', generatedCode: 'x', triggerType: 'manual', triggerTable: route('send-invoice') } }))
    expect(generated.summary).toBe('Created function send-invoice')
    const { change: endpoint } = await withChangeAttribution({ source: 'dashboard', actorUserId: ownerId }, () =>
      withGovernedChange({ projectId, title: 'register posts-schema' }, () =>
        prisma.aiFunction.create({ data: { projectId, name: 'posts-schema', description: 'Validation schema', generatedCode: 'x', triggerType: 'manual', triggerTable: route('posts-schema') } })))
    expect(endpoint).toBeNull()
  })

  it('a schedule is a function on a cron trigger, and comes back the same way', async () => {
    const c = await change('schedule nightly', () =>
      prisma.aiFunction.create({ data: { projectId, name: 'nightly', description: 'cleanup', generatedCode: 'x', triggerType: 'cron', triggerTable: '0 3 * * *' } }))
    expect(c.summary).toBe('Created schedule nightly')
    expect(await restore(c.id)).toMatchObject({ ok: true })
    expect(await prisma.aiFunction.count({ where: { projectId, name: 'nightly' } })).toBe(0)
  })
})

// ── Webhooks and triggers ────────────────────────────────────────────────────

describe('a webhook', () => {
  let hookId: string
  it('created is removed by its restore; its target comes back exactly', async () => {
    const created = await change('add webhook', async () => {
      hookId = (await prisma.webhook.create({ data: { projectId, eventType: 'row.inserted', targetUrl: 'https://hooks.example.test/a', secret: hex() } })).id
    })
    expect(created.summary).toBe('Created webhook to hooks.example.test (row.inserted)')
    const moved = await change('move webhook', () => prisma.webhook.update({ where: { id: hookId }, data: { targetUrl: 'https://other.example.test/b' } }))
    expect(await restore(moved.id)).toMatchObject({ ok: true })
    expect((await prisma.webhook.findUnique({ where: { id: hookId } }))!.targetUrl).toBe('https://hooks.example.test/a')
  })

  it('whose signing secret was rotated: the restore needs a person, and the new secret stays', async () => {
    const before = (await prisma.webhook.findUnique({ where: { id: hookId } }))!
    const c = await change('rotate and disable', () => prisma.webhook.update({ where: { id: hookId }, data: { secret: hex(), active: false } }))
    const p = (await previewRecovery(projectId, c.id))!
    expect(p.safety).toBe('needs_approval')
    expect(p.reason).toBe('The signing secret of webhook to hooks.example.test (row.inserted) was replaced, and the old one is not kept: the new one stays.')
    const out = await restore(c.id, p.acknowledgement)
    expect(out).toMatchObject({ ok: true })
    const after = (await prisma.webhook.findUnique({ where: { id: hookId } }))!
    expect(after.active).toBe(true)
    expect(after.secret).not.toBe(before.secret)
  })

  it('removed with its secret cannot be restored, and says why', async () => {
    const c = await change('remove webhook', () => prisma.webhook.delete({ where: { id: hookId } }))
    const p = (await previewRecovery(projectId, c.id))!
    expect(p.safety).toBe('unavailable')
    expect(p.reason).toBe('Webhook to hooks.example.test (row.inserted) was removed with its signing secret, which is not kept, so it does not come back.')
    const listed = (await listChanges(projectId)).changes.find((x) => x.id === c.id)!
    expect(listed.action).toMatchObject({ available: false, code: 'NOT_REVERSIBLE' })
  })
})

// ── Row-event capture ────────────────────────────────────────────────────────

describe("Backenly's row-event capture", () => {
  const captured = async (table: string) =>
    (await rows<{ n: number }>(`SELECT count(*)::int AS n FROM pg_trigger WHERE tgrelid = to_regclass('${T(table)}') AND tgname = 'backenly_webhook_capture'`))[0].n

  it('is not part of a table: a later sync does not block a restore, the archive drops it, and the table brought back gets it again', async () => {
    const created = await change('create events_x', () => ddl(`CREATE TABLE ${T('events_x')} (id serial PRIMARY KEY, kind text)`))
    // A webhook made outside this change asks for inserts; its sync puts the trigger on every table.
    const hook = await prisma.webhook.create({ data: { projectId, eventType: 'row.inserted', targetUrl: 'https://hooks.example.test/capture', secret: hex() } })
    await syncWebhookCapture(projectId)
    expect(await captured('events_x')).toBe(1)

    expect((await previewRecovery(projectId, created.id))!.safety).toBe('lossless')
    const out = await restore(created.id)
    expect(out).toMatchObject({ ok: true })
    const archived = await rows<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_trigger tg JOIN pg_class c ON c.oid = tg.tgrelid JOIN pg_namespace ns ON ns.oid = c.relnamespace
        WHERE c.relname = 'events_x' AND ns.nspname LIKE 'workspace_${projectId}_r%' AND tg.tgname = 'backenly_webhook_capture'`)
    expect(archived[0].n).toBe(0)

    expect(await restore((out as any).recoveryId)).toMatchObject({ ok: true })
    expect(await captured('events_x')).toBe(1)
    await prisma.webhook.delete({ where: { id: hook.id } })
    await syncWebhookCapture(projectId)
  })
})

// ── Environment variables ────────────────────────────────────────────────────

describe('an environment variable', () => {
  it('added is removed by its restore', async () => {
    const c = await change('set FEATURE_X', () => setEnv('FEATURE_X', 'on'))
    expect(c.summary).toBe('Created environment variable FEATURE_X')
    expect(await restore(c.id)).toMatchObject({ ok: true })
    expect(await envVar('FEATURE_X')).toBeNull()
  })

  it('whose value a change replaced keeps the new value: the earlier one was never kept', async () => {
    await setEnv('API_URL', 'https://a')
    const c = await change('repoint API_URL', () => setEnv('API_URL', 'https://b'))
    expect(c.summary).toBe('Changed environment variable API_URL: value (replaced)')
    const p = (await previewRecovery(projectId, c.id))!
    expect(p.safety).toBe('needs_approval')
    expect(p.reason).toBe('The value of environment variable API_URL was replaced, and the earlier value is not kept: the new one stays.')
  })

  it('removed cannot come back: its value was a secret', async () => {
    const c = await change('drop API_URL', () => prisma.projectEnvVar.deleteMany({ where: { projectId, key: 'API_URL' } }))
    expect((await previewRecovery(projectId, c.id))!).toMatchObject({ safety: 'unavailable', reason: 'Environment variable API_URL was removed, and its value is not kept, so it does not come back.' })
  })
})

// ── API keys ─────────────────────────────────────────────────────────────────

describe('an API key', () => {
  let keyId: string
  it('created is revoked by its restore', async () => {
    const c = await change('create a key', async () => { keyId = (await newKey('mobile app', ['read', 'write'])).id })
    expect(c.summary).toBe('Created API key mobile app')
    expect(await restore(c.id)).toMatchObject({ ok: true })
    expect(await prisma.apiKey.findUnique({ where: { id: keyId } })).toBeNull()
  })

  it('narrowed gets its permissions back; revoked never comes back', async () => {
    keyId = (await newKey('server', ['read', 'write'])).id
    const narrowed = await change('narrow server key', () => prisma.apiKey.update({ where: { id: keyId }, data: { permissions: ['read'] } }))
    expect(await restore(narrowed.id)).toMatchObject({ ok: true })
    expect((await prisma.apiKey.findUnique({ where: { id: keyId } }))!.permissions.sort()).toEqual(['read', 'write'])
    const revoked = await change('revoke server key', () => prisma.apiKey.delete({ where: { id: keyId } }))
    expect((await previewRecovery(projectId, revoked.id))!).toMatchObject({
      safety: 'unavailable',
      reason: 'API key server was revoked, and a revoked key never comes back: create a new one instead.',
    })
  })
})

// ── Sign-in ──────────────────────────────────────────────────────────────────

describe('sign-in configuration', () => {
  it('settings, a template and an OAuth provider each come back exactly', async () => {
    await prisma.projectAuthConfig.upsert({ where: { projectId }, create: { projectId, appName: 'Shop' }, update: { appName: 'Shop' } })
    const c = await change('configure sign-in', async () => {
      await prisma.projectAuthConfig.update({ where: { projectId }, data: { appName: 'Shop 2', magicLinksEnabled: false } })
      await prisma.projectEmailTemplate.create({ data: { projectId, kind: 'welcome', subject: 'Hi', bodyHtml: '<p>Hi</p>' } })
      await prisma.workspaceOAuthConfig.create({ data: { projectId, provider: 'github', clientId: 'cid', clientSecret: 'enc:secret' } })
    })
    expect((await record(c.id)).resources).toEqual(['auth'])
    expect(c.summary).toBe('Created github sign-in and welcome email template, changed sign-in settings')
    expect(await restore(c.id)).toMatchObject({ ok: true, status: 'restored' })
    expect(await prisma.projectAuthConfig.findUnique({ where: { projectId } })).toMatchObject({ appName: 'Shop', magicLinksEnabled: true })
    expect(await prisma.projectEmailTemplate.count({ where: { projectId } })).toBe(0)
    expect(await prisma.workspaceOAuthConfig.count({ where: { projectId } })).toBe(0)
  })
})

// ── Integrations ─────────────────────────────────────────────────────────────

describe('an integration', () => {
  it('connected (key stored, switched on) is disconnected by its restore', async () => {
    const c = await change('connect stripe', async () => {
      await prisma.projectIntegrationKey.create({ data: { projectId, integrationId: 'stripe', encryptedKey: 'enc', maskedKey: 'sk_…1234' } })
      await prisma.project.update({ where: { id: projectId }, data: { activeIntegrations: { stripe: { enabled: true, readiness: 'key_stored' } } } })
    })
    expect(await restore(c.id)).toMatchObject({ ok: true })
    expect(await prisma.projectIntegrationKey.count({ where: { projectId } })).toBe(0)
    expect((await prisma.project.findUnique({ where: { id: projectId } }))!.activeIntegrations).toEqual({})
  })

  it('switched off with its key stays off with it: on again with no key, it would read as connected', async () => {
    await prisma.projectIntegrationKey.create({ data: { projectId, integrationId: 'resend', encryptedKey: 'enc', maskedKey: 're_…9' } })
    await prisma.project.update({ where: { id: projectId }, data: { activeIntegrations: { resend: { enabled: true } } } })
    const c = await change('disconnect resend', async () => {
      await prisma.projectIntegrationKey.deleteMany({ where: { projectId, integrationId: 'resend' } })
      await prisma.project.update({ where: { id: projectId }, data: { activeIntegrations: { resend: { enabled: false } } } })
    })
    const p = (await previewRecovery(projectId, c.id))!
    expect(p.safety).toBe('unavailable')
    const listed = (await listChanges(projectId)).changes.find((x) => x.id === c.id)!
    expect(listed.action).toMatchObject({ available: false, code: 'NOT_REVERSIBLE' })
  })
})

// ── Keys that belong to something else ───────────────────────────────────────

describe('the anon key and a preview branch\'s keys', () => {
  it('are not the history\'s: one is the project\'s own, the other ends with its branch', async () => {
    const anon = `bk_live_${hex(16)}`
    const branch = await prisma.workspaceBranch.create({ data: { projectId, name: `b${hex(3)}`, schemaName: `workspace_${projectId}_br_x`, createdBy: ownerId } })
    const { change: c } = await withChangeAttribution({ source: 'dashboard', actorUserId: ownerId }, () =>
      withGovernedChange({ projectId, title: 'provision keys' }, async () => {
        await prisma.apiKey.create({ data: { name: 'Public Anon Key', keyPrefix: anon.slice(0, 16), keyHash: crypto.createHash('sha256').update(anon).digest('hex'), userId: ownerId, projectId, permissions: ['read', 'write'], capabilities: [] } })
        await prisma.project.update({ where: { id: projectId }, data: { anonKey: anon } })
        await prisma.apiKey.create({ data: { name: 'Preview key', keyPrefix: `bk_${hex(3)}`, keyHash: hex(16), userId: ownerId, projectId, branchId: branch.id, permissions: ['read'], capabilities: [] } })
      }))
    expect(c).toBeNull()
  })
})

// ── Across the backend at once ───────────────────────────────────────────────

describe('one change across the schema and the rest of the backend', () => {
  it('is one entry, restored as one, verified', async () => {
    const c = await change('add reviews', async () => {
      await ddl(`CREATE TABLE ${T('reviews')} (id serial PRIMARY KEY, body text)`)
      await prisma.storageBucket.create({ data: { projectId, name: 'review-photos' } })
      await setEnv('REVIEWS_ENABLED', 'true')
    })
    expect((await record(c.id)).resources).toEqual(['database', 'storage', 'env'])
    expect(c.summary).toBe('Created table reviews. Created bucket review-photos and environment variable REVIEWS_ENABLED')
    const listed = (await listChanges(projectId)).changes.find((x) => x.id === c.id)!
    expect(listed.touched).toEqual(['reviews', 'bucket review-photos', 'environment variable REVIEWS_ENABLED'])
    const out = await restore(c.id)
    expect(out).toMatchObject({ ok: true })
    const checks = (out as any).verification.checks.map((x: { label: string; outcome: string }) => `${x.label}:${x.outcome}`)
    expect(checks).toEqual(expect.arrayContaining(['bucket review-photos:confirmed', 'environment variable REVIEWS_ENABLED:confirmed']))
    expect(await rows(`SELECT to_regclass('"${schema}".reviews')::text AS t`)).toEqual([{ t: null }])
    expect(await bucket('review-photos')).toBeNull()
    expect(await envVar('REVIEWS_ENABLED')).toBeNull()
  })

  it('an agent change that fails verification is recovered automatically, the bucket with it', async () => {
    await ddl(`CREATE TABLE ${T('orders_x')} (id serial PRIMARY KEY)`)
    await ddl(`ALTER TABLE ${T('orders_x')} ENABLE ROW LEVEL SECURITY`)
    const c = await change('agent opens orders_x', async () => {
      await prisma.storageBucket.create({ data: { projectId, name: 'exports' } })
      await ddl(`ALTER TABLE ${T('orders_x')} DISABLE ROW LEVEL SECURITY`)
    }, 'mcp')
    expect(c.status).toBe('recovered')
    expect(await bucket('exports')).toBeNull()
    expect((await rows(`SELECT relrowsecurity FROM pg_class WHERE oid = '${T('orders_x')}'::regclass`))[0].relrowsecurity).toBe(true)
  })

  it('a later change to the same item blocks the restore, and is named', async () => {
    const first = await change('create media', () => prisma.storageBucket.create({ data: { projectId, name: 'media' } }))
    const second = await change('open media', () => prisma.storageBucket.updateMany({ where: { projectId, name: 'media' }, data: { isPublic: true } }))
    const p = (await previewRecovery(projectId, first.id))!
    expect(p.safety).toBe('blocked')
    expect(p.reason).toBe('bucket media has changed since this change')
    expect(p.blockedBy.map((b) => b.seq)).toEqual([second.seq])
    expect(await restore(second.id)).toMatchObject({ ok: true })
    expect(await restore(first.id)).toMatchObject({ ok: true })
    expect(await bucket('media')).toBeNull()
  })

  it("if the rest of the backend's part fails, the schema's does not commit either", async () => {
    const c = await change('add tags', async () => {
      await ddl(`CREATE TABLE ${T('tags')} (id serial PRIMARY KEY)`)
      await prisma.storageBucket.create({ data: { projectId, name: 'tag-icons' } })
    })
    const spy = jest.spyOn(storageAdapter, 'apply').mockRejectedValueOnce(new Error('platform write refused'))
    try {
      const out = await restore(c.id)
      expect(out).toMatchObject({ ok: false, code: 'RECOVERY_FAILED' })
      expect((out as any).error).toMatch(/the rest of the backend could not be put back: platform write refused/)
    } finally {
      spy.mockRestore()
    }
    expect(await rows(`SELECT to_regclass('${schema}.tags')::text AS t`)).toEqual([{ t: `"${schema}".tags` }])
    expect(await bucket('tag-icons')).not.toBeNull()
    expect((await record(c.id)).status).toBe('healthy')
    expect(await restore(c.id)).toMatchObject({ ok: true })
  })
})
