/**
 * Keeping an import from crowding out the website it runs beside.
 *
 * Two habits, used between every batch of rows, users or files:
 *
 *   yieldToServer   hand the event loop back for one turn, so requests that
 *                   arrived while a batch was prepared are answered before
 *                   the next one starts;
 *   waitForHeadroom pause while memory is tight, and stop the import if it
 *                   stays tight for five minutes. Tight means past 85% of a
 *                   real limit: the container's (the cgroup's memory.max on
 *                   Linux; Backenly Cloud's web task has 2 GB), or V8's heap
 *                   limit. BACKENLY_IMPORT_RSS_MAX_MB, when set, replaces the
 *                   container reading. A fixed line would not do: a process's
 *                   resting size differs by build and host (a dev server sits
 *                   near 2 GB), and a line below it would stall every import.
 *                   The website's own requests are never the ones that wait.
 *
 * The readings, the clock and the sleep are injectable for the tests.
 */

import { readFileSync } from 'fs'
import { getHeapStatistics } from 'v8'

const MB = 1024 * 1024
const SHARE = 0.85

export class ImportMemoryError extends Error {
  constructor() {
    super('Backenly paused this import for five minutes because the server was short of memory, and then stopped it. Start it again in a few minutes.')
    this.name = 'ImportMemoryError'
  }
}

export function yieldToServer(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

let containerLimit: number | null | undefined

/** The container's memory limit in bytes (cgroup v2, then v1), or null when there is none. Read once. */
export function containerMemoryLimit(read: (path: string) => string = (p) => readFileSync(p, 'utf8')): number | null {
  for (const path of ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes']) {
    try {
      const text = read(path).trim()
      if (text === 'max') return null
      const n = Number(text)
      // cgroup v1 writes a huge number for "no limit".
      if (Number.isFinite(n) && n > 0 && n < 2 ** 60) return n
    } catch {
      /* not this cgroup version, or not Linux */
    }
  }
  return null
}

export interface MemoryReadings {
  rss: number
  heapUsed: number
  heapLimit: number
  /** The container limit, or an explicit BACKENLY_IMPORT_RSS_MAX_MB; null for neither. */
  rssLimit: number | null
}

export function memoryReadings(): MemoryReadings {
  if (containerLimit === undefined) containerLimit = containerMemoryLimit()
  const override = Number.parseInt(process.env.BACKENLY_IMPORT_RSS_MAX_MB ?? '', 10)
  const heap = getHeapStatistics()
  return {
    rss: process.memoryUsage.rss(),
    heapUsed: heap.used_heap_size,
    heapLimit: heap.heap_size_limit,
    rssLimit: Number.isFinite(override) && override > 0 ? override * MB / SHARE : containerLimit,
  }
}

/** Past 85% of the container (or the override), or of V8's heap. */
export function memoryIsTight(m: MemoryReadings): boolean {
  if (m.rssLimit !== null && m.rss > m.rssLimit * SHARE) return true
  return m.heapLimit > 0 && m.heapUsed > m.heapLimit * SHARE
}

export interface HeadroomOptions {
  readings?: () => MemoryReadings
  maxWaitMs?: number
  pollMs?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

/** Resolves once memory is not tight; throws the signal's reason, or ImportMemoryError after maxWaitMs. */
export async function waitForHeadroom(signal: AbortSignal, opts: HeadroomOptions = {}): Promise<void> {
  const readings = opts.readings ?? memoryReadings
  const now = opts.now ?? Date.now
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const maxWaitMs = opts.maxWaitMs ?? 5 * 60_000
  const pollMs = opts.pollMs ?? 1_000
  const started = now()
  while (memoryIsTight(readings())) {
    if (signal.aborted) throw signal.reason
    if (now() - started >= maxWaitMs) throw new ImportMemoryError()
    await sleep(pollMs)
  }
  if (signal.aborted) throw signal.reason
}

/**
 * Bytes held at once by downloads that run side by side (Firebase Storage
 * moves four files at a time). A file waits until its size fits beside the
 * others in flight; a file larger than the whole budget waits until it is the
 * only one, so memory is held to the larger of the budget and one file.
 */
export class ByteBudget {
  private inFlight = 0
  private readonly waiting: Array<{ bytes: number; go: () => void }> = []

  constructor(readonly budget: number) {}

  async acquire(bytes: number): Promise<() => void> {
    const n = Math.max(0, bytes)
    if (!this.fits(n) || this.waiting.length > 0) {
      await new Promise<void>((go) => this.waiting.push({ bytes: n, go }))
    } else {
      this.inFlight += n
    }
    let released = false
    return () => {
      if (released) return
      released = true
      this.inFlight -= n
      this.wake()
    }
  }

  held(): number {
    return this.inFlight
  }

  private fits(n: number): boolean {
    return this.inFlight === 0 || this.inFlight + n <= this.budget
  }

  private wake(): void {
    while (this.waiting.length > 0 && this.fits(this.waiting[0].bytes)) {
      const next = this.waiting.shift()!
      this.inFlight += next.bytes
      next.go()
    }
  }
}

/** The file budget an import's parallel downloads share. */
export const FILE_BYTES_IN_FLIGHT = 128 * MB
