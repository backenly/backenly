/**
 * EACH PROJECT'S REALTIME STREAM HAS ITS OWN CHANNEL, KEPT BY THE PLATFORM
 * ========================================================================
 * The projects of a region share one database. A project's stream is carried
 * on a notification channel whose name only the platform keeps
 * (lib/realtime/channels.ts); the functions that announce a change read it
 * from a view that answers only to a role that may write the table. Pinned
 * here on provisioned projects, real logins, the real routes and the real
 * listener hub:
 *
 *   another project's read-only login    receives none of this project's
 *                                        changes, nothing it sends reaches
 *                                        this project's stream, and it reads
 *                                        no channel from the view or the table
 *   this project's stream                gets insert, update, delete, a large
 *                                        row, broadcast and presence, through
 *                                        both servers' routes, and a generated
 *                                        route module's own events
 *   an older function body               replaced when a stream opens, and by
 *                                        the repair pass when a restore puts
 *                                        it back
 *   the read-write login                 issued, rotated, revoked: the channel
 *                                        it could read goes quiet, the stream
 *                                        keeps working without waiting for
 *                                        the repair pass
 *   a branch                             its writes reach no production stream
 *   deleting a project                   deletes its channel
 *   no platform schema                   writes still succeed, and the next
 *                                        repair pass installs it again
 *   what is sent out                     no response, SSE frame or log line
 *                                        carries a channel
 *
 * The modules this change adds are required inside the tests that use them,
 * so the first two tests also run, and fail, on the code before it.
 */

// The data plane's schema registry is a superuser install this database does
// not have; a branch is refused when it cannot be served, so registration is
// answered here. Nothing else about the database is stood in for.
jest.mock('@/lib/postgrest/registration', () => {
  const actual = jest.requireActual('@/lib/postgrest/registration')
  return {
    ...actual,
    registerSchemaByName: async (schema: string) => ({ registered: true, schema }),
    ensureSchemaRegistered: async (projectId: string) => ({ registered: true, schema: `workspace_${projectId}` }),
    unregisterSchema: async () => {},
  }
})

import '@/tests/helpers/real-web-standard'

import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { randomUUID } from 'node:crypto'
import { format } from 'node:util'
import { Client } from 'pg'
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db/prisma'
import { hashApiKey } from '@/server/lib/end-user-identity'
import { mintKey } from '@/lib/auth/key-prefix'
import { createProvisionedProject } from '@/lib/projects/provision'
import { installRealtimeTrigger } from '@/lib/services/realtimeTriggers'
import { provisionDirectAccess, revokeDirectAccess } from '@/lib/services/direct-access'
import { listenerHub } from '@/lib/realtime/listener-hub'
import { flushRecordedRequests } from '@/lib/traffic/request-recorder'
import app from '@/server/app'

const DB_URL = process.env.DATABASE_URL ?? ''
if (!/test/i.test(DB_URL.split('/').pop()?.split('?')[0] ?? '')) throw new Error('Refusing: not a test database')
const dbUrl = new URL(DB_URL)

const originalEdition = process.env.BACKENLY_EDITION

let admin: Client
let runtime: http.Server
let runtimeBase = ''
const users: string[] = []
const projects: string[] = []

/** The project whose changes stream, and the other project, whose read-only login is used below. */
let first = { id: '', schema: '', key: '', userId: '' }
let second = { id: '', schema: '' }
let otherLogin: Client
const otherHeard: Array<{ channel: string; payload: string }> = []

/** Everything the routes sent out, and every log line, checked for a channel at the end. */
const sentOut: string[] = []
const consoleSpies: jest.SpyInstance[] = []

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const label = (id: string) => `workspace_${id}_changes`

async function until<T>(read: () => T | Promise<T>, ms = 10_000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const value = await read()
    if (value) return value
    if (Date.now() > end) throw new Error('timed out')
    await wait(25)
  }
}

