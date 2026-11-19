/**
 * The sandbox task's side of lib/import/worker/protocol.ts: calls to the
 * control plane, and the destinations a driver writes through when it runs in
 * the sandbox (lib/import/destination.ts). Nothing here holds or reaches any
 * Backenly resource; everything goes to the control plane, which checks it.
 */

import { gzipSync } from 'zlib'
import type { BucketTarget, FileUpload, FirebaseDestination, ImportDestinations, PgDestination, UploadOutcome } from '../destination'
import { ROOM_REFUSED } from '../destination'
import { ImportInputError } from '../driver'
import type { ImportedUser } from '../drivers/firebase-users'
import {
  HEADER_BUCKET,
  HEADER_FILE_NAME,
  HEADER_FILE_TYPE,
  HEADER_JOB,
  HEADER_TASK,
  type DestinationOp,
  type WorkerAction,
} from './protocol'

/** The control plane said no, or could not be reached. */
export class ControlPlaneError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
    readonly field?: string,
  ) {
    super(message)
    this.name = 'ControlPlaneError'
  }
}

/** Calls that change nothing, or that the control plane applies only once, and so may be sent again. */
const RETRIED_ACTIONS = new Set<WorkerAction>(['spec', 'checked', 'next', 'progress'])
const RETRIED_OPS = new Set<DestinationOp>(['pg.measure', 'pg.countRows', 'fb.countRows', 'fb.measureRows', 'fb.countImportedUsers'])

export interface ControlPlaneOptions {
  /** https://backenly.com, or the environment's own origin. */
  origin: string
  jobId: string
  token: string
  /** The ECS task this runs in, when it runs in one. */
  taskArn: string | null
  /** For the tests. */
  fetchImpl?: typeof fetch
}

export class ControlPlane {
  constructor(private readonly opts: ControlPlaneOptions) {
    const origin = new URL(opts.origin)
    if (origin.protocol !== 'https:' && !['127.0.0.1', 'localhost'].includes(origin.hostname)) {
      throw new Error('The control plane must be reached over https.')
    }
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      authorization: `Bearer ${this.opts.token}`,
      [HEADER_JOB]: this.opts.jobId,
      ...(this.opts.taskArn ? { [HEADER_TASK]: this.opts.taskArn } : {}),
      ...extra,
    }
  }

  /** One JSON call. Every body is gzip-encoded, so no proxy reads row text as anything but bytes. */
  async call<T = Record<string, unknown>>(action: WorkerAction, body: unknown = {}, opts: { timeoutMs?: number; retry?: boolean } = {}): Promise<T> {
    const payload = gzipSync(Buffer.from(JSON.stringify(body ?? {})))
    const attempts = (opts.retry ?? RETRIED_ACTIONS.has(action)) ? 4 : 1
    let lastError: unknown
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 1_000 * 2 ** (attempt - 1)))
      try {
        return await this.send<T>(action, payload, { 'content-type': 'application/json', 'content-encoding': 'gzip' }, opts.timeoutMs ?? 60_000)
      } catch (err) {
        lastError = err
        // Only a call that never reached a decision is sent again.
        if (err instanceof ControlPlaneError && err.status > 0 && err.status < 500) throw err
      }
    }
    throw lastError
  }

  /** A destination op; long ones keep the connection alive with spaces until they answer (worker-api.ts). */
  op<T = unknown>(op: DestinationOp, args: unknown): Promise<T> {
    return this.call<{ result: T }>('op', { op, args }, { timeoutMs: 15 * 60_000, retry: RETRIED_OPS.has(op) }).then((r) => r.result)
  }

  async upload(bucketId: string, file: FileUpload): Promise<UploadOutcome> {
    const r = await this.send<{ outcome: UploadOutcome }>(
      'file',
      file.buffer,
      {
        'content-type': 'application/octet-stream',
        [HEADER_BUCKET]: bucketId,
        [HEADER_FILE_NAME]: Buffer.from(file.name, 'utf8').toString('base64url'),
        ...(file.mimeType ? { [HEADER_FILE_TYPE]: file.mimeType.slice(0, 200) } : {}),
      },
      10 * 60_000,
    )
    return r.outcome
  }

  private async send<T>(action: WorkerAction, body: Buffer, headers: Record<string, string>, timeoutMs: number): Promise<T> {
    const fetchImpl = this.opts.fetchImpl ?? fetch
    let res: Response
    try {
      res = await fetchImpl(new URL(`/api/import/worker/${action}`, this.opts.origin), {
        method: 'POST',
        headers: this.headers(headers),
        // A Buffer is a Uint8Array, which fetch sends as is (no copy).
        body: body as unknown as BodyInit,
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'error',
      })
    } catch (err) {
      throw new ControlPlaneError(0, 'UNREACHABLE', `Backenly could not be reached (${(err as Error)?.name ?? 'network error'}).`)
    }
    // A streamed answer is spaces, then the JSON (worker-api.ts keepAlive).
    const text = (await res.text()).trim()
    let json: any = null
    try {
      json = text ? JSON.parse(text) : null
    } catch {
      json = null
    }
    const status = json && typeof json.status === 'number' ? json.status : res.status
    if (!res.ok || (json && json.ok === false)) {
      throw new ControlPlaneError(status, json?.code, typeof json?.error === 'string' ? json.error : `Backenly answered ${status}.`, json?.field)
    }
    return (json ?? {}) as T
  }
}

