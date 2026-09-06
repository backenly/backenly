/**
 * WORKSPACE BACKUP SERVICE
 * ========================
 * Automated pg_dump backups for each project's workspace_{projectId} schema.
 *
 * Features:
 *  - Daily scheduled backups (triggered by cron-runner.ts)
 *  - On-demand backup via AI chat BACKUP_DATABASE action
 *  - Restore via AI chat RESTORE_DATABASE action
 *  - 7-day retention (older backups auto-pruned)
 *  - Backups stored in BACKUP_DIR (default: ./backups/) as compressed SQL
 *
 * Each backup file:
 *   backups/{projectId}/{YYYY-MM-DD-HH-mm}.sql.gz
 */

import { exec } from 'child_process'
import { promisify } from 'util'
import * as fs from 'fs'
import * as path from 'path'
import * as zlib from 'zlib'
import { pipeline } from 'stream/promises'
import { prisma } from '@/lib/db/prisma'

const execAsync = promisify(exec)

const BACKUP_DIR = process.env.BACKUP_DIR || path.join(process.cwd(), 'backups')
const RETENTION_DAYS = 7

/**
 * Never leave a project with fewer than this many completed backups, however
 * old they are. Age-based retention is only safe when a newer backup exists to
 * replace what it deletes; see pruneOldBackups for the incident.
 */
const MIN_RETAINED_PER_PROJECT = 2

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getBackupDir(projectId: string): string {
  return path.join(BACKUP_DIR, projectId)
}