function loginClient(user: string, password: string): Client {
  return new Client({
    host: dbUrl.hostname,
    port: Number(dbUrl.port || 5432),
    database: dbUrl.pathname.replace(/^\//, ''),
    user,
    password,
  })
}

/** The channel the platform keeps for a project, read as the test's own (administrative) role. */
async function channelRow(id: string): Promise<string | null> {
  const present = await admin.query(`SELECT to_regclass('backenly_realtime.channel_secrets') IS NOT NULL AS present`)
  if (!present.rows[0].present) return null
  const { rows } = await admin.query(`SELECT channel FROM backenly_realtime.channel_secrets WHERE schema_name = $1`, [`workspace_${id}`])
  return rows[0]?.channel ?? null
}

interface Stream {
  frames: Array<Record<string, any>>
  has(match: (frame: Record<string, any>) => boolean, ms?: number): Promise<boolean>
  next(match: (frame: Record<string, any>) => boolean, ms?: number): Promise<Record<string, any>>
  close(): void
}

function collect(frames: Array<Record<string, any>>, onClose: () => void): Stream {
  const has = async (match: (frame: Record<string, any>) => boolean, ms = 10_000) => {
    try {
      await until(() => frames.some(match), ms)
      return true
    } catch {
      return false
    }
  }
  return {
    frames,
    has,
    async next(match, ms = 10_000) {
      if (!(await has(match, ms))) throw new Error('no such frame arrived')
      return frames.find(match)!
    },
    close: onClose,
  }
}

function parseInto(frames: Array<Record<string, any>>) {
  let buffer = ''
  return (chunk: string) => {
    sentOut.push(chunk)
    buffer += chunk
    let at: number
    while ((at = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, at)
      buffer = buffer.slice(at + 2)
      for (const line of block.split('\n')) if (line.startsWith('data: ')) frames.push(JSON.parse(line.slice(6)))
    }
  }
}

/** The runtime's stream route (server/routes/realtime.ts), as the SDK opens it. */
async function openStream(projectId: string, key: string): Promise<Stream> {
  const frames: Array<Record<string, any>> = []
  const take = parseInto(frames)
  const req = http.get(`${runtimeBase}/api/v1/${projectId}/realtime`, { headers: { 'x-api-key': key } })
  req.on('response', (res) => {
    res.setEncoding('utf8')
    res.on('data', take)
    res.on('error', () => {})
  })
  req.on('error', () => {})
  const stream = collect(frames, () => req.destroy())
  await stream.next((frame) => frame.type === 'connected' || frame.type === 'error')
  if (frames[0]?.type !== 'connected') throw new Error(`stream refused: ${JSON.stringify(frames[0])}`)
  return stream
}

/** The Next.js stream route (app/api/v1/[projectId]/realtime). */
async function openNextStream(projectId: string, key: string): Promise<Stream> {
  const { GET } = require('@/app/api/v1/[projectId]/realtime/route')
  const controller = new AbortController()
  const res: Response = await GET(
    new NextRequest(`https://backenly.test/api/v1/${projectId}/realtime`, { headers: { 'x-api-key': key }, signal: controller.signal }),
    { params: Promise.resolve({ projectId }) },
  )
  const frames: Array<Record<string, any>> = []
  const take = parseInto(frames)
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) return
        take(decoder.decode(value, { stream: true }))
      }
    } catch { /* closed */ }
  })()
  const stream = collect(frames, () => {
    controller.abort()
    reader.cancel().catch(() => {})
  })
  await stream.next((frame) => frame.type === 'connected' || frame.type === 'error')
  return stream
}

async function insertOrder(schema: string, note = 'row'): Promise<string> {
  const id = randomUUID()
  await admin.query(`INSERT INTO "${schema}".orders (id, email, note) VALUES ($1, 'buyer@example.com', $2)`, [id, note])
  return id
}

