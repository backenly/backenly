/**
 * THE INACTIVITY CLOCK, AGAINST A REAL DATABASE AND THE REAL RUNTIME
 * =================================================================
 *
 * `Project.lastActivityAt` is what Backenly Cloud's idle sweep measures, so
 * what moves it decides who gets paused. This suite pins the clock's own rules,
 * its interplay with the race-safe pause, that real runtime traffic moves it
 * and refused traffic does not, and that the snapshot download cannot be
 * pointed at a file outside the project's own backup directory.
 */
import http from 'http'
import os from 'os'
import path from 'path'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import type { AddressInfo } from 'net'
import { randomBytes, randomUUID } from 'crypto'

import app from '@/server/app'
import { prisma } from '@/lib/db/prisma'
import { hashApiKey } from '@/server/lib/end-user-identity'
import { resetActivityThrottle, touchProjectActivity } from '@/lib/projects/activity'
import { applyPauseTransition, withProjectLifecycleLock } from '@/lib/projects/pause-lifecycle'

// workspace-backup reads BACKUP_DIR once, at load, and `import` statements are
// hoisted above any assignment in this file. So it is loaded in isolation AFTER
// the variable is set; importing it normally would pin it to ./backups and make
// the containment tests below pass for the wrong reason.
const BACKUP_ROOT = path.join(os.tmpdir(), `activity-clock-${randomBytes(4).toString('hex')}`)
let resolveSnapshotFile: typeof import('@/lib/services/workspace-backup').resolveSnapshotFile
beforeAll(() => {
  process.env.BACKUP_DIR = BACKUP_ROOT
  jest.isolateModules(() => {
    resolveSnapshotFile = require('@/lib/services/workspace-backup').resolveSnapshotFile
  })
})

let ownerId: string
let server: http.Server
let base: string

async function project(data: Record<string, unknown> = {}): Promise<string> {
  const p = await prisma.project.create({
    data: { name: `clock-${randomBytes(4).toString('hex')}`, userId: ownerId, ...data },
    select: { id: true },
  })
  return p.id
}

const clock = (id: string) =>
  prisma.project.findUniqueOrThrow({ where: { id }, select: { lastActivityAt: true, pauseWarnedAt: true } })

/** The runtime stamps fire-and-forget, so wait for the write to land. */
async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean, ms = 3000): Promise<T> {
  const deadline = Date.now() + ms
  let v = await read()
  while (!ok(v) && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 50))
    v = await read()
  }
  return v
}

async function keyFor(projectId: string): Promise<string> {
  const raw = `bk_test_${randomBytes(16).toString('hex')}`
  await prisma.apiKey.create({
    data: {
      name: 'activity clock',
      keyPrefix: raw.slice(0, 12),
      permissions: ['read', 'write'],
      capabilities: [],
      userId: ownerId,
      projectId,
      keyType: 'public',
      keyHash: hashApiKey(raw),
    },
  })
  return raw
}

beforeAll(async () => {
  const owner = await prisma.user.create({
    data: { email: `clock-${randomBytes(6).toString('hex')}@example.test` },
    select: { id: true },
  })
  ownerId = owner.id
  server = http.createServer(app)
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}, 120_000)

afterAll(async () => {
  await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
  server.closeAllConnections()
  await new Promise<void>(r => server.close(() => r()))
  rmSync(BACKUP_ROOT, { recursive: true, force: true })
}, 120_000)

beforeEach(() => resetActivityThrottle())

describe('the clock', () => {
  it('starts on first use, and withdraws a pending pause warning', async () => {
    const id = await project({ pauseWarnedAt: new Date('2026-09-01T00:00:00Z') })

    await touchProjectActivity(id)

    const after = await clock(id)
    expect(after.lastActivityAt).toBeInstanceOf(Date)
    expect(after.pauseWarnedAt).toBeNull()
  }, 60_000)

  it('moves a clock that is more than an hour old', async () => {
    const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000)
    const id = await project({ lastActivityAt: old })

    await touchProjectActivity(id)

    expect((await clock(id)).lastActivityAt!.getTime()).toBeGreaterThan(old.getTime())
  }, 60_000)

  it('writes at most once an hour, even from a fresh process', async () => {
    const recent = new Date(Date.now() - 10 * 60 * 1000)
    const id = await project({ lastActivityAt: recent })

    await touchProjectActivity(id) // nothing in memory: the database refuses it

    expect((await clock(id)).lastActivityAt).toEqual(recent)
  }, 60_000)

  it('never moves a paused project’s clock; only resuming restarts it', async () => {
    const id = await project({ pausedAt: new Date(), pauseReason: 'inactivity', lastActivityAt: null })

    await touchProjectActivity(id)

    expect((await clock(id)).lastActivityAt).toBeNull()
  }, 60_000)

  it('is what makes a stale pause decision lose', async () => {
    // The end-to-end shape of the race: the sweep reads a two-day-old clock,
    // real use lands while the snapshot runs, and the pause must not commit.
    const seen = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)
    const id = await project({ lastActivityAt: seen })

    await touchProjectActivity(id)
    const result = await withProjectLifecycleLock(id, tx =>
      applyPauseTransition(tx, id, { observedLastActivityAt: seen, reason: 'inactivity' }),
    )

    expect(result.paused).toBe(false)
  }, 60_000)
})

