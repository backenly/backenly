/**
 * A FAILED EXPORT SAYS WHY, AND KEEPS THE DATABASE'S ADDRESS TO THE LOG
 * =====================================================================
 * Production QA re-test, 2026-11-16, new finding N5: every export answered
 * "Export failed — see server logs.", which tells someone on Backenly Cloud
 * nothing they can act on. pg_dump's own error names the cause, and also the
 * database host and its address, so the answer names the cause in plain words
 * and the detail stays in the server log.
 *
 * The real route, with a stand-in pg_dump on PATH that fails the way the real
 * one does, so every cause can be produced on any machine.
 *
 * Production QA, 2026-11-27: every export failed, because the route dumped the
 * region's database after each project had been given a database of its own.
 * And 2026-11-21: it held the dump in memory, and a large one took the web
 * task down. The stand-in also says what it was asked to dump, and can fail
 * late, so both are pinned here: which database is dumped, and that a dump
 * failing after its download began is cut short, never ended as though whole.
 */

let currentProjectId = ''
jest.mock('@/lib/middleware/projectValidation', () => ({
  withProjectValidation: (_req: any, handler: any) => handler({ projectId: currentProjectId, userId: 'test-user' }),
}))

import '../helpers/real-web-standard'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { randomUUID } from 'crypto'
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db/prisma'
import { GET as exportGET } from '@/app/api/projects/[id]/export/database/route'
import { EXPORT_LIMITS, activeExports } from '@/lib/services/database-export'
import { EXPORT_COMPLETE_LINE } from '@/lib/services/export-completion'
import { forgetProjectDatabase } from '@/lib/data-plane/regional'

const HOST = 'workspace-db.internal.example'
const DATA_HOST = 'data-instance.internal.example'
const ADDRESS = '10.20.30.40'
const saved = {
  PATH: process.env.PATH,
  BACKUP_DATABASE_URL: process.env.BACKUP_DATABASE_URL,
  DATA_BACKUP_DATABASE_URL: process.env.DATA_BACKUP_DATABASE_URL,
}
const answerWithinMs = EXPORT_LIMITS.answerWithinMs
let bin = ''
let ownerId = ''

/**
 * The stand-in pg_dump writes STANDIN_STDOUT to stdout and STANDIN_STDERR to
 * stderr, then exits with STANDIN_EXIT. It can also write the arguments it was
 * given (`args`), wait before it finishes (`sleep`, in seconds), and end by a
 * signal instead of an exit code (`killed`).
 */
function standIn(stderr: string, exit: number, stdout = '', also: { args?: boolean; sleep?: number; killed?: boolean } = {}): void {
  process.env.STANDIN_STDERR = stderr
  process.env.STANDIN_STDOUT = stdout
  process.env.STANDIN_EXIT = String(exit)
  process.env.STANDIN_ARGS = also.args ? '1' : ''
  process.env.STANDIN_SLEEP = also.sleep ? String(also.sleep) : ''
  process.env.STANDIN_KILLED = also.killed ? '1' : ''
}

async function until(condition: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 500 && !condition(); i++) await new Promise((resolve) => setTimeout(resolve, 20))
  if (!condition()) throw new Error(`Timed out waiting until ${what}`)
}

/**
 * One export, read to its end. The route removes an export's file, and lets the
 * project be exported again, a moment after its answer has been read, so this
 * waits for that before the next request; `settle: false` is for a request made
 * while another export is meant to be running.
 */
async function callExport(mode = 'full', { settle = true }: { settle?: boolean } = {}) {
  const req = new NextRequest(`http://localhost/api/projects/${currentProjectId}/export/database?mode=${mode}`)
  const res = await exportGET(req)
  const text = await res.text()
  if (settle) await until(() => activeExports() === 0, 'the export is released')
  return { status: res.status, text, json: (() => { try { return JSON.parse(text) } catch { return null } })() }
}

