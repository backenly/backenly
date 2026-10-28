/**
 * RESTORE TO A POINT, AGAINST A REAL DATABASE
 * ===========================================
 *
 * "Restore to this point" undoes everything made after one change, newest
 * first, each step an ordinary restore held to its own rules
 * (lib/changes/range.ts):
 *
 *   the schema and the rest of the backend come back to how they were right
 *   after the point, and the point itself stays in effect
 *   a restore made after the point, of a change made before it, is undone: the
 *   change is reapplied, since it was in effect at the point
 *   a change and its own restore, both after the point, are left alone
 *   a revoked key is named and left revoked, and the rest still restores
 *   a step that needs a person stops the sequence there, with everything newer
 *   already restored; once that step is decided, running it again finishes
 *   an architecture change is undone whole or not at all: one still in place
 *   stops the sequence before anything runs, one undone in full is passed over,
 *   and a point that holds part of one is refused
 *
 * And an agent asking for restores cannot keep the project's tables locked:
 * proving a restore locks what it touches, so a project takes only so many
 * requests a minute from its agents.
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
import { expectEffect, withGovernedChange, withChangeAttribution } from '@/lib/changes/ledger'
import { AGENT_PROOFS_PER_MINUTE, describeRestoreRequest, previewRecovery, recoverChange } from '@/lib/changes/recovery'
import { planRestoreTo, restoreTo } from '@/lib/changes/range'
import { closeChangeLockPool } from '@/lib/changes/lock'
import { installChangeLedgerGuard } from '../helpers/change-ledger-guard'

let ownerId: string
let projectId: string
let schema: string

const originalEdition = process.env.BACKENLY_EDITION
const originalEngineMode = process.env.ENGINE_MODE

const T = (table: string) => `"${schema}"."${table}"`
const ddl = (sql: string) => prisma.$executeRawUnsafe(sql)
const rows = <R = any>(sql: string) => prisma.$queryRawUnsafe<R[]>(sql)
const hex = (n = 8) => crypto.randomBytes(n).toString('hex')
const exists = async (table: string) => (await rows<{ t: string | null }>(`SELECT to_regclass('${T(table)}')::text AS t`))[0].t !== null

async function change(title: string, fn: () => Promise<unknown>) {
  const { change: closed } = await withChangeAttribution({ source: 'dashboard', actorUserId: ownerId }, () =>
    withGovernedChange({ projectId, title }, async () => { await fn() }))
  if (!closed) throw new Error(`"${title}" recorded nothing`)
  return closed
}
/** One step of an architecture change, as the engine records one (lib/structural-evolution). */
async function architectureStep(group: string, title: string, fn: () => Promise<unknown>) {
  const { change: closed } = await withChangeAttribution({ source: 'approval', actorUserId: ownerId, groupId: group }, () =>
    withGovernedChange({ projectId, title, autoRecover: false }, async () => { await fn() }))
  if (!closed) throw new Error(`"${title}" recorded nothing`)
  return closed
}
const dropDeclared = async (table: string) => {
  expectEffect(projectId, { action: 'DROP_TABLE', table })
  await ddl(`DROP TABLE ${T(table)}`)
}
const restore = (id: string, acknowledged?: Record<string, number> | null) =>
  recoverChange(projectId, id, { mode: 'manual', actorUserId: ownerId, acknowledged: acknowledged ?? null })
const to = (after: number) => restoreTo(projectId, after, { actorUserId: ownerId })

