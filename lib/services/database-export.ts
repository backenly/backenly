/**
 * A DATABASE EXPORT, HELD ON DISK WHILE IT IS MADE
 * ================================================
 * The export route (app/api/projects/[id]/export/database/route.ts) answers
 * with a whole pg_dump or with a refusal that says why, never with part of one.
 * It used to keep that promise by holding the dump in memory until pg_dump
 * exited: once as the chunks pg_dump wrote, again joined, again rewritten for
 * portable policies, again behind its header. A 240 MB data export took the
 * only web task in its region down (production QA, 2026-11-21).
 *
 * Here pg_dump writes to a file and the answer is read back from that file, so
 * the memory an export takes does not grow with the database.
 *
 *   - pg_dump runs at its own speed whatever the speed of the download. Piped
 *     straight to the response, a slow client would hold pg_dump's transaction,
 *     and its lock on every table, open for as long as the download took.
 *   - The file can be read while it is still being written (`read`), so a dump
 *     that takes longer than a proxy waits for a first byte can begin
 *     downloading before pg_dump has finished. If pg_dump then fails, the
 *     reader fails with it: it never ends as though the dump were whole.
 *   - One export of a project at a time and a few in the process, because each
 *     takes a database connection, a pg_dump process and disk.
 *   - The disk is not filled: past the first SPACE_CHECK_EVERY bytes the export
 *     stops while KEEP_FREE bytes are still free for everything else that
 *     writes there (snapshots take their dumps on the same disk).
 *   - The file goes when the download ends, is cancelled or fails, and a file
 *     left by a process that died is removed by a later export.
 *
 * Paths here are made at runtime and absent when Next builds; the filesystem
 * calls carry turbopackIgnore for the reason given in workspace-backup.ts.
 */

import { spawn, type ChildProcess } from 'child_process'
import { randomBytes } from 'crypto'
import { EventEmitter, once } from 'events'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { Readable, Writable, type Transform } from 'stream'
import { pipeline } from 'stream/promises'

const MIB = 1024 * 1024

export interface ExportLimits {
  /**
   * How long the route waits for pg_dump to finish before it starts the
   * download anyway. Inside it, a failure is a refusal with its reason and a
   * success carries its length. It is shorter than the 60 seconds load
   * balancers and proxies commonly wait for a first byte.
   */
  answerWithinMs: number
  /**
   * How long pg_dump waits for a table another session has locked, as it
   * starts. Shorter than answerWithinMs, so a schema change in flight is a
   * refusal that says so, never a download that begins and then stalls.
   */
  lockWaitMs: number
  /** How long pg_dump may take to connect, in seconds, for the same reason. */
  connectWithinSeconds: number
  /** How long pg_dump may run. */
  dumpWithinMs: number
  /** How long an export may exist, its download included. */
  lifetimeMs: number
  /** Exports this process makes at once. */
  atOnce: number
  /** Free disk space an export leaves for everything else. */
  keepFreeBytes: number
  /** The free space is read each time this much more has been written. */
  spaceCheckEveryBytes: number
  /** Free bytes on the disk holding `dir`. */
  freeBytes: (dir: string) => Promise<number>
  /** Where the files are written. */
  dir: string
}

export const EXPORT_LIMITS: ExportLimits = {
  answerWithinMs: 30_000,
  lockWaitMs: 15_000,
  connectWithinSeconds: 10,
  dumpWithinMs: 30 * 60_000,
  lifetimeMs: 2 * 60 * 60_000,
  atOnce: 2,
  keepFreeBytes: 1024 * MIB,
  spaceCheckEveryBytes: 64 * MIB,
  freeBytes: async (dir) => {
    const stat = await fs.promises.statfs(/*turbopackIgnore: true*/ dir)
    return stat.bavail * stat.bsize
  },
  dir: path.join(/*turbopackIgnore: true*/ os.tmpdir(), 'backenly-export'),
}

/** How much of pg_dump's stderr is kept for naming the cause. */
const STDERR_KEPT = 16_384
/** The most a reader takes from the file at once. */
const READ_CHUNK = 256 * 1024
/** A file older than an export may live, by this margin, belongs to a process that died. */
const ABANDONED_MARGIN_MS = 10 * 60_000
/** How long a pg_dump that was asked to stop is given before it is killed outright. */
const KILL_AFTER_MS = 5_000

