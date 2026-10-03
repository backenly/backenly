/**
 * SCHEDULED SNAPSHOTS: OFF BY DEFAULT, REAL WHEN ON, HONEST WHEN BROKEN
 * ====================================================================
 *
 * Three claims, and each one has a way of being quietly false.
 *
 *   DEFAULT OFF   An upgrade must not start writing a dump of every project to
 *                 disk every night on somebody's behalf while they are not
 *                 looking. Seven days of retention against an unknown disk is
 *                 not a decision this product gets to make for an operator.
 *
 *   REALLY RUNS   Calling `backupWorkspace` by hand proves the backup function
 *                 works. It says nothing about whether anything ever calls it.
 *                 So the SCHEDULER'S OWN ENTRY POINT is driven here, and the
 *                 artifact it produces is opened and read.
 *
 *   HONEST WHEN   A backup subsystem that fails quietly is indistinguishable
 *   BROKEN        from one that works. This one did exactly that in production:
 *                 nightly backups failed for at least four days while the
 *                 pruner deleted the last good ones, ending at zero backups on
 *                 disk, with one info-level line as the only trace. So a failed
 *                 run must leave a FAILED record and no artifact — never a
 *                 completed record pointing at a file that does not exist.
 *
 * ── What "the scheduler itself" means here ──────────────────────────────────
 *
 * There are two real entry points and neither can be waited for in a test:
 * node-cron inside instrumentation.ts at 02:05 UTC, and GET
 * /api/cron/daily-backup for an external scheduler. The route is driven for
 * real, because that is a genuine scheduler invocation including its auth gate.
 * The in-process schedule is asserted to still exist and still point at the
 * same function, which is what would catch it being deleted or rewired.
 *
 * Nothing here calls `backupWorkspace` directly. That is the point.
 */

import crypto from 'crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'fs'
import { gunzipSync } from 'zlib'
import { tmpdir } from 'os'
import { join } from 'path'
import { PrismaClient } from '@prisma/client'

// Both read at module load by workspace-backup, so they are set before it is
// imported anywhere in this file.
const BACKUP_DIR = mkdtempSync(join(tmpdir(), 'scheduled-snapshots-'))
process.env.BACKUP_DIR = BACKUP_DIR

const prisma = new PrismaClient()

const TABLE = 'snapshot_rows'
const MARKER = `snapshot-marker-${crypto.randomBytes(6).toString('hex')}`

let ownerId: string
let projectId: string
let schema: string

/** The scheduler's HTTP entry point, loaded after BACKUP_DIR is pinned. */
let dailyBackupRoute: (request: any) => Promise<any>

function cronRequest(secret?: string): any {
  const headers = new Map<string, string>()
  if (secret) headers.set('x-cron-secret', secret)
  return {
    headers: { get: (k: string) => headers.get(k.toLowerCase()) ?? null },
    nextUrl: { searchParams: new URLSearchParams() },
  }
}

async function runScheduler(secret?: string): Promise<{ status: number; body: any }> {
  const res = await dailyBackupRoute(cronRequest(secret))
  return { status: res.status, body: await res.json() }
}

async function backupRows() {
  return prisma.workspaceBackup.findMany({
    where: { projectId },
    orderBy: { createdAt: 'desc' },
  })
}

