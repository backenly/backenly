/**
 * What a person is told when a database export fails.
 *
 * The export route (app/api/projects/[id]/export/database/route.ts) runs
 * pg_dump to completion and answers 503 when it exits non-zero. It used to
 * answer "Export failed — see server logs." for every cause but two, which
 * tells someone on Backenly Cloud nothing they can act on: they cannot read
 * the server's logs (production QA re-test, 2026-11-16, N5). pg_dump's own
 * error names the cause, but it also names the database host and its address,
 * so it stays in the log and the answer names the cause in plain words.
 */

export type ExportFailureCode =
  | 'EXPORT_UNAVAILABLE'
  | 'EXPORT_CONNECTION_FAILED'
  | 'EXPORT_CREDENTIAL'
  | 'EXPORT_PERMISSION_DENIED'
  | 'EXPORT_TABLE_LOCKED'
  | 'EXPORT_BUSY'
  | 'EXPORT_NO_SPACE'
  | 'EXPORT_TOOK_TOO_LONG'
  | 'EXPORT_CANCELLED'
  | 'EXPORT_FAILED'

export interface ExportFailure {
  code: ExportFailureCode
  /** One sentence for the person who asked: what happened and what to do. */
  message: string
}

// libpq's words for a connection that never carried a query: "connection to
// server at … failed: …" since PostgreSQL 14, "could not connect to server"
// before it, and the TLS and authentication failures that end one.
const CONNECTION =
  /connection to server|could not connect to server|could not translate host name|could not open certificate file|SSL SYSCALL error|SSL error|server closed the connection unexpectedly|no pg_hba\.conf entry|password authentication failed|timeout expired/i

// "permission denied for table orders", for schema, sequence, view, … The
// object is the project's own; quoted or not, depending on its name.
const PERMISSION = /permission denied for (table|schema|sequence|view|materialized view|relation|function) ("(?:[^"]|"")+"|[^\s"]+)/i

// pg_dump takes a lock on every table before it writes anything, and the
// export gives it a limited time to wait for one (--lock-wait-timeout).
const LOCKED = /canceling statement due to lock timeout/i

/**
 * The plain cause of a pg_dump run that exited non-zero.
 *
 * `exitCode` is null when pg_dump could not be started at all.
 */
export function exportFailure(stderr: string, exitCode: number | null): ExportFailure {
  if (CONNECTION.test(stderr)) {
    return {
      code: 'EXPORT_CONNECTION_FAILED',
      message: "Nothing was exported: pg_dump could not connect to this project's database. Try again in a few minutes.",
    }
  }
  if (exitCode === null || /ENOENT|not found/i.test(stderr)) {
    return { code: 'EXPORT_UNAVAILABLE', message: 'Nothing was exported: pg_dump is not available on this server.' }
  }
  if (/row-level security/i.test(stderr)) {
    return {
      code: 'EXPORT_CREDENTIAL',
      message:
        "Nothing was exported: the export's database role cannot read tables that use row-level security. Set BACKUP_DATABASE_URL to the backup role (see README, Backups).",
    }
  }
  if (LOCKED.test(stderr)) {
    return {
      code: 'EXPORT_TABLE_LOCKED',
      message:
        'Nothing was exported: a table is locked by a change that is still running. Try again when it has finished.',
    }
  }
  const denied = PERMISSION.exec(stderr)
  if (denied) {
    const name = denied[2].startsWith('"') ? denied[2] : `"${denied[2]}"`
    return {
      code: 'EXPORT_PERMISSION_DENIED',
      message: `Nothing was exported: the database did not let the export read the ${denied[1].toLowerCase()} ${name}.`,
    }
  }
  return {
    code: 'EXPORT_FAILED',
    message: 'Nothing was exported: pg_dump stopped with an error before the dump was complete. Try again in a few minutes.',
  }
}

/** Running pg_dump yourself, for a database the download cannot hand over. */
const OWN_PG_DUMP = 'Run pg_dump yourself with the read-only connection string on this page.'

/**
 * The plain cause of an export that stopped for a reason other than pg_dump's
 * own exit (lib/services/database-export.ts): it could not start because
 * another is running, or the server stopped it.
 */
export function exportRefusal(
  reason: 'project_busy' | 'server_busy' | 'no_space' | 'time' | 'cancelled' | 'spool',
): ExportFailure {
  switch (reason) {
    case 'project_busy':
      return {
        code: 'EXPORT_BUSY',
        message: 'Nothing was exported: another backup of this project is still being made. Try again when it has finished.',
      }
    case 'server_busy':
      return {
        code: 'EXPORT_BUSY',
        message: 'Nothing was exported: this server is making other backups right now. Try again in a minute.',
      }
    case 'no_space':
      return {
        code: 'EXPORT_NO_SPACE',
        message: `Nothing was exported: this server does not have the free disk space to hold a dump of this database while it is made. ${OWN_PG_DUMP}`,
      }
    case 'time':
      return {
        code: 'EXPORT_TOOK_TOO_LONG',
        message: `Nothing was exported: pg_dump ran longer than a download here may take. ${OWN_PG_DUMP}`,
      }
    case 'cancelled':
      return { code: 'EXPORT_CANCELLED', message: 'Nothing was exported: the backup was cancelled before it finished.' }
    case 'spool':
      return {
        code: 'EXPORT_FAILED',
        message: 'Nothing was exported: this server could not write the dump before sending it. Try again in a few minutes.',
      }
  }
}
