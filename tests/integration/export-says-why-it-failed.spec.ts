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

const HOST = 'workspace-db.internal.example'
const ADDRESS = '10.20.30.40'
const saved = { PATH: process.env.PATH, BACKUP_DATABASE_URL: process.env.BACKUP_DATABASE_URL }
let bin = ''
let ownerId = ''

/** The stand-in pg_dump writes STANDIN_STDERR to stderr and exits with STANDIN_EXIT. */
function standIn(stderr: string, exit: number, stdout = ''): void {
  process.env.STANDIN_STDERR = stderr
  process.env.STANDIN_STDOUT = stdout
  process.env.STANDIN_EXIT = String(exit)
}

async function callExport(mode = 'full') {
  const req = new NextRequest(`http://localhost/api/projects/${currentProjectId}/export/database?mode=${mode}`)
  const res = await exportGET(req)
  const text = await res.text()
  return { status: res.status, text, json: (() => { try { return JSON.parse(text) } catch { return null } })() }
}

beforeAll(async () => {
  if (process.env.NODE_ENV !== 'test') throw new Error('Refusing: NODE_ENV is not test')
  bin = fs.mkdtempSync(path.join(os.tmpdir(), 'standin-pg-dump-'))
  fs.writeFileSync(
    path.join(bin, 'pg_dump'),
    '#!/bin/sh\nprintf "%s" "$STANDIN_STDOUT"\nprintf "%s\\n" "$STANDIN_STDERR" >&2\nexit "$STANDIN_EXIT"\n',
  )
  fs.chmodSync(path.join(bin, 'pg_dump'), 0o755)
  process.env.PATH = `${bin}${path.delimiter}${saved.PATH ?? ''}`
  process.env.BACKUP_DATABASE_URL = `postgresql://backenly_backup:not-a-real-password@${HOST}:5432/backenly?sslmode=require`

  ownerId = (await prisma.user.create({ data: { email: `export-why-${randomUUID()}@test.invalid`, name: 'export' }, select: { id: true } })).id
  currentProjectId = (await prisma.project.create({ data: { name: 'export-why', userId: ownerId }, select: { id: true } })).id
})

afterAll(async () => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  delete process.env.STANDIN_STDERR
  delete process.env.STANDIN_STDOUT
  delete process.env.STANDIN_EXIT
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
