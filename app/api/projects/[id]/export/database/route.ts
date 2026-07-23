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
import { Readable, Transform } from 'stream'
import { withProjectValidation } from '@/lib/middleware/projectValidation'
import { resolveWorkspaceSchema } from '@/lib/services/workspace-pool'
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
    const dbUrl = process.env.DATABASE_URL
    if (!dbUrl) {
      return NextResponse.json({ error: 'Database is not configured.' }, { status: 500 })
    }

    const args = [
      `--dbname=${dbUrl}`,
      `--schema=${schema}`,
      '--no-owner',
      '--no-privileges',
      '--encoding=UTF8',
    ]
    if (mode === 'schema') args.push('--schema-only')
    if (mode === 'data') args.push('--data-only')

    let child
    try {
      child = spawn('pg_dump', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch {
      return NextResponse.json({ error: 'pg_dump is not available on this server.' }, { status: 503 })
    }

    let stderr = ''
    child.stderr.on('data', (d) => { stderr += d.toString() })

    // Fail fast (clean 4xx/5xx) if pg_dump dies before producing output —
    // after the first stdout byte we're committed to the stream.
    const firstChunk = await new Promise<Buffer | null>((resolve) => {
      const onData = (d: Buffer) => { cleanup(); resolve(d) }
      const onClose = () => { cleanup(); resolve(null) }
      const onError = () => { cleanup(); resolve(null) }
      const cleanup = () => {
        child.stdout.off('data', onData)
        child.off('close', onClose)
        child.off('error', onError)
      }
      child.stdout.once('data', onData)
      child.once('close', onClose)
      child.once('error', onError)
    })

    if (firstChunk === null) {
      console.error('[export/database] pg_dump failed:', stderr.slice(0, 500))
      const notFound = /ENOENT|not found/i.test(stderr) || stderr.length === 0
      return NextResponse.json(
        { error: notFound ? 'pg_dump is not available on this server.' : 'Export failed — see server logs.' },
        { status: 503 },
      )
    }

    child.stdout.pause()
    child.stdout.unshift(firstChunk)

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

    const headerStream = Readable.from([header])
    const body = raw ? child.stdout : child.stdout.pipe(portableFilter())

    const webStream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const push = (readable: NodeJS.ReadableStream) =>
          new Promise<void>((resolve, reject) => {
            readable.on('data', (d: Buffer) => controller.enqueue(new Uint8Array(d.buffer, d.byteOffset, d.byteLength)))
            readable.on('end', resolve)
            readable.on('error', reject)
          })
        try {
          await push(headerStream)
          child.stdout.resume()
          await push(body)
          controller.close()
        } catch (err) {
          console.error('[export/database] stream error:', err)
          controller.error(err)
        }
      },
      cancel() {
        child.kill('SIGTERM')
      },
    })

    const safeName = (project?.name ?? 'backenly-project').replace(/[^a-z0-9]/gi, '-').toLowerCase()
    const stamp = new Date().toISOString().slice(0, 10)
    return new NextResponse(webStream, {
      headers: {
        'Content-Type': 'application/sql; charset=utf-8',
        'Content-Disposition': `attachment; filename="${safeName}-${mode}-${stamp}.sql"`,
        'Cache-Control': 'no-store',
      },
    })
  })
}