beforeAll(async () => {
  process.env.BACKENLY_EDITION = 'cloud'
  process.env.ENGINE_MODE = 'runtime'
  await installChangeLedgerGuard()
  ownerId = (await prisma.user.create({
    data: { email: `restore-to-${hex(6)}@example.test`, password: 'not-a-real-hash', name: 'owner' },
  })).id
  const project = await createProvisionedProject({ name: 'change-restore-to', userId: ownerId })
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

describe('restore to a point', () => {
  it('undoes everything after it, newest first, across the schema and the rest; the point stays', async () => {
    const point = await change('create authors', () => ddl(`CREATE TABLE ${T('authors')} (id serial PRIMARY KEY, name text)`))
    const a = await change('create books', () => ddl(`CREATE TABLE ${T('books')} (id serial PRIMARY KEY, title text)`))
    const b = await change('create covers bucket', () => prisma.storageBucket.create({ data: { projectId, name: 'covers' } }))
    const c = await change('add authors.bio', () => ddl(`ALTER TABLE ${T('authors')} ADD COLUMN bio text`))

    const plan = await planRestoreTo(projectId, point.seq)
    expect(plan.steps.map((s) => [s.seq, s.action])).toEqual([[c.seq, 'restore'], [b.seq, 'restore'], [a.seq, 'restore']])
    expect(plan.stop).toBeNull()

    const out = await to(point.seq)
    expect(out.stoppedAt).toBeNull()
    expect(out.restored.map((r) => r.seq)).toEqual([c.seq, b.seq, a.seq])
    expect(await exists('authors')).toBe(true)
    expect(await exists('books')).toBe(false)
    expect(await prisma.storageBucket.count({ where: { projectId, name: 'covers' } })).toBe(0)
    expect((await rows(`SELECT column_name FROM information_schema.columns WHERE table_schema = '${schema}' AND table_name = 'authors' ORDER BY ordinal_position`)).map((r: any) => r.column_name)).toEqual(['id', 'name'])

    // Nothing left to undo: running it again does nothing.
    expect(await to(point.seq)).toMatchObject({ restored: [], stoppedAt: null })
  })

  it('reapplies a change made before the point that was restored after it, and leaves a change and its own restore alone', async () => {
    const before = await change('create genres', () => ddl(`CREATE TABLE ${T('genres')} (id serial PRIMARY KEY)`))
    const point = await change('create shelves', () => ddl(`CREATE TABLE ${T('shelves')} (id serial PRIMARY KEY)`))
    // After the point: genres is restored away; tags is made and restored again.
    expect(await restore(before.id)).toMatchObject({ ok: true })
    const tags = await change('create tags', () => ddl(`CREATE TABLE ${T('tags')} (id serial PRIMARY KEY)`))
    expect(await restore(tags.id)).toMatchObject({ ok: true })

    const plan = await planRestoreTo(projectId, point.seq)
    expect(plan.steps.map((s) => [s.seq, s.action])).toEqual([[before.seq, 'reapply']])
    expect((await to(point.seq)).restored.map((r) => [r.seq, r.action])).toEqual([[before.seq, 'reapply']])
    expect(await exists('genres')).toBe(true)
    expect(await exists('shelves')).toBe(true)
    expect(await exists('tags')).toBe(false)
  })

  it('names a revoked key and leaves it revoked, and still restores the rest', async () => {
    const key = await prisma.apiKey.create({ data: { name: 'ci', keyPrefix: `bk_${hex(3)}`, keyHash: hex(16), userId: ownerId, projectId, permissions: ['read'], capabilities: [] } })
    const point = await change('create loans', () => ddl(`CREATE TABLE ${T('loans')} (id serial PRIMARY KEY)`))
    const revoked = await change('revoke ci key', () => prisma.apiKey.delete({ where: { id: key.id } }))
    const bucket = await change('create receipts bucket', () => prisma.storageBucket.create({ data: { projectId, name: 'receipts' } }))

    const out = await to(point.seq)
    expect(out.stoppedAt).toBeNull()
    expect(out.restored.map((r) => r.seq)).toEqual([bucket.seq])
    expect(out.kept).toEqual([expect.objectContaining({ seq: revoked.seq, reason: 'API key ci was revoked, and a revoked key never comes back: create a new one instead.' })])
    expect(await prisma.apiKey.findUnique({ where: { id: key.id } })).toBeNull()
    expect(await prisma.storageBucket.count({ where: { projectId, name: 'receipts' } })).toBe(0)
  })

  it('stops at a step that needs a person, with everything newer restored; decided, running it again finishes', async () => {
    const hook = await prisma.webhook.create({ data: { projectId, eventType: 'row.inserted', targetUrl: 'https://hooks.example.test/a', secret: hex() } })
    const point = await change('create members', () => ddl(`CREATE TABLE ${T('members')} (id serial PRIMARY KEY)`))
    const rotated = await change('rotate and move webhook', () => prisma.webhook.update({ where: { id: hook.id }, data: { secret: hex(), targetUrl: 'https://hooks.example.test/b' } }))
    const newer = await change('create events', () => ddl(`CREATE TABLE ${T('events')} (id serial PRIMARY KEY)`))

    const first = await to(point.seq)
    expect(first.restored.map((r) => r.seq)).toEqual([newer.seq])
    expect(first.stoppedAt).toMatchObject({
      seq: rotated.seq,
      code: 'NEEDS_APPROVAL',
      reason: 'The signing secret of webhook to hooks.example.test (row.inserted) was replaced, and the old one is not kept: the new one stays.',
    })
    expect(await exists('events')).toBe(false)

    // The person approves exactly that step in its own dialog.
    const p = (await previewRecovery(projectId, rotated.id))!
    expect(await restore(rotated.id, p.acknowledgement)).toMatchObject({ ok: true })
    expect(await to(point.seq)).toMatchObject({ restored: [], stoppedAt: null })
    expect((await prisma.webhook.findUnique({ where: { id: hook.id } }))!.targetUrl).toBe('https://hooks.example.test/a')
  })
})

describe('restore to a point across an architecture change', () => {
  it('stops before a change still in place, before running anything older, and says to undo it whole first', async () => {
    const point = await change('create carts', () => ddl(`CREATE TABLE ${T('carts')} (id serial PRIMARY KEY)`))
    const group = `evolution:${hex()}`
    await architectureStep(group, 'create cart_refunds', () => ddl(`CREATE TABLE ${T('cart_refunds')} (id int PRIMARY KEY)`))
    const last = await architectureStep(group, 'add cart_refunds.note', () => ddl(`ALTER TABLE ${T('cart_refunds')} ADD COLUMN note text`))
    const later = await change('create wishlists', () => ddl(`CREATE TABLE ${T('wishlists')} (id serial PRIMARY KEY)`))

    const plan = await planRestoreTo(projectId, point.seq)
    expect(plan.steps.map((s) => s.seq)).toEqual([later.seq])
    expect(plan.stop).toMatchObject({ seq: last.seq, code: 'UNAVAILABLE' })
    expect(plan.stop!.reason).toBe(`#${last.seq} is one step of an architecture change. Undo the whole change from the Autonomy page first, then restore again.`)

    const out = await to(point.seq)
    expect(out.restored.map((r) => r.seq)).toEqual([later.seq])
    expect(out.stoppedAt).toMatchObject({ seq: last.seq })
    expect(await exists('wishlists')).toBe(false)
    expect(await exists('cart_refunds')).toBe(true)
  })

  it('passes over a change undone in full, whose undo is still one step it will not restore alone', async () => {
    const point = await change('create coupons', () => ddl(`CREATE TABLE ${T('coupons')} (id serial PRIMARY KEY)`))
    const group = `evolution:${hex()}`
    await architectureStep(group, 'create coupon_refunds', () => ddl(`CREATE TABLE ${T('coupon_refunds')} (id int PRIMARY KEY)`))
    // A change to the host made while the architecture change was in place.
    const between = await change('add coupons.code', () => ddl(`ALTER TABLE ${T('coupons')} ADD COLUMN code text`))
    const undo = await architectureStep(`${group}:undo`, 'undo: remove coupon_refunds', () => dropDeclared('coupon_refunds'))
    expect(undo.status).toBe('healthy')
    expect(await previewRecovery(projectId, undo.id)).toMatchObject({ safety: 'unavailable', unavailableCode: 'PART_OF_ARCHITECTURE_CHANGE' })

    const plan = await planRestoreTo(projectId, point.seq)
    expect(plan.steps.map((s) => s.seq)).toEqual([between.seq])
    expect(plan.stop).toBeNull()
    const out = await to(point.seq)
    expect(out).toMatchObject({ stoppedAt: null })
    expect(out.restored.map((r) => r.seq)).toEqual([between.seq])
    expect(await exists('coupon_refunds')).toBe(false)
    expect((await rows(`SELECT column_name FROM information_schema.columns WHERE table_schema = '${schema}' AND table_name = 'coupons'`)).map((r: any) => r.column_name)).toEqual(['id'])
  })

  it('refuses a point that holds part of a change, even one undone since: only the whole is undone', async () => {
    const group = `evolution:${hex()}`
    const first = await architectureStep(group, 'create tag_refunds', () => ddl(`CREATE TABLE ${T('tag_refunds')} (id int PRIMARY KEY)`))
    await architectureStep(group, 'add tag_refunds.note', () => ddl(`ALTER TABLE ${T('tag_refunds')} ADD COLUMN note text`))
    const undo = await architectureStep(`${group}:undo`, 'undo: remove tag_refunds', () => dropDeclared('tag_refunds'))

    const plan = await planRestoreTo(projectId, first.seq)
    expect(plan.steps).toEqual([])
    expect(plan.stop).toMatchObject({ seq: undo.seq, code: 'UNAVAILABLE' })
    expect(plan.stop!.reason).toMatch(/^#\d+ is one step of an architecture change that started before this point/)
    expect(await to(first.seq)).toMatchObject({ restored: [], stoppedAt: { seq: undo.seq } })
  })
})

describe('an agent asking for restores', () => {
  it('is held to a number of proofs a minute, so the tables they lock are not held locked', async () => {
    const c = await change('create titles', () => ddl(`CREATE TABLE ${T('titles')} (id serial PRIMARY KEY)`))
    const answers = []
    for (let i = 0; i < AGENT_PROOFS_PER_MINUTE + 1; i++) answers.push(await describeRestoreRequest(projectId, c.id))
    expect(answers.filter((a) => a.ok).length).toBeLessThanOrEqual(AGENT_PROOFS_PER_MINUTE)
    expect(answers[answers.length - 1]).toMatchObject({ ok: false, status: 429, code: 'RESTORE_REQUESTS_THROTTLED' })
  })
})
