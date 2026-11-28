/**
 * A DATABASE EXPORT IS HELD ON DISK, NOT IN MEMORY, AND IS WHOLE OR FAILED
 * ========================================================================
 * Production QA, 2026-11-21: the export route held a dump in memory about four
 * times over, and a 240 MB data export took the only web task in its region
 * down. lib/services/database-export.ts has pg_dump write to a file and the
 * answer read back from it.
 *
 * What is pinned here, with a real child process standing in for pg_dump (node
 * itself, so the suite runs wherever jest does):
 *   - the file is the header, pg_dump's output and the trailer, in that order;
 *   - a reader follows the file while pg_dump is still writing it;
 *   - a reader of an export that fails is failed, never ended as though whole;
 *   - one export of a project at a time, a limited number in the process;
 *   - the disk's last free space is left alone;
 *   - the file is gone once the export is discarded, however it ended.
 */

import fs from 'fs'
import os from 'os'
import path from 'path'
import { Transform, type Readable } from 'stream'
import {
  ExportInterruptedError,
  activeExports,
  startDatabaseExport,
  type DatabaseExport,
  type ExportLimits,
  type ExportRequest,
} from '@/lib/services/database-export'

let root = ''
let dir = ''
let flags = 0
const made: DatabaseExport[] = []

/** A file the stand-in waits for, so the test decides when it carries on. */
function flag(): string {
  return path.join(root, `go-${++flags}`)
}

/** JavaScript that calls `then` once `file` exists. */
const whenFlagged = (file: string, then: string) =>
  `const fs = require('fs'); (function wait() { fs.existsSync(${JSON.stringify(file)}) ? (${then}) : setTimeout(wait, 10) })()`

const FOREVER = 'setInterval(() => {}, 1000)'

function start(projectId: string, js: string, request: Partial<ExportRequest> = {}, limits: Partial<ExportLimits> = {}) {
  const started = startDatabaseExport(
    { projectId, command: process.execPath, args: ['-e', js], env: process.env, ...request },
    { dir, ...limits },
  )
  if (started.started) made.push(started.export)
  return started
}

function begun(projectId: string, js: string, request: Partial<ExportRequest> = {}, limits: Partial<ExportLimits> = {}): DatabaseExport {
  const started = start(projectId, js, request, limits)
  if (!started.started) throw new Error(`the export did not start: ${started.reason}`)
  return started.export
}

async function textOf(stream: Readable): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

const exportFiles = () => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => name.endsWith('.sql')) : [])

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'export-spool-'))
  dir = path.join(root, 'exports')
})

afterEach(async () => {
  await Promise.all(made.splice(0).map((e) => e.discard()))
  expect(activeExports()).toBe(0)
  fs.rmSync(root, { recursive: true, force: true })
})

it("is the header, pg_dump's output and the trailer, with its length", async () => {
  const dump = begun('p1', `process.stdout.write('CREATE TABLE kept (id integer);\\n')`, { header: '-- header\n', trailer: '-- done\n' })
  const expected = '-- header\nCREATE TABLE kept (id integer);\n-- done\n'

  expect(await dump.finished).toEqual({ ok: true, bytes: Buffer.byteLength(expected) })
  expect(await textOf(dump.read())).toBe(expected)
  // A second reader starts from the first byte too.
  expect(await textOf(dump.read())).toBe(expected)

  expect(exportFiles()).toHaveLength(1)
  await dump.discard()
  expect(exportFiles()).toEqual([])
})

