/**
 * PROJECT DATABASE SNAPSHOT SERVICE
 * =================================
 * pg_dump of one project's workspace_{projectId} schema: its tables, rows,
 * indexes, constraints, RLS policies, and the triggers and functions inside it.
 *
 * WHAT A SNAPSHOT IS NOT
 * ----------------------
 * Not storage files. Not platform accounts. Not API keys. Not project
 * configuration or env. Not function source. Not deployment configuration.
 *
 * It is for schema and data rollback and for moving a project. It is NOT
 * disaster recovery, and it must never be presented as though it were - that
 * is what lib/recovery/ is for, and the two are deliberately named apart so
 * an operator cannot mistake one for the other. A generic "Backup" button that
 * could mean either is the thing this naming exists to prevent.
 *
 * Every path here is BACKUP_DIR/<projectId>/<timestamp>.sql.gz: created, read
 * and pruned at runtime, and absent when Next builds. The filesystem calls
 * therefore carry turbopackIgnore; without it the tracer cannot resolve them
 * and falls back to tracing the whole repository into .next/standalone.
 *
 * Features:
 *  - Daily scheduled backups (triggered by cron-runner.ts)
 *  - On-demand backup via AI chat BACKUP_DATABASE action
 *  - Restore via AI chat RESTORE_DATABASE action
 *  - 7-day retention (older backups auto-pruned)
 *  - Backups stored in BACKUP_DIR (default: ./backups/) as compressed SQL
 *
 * Each backup file:
 *   backups/{projectId}/{YYYY-MM-DD-HH-mm-ss}-{random}.sql.gz
 */

import { execFile } from 'child_process'
import { randomBytes } from 'crypto'
import { promisify } from 'util'
import * as fs from 'fs'
import * as path from 'path'
import * as zlib from 'zlib'
import { pipeline } from 'stream/promises'
import { prisma } from '@/lib/db/prisma'
import { isCloudEdition } from '@/lib/edition/cloud-only'

const execFileAsync = promisify(execFile)

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
  return path.join(/*turbopackIgnore: true*/ BACKUP_DIR, projectId)
}

/**
 * A filename that is unique per backup, not per minute.
 *
 * This used to be minute-precision, so two backups of the same project inside
 * one minute resolved to the SAME path: the second dump overwrote the first
 * file, and the first `workspace_backups` row was left describing content that
 * no longer existed. Observed on production 2026-09-07, when an on-demand
 * verification backup landed in the same minute as the scheduled one — two rows
 * (5419 and 5423 bytes) pointing at a single 5423-byte file.
 *
 * Seconds alone only narrows the window: a retry, or two projects' jobs
 * finishing together, still collide inside one second. The random suffix is
 * what makes the name independent of how often backups run, so no future
 * cadence change can reintroduce the overwrite.
 *
 * Nothing parses this name — restore resolves `filePath` from the row, and
 * pruning works from rows — so the format is free to change. Historical files
 * keep their old names and remain valid.
 */