/** The room ran out where the control plane counted it: the import stops in the room's own words. */
function roomOrThrow(err: unknown): never {
  if (err instanceof ControlPlaneError && err.code === ROOM_REFUSED) throw new ImportInputError(err.message)
  throw err
}

export function remoteDestinations(api: ControlPlane): ImportDestinations {
  let pg: PgDestination | undefined
  let firebase: FirebaseDestination | undefined
  return {
    pg: () => (pg ??= remotePg(api)),
    firebase: () => (firebase ??= remoteFirebase(api)),
  }
}

function remotePg(api: ControlPlane): PgDestination {
  return {
    async createTables(tables, opts) {
      await api.op('pg.createTables', { tables, title: opts.title, usersTable: opts.usersTable })
    },
    async measure() {
      return Number((await api.op<{ bytes: number }>('pg.measure', {})).bytes) || 0
    },
    async insertRows(table, columns, rows) {
      return api.op<{ written: number }>('pg.insertRows', { table, columns, rows }).then((r) => r.written, roomOrThrow)
    },
    async insertUsers(users) {
      return api.op<{ written: number }>('pg.insertUsers', { users }).then((r) => r.written, roomOrThrow)
    },
    async countRows(tables) {
      const r = await api.op<{ counts: Record<string, number> }>('pg.countRows', { tables })
      return new Map(Object.entries(r.counts ?? {}).map(([k, v]) => [k, Number(v) || 0]))
    },
    async finishSchema(input) {
      const r = await api.op<{ warnings: string[]; targets: Record<string, BucketTarget> | null }>('pg.finishSchema', input)
      return { warnings: r.warnings ?? [], targets: r.targets ? new Map(Object.entries(r.targets)) : null }
    },
    uploadFile: (bucketId, file) => api.upload(bucketId, file),
    async recordRules(proposals, opts) {
      return Number((await api.op<{ pending: number }>('pg.recordRules', { proposals, sourceLabel: opts.sourceLabel })).pending) || 0
    },
  }
}

function remoteFirebase(api: ControlPlane): FirebaseDestination {
  return {
    async createTables(plans, title) {
      // Only what CREATE_TABLE needs: the plan's Map and source notes stay here.
      const wire = plans.map((p) => ({
        name: p.name,
        parentTable: p.parentTable,
        createColumns: p.createColumns.map((c) => ({ name: c.name, type: c.type, ...(c.unique ? { unique: true } : {}) })),
      }))
      return (await api.op<{ unindexed: string[] }>('fb.createTables', { plans: wire, title })).unindexed ?? []
    },
    async addExtraColumn(table) {
      await api.op('fb.addExtraColumn', { table })
    },
    async insertRows(table, columns, rows) {
      const wire = columns.map((c) => ({ name: c.name, type: c.type, source: { kind: c.source.kind } }))
      return api.op<{ written: number }>('fb.insertRows', { table, columns: wire, rows }).then((r) => r.written, roomOrThrow)
    },
    async countRows(table) {
      return Number((await api.op<{ count: number }>('fb.countRows', { table })).count) || 0
    },
    async measureRows() {
      return Number((await api.op<{ bytes: number }>('fb.measureRows', {})).bytes) || 0
    },
    async prepareUsers() {
      await api.op('fb.prepareUsers', {})
    },
    async insertUsers(users: ImportedUser[]) {
      const wire = users.map((u) => ({
        ...u,
        createdAt: u.createdAt ? u.createdAt.toISOString() : null,
        lastLoginAt: u.lastLoginAt ? u.lastLoginAt.toISOString() : null,
      }))
      return api.op<{ written: number }>('fb.insertUsers', { users: wire }).then((r) => r.written, roomOrThrow)
    },
    async countImportedUsers() {
      return Number((await api.op<{ count: number }>('fb.countImportedUsers', {})).count) || 0
    },
    async prepareFilesBucket(maxFileBytes) {
      return (await api.op<{ bucketId: string }>('fb.prepareFilesBucket', { maxFileBytes })).bucketId
    },
    uploadFile: (bucketId, file) => api.upload(bucketId, file),
    async close() {},
  }
}