export interface ExportRequest {
  projectId: string
  /** pg_dump's arguments: the connection (buildConnection) and what to dump. */
  args: string[]
  /** pg_dump's environment (buildConnection), which carries the password. */
  env: NodeJS.ProcessEnv
  /** Written to the file before pg_dump's output. */
  header?: string
  /** Written after pg_dump's output, only when pg_dump exited 0. */
  trailer?: string
  /** What the dump passes through on its way to the file. */
  through?: Transform
  /** The program run: pg_dump, unless a test stands another in. */
  command?: string
}

/**
 * Why an export did not finish:
 *   pg_dump    it exited non-zero or could not be started (`stderr`, `exitCode`)
 *   no_space   the disk could not hold the dump and keep its free space
 *   time       pg_dump ran longer than it may
 *   cancelled  the export was discarded while pg_dump was running
 *   spool      the file could not be written (`detail`)
 */
export type ExportFailureReason = 'pg_dump' | 'no_space' | 'time' | 'cancelled' | 'spool'

export type ExportOutcome =
  | { ok: true; bytes: number }
  | {
      ok: false
      reason: ExportFailureReason
      /** What pg_dump wrote to stderr, cut to STDERR_KEPT. */
      stderr: string
      /** pg_dump's exit code; null when it was not started or a signal ended it. */
      exitCode: number | null
      /** False when pg_dump could not be started at all. */
      started: boolean
      /** For `spool`: what went wrong writing the file. */
      detail?: string
    }

/** What a reader of an export fails with when the export did not finish. */
export class ExportInterruptedError extends Error {
  readonly code = 'EXPORT_INTERRUPTED'

  constructor(readonly reason: ExportFailureReason) {
    super(`The database export did not finish (${reason}), so the download was stopped.`)
    this.name = 'ExportInterruptedError'
  }
}

export interface DatabaseExport {
  /** Settles once pg_dump has exited and all it wrote is in the file. Never rejects. */
  readonly finished: Promise<ExportOutcome>
  /**
   * The export from its first byte, read from the file while it is written.
   * It ends when a finished export has been read to its end, and fails with
   * ExportInterruptedError when the export fails or is discarded.
   */
  read(): Readable
  /** Stops pg_dump if it is running and removes the file. Safe to call again. */
  discard(): Promise<void>
}

export type ExportStart =
  | { started: true; export: DatabaseExport }
  | { started: false; reason: 'project_busy' | 'server_busy' }

/** The exports this process is making or still serving, by project. */
const active = new Map<string, Spool>()

/**
 * Start an export of a project, or say why one cannot start now. The caller
 * owns what is returned and must `discard` it: when its download ends, when the
 * client goes away, and when it answers with anything else.
 */
export function startDatabaseExport(request: ExportRequest, overrides: Partial<ExportLimits> = {}): ExportStart {
  const limits = { ...EXPORT_LIMITS, ...overrides }
  if (active.has(request.projectId)) return { started: false, reason: 'project_busy' }
  if (active.size >= limits.atOnce) return { started: false, reason: 'server_busy' }
  const spool = new Spool(request, limits)
  active.set(request.projectId, spool)
  return { started: true, export: spool }
}

/** How many exports this process is making or serving. */
export function activeExports(): number {
  return active.size
}

class Spool implements DatabaseExport {
  readonly finished: Promise<ExportOutcome>
  readonly file: string

  private written = 0
  private state: 'running' | 'done' | 'failed' = 'running'
  private failure: ExportInterruptedError | null = null
  /** Emits 'change' when more has been written and when the export settles. */
  private readonly changes = new EventEmitter()
  private child: ChildProcess | null = null
  private stopped: 'no_space' | 'time' | 'cancelled' | null = null
  private nextSpaceCheck: number
  private readonly readers = new Map<Readable, Promise<void>>()
  private discarding: Promise<void> | null = null
  private readonly dumpTimer: NodeJS.Timeout
  private readonly lifeTimer: NodeJS.Timeout

  constructor(
    private readonly request: ExportRequest,
    private readonly limits: ExportLimits,
  ) {
    // Any number of readers may wait on one export.
    this.changes.setMaxListeners(0)
    const name = `${request.projectId.replace(/[^a-zA-Z0-9_-]/g, '_')}-${randomBytes(6).toString('hex')}.sql`
    this.file = path.join(/*turbopackIgnore: true*/ limits.dir, name)
    this.nextSpaceCheck = limits.spaceCheckEveryBytes
    this.dumpTimer = setTimeout(() => this.stop('time'), limits.dumpWithinMs)
    this.lifeTimer = setTimeout(() => void this.discard(), limits.lifetimeMs)
    this.dumpTimer.unref()
    this.lifeTimer.unref()
    this.finished = this.run()
  }