/** Whether the stream hears a new row within a moment, tried a few times. */
async function streamHearsSoon(stream: Stream, schema: string): Promise<boolean> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const id = await insertOrder(schema, 'probe')
    if (await stream.has((frame) => frame.data?.id === id, 250)) return true
  }
  return false
}

/** Let notifications already sent reach a listening client. */
async function settle(client: Client): Promise<void> {
  await wait(150)
  await client.query('SELECT 1')
  await wait(50)
}

async function makeProject(name: string) {
  const user = await prisma.user.create({ data: { email: `rt-channel-${randomUUID()}@test.invalid`, name } })
  users.push(user.id)
  const project = await createProvisionedProject({ name: `rt channel ${name} ${randomUUID().slice(0, 6)}`, userId: user.id })
  projects.push(project.id)
  return { id: project.id, schema: `workspace_${project.id}`, userId: user.id }
}

async function serviceKeyFor(projectId: string, userId: string): Promise<string> {
  const minted = mintKey({ keyType: 'public', serviceRole: true })
  await prisma.apiKey.create({
    data: {
      name: 'rt-channel', keyPrefix: minted.prefix, keyHash: hashApiKey(minted.key),
      permissions: ['read', 'write'], capabilities: [], userId, projectId,
      keyType: 'public', scope: 'runtime', serviceRole: true, rateLimit: 1000,
    },
  })
  return minted.key
}

beforeAll(async () => {
  process.env.BACKENLY_EDITION = 'cloud'
  for (const method of ['log', 'info', 'warn', 'error'] as const) consoleSpies.push(jest.spyOn(console, method))

  admin = new Client({ connectionString: DB_URL })
  await admin.connect()

  const a = await makeProject('first')
  await admin.query(`CREATE TABLE "${a.schema}".orders (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text, note text)`)
  expect(await installRealtimeTrigger(a.id, 'orders')).toEqual({ installed: true })
  first = { id: a.id, schema: a.schema, key: await serviceKeyFor(a.id, a.userId), userId: a.userId }

  const b = await makeProject('second')
  await admin.query(`CREATE TABLE "${b.schema}".notes (id serial PRIMARY KEY, body text)`)
  second = { id: b.id, schema: b.schema }
  const login = await provisionDirectAccess(b.id, 'READ_ONLY')
  otherLogin = loginClient(login.roleName, login.password)
  otherLogin.on('error', () => {})
  await otherLogin.connect()
  otherLogin.on('notification', (msg) => otherHeard.push({ channel: msg.channel, payload: msg.payload ?? '' }))

  runtime = http.createServer(app)
  await new Promise<void>((resolve) => runtime.listen(0, '127.0.0.1', resolve))
  runtimeBase = `http://127.0.0.1:${(runtime.address() as AddressInfo).port}`
}, 120_000)

afterAll(async () => {
  await otherLogin?.end().catch(() => {})
  runtime?.closeAllConnections?.()
  await new Promise((resolve) => runtime?.close(resolve))
  await flushRecordedRequests().catch(() => {})
  for (const id of projects) {
    await revokeDirectAccess(id, 'READ_ONLY').catch(() => {})
    await revokeDirectAccess(id, 'READ_WRITE').catch(() => {})
    const { rows } = await admin.query(`SELECT nspname FROM pg_namespace WHERE nspname = $1 OR nspname LIKE $2`, [`workspace_${id}`, `workspace_${id}\\_%`])
    for (const { nspname } of rows) await admin.query(`DROP SCHEMA IF EXISTS "${nspname}" CASCADE`).catch(() => {})
    await admin.query(`DELETE FROM backenly_realtime.channel_secrets WHERE schema_name LIKE $1`, [`workspace_${id}%`]).catch(() => {})
    await prisma.workspaceBranch.deleteMany({ where: { projectId: id } }).catch(() => {})
    await prisma.apiKey.deleteMany({ where: { projectId: id } }).catch(() => {})
  }
  await prisma.project.deleteMany({ where: { id: { in: projects } } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: { in: users } } }).catch(() => {})
  await admin?.end().catch(() => {})
  const { disconnectRegionalClients } = require('@/lib/data-plane/regional')
  await disconnectRegionalClients().catch(() => {})
  for (const spy of consoleSpies) spy.mockRestore()
  process.env.BACKENLY_EDITION = originalEdition
}, 120_000)