describe('what the runtime counts', () => {
  it('stamps an authenticated request that was served', async () => {
    const id = await project()
    const key = await keyFor(id)

    const res = await fetch(`${base}/api/v1/${id}/database/query`, {
      method: 'POST',
      headers: { 'x-api-key': key, 'content-type': 'application/json' },
      body: JSON.stringify({ table: 'things' }),
    })
    await res.text()

    const after = await until(() => clock(id), c => c.lastActivityAt !== null)
    expect(after.lastActivityAt).toBeInstanceOf(Date)
  }, 60_000)

  it('does not stamp a request with no valid credential', async () => {
    const id = await project()

    const res = await fetch(`${base}/api/v1/${id}/database/query`, {
      method: 'POST',
      headers: { 'x-api-key': 'bk_test_not_a_real_key', 'content-type': 'application/json' },
      body: JSON.stringify({ table: 'things' }),
    })
    await res.text()
    await new Promise(r => setTimeout(r, 300))

    expect((await clock(id)).lastActivityAt).toBeNull()
  }, 60_000)

  it('does not stamp a request the pause refused', async () => {
    const id = await project({ pausedAt: new Date(), pauseReason: 'inactivity' })
    const key = await keyFor(id)

    const res = await fetch(`${base}/api/v1/${id}/database/query`, {
      method: 'POST',
      headers: { 'x-api-key': key, 'content-type': 'application/json' },
      body: JSON.stringify({ table: 'things' }),
    })
    await res.text()
    await new Promise(r => setTimeout(r, 300))

    expect(res.status).toBe(503)
    expect((await clock(id)).lastActivityAt).toBeNull()
  }, 60_000)
})

describe('the snapshot a download may hand out', () => {
  async function snapshotRow(projectId: string, filePath: string, status = 'completed') {
    return prisma.workspaceBackup.create({
      data: {
        projectId,
        filename: path.basename(filePath),
        filePath,
        schemaName: `workspace_${projectId}`,
        status,
        sizeBytes: 3,
      },
      select: { id: true },
    })
  }

  it('resolves a completed snapshot inside the project’s own directory', async () => {
    const id = await project()
    const dir = path.join(BACKUP_ROOT, id)
    mkdirSync(dir, { recursive: true })
    const file = path.join(dir, 'snap.sql.gz')
    writeFileSync(file, 'abc')
    const row = await snapshotRow(id, file)

    await expect(resolveSnapshotFile(id, row.id)).resolves.toMatchObject({ filePath: file, sizeBytes: 3 })
  }, 60_000)

  it('refuses a row that points outside that directory', async () => {
    const id = await project()
    const outside = path.join(BACKUP_ROOT, 'elsewhere.sql.gz')
    mkdirSync(BACKUP_ROOT, { recursive: true })
    writeFileSync(outside, 'abc')
    const row = await snapshotRow(id, outside)

    await expect(resolveSnapshotFile(id, row.id)).resolves.toBeNull()
  }, 60_000)

  it("refuses another project's snapshot and a failed one", async () => {
    const owner = await project()
    const other = await project()
    const dir = path.join(BACKUP_ROOT, owner)
    mkdirSync(dir, { recursive: true })
    const file = path.join(dir, `s-${randomUUID()}.sql.gz`)
    writeFileSync(file, 'abc')
    const ok = await snapshotRow(owner, file)
    const failed = await snapshotRow(owner, file, 'failed')

    await expect(resolveSnapshotFile(other, ok.id)).resolves.toBeNull()
    await expect(resolveSnapshotFile(owner, failed.id)).resolves.toBeNull()
  }, 60_000)
})