export function getBackupFilename(): string {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const stamp =
    `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}` +
    `-${pad(now.getUTCHours())}-${pad(now.getUTCMinutes())}-${pad(now.getUTCSeconds())}`
  return `${stamp}-${randomBytes(4).toString('hex')}.sql.gz`
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
 * AND bypasses RLS, used by nothing but this dump.
 *
 * The DDL, and the reasoning, are in README.md under "Backups". The privilege
 * set is deliberately minimal and is proven rather than asserted:
 * __tests__/services/backup-restore-privileges.test.ts builds a NOSUPERUSER
 * NOBYPASSRLS application role and a NOSUPERUSER BYPASSRLS backup role with
 * CONNECT, USAGE and SELECT and nothing else, and runs the whole round trip
 * against them.
 */
/**
 * Connection arguments for pg_dump/psql, with the password kept OUT of argv.
 *
 * This used to return `"<full postgresql:// URL>"` for interpolation into a
 * shell string. That put the production password on the command line, and
 * Node's exec error includes the whole command it ran — so every pg_dump
 * failure wrote the live credential into the Web error log, and into the
 * `workspace_backups.error` column. Measured on production 2026-09-06: 450 log
 * lines carrying the DB URI with credentials.
 *
 * Discrete flags plus PGPASSWORD in the CHILD environment fixes the class of
 * bug, not just the symptom: there is no longer any string containing the
 * password for an error message to capture.
 */
export function buildConnection(
  purpose: 'read' | 'write' = 'read',
): { args: string[]; env: NodeJS.ProcessEnv } {
  // Only the DUMP wants BACKUP_DATABASE_URL. Restoring over that connection
  // makes the backup role the OWNER of the restored schema and every table in
  // it, because pg_dump runs with --no-owner and psql creates whatever it
  // replays as the role it connected with.
  //
  // That is not cosmetic. The application role loses ownership of its own
  // workspace, explicit grants are gone (--no-privileges never carried them),
  // and FORCE ROW LEVEL SECURITY keys on the owner — so a "successful" restore
  // silently rewrites who the policies bind. It is invisible on the Compose
  // stack, where one superuser is both roles, and breaks the project anywhere
  // the two are separate.
  //
  // So the backup role stays what its own docstring above describes: read-only
  // with BYPASSRLS. Writing back is the application's own connection.
  const url =
    (purpose === 'read' ? process.env.BACKUP_DATABASE_URL : '') ||
    process.env.DATABASE_URL ||
    process.env.DIRECT_URL ||
    ''
  if (!url) throw new Error('DATABASE_URL not set — cannot run pg_dump')

  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error('DATABASE_URL is not a valid connection URL')
  }

  const args = [
    '--host', parsed.hostname,
    '--port', parsed.port || '5432',
    '--username', decodeURIComponent(parsed.username),
    '--dbname', parsed.pathname.replace(/^\//, ''),
    '--no-password',
  ]

  const env: NodeJS.ProcessEnv = { ...process.env }
  if (parsed.password) env.PGPASSWORD = decodeURIComponent(parsed.password)
  const sslmode = parsed.searchParams.get('sslmode')
  if (sslmode) env.PGSSLMODE = sslmode

  return { args, env }
}

/**
 * Strip anything credential-shaped from a message before it is logged or stored.
 *
 * Defence in depth. With the password out of argv nothing should reach here,
 * but a message is written to logs AND persisted to the database, so it is the
 * wrong place to rely on an upstream guarantee.
 */
export function sanitizeError(message: string): string {
  let out = String(message ?? '')
  // postgres://user:secret@host -> postgres://user:***@host
  out = out.replace(/(\b[a-z]+:\/\/[^:\s/]+:)[^@\s]*(@)/gi, '$1***$2')
  // Any literal occurrence of the live password, however it got there.
  for (const key of ['PGPASSWORD', 'BACKUP_DATABASE_URL', 'DATABASE_URL', 'DIRECT_URL']) {
    const raw = process.env[key]
    if (!raw) continue
    const secret = key === 'PGPASSWORD' ? raw : (() => {
      try { return decodeURIComponent(new URL(raw).password) } catch { return '' }
    })()
    if (secret && secret.length >= 8) out = out.split(secret).join('***')
  }
  return out
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
  const sqlPath = path.join(/*turbopackIgnore: true*/ backupDir, filename.replace('.gz', ''))
  const gzPath = path.join(backupDir, filename)
  const createdAt = new Date().toISOString()

  try {
    // Ensure backup directory exists
    await fs.promises.mkdir(/*turbopackIgnore: true*/ backupDir, { recursive: true })

    const conn = buildConnection('read')

    // Dump only the workspace schema (data + structure, no roles).
    // execFile, not exec: no shell, no command string, nothing for an error to
    // quote back containing the credential.
    await execFileAsync(
      'pg_dump',
      [...conn.args, '--schema', schemaName, '--no-privileges', '--no-owner', '--file', sqlPath],
      { timeout: 120_000, env: conn.env },
    )

    // Compress the dump
    await pipeline(
      fs.createReadStream(/*turbopackIgnore: true*/ sqlPath),
      zlib.createGzip({ level: 6 }),
      fs.createWriteStream(/*turbopackIgnore: true*/ gzPath)
    )

    // Remove uncompressed file
    await fs.promises.unlink(/*turbopackIgnore: true*/ sqlPath).catch(() => {})

    const stat = await fs.promises.stat(/*turbopackIgnore: true*/ gzPath)

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
    // Sanitize FIRST, then classify. Everything downstream of this line is
    // logged and persisted, so nothing credential-shaped may survive it.
    const raw = sanitizeError(err?.message ?? '')
    const isRlsBlock = /row-level security policy/i.test(raw)
    const message = isRlsBlock && usingAppCredentialForBackup()
      ? `${raw} — pg_dump is running as the application role, which does not ` +
        `bypass RLS, and these tables use FORCE ROW LEVEL SECURITY (the owner is ` +
        `subject to policies too). Set BACKUP_DATABASE_URL to a read-only role with ` +
        `BYPASSRLS. Do NOT grant BYPASSRLS to the application role.`
      : raw

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
    await fs.promises.unlink(/*turbopackIgnore: true*/ sqlPath).catch(() => {})
    await fs.promises.unlink(/*turbopackIgnore: true*/ gzPath).catch(() => {})

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

  if (!fs.existsSync(/*turbopackIgnore: true*/ backup.filePath)) {
    return { success: false, error: `Backup file not found on disk: ${backup.filename}` }
  }

  // Short enough to stay inside Postgres's 63-byte identifier limit:
  // workspace_<uuid> is already 46 characters.
  const asideName = `${schemaName}_pre${randomBytes(3).toString('hex')}`
  const sqlPath = backup.filePath.replace('.gz', '.restore.sql')
  let renamed = false

  try {
    // 'write': restoring over BACKUP_DATABASE_URL would re-own the schema to
    // the backup role. See buildConnection.
    const conn = buildConnection('write')

    // Decompress BEFORE touching the live schema. A corrupt or truncated
    // archive must fail while the project's data is still there.
    await pipeline(
      fs.createReadStream(/*turbopackIgnore: true*/ backup.filePath),
      zlib.createGunzip(),
      fs.createWriteStream(/*turbopackIgnore: true*/ sqlPath)
    )

    // Move the live schema aside rather than dropping it.
    //
    // The previous implementation ran DROP + CREATE and then fed in a dump
    // whose own first statement is `CREATE SCHEMA`. That collided, the
    // --single-transaction restore aborted, psql still exited 0 because
    // ON_ERROR_STOP was not set, and the function reported success over a
    // schema it had just emptied. Every restore was silent total data loss.
    //
    // Renaming keeps the old data recoverable for the whole operation, so a
    // failure anywhere below is survivable instead of terminal.
    await prisma.$executeRawUnsafe(
      `ALTER SCHEMA "${schemaName}" RENAME TO "${asideName}"`
    ).then(
      () => { renamed = true },
      // Nothing to move aside is fine: restoring into an absent schema is the
      // disaster-recovery case, and the dump creates it.
      () => { renamed = false },
    )

    // ON_ERROR_STOP is what makes psql's exit code mean anything. Without it
    // the restore above reported success over an aborted transaction.
    await execFileAsync(
      'psql',
      [...conn.args, '--file', sqlPath, '--single-transaction', '-v', 'ON_ERROR_STOP=1'],
      { timeout: 300_000, env: conn.env },
    )

    // Belt and braces: psql exiting 0 is necessary, not sufficient. Confirm the
    // schema exists and actually holds relations before destroying the aside.
    const [{ count }] = await prisma.$queryRawUnsafe<{ count: bigint }[]>(
      `SELECT count(*)::bigint AS count
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relkind IN ('r', 'v', 'm', 'p')`,
      schemaName,
    )
    if (Number(count) === 0) {
      throw new Error(
        `restore produced an empty schema: psql reported success but ${schemaName} holds no relations`
      )
    }

    // Only now is the old copy safe to destroy.
    if (renamed) {
      await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${asideName}" CASCADE`)
    }
    await fs.promises.unlink(/*turbopackIgnore: true*/ sqlPath).catch(() => {})

    console.log(`[Restore] Restored ${projectId} from ${backup.filename} (${count} relations)`)

    return { success: true, restoredFrom: backup.filename }
  } catch (err: any) {
    const message = sanitizeError(err?.message ?? '')
    console.error(`[Restore] Failed for ${projectId}:`, message)

    // Put the project back. The half-restored schema is the thing to discard;
    // the aside is the thing to keep.
    if (renamed) {
      try {
        await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`)
        await prisma.$executeRawUnsafe(`ALTER SCHEMA "${asideName}" RENAME TO "${schemaName}"`)
        console.error(`[Restore] Rolled ${projectId} back to its pre-restore state`)
      } catch (rollbackErr: any) {
        // Worth shouting about: the data still exists under asideName, and an
        // operator needs to know that name to get it back by hand.
        console.error(
          `[Restore] ROLLBACK FAILED for ${projectId}. The pre-restore schema is ` +
            `retained as "${asideName}" and must be renamed back manually: ` +
            sanitizeError(rollbackErr?.message ?? '')
        )
        return {
          success: false,
          error: `${message} — rollback also failed; pre-restore data retained as ${asideName}`,
        }
      }
    }

    await fs.promises.unlink(/*turbopackIgnore: true*/ sqlPath).catch(() => {})
    return { success: false, error: message }
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
      await fs.promises.unlink(/*turbopackIgnore: true*/ b.filePath).catch(() => {})
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
export function scheduledSnapshotsEnabled(): boolean {
  // Cloud runs them as part of the service. Self-host does NOT, unless the
  // operator asks.
  //
  // Not because scheduled snapshots are a Cloud feature - the whole product is
  // un-gated now - but because turning them on would start writing a dump of
  // every project to BACKUP_DIR every day, on every existing install, on
  // upgrade. Seven days of retention against an unknown disk is not a change to
  // make on somebody's behalf while they are not looking.
  //
  // The panel states whether they are on rather than leaving it to be
  // discovered, because a backup schedule nobody knows about is the same
  // problem in the other direction.
  if (isCloudEdition()) return true
  const raw = process.env.BACKENLY_SCHEDULED_SNAPSHOTS?.trim().toLowerCase()
  return raw === 'true' || raw === '1'
}

export async function runDailyBackups(): Promise<{ ran: number; succeeded: number; failed: number }> {
  // The scheduler ticks on every deployment. Return rather than throw: an
  // install that has not opted in has nothing to do here, and an exception once
  // a day would read as a broken scheduler.
  if (!scheduledSnapshotsEnabled()) return { ran: 0, succeeded: 0, failed: 0 }

  const today = new Date()
  today.setUTCHours(0, 0, 0, 0)

  // Get all projects with an active workspace. A paused project is skipped:
  // nothing can write to it, so today's dump would equal the one taken when it
  // paused. Skipping it also keeps that snapshot, because pruning below only
  // ever touches projects backed up in this run.
  const projects = await prisma.project.findMany({
    where: { deletedAt: null, pausedAt: null },
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