describe('another project\'s read-only login', () => {
  it('receives none of this project\'s changes', async () => {
    const stream = await openStream(first.id, first.key)
    try {
      await otherLogin.query(`LISTEN "${label(first.id)}"`)
      otherHeard.length = 0
      const id = await insertOrder(first.schema, 'card ending 4242')
      expect(await stream.next((frame) => frame.data?.id === id)).toMatchObject({
        type: 'insert', table: 'orders', data: { id, email: 'buyer@example.com', note: 'card ending 4242' },
      })
      await settle(otherLogin)
      expect(otherHeard).toEqual([])
    } finally {
      stream.close()
      await otherLogin.query(`UNLISTEN *`)
    }
  })

  it('cannot put an event on this project\'s stream', async () => {
    const stream = await openStream(first.id, first.key)
    try {
      await otherLogin.query(`SELECT pg_notify($1, $2)`, [
        label(first.id),
        JSON.stringify({ type: 'insert', table: 'orders', data: { id: 'not-from-this-project' } }),
      ])
      // Notifications arrive in commit order: one sent before this change arrives before it.
      const id = await insertOrder(first.schema)
      await stream.next((frame) => frame.data?.id === id)
      expect(stream.frames.filter((frame) => frame.data?.id === 'not-from-this-project')).toEqual([])
    } finally {
      stream.close()
    }
  })

  it('reads no channel from the view or the table, not even through a function of its own', async () => {
    // The stream above made the first project's channel.
    expect(await channelRow(first.id)).toMatch(/^bkn_rt_[0-9a-f]{48}$/)

    const { rows } = await otherLogin.query(
      `SELECT count(*) FILTER (WHERE channel IS NOT NULL)::int AS with_channel,
              count(*) FILTER (WHERE relid IN (SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                                                WHERE n.nspname = $1))::int AS of_first
         FROM backenly_realtime.channels`,
      [first.schema],
    )
    expect(rows[0]).toEqual({ with_channel: 0, of_first: 0 })
    // Read-only by default; turned off, so what refuses below is the privilege.
    await otherLogin.query(`SET default_transaction_read_only = off`)
    await expect(otherLogin.query(`SELECT * FROM backenly_realtime.channel_secrets`)).rejects.toMatchObject({ code: '42501' })
    await expect(otherLogin.query(`UPDATE backenly_realtime.channel_secrets SET channel = channel`)).rejects.toMatchObject({ code: '42501' })

    // A function it writes, made as cheap as can be so the planner would run it
    // before the view's own conditions, sees no channel either.
    const notices: string[] = []
    const onNotice = (notice: { message?: string }) => notices.push(notice.message ?? '')
    otherLogin.on('notice', onNotice)
    try {
      await otherLogin.query(
        `CREATE FUNCTION pg_temp.peek(text) RETURNS boolean LANGUAGE plpgsql COST 0.0000001
           AS $$ BEGIN RAISE NOTICE 'seen %', $1; RETURN true; END $$`,
      )
      await otherLogin.query(`SELECT count(*) FROM backenly_realtime.channels WHERE pg_temp.peek(channel)`)
    } finally {
      otherLogin.off('notice', onNotice)
    }
    expect(notices.filter((message) => message.includes('bkn_rt_'))).toEqual([])
  })
})