beforeAll(async () => {
  if (process.env.NODE_ENV !== 'test') throw new Error('Refusing: NODE_ENV is not test')
  bin = fs.mkdtempSync(path.join(os.tmpdir(), 'standin-pg-dump-'))
  fs.writeFileSync(
    path.join(bin, 'pg_dump'),
    [
      '#!/bin/sh',
      'printf "%s" "$STANDIN_STDOUT"',
      'if [ -n "$STANDIN_ARGS" ]; then printf "%s\\n" "$*"; fi',
      'if [ -n "$STANDIN_SLEEP" ]; then sleep "$STANDIN_SLEEP"; fi',
      'printf "%s\\n" "$STANDIN_STDERR" >&2',
      'if [ -n "$STANDIN_KILLED" ]; then kill -KILL $$; fi',
      'exit "$STANDIN_EXIT"',
      '',
    ].join('\n'),
  )
  fs.chmodSync(path.join(bin, 'pg_dump'), 0o755)
  process.env.PATH = `${bin}${path.delimiter}${saved.PATH ?? ''}`
  process.env.BACKUP_DATABASE_URL = `postgresql://backenly_backup:not-a-real-password@${HOST}:5432/backenly?sslmode=require`
  process.env.DATA_BACKUP_DATABASE_URL = `postgresql://backenly_backup:not-a-real-password@${DATA_HOST}:5432/postgres?sslmode=require`

  ownerId = (await prisma.user.create({ data: { email: `export-why-${randomUUID()}@test.invalid`, name: 'export' }, select: { id: true } })).id
  currentProjectId = (await prisma.project.create({ data: { name: 'export-why', userId: ownerId }, select: { id: true } })).id
})

afterAll(async () => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  for (const name of ['STDERR', 'STDOUT', 'EXIT', 'ARGS', 'SLEEP', 'KILLED']) delete process.env[`STANDIN_${name}`]
  EXPORT_LIMITS.answerWithinMs = answerWithinMs
  fs.rmSync(bin, { recursive: true, force: true })
  await prisma.project.deleteMany({ where: { id: currentProjectId } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: ownerId } }).catch(() => {})
})

it("says it could not connect, without the database's host or address", async () => {
  standIn(
    `pg_dump: error: connection to server at "${HOST}" (${ADDRESS}), port 5432 failed: could not open certificate file "/root/.postgresql/postgresql.crt": Permission denied`,
    1,
  )
  for (const mode of ['full', 'schema', 'data']) {
    const res = await callExport(mode)
    expect(res.status).toBe(503)
    expect(res.json).toEqual({
      code: 'EXPORT_CONNECTION_FAILED',
      error: "Nothing was exported: pg_dump could not connect to this project's database. Try again in a few minutes.",
    })
    expect(res.text).not.toContain(HOST)
    expect(res.text).not.toContain(ADDRESS)
    expect(res.text).not.toContain('server logs')
  }
})

it('names the object the database refused it', async () => {
  standIn('pg_dump: error: query failed: ERROR:  permission denied for table orders\npg_dump: detail: Query was: LOCK TABLE ...', 1)
  const res = await callExport()
  expect(res.status).toBe(503)
  expect(res.json).toEqual({
    code: 'EXPORT_PERMISSION_DENIED',
    error: 'Nothing was exported: the database did not let the export read the table "orders".',
  })
})

it('says the credential cannot read row-level-security tables, and which setting fixes it', async () => {
  standIn('pg_dump: error: query failed: ERROR:  query would be affected by row-level security policy for table "users"', 1)
  const res = await callExport()
  expect(res.status).toBe(503)
  expect(res.json?.code).toBe('EXPORT_CREDENTIAL')
  expect(res.json?.error).toContain('BACKUP_DATABASE_URL')
})

it('says nothing was exported when pg_dump stops for another reason', async () => {
  standIn('pg_dump: error: query failed: ERROR:  canceling statement due to conflict with recovery', 1)
  const res = await callExport()
  expect(res.status).toBe(503)
  expect(res.json).toEqual({
    code: 'EXPORT_FAILED',
    error: 'Nothing was exported: pg_dump stopped with an error before the dump was complete. Try again in a few minutes.',
  })
})

