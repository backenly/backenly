/**
 * LARGE ROWS STILL SAY WHICH ROW CHANGED, AND LARGE PRESENCE IS REFUSED, NOT A 500 (#620)
 * =====================================================================================
 * PostgreSQL caps a NOTIFY payload at 8,000 bytes. A change over the trigger's
 * 7,500-byte line went out as `{ data: null, truncated: true }`: which row
 * changed was lost, so a client could neither fetch it nor apply a delete.
 * Updates got there at half the row size, because the payload carried the whole
 * old row too. Presence metadata past the cap made pg_notify raise, which failed
 * the presence upsert with a 500. Pinned here against real triggers:
 *
 *   a change that fits                 whole, as before
 *   an update that fits without its    the new row whole, `old` reduced to its
 *   old row                            primary key, `oldTruncated`
 *   a change too large either way      `truncated`, the primary key in `data`
 *                                      (both columns of a two-column key)
 *   a table without a primary key      the old frame with no row data; the
 *                                      write still succeeds
 *   a truncated frame                  delivered only to a stream that may read
 *                                      the row (lib/realtime/visibility.ts)
 *   a schema still on the old body     brought up to date once, all its tables
 *                                      at once (ensureRealtimeFunctionCurrent)
 *   presence metadata over 4 KB        413 PRESENCE_METADATA_TOO_LARGE on both
 *                                      runtimes; 4 KB of the shape jsonb
 *                                      lengthens most still goes through
 *
 * Real database: the tables, their triggers, the notifications on the project's
 * channel, the row-level security, the presence table. Each visibility check
 * runs under a NOSUPERUSER NOBYPASSRLS role when this suite's connection is a
 * superuser, as in __tests__/database/realtime-row-visibility.test.ts.
 */

const mockPremise = { role: '' }
jest.mock('@/lib/services/workspace-rls', () => {
  const actual = jest.requireActual('@/lib/services/workspace-rls')
  return {
    ...actual,
    executeWithUserContext: async (projectId: string, userId: string, isServiceRole: boolean, sql: string, values: unknown[] = [], userRole = 'user') => {
      if (!mockPremise.role) return actual.executeWithUserContext(projectId, userId, isServiceRole, sql, values, userRole)
      const { prisma: db } = jest.requireActual('@/lib/db/prisma')
      const { rlsSessionSql, rlsSessionParams } = jest.requireActual('@/lib/services/rls-session')
      return db.$transaction(async (tx: any) => {
        await tx.$executeRawUnsafe(`SET LOCAL ROLE ${mockPremise.role}`)
        await tx.$executeRawUnsafe(rlsSessionSql(), ...rlsSessionParams({ userId, isServiceRole, userRole }))
        return tx.$queryRawUnsafe(sql, ...values)
      })
    },
  }
})

import '@/tests/helpers/real-web-standard'

import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { randomUUID } from 'node:crypto'
import { Client } from 'pg'
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db/prisma'
import { hashApiKey } from '@/server/lib/end-user-identity'
import { mintKey } from '@/lib/auth/key-prefix'
import { jwtClaimFunctionSql, ownRowsPredicate } from '@/lib/postgrest/rls-translation'
import {
  ensureRealtimeFunctionCurrent,
  installRealtimeTrigger,
  REALTIME_FUNCTION_VERSION,
} from '@/lib/services/realtimeTriggers'
import { visibleChange, type RealtimeChange, type RealtimeSubscriber } from '@/lib/realtime/visibility'
import { PRESENCE_METADATA_MAX_BYTES } from '@/lib/realtime/presence-metadata'
import { POST as presencePost } from '@/app/api/v1/[projectId]/presence/route'
import { flushRecordedRequests } from '@/lib/traffic/request-recorder'
import app from '@/server/app'

let ownerId = ''
let projectId = ''
/** A project whose realtime was enabled before this change: its function has the old body. */
let olderProjectId = ''
let schema = ''
let serviceKey = ''
let listener: Client
let runtime: http.Server
let runtimeBase = ''
const alice = randomUUID()
const bob = randomUUID()