function getBackupFilename(): string {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}-${pad(now.getUTCHours())}-${pad(now.getUTCMinutes())}.sql.gz`
}

/**
 * Connection for pg_dump. Prefers BACKUP_DATABASE_URL.
 *
 * WHY A SEPARATE CREDENTIAL
 * -------------------------
 * Workspace tables are created with FORCE ROW LEVEL SECURITY, and under FORCE
 * RLS even the table OWNER is subject to its policies. `backenly_user` owns
 * those tables and has rolbypassrls = false, so pg_dump running as that role
 * aborts on the first protected table:
 *
 *   pg_dump: error: query failed: ERROR: query would be affected by
 *            row-level security policy for table "users"
 *
 * On production that meant every nightly backup failed for at least four days
 * ("Ran 6 backups — 0 succeeded, 6 failed") while the pruner deleted the last
 * good ones, ending at zero backups on disk.
 *
 * The fix is NOT to grant BYPASSRLS to `backenly_user`. That role serves
 * application requests, and giving it BYPASSRLS would silently disable every
 * RLS policy on every tenant at once — the same shape as the cutover-script
 * vulnerability that exposed password hashes. It needs a role that is read-only
 * AND bypasses RLS, used by nothing but this dump. See docs for the DDL.
 */
function buildPgDumpArgs(): string {
  const url =
    process.env.BACKUP_DATABASE_URL ||
    process.env.DATABASE_URL ||
    process.env.DIRECT_URL ||
    ''
  if (!url) throw new Error('DATABASE_URL not set — cannot run pg_dump')
  return `"${url}"` // pg_dump accepts full connection URL
}

/**
 * True when the dump is running on the shared application credential rather than
 * a dedicated backup role. Used to turn the RLS failure into an explanation
 * instead of a bare pg_dump error, because the bare error gave no hint that the
 * cause was a missing role rather than a broken database.
 */
function usingAppCredentialForBackup(): boolean {
  return !process.env.BACKUP_DATABASE_URL
}

// ─── Core Backup ─────────────────────────────────────────────────────────────

export interface BackupResult {
  success: boolean
  filePath?: string
  filename?: string
  sizeBytes?: number
  error?: string
  projectId: string
  createdAt: string
}

/**
 * Create a compressed SQL dump of workspace_{projectId} schema.
 * Runs pg_dump with --schema=workspace_{projectId} so only that tenant's
 * data is captured. Returns the file path of the created backup.
 */
export async function backupWorkspace(projectId: string): Promise<BackupResult> {
  const schemaName = `workspace_${projectId}`
  const backupDir = getBackupDir(projectId)
  const filename = getBackupFilename()
  const sqlPath = path.join(backupDir, filename.replace('.gz', ''))
  const gzPath = path.join(backupDir, filename)
  const createdAt = new Date().toISOString()

  try {
    // Ensure backup directory exists
    await fs.promises.mkdir(backupDir, { recursive: true })

    const connArgs = buildPgDumpArgs()

    // Dump only the workspace schema (data + structure, no roles)
    const pgDumpCmd = `pg_dump ${connArgs} --schema="${schemaName}" --no-privileges --no-owner --file="${sqlPath}"`

    await execAsync(pgDumpCmd, { timeout: 120_000 })

    // Compress the dump
    await pipeline(
      fs.createReadStream(sqlPath),
      zlib.createGzip({ level: 6 }),
      fs.createWriteStream(gzPath)
    )

    // Remove uncompressed file
    await fs.promises.unlink(sqlPath).catch(() => {})

    const stat = await fs.promises.stat(gzPath)

    // Record in DB
    await prisma.workspaceBackup.create({
      data: {
        projectId,
        filename,
        filePath: gzPath,
        sizeBytes: stat.size,
        schemaName,
        status: 'completed',
      },
    })

    console.log(`[Backup] Created backup for ${projectId}: ${filename} (${stat.size} bytes)`)

    return {
      success: true,
      filePath: gzPath,
      filename,
      sizeBytes: stat.size,
      projectId,
      createdAt,
    }
  } catch (err: any) {
    // Name the actual cause. The raw pg_dump line ("query would be affected by
    // row-level security policy") reads like a database fault, so four days of
    // total backup failure looked like something transient. It is a missing
    // credential, and the message now says so.
    const isRlsBlock = /row-level security policy/i.test(err?.message ?? '')
    const message = isRlsBlock && usingAppCredentialForBackup()
      ? `${err.message} — pg_dump is running as the application role, which does not ` +
        `bypass RLS, and these tables use FORCE ROW LEVEL SECURITY (the owner is ` +
        `subject to policies too). Set BACKUP_DATABASE_URL to a read-only role with ` +
        `BYPASSRLS. Do NOT grant BYPASSRLS to the application role.`
      : err.message

    console.error(`[Backup] Failed for ${projectId}:`, message)

    // Record failure
    await prisma.workspaceBackup.create({
      data: {
        projectId,
        filename,
        filePath: '',
        sizeBytes: 0,
        schemaName,
        status: 'failed',
        error: message,
      },
    }).catch(() => {})

    // Clean up any partial files
    await fs.promises.unlink(sqlPath).catch(() => {})
    await fs.promises.unlink(gzPath).catch(() => {})

    return { success: false, error: message, projectId, createdAt }
  }
}

// ─── Restore ──────────────────────────────────────────────────────────────────

export interface RestoreResult {
  success: boolean
  restoredFrom?: string
  error?: string
}

/**
 * Restore workspace_{projectId} from a backup file.
 * DROP + recreate the schema, then psql the dump into it.
 * Requires confirmation — only called by the AI after user approval.
 */
export async function restoreWorkspace(
  projectId: string,
  backupId?: string
): Promise<RestoreResult> {
  const schemaName = `workspace_${projectId}`

  // Find the backup to restore from
  const backup = backupId
    ? await prisma.workspaceBackup.findFirst({ where: { id: backupId, projectId, status: 'completed' } })
    : await prisma.workspaceBackup.findFirst({
        where: { projectId, status: 'completed' },
        orderBy: { createdAt: 'desc' },
      })

  if (!backup) {
    return { success: false, error: 'No completed backup found for this project' }
  }

  if (!fs.existsSync(backup.filePath)) {
    return { success: false, error: `Backup file not found on disk: ${backup.filename}` }
  }

  try {
    const connArgs = buildPgDumpArgs()

    // Drop and recreate the schema
    await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`)
    await prisma.$executeRawUnsafe(`CREATE SCHEMA "${schemaName}"`)

    // Decompress and restore
    const sqlPath = backup.filePath.replace('.gz', '.restore.sql')
    await pipeline(
      fs.createReadStream(backup.filePath),
      zlib.createGunzip(),
      fs.createWriteStream(sqlPath)
    )

    const psqlCmd = `psql ${connArgs} --file="${sqlPath}" --single-transaction`
    await execAsync(psqlCmd, { timeout: 300_000 })

    await fs.promises.unlink(sqlPath).catch(() => {})

    console.log(`[Restore] Restored ${projectId} from ${backup.filename}`)

    return { success: true, restoredFrom: backup.filename }
  } catch (err: any) {
    console.error(`[Restore] Failed for ${projectId}:`, err.message)
    return { success: false, error: err.message }
  }
}

// ─── List Backups ─────────────────────────────────────────────────────────────

export async function listBackups(projectId: string) {
  return prisma.workspaceBackup.findMany({
    where: { projectId },
    orderBy: { createdAt: 'desc' },
    take: 30,
    select: {
      id: true,
      filename: true,
      sizeBytes: true,
      status: true,
      error: true,
      createdAt: true,
    },
  })
}

// ─── Retention Pruning ────────────────────────────────────────────────────────