it('says pg_dump is not there when it cannot be started', async () => {
  const before = process.env.PATH
  process.env.PATH = path.join(bin, 'no-such-directory')
  try {
    const res = await callExport()
    expect(res.status).toBe(503)
    expect(res.json).toEqual({ code: 'EXPORT_UNAVAILABLE', error: 'Nothing was exported: pg_dump is not available on this server.' })
  } finally {
    process.env.PATH = before
  }
})

it('still hands over the dump when pg_dump finishes', async () => {
  standIn('', 0, 'CREATE TABLE public.kept (id integer);\n')
  const res = await callExport('schema')
  expect(res.status).toBe(200)
  expect(res.text).toContain('CREATE TABLE public.kept')
})

it('says a table is locked when pg_dump gave up waiting for one, having been told how long to wait', async () => {
  standIn(
    'pg_dump: error: query failed: ERROR:  canceling statement due to lock timeout\npg_dump: detail: Query was: LOCK TABLE public.orders IN ACCESS SHARE MODE',
    1,
  )
  const res = await callExport()
  expect(res.status).toBe(503)
  expect(res.json).toEqual({
    code: 'EXPORT_TABLE_LOCKED',
    error: 'Nothing was exported: a table is locked by a change that is still running. Try again when it has finished.',
  })

  standIn('', 0, '', { args: true })
  expect((await callExport()).text).toContain(`--lock-wait-timeout=${EXPORT_LIMITS.lockWaitMs}`)
})

it('does not call a pg_dump that was killed one that is not there', async () => {
  standIn('', 0, 'CREATE TABLE public.half', { killed: true })
  const res = await callExport()
  expect(res.status).toBe(503)
  expect(res.json?.code).toBe('EXPORT_FAILED')
})

describe('which database is dumped', () => {
  const OWN_DATABASE = `p_${randomUUID().replace(/-/g, '')}`

  afterAll(async () => {
    await prisma.project.update({
      where: { id: currentProjectId },
      data: { databaseTenancy: 'shared', databaseName: null, databaseInstance: null },
    })
    forgetProjectDatabase(currentProjectId)
  })

  it("is the region's, with the project's schema, for a project without a database of its own", async () => {
    standIn('', 0, '', { args: true })
    const res = await callExport()
    expect(res.status).toBe(200)
    expect(res.text).toContain(`--host ${HOST} `)
    expect(res.text).toContain('--dbname backenly ')
    expect(res.text).toContain(`--schema=workspace_${currentProjectId} `)
  })

  // Production QA, 2026-11-27: the route asked the region's database for the
  // schema of a project whose data had moved to a database of its own, and
  // pg_dump found no such schema, for every project.
  it("is the project's own, on its region's data instance, once it has one", async () => {
    await prisma.project.update({
      where: { id: currentProjectId },
      data: { databaseTenancy: 'dedicated', databaseName: OWN_DATABASE, databaseInstance: 'primary', tenancyEpoch: { increment: 1 } },
    })
    forgetProjectDatabase(currentProjectId)

    standIn('', 0, '', { args: true })
    for (const mode of ['full', 'schema', 'data']) {
      const res = await callExport(mode)
      expect(res.status).toBe(200)
      expect(res.text).toContain(`--host ${DATA_HOST} `)
      expect(res.text).toContain(`--dbname ${OWN_DATABASE} `)
      expect(res.text).toContain(`--schema=workspace_${currentProjectId} `)
      expect(res.text).not.toContain(HOST)
      expect(res.text).not.toContain('--dbname backenly')
    }
  })
})