it('is read while pg_dump is still writing it, every byte in order', async () => {
  const go = flag()
  const dump = begun(
    'p1',
    `process.stdout.write('a'.repeat(100000)); ${whenFlagged(go, `process.stdout.write('b'.repeat(100000))`)}`,
    { trailer: 'END' },
  )

  let settled = false
  void dump.finished.then(() => { settled = true })

  const reader = dump.read()
  let read = ''
  let largest = 0
  for await (const chunk of reader) {
    largest = Math.max(largest, (chunk as Buffer).length)
    if (read === '') {
      // The first bytes arrived while the stand-in is still waiting to write the rest.
      expect(settled).toBe(false)
      fs.writeFileSync(go, '')
    }
    read += (chunk as Buffer).toString('utf8')
  }

  expect(read).toBe('a'.repeat(100000) + 'b'.repeat(100000) + 'END')
  expect(largest).toBeLessThanOrEqual(256 * 1024)
  expect(await dump.finished).toEqual({ ok: true, bytes: 200003 })
})

it('fails its reader when pg_dump fails after writing, and never ends it', async () => {
  const go = flag()
  const dump = begun(
    'p1',
    `process.stdout.write('CREATE TABLE half'); ${whenFlagged(go, `(process.stderr.write('pg_dump: error: query failed'), process.exit(3))`)}`,
    { trailer: 'END' },
  )

  const reader = dump.read()
  let read = ''
  let ended = false
  reader.once('end', () => { ended = true })
  const failure = (async () => {
    for await (const chunk of reader) {
      read += (chunk as Buffer).toString('utf8')
      fs.writeFileSync(go, '')
    }
  })()

  await expect(failure).rejects.toBeInstanceOf(ExportInterruptedError)
  await expect(failure).rejects.toMatchObject({ code: 'EXPORT_INTERRUPTED', reason: 'pg_dump' })
  expect(ended).toBe(false)
  expect(read).toBe('CREATE TABLE half')
  expect(await dump.finished).toEqual({ ok: false, reason: 'pg_dump', stderr: 'pg_dump: error: query failed', exitCode: 3, started: true })

  // A reader that begins after the failure is failed too, having read what there was.
  await expect(textOf(dump.read())).rejects.toBeInstanceOf(ExportInterruptedError)
})

it('says pg_dump was not started when the program is not there', async () => {
  const dump = begun('p1', '', { command: path.join(root, 'no-such-program') })
  expect(await dump.finished).toMatchObject({ ok: false, reason: 'pg_dump', started: false, exitCode: null })
})

it('makes one export of a project at a time, and a limited number in the process', async () => {
  const limits = { atOnce: 2 }
  const first = begun('p1', FOREVER, {}, limits)
  expect(start('p1', FOREVER, {}, limits)).toEqual({ started: false, reason: 'project_busy' })
  begun('p2', FOREVER, {}, limits)
  expect(start('p3', FOREVER, {}, limits)).toEqual({ started: false, reason: 'server_busy' })
  expect(activeExports()).toBe(2)

  // The place is the project's again once its export is discarded, not before.
  await first.discard()
  expect(activeExports()).toBe(1)
  begun('p1', FOREVER, {}, limits)
})

it('holds its place until it is discarded, even after pg_dump has finished', async () => {
  const dump = begun('p1', `process.stdout.write('x')`)
  await dump.finished
  expect(start('p1', FOREVER)).toEqual({ started: false, reason: 'project_busy' })
  await dump.discard()
  await dump.discard()
  expect(activeExports()).toBe(0)
})

it('stops pg_dump and removes the file when it is discarded while running', async () => {
  const dump = begun('p1', `process.stdout.write('x'.repeat(5000)); ${FOREVER}`)
  const reader = dump.read()
  // Until the first bytes are in the file the stand-in has not started.
  await new Promise<void>((resolve) => reader.once('readable', () => resolve()))
  const cutShort = expect(textOf(reader)).rejects.toMatchObject({ reason: 'cancelled' })

  await dump.discard()
  expect(await dump.finished).toMatchObject({ ok: false, reason: 'cancelled' })
  await cutShort
  expect(exportFiles()).toEqual([])
})

