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

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getBackupDir(projectId: string): string {
  return path.join(BACKUP_DIR, projectId)
}

function getBackupFilename(): string {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}-${pad(now.getUTCHours())}-${pad(now.getUTCMinutes())}.sql.gz`
}

/** Parse DATABASE_URL into pg_dump connection args */
function buildPgDumpArgs(): string {
  const url = process.env.DATABASE_URL || process.env.DIRECT_URL || ''
  if (!url) throw new Error('DATABASE_URL not set — cannot run pg_dump')
  return `"${url}"` // pg_dump accepts full connection URL
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
    console.error(`[Backup] Failed for ${projectId}:`, err.message)

    // Record failure
    await prisma.workspaceBackup.create({
      data: {
        projectId,
        filename,
        filePath: '',
        sizeBytes: 0,
        schemaName,
        status: 'failed',
        error: err.message,
      },
    }).catch(() => {})

    // Clean up any partial files
    await fs.promises.unlink(sqlPath).catch(() => {})
    await fs.promises.unlink(gzPath).catch(() => {})

    return { success: false, error: err.message, projectId, createdAt }
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
 * Called by the daily cleanup cron job.
 */
export async function pruneOldBackups(): Promise<{ pruned: number }> {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000)

  const oldBackups = await prisma.workspaceBackup.findMany({
    where: { createdAt: { lt: cutoff } },
    select: { id: true, filePath: true },
  })

  let pruned = 0

  for (const backup of oldBackups) {
    if (backup.filePath) {
      await fs.promises.unlink(backup.filePath).catch(() => {})
    }
    await prisma.workspaceBackup.delete({ where: { id: backup.id } }).catch(() => {})
    pruned++
  }

  if (pruned > 0) {
    console.log(`[Backup] Pruned ${pruned} old backups (older than ${RETENTION_DAYS} days)`)
  }

  return { pruned }
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

  for (const project of projects) {
    // Skip if already backed up today
    const existing = await prisma.workspaceBackup.findFirst({
      where: { projectId: project.id, status: 'completed', createdAt: { gte: today } },
    })
    if (existing) continue

    ran++
    const result = await backupWorkspace(project.id)
    if (result.success) succeeded++
    else failed++
  }

  // Prune old backups
  await pruneOldBackups().catch(() => {})

  console.log(`[DailyBackup] Ran ${ran} backups — ${succeeded} succeeded, ${failed} failed`)
  return { ran, succeeded, failed }
}
