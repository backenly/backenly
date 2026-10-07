/**
 * The usage ledger: every metered quantity is recorded here, and nowhere else.
 *
 * ── Guarantees ──────────────────────────────────────────────────────────────
 *
 *  • Recording never blocks or fails a request. `recordUsage` only adds to an
 *    in-process accumulator.
 *  • Nothing is counted twice. Each flush seals the accumulator into a batch
 *    with its own id, and the batch is applied in ONE transaction that first
 *    inserts that id into usage_applied_batches. A retry after an ambiguous
 *    failure (the commit landed, the acknowledgement did not) or a replay of a
 *    spooled batch finds the id already there and applies nothing.
 *  • Nothing is silently dropped. A batch that fails to apply stays queued and
 *    is retried on the next tick; it is never discarded. On SIGTERM every
 *    unconfirmed batch is first written SYNCHRONOUSLY to the spool directory,
 *    then flushed; a spool file left behind by an exit that came first is
 *    replayed, idempotently, the next time a ledger starts.
 *
 * The one bounded loss: a process killed without a signal (SIGKILL, OOM) loses
 * what it accumulated since its last flush, at most FLUSH_MS of events. That
 * errs in the customer's favour, and is the price of never putting the
 * database on the request path.
 *
 * ── Attribution ─────────────────────────────────────────────────────────────
 *
 * A row belongs to the project's billing account (lib/usage/account.ts): its
 * organization on Cloud, its owning user where there are no organizations. The
 * account is resolved when the batch is applied, unless the caller already
 * knew it. Usage for a project that no longer exists and whose account was
 * never seen is dropped with a log line, in the customer's favour, rather than
 * attributed to a guess.
 */

import { randomUUID } from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { prisma } from '@/lib/db/prisma'
import {
  USAGE_AXES,
  isUsageAxis,
  isUsageSource,
  utcDay,
  type UsageAxisName,
  type UsageSource,
} from './axes'

export const FLUSH_MS = 5_000
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const GAUGE_AXES = Object.entries(USAGE_AXES)
  .filter(([, a]) => a.kind === 'gauge')
  .map(([name]) => name)

export interface UsageEvent {
  projectId: string
  axis: UsageAxisName
  quantity: number | bigint
  source: UsageSource
  /** When the usage happened; defaults to now. Only its UTC day is kept. */
  at?: Date
  /** The billing account, when the caller already knows it (saves a lookup). */
  billingAccountId?: string | null
}

export interface LedgerEntry {
  projectId: string
  axis: UsageAxisName
  /** YYYY-MM-DD, UTC. */
  day: string
  source: UsageSource
  quantity: bigint
  billingAccountId: string | null
}

export interface LedgerBatch {
  id: string
  kind: 'flush' | 'spool' | 'log'
  entries: LedgerEntry[]
}

export interface ApplyResult {
  applied: boolean // false = this batch id had already been applied
  rows: number
  skipped: number // entries with no attributable billing account
}

type Db = Pick<typeof prisma, '$transaction'>

function isGauge(axis: string): boolean {
  return GAUGE_AXES.includes(axis)
}

function toBig(q: number | bigint): bigint | null {
  if (typeof q === 'bigint') return q
  if (!Number.isFinite(q)) return null
  return BigInt(Math.trunc(q))
}

/**
 * Apply one batch exactly once. Exported for the access-log ingester, whose
 * batch id is the log object key.
 */
export async function applyUsageBatch(batch: LedgerBatch, db: Db = prisma): Promise<ApplyResult> {
  if (batch.entries.length === 0) return { applied: false, rows: 0, skipped: 0 }
  return db.$transaction(
    async (tx) => {
      const claimed = await tx.$executeRaw`
        INSERT INTO "usage_applied_batches" ("id", "kind", "entries")
        VALUES (${batch.id}, ${batch.kind}, ${batch.entries.length})
        ON CONFLICT ("id") DO NOTHING`
      if (claimed === 0) return { applied: false, rows: 0, skipped: 0 }

      const unknown = Array.from(
        new Set(batch.entries.filter((e) => !e.billingAccountId).map((e) => e.projectId)),
      )
      const owners = new Map<string, string>()
      if (unknown.length > 0) {
        const found = await tx.$queryRaw<Array<{ id: string; account: string | null }>>`
          SELECT "id", COALESCE("organizationId", "userId") AS "account" FROM "projects" WHERE "id" = ANY(${unknown}::text[])`
        for (const row of found) if (row.account) owners.set(row.id, row.account)
      }

      let rows = 0
      let skipped = 0
      for (const e of batch.entries) {
        const account = e.billingAccountId || owners.get(e.projectId) || null
        if (!account) {
          skipped++
          continue
        }
        await tx.$executeRaw`
          INSERT INTO "usage_daily"
            ("id", "billingAccountId", "projectId", "axis", "day", "quantity", "source", "updatedAt")
          VALUES
            (${randomUUID()}, ${account}, ${e.projectId}, ${e.axis}, ${e.day}::date, ${e.quantity}, ${e.source}, now())
          ON CONFLICT ("projectId", "axis", "day", "source") DO UPDATE SET
            "quantity" = CASE
              WHEN EXCLUDED."axis" = ANY(${GAUGE_AXES}::text[])
                THEN GREATEST("usage_daily"."quantity", EXCLUDED."quantity")
              ELSE "usage_daily"."quantity" + EXCLUDED."quantity"
            END,
            "updatedAt" = now()`
        rows++
      }
      if (skipped > 0) {
        console.warn(`[UsageLedger] batch ${batch.id}: ${skipped} entr${skipped === 1 ? 'y' : 'ies'} had no billing account (project gone, owner unknown); not billed`)
      }
      return { applied: true, rows, skipped }
    },
    { timeout: 30_000 },
  )
}