it('removes the file when its reader is closed before the end', async () => {
  const dump = begun('p1', `process.stdout.write('x'.repeat(600000))`)
  await dump.finished
  const reader = dump.read()
  await new Promise<void>((resolve) => reader.once('readable', () => resolve()))
  reader.destroy()
  await new Promise<void>((resolve) => reader.once('close', () => resolve()))
  await dump.discard()
  expect(exportFiles()).toEqual([])
})

it("stops before it takes the disk's last free space", async () => {
  const asked: string[] = []
  const limits: Partial<ExportLimits> = {
    spaceCheckEveryBytes: 4096,
    keepFreeBytes: 1000,
    freeBytes: async (where) => {
      asked.push(where)
      return 999
    },
  }
  const dump = begun('p1', `process.stdout.write('x'.repeat(65536)); ${FOREVER}`, {}, limits)
  expect(await dump.finished).toMatchObject({ ok: false, reason: 'no_space', started: true })
  expect(asked).toEqual([dir])
  await expect(textOf(dump.read())).rejects.toMatchObject({ reason: 'no_space' })
})

it('does not measure the disk for a small export, or refuse one where it cannot be measured', async () => {
  const freeBytes = jest.fn(async () => 0)
  const small = begun('p1', `process.stdout.write('small')`, {}, { freeBytes })
  expect(await small.finished).toEqual({ ok: true, bytes: 5 })
  expect(freeBytes).not.toHaveBeenCalled()

  const unmeasured = begun(
    'p2',
    `process.stdout.write('x'.repeat(65536))`,
    {},
    { spaceCheckEveryBytes: 4096, freeBytes: async () => { throw new Error('statfs is not supported here') } },
  )
  expect(await unmeasured.finished).toEqual({ ok: true, bytes: 65536 })
})

it('stops a pg_dump that runs longer than it may', async () => {
  const dump = begun('p1', FOREVER, {}, { dumpWithinMs: 150 })
  expect(await dump.finished).toMatchObject({ ok: false, reason: 'time' })
})

it('is discarded when it has existed longer than an export may', async () => {
  const dump = begun('p1', `process.stdout.write('x')`, {}, { lifetimeMs: 150 })
  await dump.finished
  await new Promise((resolve) => setTimeout(resolve, 400))
  await dump.discard()
  expect(activeExports()).toBe(0)
  expect(exportFiles()).toEqual([])
})

it("passes pg_dump's output, and only that, through the transform it is given", async () => {
  const upper = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      done(null, chunk.toString('utf8').toUpperCase())
    },
  })
  const dump = begun('p1', `process.stdout.write('create policy p on t;\\n')`, { header: '-- header\n', trailer: '-- done\n', through: upper })
  expect(await textOf(dump.read())).toBe('-- header\nCREATE POLICY P ON T;\n-- done\n')
})

it('says the file could not be written when the transform fails, not that pg_dump did', async () => {
  const broken = new Transform({
    transform(_chunk, _encoding, done) {
      done(new Error('the rewrite failed'))
    },
  })
  const dump = begun('p1', `process.stdout.write('x'.repeat(1000)); ${FOREVER}`, { through: broken })
  expect(await dump.finished).toMatchObject({ ok: false, reason: 'spool', detail: 'the rewrite failed', started: true })
})

it('removes a file left by a process that died, and leaves one that may still be in use', async () => {
  fs.mkdirSync(dir, { recursive: true })
  const abandoned = path.join(dir, 'left-behind.sql')
  const recent = path.join(dir, 'in-use.sql')
  fs.writeFileSync(abandoned, 'rows')
  fs.writeFileSync(recent, 'rows')
  const longAgo = new Date(Date.now() - 24 * 60 * 60_000)
  fs.utimesSync(abandoned, longAgo, longAgo)

  const dump = begun('p1', `process.stdout.write('x')`)
  await dump.finished
  for (let i = 0; i < 100 && fs.existsSync(abandoned); i++) await new Promise((resolve) => setTimeout(resolve, 20))

  expect(fs.existsSync(abandoned)).toBe(false)
  expect(fs.existsSync(recent)).toBe(true)
})