describe('this project\'s stream', () => {
  it('gets insert, update, delete and a large row through the runtime\'s route', async () => {
    const stream = await openStream(first.id, first.key)
    try {
      expect(stream.frames[0]).toEqual({ type: 'connected', projectId: first.id, channel: label(first.id) })
      const id = await insertOrder(first.schema, 'one')
      expect(await stream.next((f) => f.type === 'insert' && f.data?.id === id)).toMatchObject({ data: { note: 'one' }, old: null })
      await admin.query(`UPDATE "${first.schema}".orders SET note = 'two' WHERE id = $1`, [id])
      expect(await stream.next((f) => f.type === 'update' && f.data?.id === id)).toMatchObject({ data: { note: 'two' }, old: { note: 'one' } })
      await admin.query(`DELETE FROM "${first.schema}".orders WHERE id = $1`, [id])
      expect(await stream.next((f) => f.type === 'delete' && f.data?.id === id)).toMatchObject({ table: 'orders' })

      const large = randomUUID()
      await admin.query(`INSERT INTO "${first.schema}".orders (id, email, note) VALUES ($1, 'big@example.com', $2)`, [large, 'x'.repeat(9_000)])
      const frame = await stream.next((f) => f.type === 'insert' && f.data?.id === large)
      expect(frame).toMatchObject({ table: 'orders', data: { id: large }, truncated: true })
      expect(Object.keys(frame.data)).toEqual(['id'])
    } finally {
      stream.close()
    }
  })

  it('gets broadcast and presence from both servers, and changes through the Next.js route', async () => {
    const stream = await openStream(first.id, first.key)
    const nextStream = await openNextStream(first.id, first.key)
    try {
      expect(nextStream.frames[0]).toEqual({ type: 'connected', projectId: first.id, channel: label(first.id) })
      const headers = { 'x-api-key': first.key, 'content-type': 'application/json' }

      const viaRuntime = await fetch(`${runtimeBase}/api/v1/${first.id}/broadcast`, {
        method: 'POST', headers, body: JSON.stringify({ channel: 'room', payload: { from: 'runtime' } }),
      })
      sentOut.push(await viaRuntime.text())
      expect(viaRuntime.status).toBe(200)
      expect(await stream.next((f) => f.type === 'broadcast' && f.payload?.from === 'runtime')).toMatchObject({ channel: 'room' })

      const { POST: broadcastPOST } = require('@/app/api/v1/[projectId]/broadcast/route')
      const viaNext: Response = await broadcastPOST(
        new NextRequest(`https://backenly.test/api/v1/${first.id}/broadcast`, {
          method: 'POST', headers, body: JSON.stringify({ channel: 'room', payload: { from: 'next' } }),
        }),
        { params: Promise.resolve({ projectId: first.id }) },
      )
      sentOut.push(await viaNext.clone().text())
      expect(viaNext.status).toBe(200)
      expect(await stream.next((f) => f.type === 'broadcast' && f.payload?.from === 'next')).toMatchObject({ channel: 'room' })
      expect(await nextStream.next((f) => f.type === 'broadcast' && f.payload?.from === 'next')).toMatchObject({ channel: 'room' })

      const userId = `user-${randomUUID().slice(0, 8)}`
      const join = await fetch(`${runtimeBase}/api/v1/${first.id}/presence`, {
        method: 'POST', headers, body: JSON.stringify({ userId, metadata: { status: 'here' } }),
      })
      sentOut.push(await join.text())
      expect(join.status).toBe(200)
      expect(await stream.next((f) => f.type === 'presence' && f.event === 'join' && f.userId === userId)).toMatchObject({ metadata: { status: 'here' } })

      const { POST: presencePOST } = require('@/app/api/v1/[projectId]/presence/route')
      const update: Response = await presencePOST(
        new NextRequest(`https://backenly.test/api/v1/${first.id}/presence`, {
          method: 'POST', headers, body: JSON.stringify({ userId, metadata: { status: 'away' } }),
        }),
        { params: Promise.resolve({ projectId: first.id }) },
      )
      sentOut.push(await update.clone().text())
      expect(update.status).toBe(200)
      expect(await stream.next((f) => f.type === 'presence' && f.event === 'update' && f.userId === userId)).toMatchObject({ metadata: { status: 'away' } })

      const leave = await fetch(`${runtimeBase}/api/v1/${first.id}/presence?userId=${userId}`, { method: 'DELETE', headers })
      sentOut.push(await leave.text())
      expect(leave.status).toBe(200)
      expect(await stream.next((f) => f.type === 'presence' && f.event === 'leave' && f.userId === userId)).toBeTruthy()

      const id = await insertOrder(first.schema, 'seen by next')
      expect(await nextStream.next((f) => f.type === 'insert' && f.data?.id === id)).toMatchObject({ data: { note: 'seen by next' } })
    } finally {
      stream.close()
      nextStream.close()
    }
  })

  it('gets the events a generated route module sends on its project\'s stream label', async () => {
    const { executeRouteModuleFunction } = require('@/lib/services/ai-functions/route-module-runner')
    const stream = await openStream(first.id, first.key)
    try {
      const code = `
        import { NextResponse } from 'next/server'
        import { prisma } from '@/lib/db'
        export async function POST() {
          await prisma.$executeRawUnsafe(\`SELECT pg_notify($1, $2)\`, '${label(first.id)}', JSON.stringify({ event: 'jobs.created', jobId: 'job-1' }))
          await prisma.$executeRawUnsafe(\`SELECT pg_notify($1, $2)\`, '${label(second.id)}', JSON.stringify({ event: 'jobs.created', jobId: 'job-elsewhere' }))
          return NextResponse.json({ ok: true })
        }`
      const result = await executeRouteModuleFunction(code, first.id, { type: 'http', data: {} }, 'POST /jobs')
      sentOut.push(JSON.stringify(result))
      // The module ran to the end: its second statement, on another project's
      // label, went to the database as written, on the function's login.
      expect(result.returnValue).toEqual({ status: 200, body: { ok: true } })
      expect(await stream.next((f) => f.event === 'jobs.created' && f.jobId === 'job-1')).toBeTruthy()
      const id = await insertOrder(first.schema)
      await stream.next((frame) => frame.data?.id === id)
      expect(stream.frames.filter((f) => f.jobId === 'job-elsewhere')).toEqual([])
    } finally {
      stream.close()
    }
  })
})