export interface UsageLedgerOptions {
  spoolDir?: string
  db?: Db
  flushMs?: number
  /** Start the periodic flush timer on first record (default true). */
  autoFlush?: boolean
}

export class UsageLedger {
  private pending = new Map<string, LedgerEntry>()
  private queue: LedgerBatch[] = []
  private timer: ReturnType<typeof setInterval> | null = null
  private inflight: Promise<void> | null = null
  private lastErrorLoggedAt = 0
  readonly spoolDir: string
  private readonly db: Db
  private readonly flushMs: number
  private readonly autoFlush: boolean

  constructor(opts: UsageLedgerOptions = {}) {
    this.spoolDir =
      opts.spoolDir ||
      process.env.USAGE_SPOOL_DIR ||
      path.join(os.tmpdir(), 'backenly-usage-spool')
    this.db = opts.db ?? prisma
    this.flushMs = opts.flushMs ?? FLUSH_MS
    this.autoFlush = opts.autoFlush ?? true
  }

  /** Queue usage. Never throws, never touches the database. */
  record(e: UsageEvent): void {
    try {
      if (!e || typeof e.projectId !== 'string' || !UUID_RE.test(e.projectId)) return
      if (!isUsageAxis(e.axis) || !isUsageSource(e.source)) return
      const q = toBig(e.quantity)
      if (q === null || q < BigInt(0)) return
      const gauge = isGauge(e.axis)
      if (!gauge && q === BigInt(0)) return
      const day = utcDay(e.at ?? new Date()).toISOString().slice(0, 10)
      const key = `${e.projectId}|${e.axis}|${day}|${e.source}`
      const prev = this.pending.get(key)
      if (prev) {
        prev.quantity = gauge ? (q > prev.quantity ? q : prev.quantity) : prev.quantity + q
        if (!prev.billingAccountId && e.billingAccountId) prev.billingAccountId = e.billingAccountId
      } else {
        this.pending.set(key, {
          projectId: e.projectId,
          axis: e.axis,
          day,
          source: e.source,
          quantity: q,
          billingAccountId: e.billingAccountId || null,
        })
      }
      this.ensureTimer()
    } catch {
      /* metering must never break the request that produced it */
    }
  }

  /** Entries accumulated but not yet sealed into a batch (for tests and diagnostics). */
  pendingSize(): number {
    return this.pending.size
  }

  /** Batches sealed but not yet confirmed applied. */
  queuedBatches(): number {
    return this.queue.length
  }

