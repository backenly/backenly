/**
 * GET /api/projects/[id]/export/database — self-serve pg_dump.
 *
 * The portability guarantee as an endpoint: a real PostgreSQL dump of the
 * project's workspace schema that restores onto ANY Postgres (RDS, Neon, a
 * VPS, localhost). Complements the existing /export/schema (CREATE TABLE
 * approximation) with the genuine article — data, constraints, indexes,
 * sequences, defaults.
 *
 * Query params:
 *   mode = full (default) | schema | data
 *   raw  = 1 → pg_dump's output as it is: a policy written for particular
 *          roles stays as written and fails to restore where those roles do
 *          not exist (migration tools prefer the portable file)
 *
 * Runs pg_dump on the app box with --no-owner --no-privileges, against the
 * database that holds the project's data: its own, or its region's
 * (backupTargetOf, the target of its nightly snapshots). In portable mode
 * (default), every policy comes with its table, and one written for particular
 * roles is created for those of its roles the destination has
 * (lib/services/export-policies.ts). This mode used to leave out every policy,
 * which restored FORCE ROW LEVEL SECURITY with nothing to allow a row, so every
 * table denied every row (production QA, 2026-11-09).
 *
 * THE ANSWER IS A WHOLE DUMP OR A REFUSAL
 * ---------------------------------------
 * pg_dump writes to a file on this server's disk and the answer is read back
 * from it (lib/services/database-export.ts), so an export takes the same
 * memory whatever the size of the database.
 *
 *   - pg_dump finishes within EXPORT_LIMITS.answerWithinMs, as nearly every
 *     export does: 200 with the whole file and its length, or a refusal that
 *     names the cause. Nothing is sent before pg_dump has exited.
 *   - pg_dump is still running after that: by then it has connected, locked
 *     every table and been writing rows for the whole wait, and a proxy in
 *     front of this server gives up on a request that has sent nothing for
 *     about a minute. The download starts and follows the file as pg_dump
 *     writes it. If pg_dump fails after that, the connection is cut, which
 *     every client reports as a failed download; it is never ended as though
 *     the file were whole.
 *
 * The file's last line is EXPORT_COMPLETE_LINE, written only after pg_dump
 * exited 0. The console checks for it before it saves anything.
 *
 * Note: developers can also run pg_dump themselves with their read-only
 * connection string — this endpoint is the zero-install path.
 */

import { Readable } from 'stream'
import { NextRequest, NextResponse } from 'next/server'
import { portablePolicies } from '@/lib/services/export-policies'
import { exportFailure, exportRefusal, type ExportFailure } from '@/lib/services/export-failure'
import { EXPORT_COMPLETE_LINE } from '@/lib/services/export-completion'
import { EXPORT_LIMITS, startDatabaseExport, type ExportOutcome } from '@/lib/services/database-export'
import { withProjectValidation } from '@/lib/middleware/projectValidation'
import { resolveWorkspaceSchema } from '@/lib/services/workspace-pool'
import { backupTargetOf, buildConnection, sanitizeError } from '@/lib/services/workspace-backup'
import { prisma } from '@/lib/db/prisma'
import { projectDatabase } from '@/lib/data-plane/regional'
import { regionErrorResponse } from '@/lib/api/v1/errors'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

function refusal(failure: ExportFailure, status: number, headers?: Record<string, string>) {
  return NextResponse.json({ error: failure.message, code: failure.code }, { status, headers })
}