describe('an older function body', () => {
  /** The notify body a release before this one wrote, naming the stream label. */
  const olderNotify = (schema: string, channel: string) => `
    CREATE OR REPLACE FUNCTION "${schema}".backenly_notify_realtime()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      PERFORM pg_notify('${channel}', json_build_object('type', lower(TG_OP), 'table', TG_TABLE_NAME,
        'data', CASE WHEN TG_OP = 'DELETE' THEN row_to_json(OLD) ELSE row_to_json(NEW) END)::text);
      RETURN COALESCE(NEW, OLD);
    END;
    $$;
    COMMENT ON FUNCTION "${schema}".backenly_notify_realtime() IS 'backenly realtime notify v2';`
  const olderPresence = (schema: string, channel: string) => `
    CREATE OR REPLACE FUNCTION "${schema}".backenly_notify_presence()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      PERFORM pg_notify('${channel}', json_build_object('type', 'presence', 'event', 'join', 'userId', NEW."userId")::text);
      RETURN NEW;
    END;
    $$;`
  const state = async (schema: string) =>
    (await admin.query(
      `SELECT p.proname AS name, obj_description(p.oid, 'pg_proc') AS version, strpos(p.prosrc, 'backenly_realtime.channels') > 0 AS reads_view
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = $1 AND p.proname IN ('backenly_notify_realtime', 'backenly_notify_presence') ORDER BY 1`,
      [schema],
    )).rows

  it('is replaced when a stream opens, and by the repair pass when a restore puts it back', async () => {
    const p = await makeProject('older')
    await admin.query(`CREATE TABLE "${p.schema}".posts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), body text)`)
    expect(await installRealtimeTrigger(p.id, 'posts')).toEqual({ installed: true })
    await admin.query(`CREATE TABLE "${p.schema}"."_backenly_presence" ("userId" text PRIMARY KEY, "metadata" jsonb NOT NULL DEFAULT '{}', "joinedAt" timestamptz NOT NULL DEFAULT now(), "lastSeen" timestamptz NOT NULL DEFAULT now())`)
    await admin.query(olderPresence(p.schema, label(p.id)))
    await admin.query(`CREATE TRIGGER backenly_presence_notify AFTER INSERT OR UPDATE OR DELETE ON "${p.schema}"."_backenly_presence" FOR EACH ROW EXECUTE FUNCTION "${p.schema}".backenly_notify_presence()`)
    await admin.query(olderNotify(p.schema, label(p.id)))

    const heard: Array<Record<string, any>> = []
    const subscription = await listenerHub.subscribe(p.id, (payload) => heard.push(payload))
    if (!subscription.ok) throw new Error(subscription.message)
    const write = async () => {
      const id = randomUUID()
      await admin.query(`INSERT INTO "${p.schema}".posts (id, body) VALUES ($1, 'b')`, [id])
      return id
    }
    try {
      expect(await state(p.schema)).toEqual([
        { name: 'backenly_notify_presence', version: 'backenly presence notify v2', reads_view: true },
        { name: 'backenly_notify_realtime', version: 'backenly realtime notify v3', reads_view: true },
      ])
      const written = await write()
      await until(() => heard.some((f) => f.data?.id === written))
      await admin.query(`INSERT INTO "${p.schema}"."_backenly_presence" ("userId") VALUES ('u-1')`)
      await until(() => heard.some((f) => f.type === 'presence' && f.userId === 'u-1'))

      // A restore puts the older body back.
      await admin.query(olderNotify(p.schema, label(p.id)))
      const missed = await write()
      await wait(300)
      expect(heard.some((f) => f.data?.id === missed)).toBe(false)

      await listenerHub.repairNow()
      expect((await state(p.schema)).map((row) => row.version)).toEqual(['backenly presence notify v2', 'backenly realtime notify v3'])
      const after = await write()
      await until(() => heard.some((f) => f.data?.id === after))
    } finally {
      subscription.unsubscribe()
    }
  })
})