/** Every notification on a channel, in arrival order. */
const heard = new Map<string, Array<Record<string, any>>>()

const channelOf = (id: string) => `workspace_${id}_changes`
const big = (bytes: number) => 'x'.repeat(bytes)

/** The next notification on the project's channel after `before` of them. */
async function nextOn(id: string, before: number): Promise<Record<string, any>> {
  const until = Date.now() + 10_000
  for (;;) {
    const got = heard.get(channelOf(id)) ?? []
    if (got.length > before) return got[before]
    if (Date.now() > until) throw new Error(`no notification on ${channelOf(id)}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

/** Run a statement on the project's schema and return the notification it caused. */
async function notified(id: string, sql: string, ...values: unknown[]): Promise<Record<string, any>> {
  const before = (heard.get(channelOf(id)) ?? []).length
  await prisma.$executeRawUnsafe(sql, ...values)
  return nextOn(id, before)
}

const as = (endUserId: string | null): RealtimeSubscriber => ({ projectId, endUserId, endUserRole: endUserId ? 'user' : null, serviceRole: false })

/** The trigger body before this change, as a schema enabled earlier still runs it. */
const OLDER_BODY = (s: string, channel: string) => `
  CREATE OR REPLACE FUNCTION "${s}".backenly_notify_realtime()
  RETURNS trigger LANGUAGE plpgsql AS $$
  DECLARE payload text; row_data json; old_data json;
  BEGIN
    row_data := CASE WHEN TG_OP = 'DELETE' THEN row_to_json(OLD) ELSE row_to_json(NEW) END;
    old_data := CASE WHEN TG_OP = 'UPDATE' THEN row_to_json(OLD) ELSE NULL END;
    payload := json_build_object('type', lower(TG_OP), 'table', TG_TABLE_NAME, 'data', row_data, 'old', old_data,
                                 'timestamp', extract(epoch from clock_timestamp()))::text;
    IF octet_length(payload) <= 7500 THEN
      PERFORM pg_notify('${channel}', payload);
    ELSE
      PERFORM pg_notify('${channel}', json_build_object('type', lower(TG_OP), 'table', TG_TABLE_NAME, 'data', null,
                                                       'truncated', true, 'timestamp', extract(epoch from clock_timestamp()))::text);
    END IF;
    RETURN COALESCE(NEW, OLD);
  END;
  $$`

beforeAll(async () => {
  ownerId = (await prisma.user.create({
    data: { email: `rt-large-${randomUUID()}@test.invalid`, name: 'Realtime Large Changes' },
    select: { id: true },
  })).id
  projectId = (await prisma.project.create({ data: { name: `rt-large-${randomUUID().slice(0, 8)}`, userId: ownerId }, select: { id: true } })).id
  schema = `workspace_${projectId}`
  const s = `"${schema}"`
  await prisma.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS ${s}`)
  await prisma.$executeRawUnsafe(`CREATE TABLE ${s}.notes (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_id text, body text)`)
  await prisma.$executeRawUnsafe(`CREATE TABLE ${s}.pairs (tenant text, n integer, body text, PRIMARY KEY (tenant, n))`)
  await prisma.$executeRawUnsafe(`CREATE TABLE ${s}.keyless (body text)`)
  for (const table of ['notes', 'pairs', 'keyless']) expect(await installRealtimeTrigger(projectId, table)).toEqual({ installed: true })

  // Own-rows security on notes, so a truncated frame is checked as a read would be.
  await prisma.$executeRawUnsafe(jwtClaimFunctionSql(schema))
  await prisma.$executeRawUnsafe(`ALTER TABLE ${s}.notes ENABLE ROW LEVEL SECURITY`)
  await prisma.$executeRawUnsafe(`ALTER TABLE ${s}.notes FORCE ROW LEVEL SECURITY`)
  const pred = ownRowsPredicate(schema, 'owner_id')
  await prisma.$executeRawUnsafe(`CREATE POLICY own_rows ON ${s}.notes FOR ALL USING (${pred}) WITH CHECK (${pred})`)
  const [who] = await prisma.$queryRawUnsafe<Array<{ rolsuper: boolean; user: string }>>(
    `SELECT rolsuper, current_user AS "user" FROM pg_roles WHERE rolname = current_user`,
  )
  if (who.rolsuper) {
    await prisma.$executeRawUnsafe(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'backenly_rls_premise') THEN
          CREATE ROLE backenly_rls_premise NOSUPERUSER NOBYPASSRLS;
        END IF;
      END $$`)
    await prisma.$executeRawUnsafe(`GRANT "${who.user}" TO backenly_rls_premise`)
    mockPremise.role = 'backenly_rls_premise'
  }

  // A project enabled before this change: the old body, no version recorded.
  olderProjectId = (await prisma.project.create({ data: { name: `rt-older-${randomUUID().slice(0, 8)}`, userId: ownerId }, select: { id: true } })).id
  const older = `workspace_${olderProjectId}`
  await prisma.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "${older}"`)
  await prisma.$executeRawUnsafe(`CREATE TABLE "${older}".posts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), body text)`)
  await prisma.$executeRawUnsafe(OLDER_BODY(older, channelOf(olderProjectId)))
  await prisma.$executeRawUnsafe(
    `CREATE TRIGGER backenly_realtime AFTER INSERT OR UPDATE OR DELETE ON "${older}".posts FOR EACH ROW EXECUTE FUNCTION "${older}".backenly_notify_realtime()`,
  )

  // A service-role project key, as minted: presence lets it speak for any user.
  const minted = mintKey({ keyType: 'public', serviceRole: true })
  serviceKey = minted.key
  await prisma.apiKey.create({
    data: {
      name: 'rt-large', keyPrefix: minted.prefix, keyHash: hashApiKey(serviceKey),
      permissions: ['read', 'write'], capabilities: [], userId: ownerId, projectId,
      keyType: 'public', scope: 'runtime', serviceRole: true, rateLimit: 1000,
    },
  })

  listener = new Client({ connectionString: process.env.DATABASE_URL })
  await listener.connect()
  listener.on('notification', (msg) => {
    const list = heard.get(msg.channel) ?? []
    list.push(JSON.parse(msg.payload ?? 'null'))
    heard.set(msg.channel, list)
  })
  await listener.query(`LISTEN "${channelOf(projectId)}"`)
  await listener.query(`LISTEN "${channelOf(olderProjectId)}"`)

  runtime = http.createServer(app)
  await new Promise<void>((resolve) => runtime.listen(0, '127.0.0.1', resolve))
  runtimeBase = `http://127.0.0.1:${(runtime.address() as AddressInfo).port}`
}, 60_000)