  private ensureTimer(): void {
    if (this.timer || !this.autoFlush) return
    this.timer = setInterval(() => {
      this.flush().catch(() => {})
    }, this.flushMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private seal(kind: LedgerBatch['kind'] = 'flush'): void {
    if (this.pending.size === 0) return
    this.queue.push({ id: randomUUID(), kind, entries: Array.from(this.pending.values()) })
    this.pending.clear()
  }

  /**
   * Seal what has accumulated and apply every queued batch, in order. A batch
   * that fails stays at the head of the queue for the next call. Single-flight:
   * a call while one is running waits for it and then runs again.
   */
  async flush(): Promise<void> {
    if (this.inflight) {
      await this.inflight.catch(() => {})
    }
    this.inflight = this.drain()
    try {
      await this.inflight
    } finally {
      this.inflight = null
    }
  }

  private async drain(): Promise<void> {
    this.seal()
    while (this.queue.length > 0) {
      const batch = this.queue[0]
      try {
        await applyUsageBatch(batch, this.db)
      } catch (err: any) {
        const now = Date.now()
        if (now - this.lastErrorLoggedAt > 60_000) {
          this.lastErrorLoggedAt = now
          console.error(`[UsageLedger] flush failed, ${this.queue.length} batch(es) kept for retry: ${err?.message ?? err}`)
        }
        throw err
      }
      this.queue.shift()
      this.removeSpool(batch.id)
    }
  }

  /**
   * Durably write every unapplied batch to the spool directory. Synchronous on
   * purpose: it runs inside a signal handler and must finish before any
   * process.exit another handler may call.
   */
  spoolSync(): number {
    this.seal('spool')
    if (this.queue.length === 0) return 0
    try {
      fs.mkdirSync(this.spoolDir, { recursive: true })
    } catch {
      /* reported below by the write */
    }
    let written = 0
    for (const batch of this.queue) {
      const file = path.join(this.spoolDir, `${batch.id}.json`)
      const tmp = `${file}.tmp`
      try {
        fs.writeFileSync(
          tmp,
          JSON.stringify({ ...batch, entries: batch.entries.map((e) => ({ ...e, quantity: e.quantity.toString() })) }),
        )
        fs.renameSync(tmp, file)
        written++
      } catch (err: any) {
        console.error(`[UsageLedger] could not spool batch ${batch.id} to ${this.spoolDir}: ${err?.message ?? err}`)
      }
    }
    return written
  }

  private removeSpool(id: string): void {
    try {
      fs.unlinkSync(path.join(this.spoolDir, `${id}.json`))
    } catch {
      /* usually not spooled at all */
    }
  }

  /** Load spooled batches left by an earlier process. They apply exactly once. */
  loadSpool(): number {
    let files: string[] = []
    try {
      files = fs.readdirSync(this.spoolDir).filter((f) => f.endsWith('.json'))
    } catch {
      return 0
    }
    let loaded = 0
    for (const f of files) {
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(this.spoolDir, f), 'utf8'))
        if (typeof raw?.id !== 'string' || !Array.isArray(raw.entries)) continue
        if (this.queue.some((b) => b.id === raw.id)) continue
        this.queue.push({
          id: raw.id,
          kind: 'spool',
          entries: raw.entries
            .filter((e: any) => isUsageAxis(e?.axis) && isUsageSource(e?.source))
            .map((e: any) => ({ ...e, quantity: BigInt(e.quantity) })),
        })
        loaded++
      } catch (err: any) {
        console.error(`[UsageLedger] unreadable spool file ${f}: ${err?.message ?? err}`)
      }
    }
    return loaded
  }

  /**
   * For a SIGTERM handler: spool synchronously, then try to apply everything
   * within `timeoutMs`. Whatever does not make it stays in the spool.
   */
  async shutdown(timeoutMs = 5_000): Promise<void> {
    this.stop()
    this.spoolSync()
    await Promise.race([
      this.flush().catch(() => {}),
      new Promise((r) => setTimeout(r, timeoutMs).unref?.()),
    ])
  }
}

// ── The process-wide ledger ──────────────────────────────────────────────────

const g = globalThis as unknown as { __backenlyUsageLedger?: UsageLedger; __backenlyUsageShutdownHooked?: boolean }

export function usageLedger(): UsageLedger {
  if (!g.__backenlyUsageLedger) g.__backenlyUsageLedger = new UsageLedger()
  return g.__backenlyUsageLedger
}

/** Record usage against the process-wide ledger. Never throws. */
export function recordUsage(e: UsageEvent): void {
  usageLedger().record(e)
}

/**
 * Call once at process start: replay any spool a previous process left, and
 * spool on SIGTERM/SIGINT. Safe to call more than once.
 */
export function startUsageLedger(): void {
  const ledger = usageLedger()
  if (ledger.loadSpool() > 0) ledger.flush().catch(() => {})
  if (g.__backenlyUsageShutdownHooked) return
  g.__backenlyUsageShutdownHooked = true
  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.on(sig, () => {
      // The synchronous half runs now, inside the handler, so it completes
      // before any other handler's eventual process.exit.
      ledger.stop()
      ledger.spoolSync()
      ledger.flush().catch(() => {})
    })
  }
}

/**
 * Forget exactly-once markers older than `days`. A marker only matters while
 * its batch could still be retried or replayed, which is minutes, or until the
 * next start for a spooled batch; 90 days is far past either.
 */
export async function pruneAppliedBatches(days = 90, db: Pick<typeof prisma, '$executeRaw'> = prisma): Promise<number> {
  return db.$executeRaw`
    DELETE FROM "usage_applied_batches"
    WHERE "appliedAt" < now() - make_interval(days => ${days}::int)`
}

export const __testing = { isGauge, GAUGE_AXES }