describe('a dump is whole or it is not handed over', () => {
  afterEach(async () => {
    EXPORT_LIMITS.answerWithinMs = answerWithinMs
    await until(() => activeExports() === 0, 'no export is left running')
  })

  it('gives the length of a finished dump, which ends with the line that says it is whole', async () => {
    standIn('', 0, 'CREATE TABLE public.kept (id integer);\n')
    const req = new NextRequest(`http://localhost/api/projects/${currentProjectId}/export/database?mode=schema`)
    const res = await exportGET(req)
    const body = Buffer.from(await res.arrayBuffer())
    expect(res.status).toBe(200)
    expect(res.headers.get('content-length')).toBe(String(body.length))
    expect(body.toString('utf8').trimEnd().endsWith(EXPORT_COMPLETE_LINE)).toBe(true)
  })

  it('refuses a dump that failed, with nothing of it in the answer, however much pg_dump had written', async () => {
    standIn('pg_dump: error: query failed: ERROR:  canceling statement due to conflict with recovery', 1, 'CREATE TABLE public.half (id integer);\n')
    const res = await callExport()
    expect(res.status).toBe(503)
    expect(res.json?.code).toBe('EXPORT_FAILED')
    expect(res.text).not.toContain('CREATE TABLE')
    expect(res.text).not.toContain(EXPORT_COMPLETE_LINE)
  })

  // A dump still running after the wait begins to download, so that a proxy
  // does not give up on it. If pg_dump fails after that, the body fails: the
  // server cuts the connection, and no client is left with a whole-looking file.
  it('cuts the download short when pg_dump fails after it began', async () => {
    EXPORT_LIMITS.answerWithinMs = 200
    standIn(
      'pg_dump: error: query failed: ERROR:  canceling statement due to conflict with recovery',
      1,
      'CREATE TABLE public.half (id integer);\n',
      { sleep: 2 },
    )
    const req = new NextRequest(`http://localhost/api/projects/${currentProjectId}/export/database`)
    const res = await exportGET(req)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-length')).toBeNull()
    // The body fails with the export's own error, or with one that carries it.
    const failure = await res.text().then(
      () => null,
      (err: { code?: string; cause?: { code?: string } }) => err,
    )
    expect(failure).not.toBeNull()
    expect([failure?.code, failure?.cause?.code]).toContain('EXPORT_INTERRUPTED')
  })

  it('hands over a dump that finishes after its download began, whole', async () => {
    EXPORT_LIMITS.answerWithinMs = 200
    standIn('', 0, 'CREATE TABLE public.kept (id integer);\n', { sleep: 1 })
    const req = new NextRequest(`http://localhost/api/projects/${currentProjectId}/export/database`)
    const res = await exportGET(req)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-length')).toBeNull()
    const text = await res.text()
    expect(text).toContain('CREATE TABLE public.kept')
    expect(text.trimEnd().endsWith(EXPORT_COMPLETE_LINE)).toBe(true)
  })

  it('makes one backup of a project at a time', async () => {
    standIn('', 0, 'CREATE TABLE public.kept (id integer);\n', { sleep: 1 })
    const first = callExport()
    await until(() => activeExports() === 1, 'the first export is running')

    const second = await callExport('full', { settle: false })
    expect(second.status).toBe(429)
    expect(second.json).toEqual({
      code: 'EXPORT_BUSY',
      error: 'Nothing was exported: another backup of this project is still being made. Try again when it has finished.',
    })
    expect((await first).status).toBe(200)
  })

  it('stops pg_dump when whoever asked has gone', async () => {
    standIn('', 0, 'CREATE TABLE public.kept (id integer);\n', { sleep: 5 })
    const gone = new AbortController()
    const req = new NextRequest(`http://localhost/api/projects/${currentProjectId}/export/database`, { signal: gone.signal })
    const answer = exportGET(req)
    await until(() => activeExports() === 1, 'the export is running')
    gone.abort()
    const res = await answer
    expect(res.status).toBe(503)
    expect((await res.json()).code).toBe('EXPORT_CANCELLED')
    expect(activeExports()).toBe(0)
  })
})