  read(): Readable {
    const spool = this
    const waiting = new AbortController()
    let handle: fs.promises.FileHandle | null = null
    let offset = 0

    const stream = new Readable({
      highWaterMark: READ_CHUNK,
      read(size) {
        void (async () => {
          try {
            for (;;) {
              if (offset < spool.written) {
                if (!handle) {
                  const opened = await fs.promises.open(/*turbopackIgnore: true*/ spool.file, 'r')
                  // Destroyed while it opened: destroy saw no handle to close.
                  if (this.destroyed) {
                    await opened.close().catch(() => {})
                    return
                  }
                  handle = opened
                }
                const want = Math.min(Math.max(size, 1), READ_CHUNK, spool.written - offset)
                const chunk = Buffer.allocUnsafe(want)
                const { bytesRead } = await handle.read(chunk, 0, want, offset)
                if (this.destroyed) return
                if (bytesRead === 0) throw new Error('The export file is shorter than what was written to it.')
                // Before the push: a push can ask for the next chunk at once.
                offset += bytesRead
                this.push(bytesRead === want ? chunk : chunk.subarray(0, bytesRead))
                return
              }
              if (spool.state === 'done') {
                this.push(null)
                return
              }
              if (spool.state === 'failed') {
                this.destroy(spool.failure ?? new ExportInterruptedError('spool'))
                return
              }
              // No await between the checks above and this listener: a write
              // or a settle in between cannot be missed.
              await once(spool.changes, 'change', { signal: waiting.signal })
            }
          } catch (err) {
            if (!waiting.signal.aborted) this.destroy(err as Error)
          }
        })()
      },
      destroy(err, done) {
        waiting.abort()
        const open = handle
        handle = null
        // close() waits for a read in flight on the handle.
        void (open ? open.close().catch(() => {}) : Promise.resolve()).then(() => done(err))
      },
    })

    this.readers.set(
      stream,
      new Promise<void>((resolve) => {
        stream.once('close', () => {
          this.readers.delete(stream)
          resolve()
        })
      }),
    )
    return stream
  }

  discard(): Promise<void> {
    if (this.discarding) return this.discarding
    // The project may be exported again from here on: all that is left of this
    // one is stopping pg_dump and removing its file.
    if (active.get(this.request.projectId) === this) active.delete(this.request.projectId)
    this.discarding = (async () => {
      clearTimeout(this.lifeTimer)
      this.stop('cancelled')
      // The writer has let go of the file once this settles.
      await this.finished
      const closing = [...this.readers.values()]
      for (const reader of this.readers.keys()) {
        if (!reader.destroyed) reader.destroy(this.failure ?? new ExportInterruptedError('cancelled'))
      }
      // An open file cannot be removed on every platform.
      await Promise.all(closing)
      await fs.promises.rm(/*turbopackIgnore: true*/ this.file, { force: true }).catch(() => {})
    })()
    return this.discarding
  }