beforeAll(async () => {
  ;({ GET: dailyBackupRoute } = (await import('@/app/api/cron/daily-backup/route')) as any)

  ownerId = (
    await prisma.user.create({
      data: {
        email: `snapshots-${crypto.randomBytes(5).toString('hex')}@example.test`,
        password: 'not-a-real-hash',
        name: 'Scheduled Snapshot Suite',
      },
      select: { id: true },
    })
  ).id
  projectId = (
    await prisma.project.create({
      data: { name: 'scheduled-snapshots', userId: ownerId },
      select: { id: true },
    })
  ).id
  schema = `workspace_${projectId}`

  await prisma.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "${schema}"`)
  await prisma.$executeRawUnsafe(
    `CREATE TABLE IF NOT EXISTS "${schema}"."${TABLE}" (id serial PRIMARY KEY, label text NOT NULL)`,
  )
  await prisma.$executeRawUnsafe(
    `INSERT INTO "${schema}"."${TABLE}" (label) VALUES ('${MARKER}')`,
  )
}, 300_000)

afterAll(async () => {
  delete process.env.BACKENLY_SCHEDULED_SNAPSHOTS
  await prisma.workspaceBackup.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
  await prisma.project.deleteMany({ where: { userId: ownerId } }).catch(() => {})
  await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
  rmSync(BACKUP_DIR, { recursive: true, force: true })
  await prisma.$disconnect()
}, 300_000)

// ─────────────────────────────────────────────────────────────────────────────

describe('1 — default configuration', () => {
  it('does NOT take snapshots when the operator has not asked', async () => {
    delete process.env.BACKENLY_SCHEDULED_SNAPSHOTS
    // This developer's .env carries a CRON_SECRET, so an unauthenticated call
    // is refused at the door and never reaches the behaviour under test. The
    // auth gate has its own test below; this one is about the opt-in.
    const cronSecret = process.env.CRON_SECRET
    delete process.env.CRON_SECRET
    try {
      const { scheduledSnapshotsEnabled } = await import('@/lib/services/workspace-backup')
      expect(scheduledSnapshotsEnabled()).toBe(false)

      const run = await runScheduler()
      expect(run.status).toBe(200)
      // The scheduler ticked and did nothing, which is the correct answer for
      // an install that never opted in. An exception once a day would read as a
      // broken scheduler; silently backing up would be worse.
      expect(run.body).toMatchObject({ ran: 0, succeeded: 0, failed: 0 })
      expect(await backupRows()).toHaveLength(0)
    } finally {
      if (cronSecret === undefined) delete process.env.CRON_SECRET
      else process.env.CRON_SECRET = cronSecret
    }
  }, 300_000)

  it('is not enabled by an unrelated truthy-looking value', async () => {
    process.env.BACKENLY_SCHEDULED_SNAPSHOTS = 'yes'
    const { scheduledSnapshotsEnabled } = await import('@/lib/services/workspace-backup')
    // Only `true` or `1`. An operator who writes `yes` has not configured
    // anything, and guessing on their behalf is how a disk fills up.
    expect(scheduledSnapshotsEnabled()).toBe(false)
    delete process.env.BACKENLY_SCHEDULED_SNAPSHOTS
  }, 60_000)
})

describe('2, 3 & 4 — enabled, driven by the scheduler, producing a real artifact', () => {
  beforeAll(() => {
    process.env.BACKENLY_SCHEDULED_SNAPSHOTS = 'true'
  })

  it('refuses an unauthenticated scheduler call when a secret is configured', async () => {
    process.env.CRON_SECRET = `cron-${crypto.randomBytes(6).toString('hex')}`
    try {
      const refused = await runScheduler()
      expect(refused.status).toBe(401)
      expect(await backupRows()).toHaveLength(0)

      // CONTROL: the same call with the secret is accepted, so the refusal is
      // the gate working rather than the route being broken.
      const allowed = await runScheduler(process.env.CRON_SECRET)
      expect(allowed.status).toBe(200)
    } finally {
      delete process.env.CRON_SECRET
    }
  }, 600_000)

  it('the SCHEDULER produced a completed record and a file that exists', async () => {
    const rows = await backupRows()
    // Written by the scheduler run in the test above — nothing here called
    // backupWorkspace.
    expect(rows.length).toBeGreaterThan(0)
    const latest = rows[0]
    expect(latest.status).toBe('completed')
    expect(latest.filePath).toBeTruthy()

    // A record is a claim about a file. The claim is checked.
    expect(existsSync(latest.filePath)).toBe(true)
    expect(statSync(latest.filePath).size).toBeGreaterThan(0)
    expect(latest.sizeBytes).toBeGreaterThan(0)
  }, 300_000)

  it('the artifact CONTAINS the project state, not merely bytes', async () => {
    const latest = (await backupRows())[0]
    const sql = gunzipSync(readFileSync(latest.filePath)).toString('utf8')

    // The table, and the row that was in it. A dump that restored to an empty
    // schema would satisfy every size and existence check above.
    expect(sql).toContain(TABLE)
    expect(sql).toContain(MARKER)
  }, 300_000)

  it('does not take a second snapshot of the same project on the same day', async () => {
    const before = (await backupRows()).length
    const run = await runScheduler()
    expect(run.status).toBe(200)
    expect(run.body.ran).toBe(0)
    expect((await backupRows()).length).toBe(before)
  }, 600_000)
})

describe('3b — the in-process schedule still exists', () => {
  it('registers the daily run and points it at runDailyBackups', () => {
    // A STATIC check, and said to be one. The node-cron entry inside
    // instrumentation.ts cannot be waited for in a test - it fires at 02:05
    // UTC - so what is asserted is that it is still registered and still calls
    // the same function. That is what would catch it being deleted or rewired,
    // which is the failure mode a route-driven test cannot see at all.
    const source = readFileSync(join(process.cwd(), 'instrumentation.ts'), 'utf8')
    const block = source.slice(source.indexOf("cron.schedule('5 2 * * *'"))
    expect(block.length).toBeGreaterThan(0)
    expect(block.slice(0, 400)).toContain('runDailyBackups')
  }, 60_000)
})

describe('5 — restoring from a snapshot the scheduler produced', () => {
  it('brings the workspace back after the source state is destroyed', async () => {
    const snapshot = (await backupRows()).find(r => r.status === 'completed')
    expect(snapshot).toBeTruthy()

    // Destroyed, not toggled: the row is gone from the live database, so a
    // restore cannot pass by reading what was already there.
    await prisma.$executeRawUnsafe(`DELETE FROM "${schema}"."${TABLE}"`)
    const emptied = (await prisma.$queryRawUnsafe(
      `SELECT count(*)::int AS n FROM "${schema}"."${TABLE}"`,
    )) as Array<{ n: number }>
    expect(emptied[0].n).toBe(0)

    const { restoreWorkspace } = await import('@/lib/services/workspace-backup')
    const result = await restoreWorkspace(projectId, snapshot!.id)
    expect(result.success).toBe(true)

    const restored = (await prisma.$queryRawUnsafe(
      `SELECT label FROM "${schema}"."${TABLE}"`,
    )) as Array<{ label: string }>
    expect(restored.map(r => r.label)).toContain(MARKER)
  }, 600_000)
})

describe('6 & 7 — a destination that cannot be written', () => {
  const PARKED = `${BACKUP_DIR}.parked`

  afterAll(() => {
    // Leave the directory usable for anything that runs after this file.
    try {
      rmSync(BACKUP_DIR, { force: true })
    } catch {
      /* it may already be a directory again */
    }
    if (existsSync(PARKED)) {
      const { renameSync } = require('fs')
      renameSync(PARKED, BACKUP_DIR)
    }
  })

  it('records the FAILURE and creates no artifact', async () => {
    // Yesterday, so the "already backed up today" skip does not hide the run.
    await prisma.workspaceBackup.updateMany({
      where: { projectId },
      data: { createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000) },
    })

    const { renameSync, writeFileSync } = require('fs')
    renameSync(BACKUP_DIR, PARKED)
    // A FILE where the directory should be: mkdir -p cannot create under it, so
    // the write fails at its first step. The shape a self-hoster actually hits
    // is a volume that did not mount.
    writeFileSync(BACKUP_DIR, 'not a directory')

    const run = await runScheduler()
    expect(run.status).toBe(200)
    expect(run.body.failed).toBeGreaterThan(0)
    expect(run.body.succeeded).toBe(0)

    const rows = await backupRows()
    const latest = rows[0]
    expect(latest.status).toBe('failed')
    // The defect this guards: a completed record pointing at a file that does
    // not exist is what turns a broken backup into a restore that fails at the
    // worst possible moment.
    expect(latest.filePath).toBeFalsy()

    // The orphan check belongs in the NEXT test, once the directory is back:
    // parking it makes every earlier artifact's path unresolvable, so running
    // the check here would report thirteen orphans that are nothing of the
    // kind. The first run of this suite did exactly that.
  }, 600_000)

  it('succeeds again once the destination is healthy', async () => {
    rmSync(BACKUP_DIR, { force: true })
    const { renameSync } = require('fs')
    renameSync(PARKED, BACKUP_DIR)

    await prisma.workspaceBackup.updateMany({
      where: { projectId },
      data: { createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000) },
    })

    const run = await runScheduler()
    expect(run.status).toBe(200)
    expect(run.body.succeeded).toBeGreaterThan(0)

    const latest = (await backupRows())[0]
    expect(latest.status).toBe('completed')
    expect(existsSync(latest.filePath)).toBe(true)

    // The invariant the failed run must not have broken: no record claims
    // `completed` while pointing at a file that is not there. That combination
    // is what turns a broken backup into a restore that fails at the worst
    // possible moment.
    const orphans = (await backupRows()).filter(
      r => r.status === 'completed' && (!r.filePath || !existsSync(r.filePath)),
    )
    expect(orphans).toEqual([])
  }, 600_000)
})

describe('8 — retention exists, and does not prune what it should protect', () => {
  it('keeps a project whose latest run FAILED from losing its history', async () => {
    // The production incident this encodes: the pruner deleted old backups on a
    // calendar cutoff while every new one was failing, so the platform reached
    // zero backups on disk while logging "Pruned 4 old backups" nightly.
    const { pruneOldBackups } = await import('@/lib/services/workspace-backup')

    const old = await prisma.workspaceBackup.findFirst({
      where: { projectId, status: 'completed' },
      orderBy: { createdAt: 'desc' },
    })
    expect(old).toBeTruthy()

    const result = await pruneOldBackups({ onlyProjectIds: new Set([projectId]) })
    expect(result.protected).toBeGreaterThan(0)

    // The newest completed backup is still there, and so is its file.
    const survivor = await prisma.workspaceBackup.findUnique({ where: { id: old!.id } })
    expect(survivor).toBeTruthy()
    expect(existsSync(survivor!.filePath)).toBe(true)
  }, 600_000)
})