// ADMIN: `mode=full` streams every row of every table in the workspace — the
// whole tenant, end-user data included. An export is classified by what it
// hands over, not by its verb; membership alone let an organization VIEWER
// exfiltrate the project.
export async function GET(request: NextRequest) {
  return withProjectValidation<any>(request, async (validated) => {
    const url = new URL(request.url)
    const mode = url.searchParams.get('mode') ?? 'full'
    const raw = url.searchParams.get('raw') === '1'
    if (!['full', 'schema', 'data'].includes(mode)) {
      return NextResponse.json({ error: 'mode must be full, schema, or data' }, { status: 400 })
    }

    const schema = await resolveWorkspaceSchema(validated.projectId)
    const project = await prisma.project.findUnique({
      where: { id: validated.projectId },
      select: { name: true },
    })

    // The SAME database and the SAME credential the nightly snapshots use
    // (workspace-backup.ts). The database, because the schema is only where
    // the project's data is: in its own database when it has one, otherwise in
    // its region's. The credential, because workspace tables carry FORCE ROW
    // LEVEL SECURITY, so pg_dump as the NOBYPASSRLS app role aborts at the
    // first protected table — the exact failure that once took the nightly
    // backups to zero. On a production split, BACKUP_DATABASE_URL must exist;
    // the single-role Compose/self-host stack works on its one superuser
    // connection.
    let conn: { args: string[]; env: NodeJS.ProcessEnv }
    try {
      conn = buildConnection('read', backupTargetOf(await projectDatabase(validated.projectId)))
    } catch (err) {
      return regionErrorResponse(err) ?? NextResponse.json({ error: 'Database is not configured.' }, { status: 500 })
    }

    const args = [
      ...conn.args,
      `--schema=${schema}`,
      '--no-owner',
      '--no-privileges',
      '--encoding=UTF8',
      // A table held by a schema change in flight is a refusal now, not a wait
      // with no end.
      `--lock-wait-timeout=${EXPORT_LIMITS.lockWaitMs}`,
    ]
    if (mode === 'schema') args.push('--schema-only')
    if (mode === 'data') args.push('--data-only')

    const header = [
      `-- Backenly database export`,
      `-- Project: ${project?.name ?? validated.projectId}`,
      `-- Schema:  ${schema}`,
      `-- Mode:    ${mode}${raw ? ' (raw)' : ' (portable)'}`,
      `-- Exported at: ${new Date().toISOString()}`,
      `--`,
      `-- Restore anywhere:  psql -d yourdb -f this-file.sql`,
      // A data-only dump has no policies to speak of.
      ...(mode === 'data'
        ? []
        : raw
          ? [
              `-- Raw mode: pg_dump's output as it is. A policy for a role this server`,
              `-- does not have fails to restore; psql reports it and carries on.`,
            ]
          : [
              `-- Portable mode: row-level security comes with its policies. A policy`,
              `-- written for particular roles is created for those of its roles this`,
              `-- server has, and skipped with a warning when it has none of them.`,
            ]),
      `--`,
      `-- This file is whole only if its last line is:`,
      `--   ${EXPORT_COMPLETE_LINE}`,
      ``,
      ``,
    ].join('\n')

    const start = startDatabaseExport({
      projectId: validated.projectId,
      args,
      // A database that does not answer is a refusal inside the wait below.
      env: { PGCONNECT_TIMEOUT: String(EXPORT_LIMITS.connectWithinSeconds), ...conn.env },
      header,
      trailer: `\n${EXPORT_COMPLETE_LINE}\n`,
      through: raw ? undefined : portablePolicies(),
    })
    if (start.started === false) return refusal(exportRefusal(start.reason), 429, { 'Retry-After': '30' })
    const dump = start.export

    // Whoever asked has gone: stop pg_dump and remove the file. The export
    // then settles as cancelled, which is answered like any other failure.
    // (A caller that hands over no signal is one that cannot go away.)
    const leaving: AbortSignal | undefined = request.signal
    const gone = () => void dump.discard()
    leaving?.addEventListener('abort', gone, { once: true })
    if (leaving?.aborted) gone()

    let waited: NodeJS.Timeout | undefined
    const early: ExportOutcome | null = await Promise.race([
      dump.finished,
      new Promise<null>((resolve) => {
        waited = setTimeout(() => resolve(null), EXPORT_LIMITS.answerWithinMs)
      }),
    ])
    clearTimeout(waited)

    if (early !== null && early.ok === false) {
      await dump.discard()
      return refusal(describeFailure(early), 503)
    }
    // The length is known only when pg_dump has already finished.
    const length = early !== null && early.ok === true ? early.bytes : null

    // Still running: whatever ends it now is told to the log, since the
    // answer has begun and can only be cut short.
    if (early === null) {
      void dump.finished.then((late) => {
        if (late.ok === false && late.reason !== 'cancelled') {
          console.error(`[export/database] failed after the download began: ${describeFailure(late).code}`)
        }
      })
    }

    const body = dump.read()
    // Read to its end, cut short, or abandoned by the client: the file goes.
    body.once('close', () => {
      leaving?.removeEventListener('abort', gone)
      void dump.discard()
    })

    const safeName = (project?.name ?? 'backenly-project').replace(/[^a-z0-9]/gi, '-').toLowerCase()
    const stamp = new Date().toISOString().slice(0, 10)
    return new NextResponse(Readable.toWeb(body) as unknown as ReadableStream<Uint8Array>, {
      headers: {
        'Content-Type': 'application/sql; charset=utf-8',
        'Content-Disposition': `attachment; filename="${safeName}-${mode}-${stamp}.sql"`,
        'Cache-Control': 'no-store',
        // Without a length the answer is chunked.
        ...(length !== null ? { 'Content-Length': String(length) } : {}),
      },
    })
  }, { floor: 'administer' })
}

/**
 * The plain cause of an export that did not finish, with pg_dump's own words
 * left in the log: they name the database host and its address
 * (lib/services/export-failure.ts).
 */
function describeFailure(outcome: Extract<ExportOutcome, { ok: false }>): ExportFailure {
  if (outcome.reason === 'pg_dump') {
    console.error('[export/database] pg_dump failed:', sanitizeError(outcome.stderr).slice(0, 500))
    return exportFailure(outcome.stderr, outcome.started ? (outcome.exitCode ?? 1) : null)
  }
  if (outcome.reason === 'spool') {
    console.error('[export/database] the export file could not be written:', sanitizeError(outcome.detail ?? '').slice(0, 500))
  }
  return exportRefusal(outcome.reason)
}