describe('the read-write login', () => {
  it('when issued, rotated or revoked, leaves the channel it could read quiet, and the stream keeps working', async () => {
    const stream = await openStream(first.id, first.key)
    const eavesdrop = new Client({ connectionString: DB_URL })
    await eavesdrop.connect()
    const overheard: string[] = []
    eavesdrop.on('notification', (msg) => {
      const payload = JSON.parse(msg.payload ?? '{}')
      if (payload.type !== 'backenly.channel') overheard.push(msg.payload ?? '')
    })
    try {
      const before = await channelRow(first.id)
      const rw = await provisionDirectAccess(first.id, 'READ_WRITE')
      const issued = await channelRow(first.id)
      expect(issued).toMatch(/^bkn_rt_/)
      expect(issued).not.toBe(before)
      expect(await streamHearsSoon(stream, first.schema)).toBe(true)

      // The project's own read-write login can read its own project's channel.
      const rwLogin = loginClient(rw.roleName, rw.password)
      rwLogin.on('error', () => {})
      await rwLogin.connect()
      const { rows } = await rwLogin.query(`SELECT channel FROM backenly_realtime.channels WHERE relid = $1::regclass`, [`"${first.schema}".orders`])
      expect(rows).toEqual([{ channel: issued }])
      await rwLogin.end().catch(() => {})

      await eavesdrop.query(`LISTEN "${issued}"`)
      const { rotateDirectAccess } = require('@/lib/services/direct-access')
      await rotateDirectAccess(first.id, 'READ_WRITE')
      const rotated = await channelRow(first.id)
      expect(rotated).not.toBe(issued)
      expect(await streamHearsSoon(stream, first.schema)).toBe(true)
      await settle(eavesdrop)
      expect(overheard).toEqual([])

      await eavesdrop.query(`LISTEN "${rotated}"`)
      await revokeDirectAccess(first.id, 'READ_WRITE')
      const revoked = await channelRow(first.id)
      expect(revoked).not.toBe(rotated)
      expect(await streamHearsSoon(stream, first.schema)).toBe(true)
      await settle(eavesdrop)
      expect(overheard).toEqual([])
    } finally {
      stream.close()
      await eavesdrop.end().catch(() => {})
    }
  })
})

