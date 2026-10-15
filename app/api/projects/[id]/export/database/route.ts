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
 *   raw  = 1 → skip the portability filter (keep RLS policy statements that
 *          reference Backenly-internal roles; they error harmlessly on a
 *          foreign cluster, but migration tools prefer clean input)
 *
 * Runs pg_dump on the app box (same host as Postgres in prod) with
 * --no-owner --no-privileges and streams stdout. In portable mode (default),
 * CREATE POLICY statements are filtered out because they reference roles
 * (backenly_user, bkn_…) that don't exist at the destination; row-level
 * security ENABLE statements are kept — they're valid everywhere.
 *
 * Note: developers can also run pg_dump themselves with their read-only
 * connection string — this endpoint is the zero-install path.
 */

import { NextRequest, NextResponse } from 'next/server'
import { spawn } from 'child_process'
import { Transform } from 'stream'
import { withProjectValidation } from '@/lib/middleware/projectValidation'
import { resolveWorkspaceSchema } from '@/lib/services/workspace-pool'
import { buildConnection, sanitizeError } from '@/lib/services/workspace-backup'
import { prisma } from '@/lib/db/prisma'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

/** Line-oriented filter that drops CREATE POLICY … ; statements (multi-line safe). */
function portableFilter(): Transform {
  let carry = ''
  let inPolicy = false
  return new Transform({
    transform(chunk, _enc, cb) {
      const text = carry + chunk.toString('utf8')
      const lines = text.split('\n')
      carry = lines.pop() ?? '' // last piece may be a partial line
      const out: string[] = []
      for (const line of lines) {
        if (!inPolicy && /^\s*CREATE POLICY /.test(line)) inPolicy = true
        if (!inPolicy) out.push(line)
        else if (/;\s*$/.test(line)) inPolicy = false // statement ended — drop it and resume
      }
      cb(null, out.length > 0 ? out.join('\n') + '\n' : '')
    },
    flush(cb) {
      cb(null, !inPolicy && carry.length > 0 ? carry : '')
    },
  })
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

    // The SAME credential the nightly backups use (workspace-backup.ts), for
    // the same reason: workspace tables carry FORCE ROW LEVEL SECURITY, so
    // pg_dump as the NOBYPASSRLS app role aborts at the first protected table
    // — the exact failure that once took the nightly backups to zero. On a
    // production split, BACKUP_DATABASE_URL must exist; the single-role
    // Compose/self-host stack works on its one superuser connection.
    let conn: { args: string[]; env: NodeJS.ProcessEnv }
    try {
      conn = buildConnection('read')
    } catch {
      return NextResponse.json({ error: 'Database is not configured.' }, { status: 500 })
    }

    const args = [
      ...conn.args,
      `--schema=${schema}`,
      '--no-owner',
      '--no-privileges',
      '--encoding=UTF8',
    ]
    if (mode === 'schema') args.push('--schema-only')
    if (mode === 'data') args.push('--data-only')

    let child
    try {
      child = spawn('pg_dump', args, { stdio: ['ignore', 'pipe', 'pipe'], env: conn.env })
    } catch {
      return NextResponse.json({ error: 'pg_dump is not available on this server.' }, { status: 503 })
    }

    // Run to COMPLETION before answering. The old version committed to a 200
    // stream on the first stdout byte — and pg_dump prints the pre-data DDL
    // before the COPY that can fail, so an aborted dump downloaded as a
    // successful-looking .sql that silently ended mid-way with no data.
    let stderr = ''
    child.stderr.on('data', (d) => { stderr += d.toString() })
    const chunks: Buffer[] = []
    child.stdout.on('data', (d: Buffer) => { chunks.push(d) })
    const exitCode: number | null = await new Promise((resolve) => {
      child.once('close', (code) => resolve(code))
      child.once('error', () => resolve(null))
    })

    if (exitCode !== 0) {
      console.error('[export/database] pg_dump failed:', sanitizeError(stderr).slice(0, 500))
      const notFound = exitCode === null || /ENOENT|not found/i.test(stderr)
      const rls = /row-level security/i.test(stderr)
      return NextResponse.json(
        {
          error: notFound
            ? 'pg_dump is not available on this server.'
            : rls
              ? 'Export failed: the export credential cannot read RLS-protected tables. Set BACKUP_DATABASE_URL to the backup role (see README, Backups).'
              : 'Export failed — see server logs.',
        },
        { status: 503 },
      )
    }

    const dump = Buffer.concat(chunks)

    const header = [
      `-- Backenly database export`,
      `-- Project: ${project?.name ?? validated.projectId}`,
      `-- Schema:  ${schema}`,
      `-- Mode:    ${mode}${raw ? ' (raw)' : ' (portable)'}`,
      `-- Exported at: ${new Date().toISOString()}`,
      `--`,
      `-- Restore anywhere:  psql -d yourdb -f this-file.sql`,
      raw
        ? `-- Raw mode: CREATE POLICY statements reference Backenly-managed roles and`
        : `-- Portable mode: CREATE POLICY statements were omitted (they reference`,
      raw
        ? `-- will error harmlessly if those roles don't exist at the destination.`
        : `-- Backenly-managed roles). Row-level security ENABLE statements are kept.`,
      ``,
      ``,
    ].join('\n')

    const filtered = raw
      ? dump
      : await new Promise<Buffer>((resolve, reject) => {
          const out: Buffer[] = []
          const f = portableFilter()
          f.on('data', (d: Buffer) => out.push(Buffer.from(d)))
          f.on('end', () => resolve(Buffer.concat(out)))
          f.on('error', reject)
          f.end(dump)
        })

    const payload = Buffer.concat([Buffer.from(header, 'utf8'), filtered])

    const safeName = (project?.name ?? 'backenly-project').replace(/[^a-z0-9]/gi, '-').toLowerCase()
    const stamp = new Date().toISOString().slice(0, 10)
    return new NextResponse(new Uint8Array(payload), {
      headers: {
        'Content-Type': 'application/sql; charset=utf-8',
        'Content-Disposition': `attachment; filename="${safeName}-${mode}-${stamp}.sql"`,
        'Cache-Control': 'no-store',
      },
    })
  }, { floor: 'administer' })
}