afterAll(async () => {
  await listener?.end().catch(() => {})
  await new Promise((resolve) => runtime?.close(resolve))
  await flushRecordedRequests().catch(() => {})
  for (const id of [projectId, olderProjectId]) {
    if (!id) continue
    await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "workspace_${id}" CASCADE`).catch(() => {})
    await prisma.apiKey.deleteMany({ where: { projectId: id } }).catch(() => {})
  }
  await prisma.project.deleteMany({ where: { userId: ownerId } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: ownerId } }).catch(() => {})
}, 60_000)

describe('a change on a realtime table', () => {
  it('that fits goes out whole, with an update\'s old row', async () => {
    const id = randomUUID()
    const inserted = await notified(projectId, `INSERT INTO "${schema}".notes (id, owner_id, body) VALUES ($1::uuid, $2, 'short')`, id, alice)
    expect(inserted).toMatchObject({ type: 'insert', table: 'notes', data: { id, owner_id: alice, body: 'short' }, old: null })
    expect(inserted.truncated).toBeUndefined()
    const updated = await notified(projectId, `UPDATE "${schema}".notes SET body = 'still short' WHERE id = $1::uuid`, id)
    expect(updated).toMatchObject({ type: 'update', data: { body: 'still short' }, old: { id, owner_id: alice, body: 'short' } })
    expect(updated.oldTruncated).toBeUndefined()
  })

  it('that fits only without its old row keeps the new row whole and reduces the old one to its key', async () => {
    const id = randomUUID()
    await notified(projectId, `INSERT INTO "${schema}".notes (id, owner_id, body) VALUES ($1::uuid, $2, $3)`, id, alice, big(4_000))
    const updated = await notified(projectId, `UPDATE "${schema}".notes SET body = $2 WHERE id = $1::uuid`, id, big(4_100))
    expect(updated).toMatchObject({ type: 'update', table: 'notes', data: { id, owner_id: alice, body: big(4_100) }, old: { id }, oldTruncated: true })
    expect(Object.keys(updated.old)).toEqual(['id'])
    expect(updated.truncated).toBeUndefined()
  })

  it('too large either way carries the primary key, for an insert, an update and a delete', async () => {
    const id = randomUUID()
    const inserted = await notified(projectId, `INSERT INTO "${schema}".notes (id, owner_id, body) VALUES ($1::uuid, $2, $3)`, id, alice, big(9_000))
    expect(inserted).toMatchObject({ type: 'insert', table: 'notes', data: { id }, truncated: true, old: null })
    expect(Object.keys(inserted.data)).toEqual(['id'])
    const updated = await notified(projectId, `UPDATE "${schema}".notes SET body = $2 WHERE id = $1::uuid`, id, big(9_100))
    expect(updated).toMatchObject({ type: 'update', data: { id }, old: { id }, truncated: true })
    const deleted = await notified(projectId, `DELETE FROM "${schema}".notes WHERE id = $1::uuid`, id)
    expect(deleted).toMatchObject({ type: 'delete', data: { id }, truncated: true })
  })

  it('carries both columns of a two-column primary key', async () => {
    const frame = await notified(projectId, `INSERT INTO "${schema}".pairs (tenant, n, body) VALUES ('t1', 7, $1)`, big(9_000))
    expect(frame).toMatchObject({ type: 'insert', table: 'pairs', data: { tenant: 't1', n: 7 }, truncated: true })
    expect(Object.keys(frame.data).sort()).toEqual(['n', 'tenant'])
  })

  it('on a table with no primary key still goes out, with no row data, and the write succeeds', async () => {
    const frame = await notified(projectId, `INSERT INTO "${schema}".keyless (body) VALUES ($1)`, big(9_000))
    expect(frame).toMatchObject({ type: 'insert', table: 'keyless', data: null, truncated: true })
    expect(await prisma.$queryRawUnsafe(`SELECT count(*)::int AS n FROM "${schema}".keyless`)).toEqual([{ n: 1 }])
  })

  it('truncated reaches only a stream that may read the row', async () => {
    const id = randomUUID()
    const frame = await notified(projectId, `INSERT INTO "${schema}".notes (id, owner_id, body) VALUES ($1::uuid, $2, $3)`, id, alice, big(9_000))
    expect(await visibleChange(as(alice), frame as RealtimeChange)).toMatchObject({ type: 'insert', data: { id }, truncated: true })
    expect(await visibleChange(as(bob), frame as RealtimeChange)).toBeNull()
    expect(await visibleChange(as(null), frame as RealtimeChange)).toBeNull()
  })
})

describe('a schema whose realtime was enabled earlier', () => {
  it('is brought up to date once, and its tables then name the row of a large change', async () => {
    const id = randomUUID()
    const before = await notified(olderProjectId, `INSERT INTO "workspace_${olderProjectId}".posts (id, body) VALUES ($1::uuid, $2)`, id, big(9_000))
    expect(before).toMatchObject({ data: null, truncated: true })

    expect(await ensureRealtimeFunctionCurrent(olderProjectId)).toBe('upgraded')
    const [version] = await prisma.$queryRawUnsafe<Array<{ note: string }>>(
      `SELECT obj_description(p.oid, 'pg_proc') AS note FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = $1 AND p.proname = 'backenly_notify_realtime'`,
      `workspace_${olderProjectId}`,
    )
    expect(version.note).toBe(REALTIME_FUNCTION_VERSION)
    expect(await ensureRealtimeFunctionCurrent(olderProjectId)).toBe('current')

    const after = await notified(olderProjectId, `UPDATE "workspace_${olderProjectId}".posts SET body = $2 WHERE id = $1::uuid`, id, big(9_100))
    expect(after).toMatchObject({ type: 'update', data: { id }, truncated: true })
  })
})

describe('presence metadata', () => {
  /** The metadata jsonb lengthens most: one-character values, each followed by `, ` in jsonb's text. */
  const atTheLimit = { picks: Array.from({ length: (PRESENCE_METADATA_MAX_BYTES - 12) / 2 }, () => 1) }
  /** An avatar as a data URL: over pg_notify's own cap, where the upsert used to fail with a 500. */
  const avatarDataUrl = { avatar: `data:image/png;base64,${big(8_000)}` }
  /** One byte over the limit. */
  const justOver = { note: big(PRESENCE_METADATA_MAX_BYTES - 11 + 1) }

  const viaNext = async (userId: string, metadata: unknown) => {
    const res = await presencePost(
      new NextRequest(`https://backenly.test/api/v1/${projectId}/presence`, {
        method: 'POST',
        headers: { 'x-api-key': serviceKey, 'content-type': 'application/json' },
        body: JSON.stringify({ userId, metadata }),
      }),
      { params: Promise.resolve({ projectId }) },
    )
    return { status: res.status, body: (await res.json()) as any }
  }
  const viaRuntime = async (userId: string, metadata: unknown) => {
    const res = await fetch(`${runtimeBase}/api/v1/${projectId}/presence`, {
      method: 'POST',
      headers: { 'x-api-key': serviceKey, 'content-type': 'application/json' },
      body: JSON.stringify({ userId, metadata }),
    })
    return { status: res.status, body: (await res.json()) as any }
  }
  /** Whether the user is online; before any presence write the table does not exist, and no one is. */
  const online = async (userId: string) => {
    const [table] = await prisma.$queryRawUnsafe<Array<{ oid: string | null }>>(
      `SELECT to_regclass($1)::text AS oid`,
      `"${schema}"."_backenly_presence"`,
    )
    if (!table.oid) return false
    return (await prisma.$queryRawUnsafe<Array<{ n: number }>>(
      `SELECT count(*)::int AS n FROM "${schema}"."_backenly_presence" WHERE "userId" = $1`,
      userId,
    ))[0].n === 1
  }

  it.each([['Next', viaNext], ['the runtime', viaRuntime]] as const)(
    'too large for a notification is refused with 413 by %s, not a 500, and nothing is written',
    async (_door, post) => {
      const userId = `big-${randomUUID().slice(0, 8)}`
      const out = await post(userId, avatarDataUrl)
      expect(out.status).toBe(413)
      expect(out.body).toMatchObject({ code: 'PRESENCE_METADATA_TOO_LARGE', limitBytes: PRESENCE_METADATA_MAX_BYTES })
      expect(out.body.bytes).toBeGreaterThan(8_000)
      expect(await online(userId)).toBe(false)
    },
  )

  it('one byte over 4 KB is refused', async () => {
    expect(Buffer.byteLength(JSON.stringify(justOver))).toBe(PRESENCE_METADATA_MAX_BYTES + 1)
    const out = await viaNext(`over-${randomUUID().slice(0, 8)}`, justOver)
    expect(out).toMatchObject({ status: 413, body: { code: 'PRESENCE_METADATA_TOO_LARGE', bytes: PRESENCE_METADATA_MAX_BYTES + 1 } })
  })

  it.each([['Next', viaNext], ['the runtime', viaRuntime]] as const)(
    'at 4 KB in the shape jsonb lengthens most goes through %s, and its join is announced',
    async (_door, post) => {
      expect(Buffer.byteLength(JSON.stringify(atTheLimit))).toBeLessThanOrEqual(PRESENCE_METADATA_MAX_BYTES)
      const userId = `edge-${randomUUID().slice(0, 8)}`
      const before = (heard.get(channelOf(projectId)) ?? []).length
      const out = await post(userId, atTheLimit)
      expect(out).toMatchObject({ status: 200, body: { success: true } })
      expect(await online(userId)).toBe(true)
      expect(await nextOn(projectId, before)).toMatchObject({ type: 'presence', event: 'join', userId })
    },
  )
})