describe('a branch', () => {
  it('sends none of its writes to the production stream, even through the production function', async () => {
    const { createBranch } = require('@/lib/branches/engine')
    const cut = await createBranch(first.id, first.userId, `preview-${randomUUID().slice(0, 6)}`)
    expect(cut.ok).toBe(true)
    const branchSchema: string = cut.branch.schemaName
    // A trigger a person attached to the branch's copy, calling the production function.
    await admin.query(
      `CREATE TRIGGER backenly_realtime AFTER INSERT OR UPDATE OR DELETE ON "${branchSchema}".orders
         FOR EACH ROW EXECUTE FUNCTION "${first.schema}".backenly_notify_realtime()`,
    )
    const stream = await openStream(first.id, first.key)
    try {
      const onBranch = await insertOrder(branchSchema, 'on the branch')
      const onMain = await insertOrder(first.schema, 'on main')
      await stream.next((f) => f.data?.id === onMain)
      expect(stream.frames.filter((f) => f.data?.id === onBranch)).toEqual([])
    } finally {
      stream.close()
    }
  })
})

describe('deleting a project', () => {
  it('deletes its channel', async () => {
    const { deleteProjectCompletely } = require('@/lib/projects/delete')
    const p = await makeProject('deleted')
    const subscription = await listenerHub.subscribe(p.id, () => {})
    if (!subscription.ok) throw new Error(subscription.message)
    subscription.unsubscribe()
    expect(await channelRow(p.id)).toMatch(/^bkn_rt_/)
    await deleteProjectCompletely(p.id)
    expect(await channelRow(p.id)).toBeNull()
  })
})

describe('without the platform schema', () => {
  it('writes still succeed, and the repair pass installs it again for the streams', async () => {
    const stream = await openStream(first.id, first.key)
    try {
      await admin.query(`DROP SCHEMA backenly_realtime CASCADE`)
      const id = await insertOrder(first.schema, 'written without it')
      expect((await admin.query(`SELECT note FROM "${first.schema}".orders WHERE id = $1`, [id])).rows).toEqual([{ note: 'written without it' }])
      await wait(300)
      expect(stream.frames.some((f) => f.data?.id === id)).toBe(false)

      await listenerHub.repairNow()
      expect(await channelRow(first.id)).toMatch(/^bkn_rt_/)
      expect(await streamHearsSoon(stream, first.schema)).toBe(true)
    } finally {
      stream.close()
    }
  })
})

describe('what is sent out', () => {
  it('carries no channel: no response, no SSE frame, no status, no log line', async () => {
    const { getRealtimeStatus } = require('@/lib/services/realtimeTriggers')
    const status = await getRealtimeStatus(first.id)
    expect(status.channel).toBe(label(first.id))
    sentOut.push(JSON.stringify(status))

    expect(sentOut.length).toBeGreaterThan(10)
    expect(sentOut.filter((text) => text.includes('bkn_rt_'))).toEqual([])
    const logged = consoleSpies.flatMap((spy) => spy.mock.calls.map((call) => format(...call)))
    expect(logged.filter((line) => line.includes('bkn_rt_'))).toEqual([])
  })
})