  /** Stop pg_dump, remembering the first reason. Nothing to do once it has exited. */
  private stop(reason: 'no_space' | 'time' | 'cancelled'): void {
    if (this.state !== 'running') return
    this.stopped ??= reason
    const child = this.child
    if (!child) return
    child.kill()
    // Its output is not waited for: a process it started can outlive it and
    // hold the pipe open.
    child.stdout?.destroy()
    // One that does not stop when asked is not asked twice.
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }, KILL_AFTER_MS).unref()
  }

  private settle(state: 'done' | 'failed', reason?: ExportFailureReason): void {
    clearTimeout(this.dumpTimer)
    if (state === 'failed') this.failure = new ExportInterruptedError(reason ?? 'spool')
    this.state = state
    this.changes.emit('change')
  }

  private async append(handle: fs.promises.FileHandle, data: Buffer): Promise<void> {
    // write() may take less than it was given.
    for (let done = 0; done < data.length; ) {
      done += (await handle.write(data, done, data.length - done)).bytesWritten
    }
    this.written += data.length
    this.changes.emit('change')
  }

  /** Stops the export when writing more would take the disk's last free space. */
  private async leaveRoom(): Promise<void> {
    if (this.written < this.nextSpaceCheck) return
    this.nextSpaceCheck = this.written + this.limits.spaceCheckEveryBytes
    // Free space that cannot be read is not a reason to refuse an export.
    const free = await this.limits.freeBytes(this.limits.dir).catch(() => Infinity)
    if (free < this.limits.keepFreeBytes) {
      this.stop('no_space')
      throw new Error('The disk holding database exports is nearly full.')
    }
  }

  private async run(): Promise<ExportOutcome> {
    const { request, limits } = this
    let handle: fs.promises.FileHandle | null = null
    let stderr = ''
    let exitCode: number | null = null
    /** How far the export got: making its file, starting pg_dump, or taking its output. */
    let phase: 'file' | 'spawn' | 'dump' = 'file'
    /** False when pg_dump could not be started. */
    let started = false
    /** A fault writing the file, met while pg_dump was still running. */
    let wroteBadly = false
    let fault: unknown = null

    try {
      await fs.promises.mkdir(/*turbopackIgnore: true*/ limits.dir, { recursive: true })
      void sweepAbandoned(limits)
      // wx: the name is this export's alone. 0600: it holds every row.
      handle = await fs.promises.open(/*turbopackIgnore: true*/ this.file, 'wx', 0o600)
      const file = handle
      if (request.header) await this.append(file, Buffer.from(request.header, 'utf8'))

      if (!this.stopped) {
        phase = 'spawn'
        const child = spawn(request.command ?? 'pg_dump', request.args, {
          stdio: ['ignore', 'pipe', 'pipe'],
          env: request.env,
        })
        phase = 'dump'
        started = true
        this.child = child
        child.stderr!.on('data', (d: Buffer) => {
          if (stderr.length < STDERR_KEPT) stderr += d.toString('utf8')
        })
        const exited = new Promise<number | null>((resolve) => {
          // 'error' alone when it could not be started; 'close' once it has
          // exited and its output has been read to the end.
          child.once('error', () => {
            started = false
            resolve(null)
          })
          child.once('close', (code) => resolve(code))
        })
        const sink = new Writable({
          highWaterMark: MIB,
          write: (chunk: Buffer | string, _encoding, done) => {
            const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
            this.append(file, data).then(() => this.leaveRoom()).then(() => done(), done)
          },
        })
        const streams = request.through ? [child.stdout!, request.through, sink] : [child.stdout!, sink]
        const piped = pipeline(streams).then(
          () => null,
          (err: unknown) => {
            // Nothing reads pg_dump's output any more, so it is stopped. Had it
            // already exited, the fault is its own and its exit code says so.
            wroteBadly = child.exitCode === null && child.signalCode === null
            child.kill()
            return err ?? new Error('The export could not be written.')
          },
        )
        const [code, pipeFault] = await Promise.all([exited, piped])
        exitCode = code
        fault = pipeFault
      }

      if (exitCode === 0 && !fault && !this.stopped) {
        if (request.trailer) await this.append(file, Buffer.from(request.trailer, 'utf8'))
        handle = null
        await file.close()
        this.settle('done')
        return { ok: true, bytes: this.written }
      }
    } catch (err) {
      fault = err
    } finally {
      await handle?.close().catch(() => {})
    }

    // Why it was stopped comes first: a pg_dump that was killed also exits
    // non-zero and breaks the pipe. Then a full disk. Then a fault of this
    // file's own: making the file, or writing to it while a started pg_dump
    // was still running or after it exited 0. Anything else is pg_dump's: it
    // exited non-zero, or it never started.
    const outOfSpace = (fault as NodeJS.ErrnoException | null)?.code === 'ENOSPC'
    const ownFault = fault !== null && (phase === 'file' || (phase === 'dump' && started && (wroteBadly || exitCode === 0)))
    const reason: ExportFailureReason = this.stopped ?? (outOfSpace ? 'no_space' : ownFault ? 'spool' : 'pg_dump')
    this.settle('failed', reason)
    return {
      ok: false,
      reason,
      stderr,
      exitCode,
      started,
      ...(reason === 'spool' ? { detail: fault instanceof Error ? fault.message : String(fault) } : {}),
    }
  }
}

/**
 * Remove export files no live export can own: older than an export may live.
 * A process that died mid-export leaves its file, and where the disk outlives
 * the process (a self-hosted server under a process manager) nothing else
 * would ever remove it. Age, not ownership, decides: another process on the
 * same disk may be serving one of these right now.
 */
async function sweepAbandoned(limits: ExportLimits): Promise<void> {
  try {
    const cutoff = Date.now() - limits.lifetimeMs - ABANDONED_MARGIN_MS
    for (const name of await fs.promises.readdir(/*turbopackIgnore: true*/ limits.dir)) {
      if (!name.endsWith('.sql')) continue
      const file = path.join(/*turbopackIgnore: true*/ limits.dir, name)
      const stat = await fs.promises.stat(/*turbopackIgnore: true*/ file).catch(() => null)
      if (stat && stat.mtimeMs < cutoff) await fs.promises.rm(/*turbopackIgnore: true*/ file, { force: true }).catch(() => {})
    }
  } catch {
    // Best effort: never a reason an export fails.
  }
}