/**
 * Delete backup files and DB records older than RETENTION_DAYS.
 *
 * RETENTION HAS A FLOOR, and the floor is the whole point.
 *
 * This function used to delete everything past the cutoff unconditionally, and
 * `runDailyBackups` called it whether or not a single backup had succeeded. On
 * production that combination destroyed every backup the platform had: pg_dump
 * was failing on RLS-forced tables, so each night logged
 * "0 succeeded, 6 failed" and then pruned 3-5 of the previous good ones. Four
 * days later the backups directory held zero files. A failing backup system that
 * also deletes history is strictly worse than no backup system, because it
 * converts a recoverable fault into permanent data loss and reports success
 * while doing it ("Pruned 4 old backups" reads like housekeeping).
 *
 * Two independent guards now, either of which alone would have prevented it:
 *   • the newest MIN_RETAINED_PER_PROJECT completed backups are never deleted,
 *     no matter how old — age can only remove a backup that has replacements
 *   • the caller does not prune a project that has no fresh successful backup
 *
 * Failed/incomplete rows carry no restorable data and are always prunable.
 */
export async function pruneOldBackups(
  opts: { onlyProjectIds?: ReadonlySet<string> } = {},
): Promise<{ pruned: number; protected: number }> {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000)

  const all = await prisma.workspaceBackup.findMany({
    where: opts.onlyProjectIds
      ? { projectId: { in: [...opts.onlyProjectIds] } }
      : {},
    select: { id: true, projectId: true, filePath: true, status: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
  })

  // Per project, hold back the newest completed backups from age-based pruning.
  const keptPerProject = new Map<string, number>()
  const protectedIds = new Set<string>()
  for (const b of all) {
    if (b.status !== 'completed') continue
    const kept = keptPerProject.get(b.projectId) ?? 0
    if (kept < MIN_RETAINED_PER_PROJECT) {
      protectedIds.add(b.id)
      keptPerProject.set(b.projectId, kept + 1)
    }
  }

  let pruned = 0
  for (const b of all) {
    if (b.createdAt >= cutoff) continue
    if (protectedIds.has(b.id)) continue
    if (b.filePath) {
      await fs.promises.unlink(b.filePath).catch(() => {})
    }
    await prisma.workspaceBackup.delete({ where: { id: b.id } }).catch(() => {})
    pruned++
  }

  if (pruned > 0) {
    console.log(
      `[Backup] Pruned ${pruned} old backups (older than ${RETENTION_DAYS} days; ` +
      `${protectedIds.size} recent completed backup(s) protected from pruning)`,
    )
  }

  return { pruned, protected: protectedIds.size }
}

// ─── Daily Backup Runner ──────────────────────────────────────────────────────

/**
 * Run daily backups for ALL active projects.
 * Called by cron-runner.ts once per day (02:00 UTC).
 * Skips projects that already have a backup today.
 */
export async function runDailyBackups(): Promise<{ ran: number; succeeded: number; failed: number }> {
  const today = new Date()
  today.setUTCHours(0, 0, 0, 0)

  // Get all projects with an active workspace
  const projects = await prisma.project.findMany({
    where: { deletedAt: null },
    select: { id: true },
  })

  let ran = 0, succeeded = 0, failed = 0
  const succeededIds = new Set<string>()
  const failures: Array<{ projectId: string; error: string }> = []

  for (const project of projects) {
    // Skip if already backed up today
    const existing = await prisma.workspaceBackup.findFirst({
      where: { projectId: project.id, status: 'completed', createdAt: { gte: today } },
    })
    if (existing) {
      // Already has today's backup — safe to prune this project's old ones.
      succeededIds.add(project.id)
      continue
    }

    ran++
    const result = await backupWorkspace(project.id)
    if (result.success) {
      succeeded++
      succeededIds.add(project.id)
    } else {
      failed++
      failures.push({ projectId: project.id, error: result.error ?? 'unknown error' })
    }
  }

  // Prune ONLY projects that now hold a fresh successful backup. A project whose
  // backup just failed keeps everything it has — deleting its history because a
  // calendar cutoff passed is how the platform reached zero backups while
  // logging "Pruned 4 old backups" every night for four days.
  if (succeededIds.size > 0) {
    await pruneOldBackups({ onlyProjectIds: succeededIds }).catch(() => {})
  }

  // A backup subsystem that fails quietly is indistinguishable from one that
  // works. This ran red nightly and the only trace was one info-level line in a
  // log nobody tails, so it survived at least four days and took every existing
  // backup with it. console.error at minimum, so it lands in nextjs-error.log.
  if (failed > 0) {
    console.error(
      `[DailyBackup] BACKUPS FAILING — ${failed}/${ran} failed, ${succeeded} succeeded. ` +
      `No restore point was created for ${failed} project(s). ` +
      `First error: ${failures[0]?.error ?? 'unknown'}`,
    )
    for (const f of failures.slice(0, 10)) {
      console.error(`[DailyBackup]   project=${f.projectId} error=${f.error}`)
    }
  }

  console.log(`[DailyBackup] Ran ${ran} backups — ${succeeded} succeeded, ${failed} failed`)
  return { ran, succeeded, failed }
}
