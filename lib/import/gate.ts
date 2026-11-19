/**
 * How many imports run at once in this process, and the line the rest wait in.
 *
 * An import runs inside the web server (lib/import/jobs.ts), and Backenly
 * Cloud runs one web task per region with 1 vCPU and 2 GB (backenly-infra
 * modules/ecs-services). Two large imports at once could take the memory the
 * website needs, so by default one runs at a time and the next ones wait, in
 * order, with their place in line on their progress. A start is refused only
 * when the line itself is full; nothing is created then.
 *
 * The credentials of a waiting import stay in this process's memory, as for a
 * running one; a restart while it waits ends it the way a restart ends a
 * running import. Pure apart from the env defaults, so the tests drive it.
 */

export class ImportGate {
  private running = 0
  private readonly line: Array<{
    jobId: string
    admit: (release: () => void) => void
    refuse: (reason: unknown) => void
    onPlace: (place: number) => void
  }> = []

  constructor(
    private readonly slots: () => number,
    private readonly maxWaiting: () => number,
  ) {}

  /** Whether a new import may join: a free slot, or room in the line. */
  hasRoom(): boolean {
    return this.running < Math.max(1, this.slots()) || this.line.length < Math.max(0, this.maxWaiting())
  }

  /** Imports running, and waiting, in this process. */
  counts(): { running: number; waiting: number } {
    return { running: this.running, waiting: this.line.length }
  }

  /**
   * Wait for a slot. Resolves with the release to call when the import ends;
   * rejects with the signal's reason if it is aborted (a cancel) while waiting.
   * `onPlace` hears 1 for "next in line", 2 for the one behind it, and so on,
   * each time the place changes; it is not called for an import that starts at once.
   */
  acquire(jobId: string, signal: AbortSignal, onPlace: (place: number) => void = () => {}): Promise<() => void> {
    if (signal.aborted) return Promise.reject(signal.reason)
    if (this.running < Math.max(1, this.slots()) && this.line.length === 0) {
      this.running++
      return Promise.resolve(this.releaser())
    }
    return new Promise((resolve, reject) => {
      const entry = {
        jobId,
        admit: (release: () => void) => {
          signal.removeEventListener('abort', onAbort)
          resolve(release)
        },
        refuse: (reason: unknown) => {
          signal.removeEventListener('abort', onAbort)
          reject(reason)
        },
        onPlace,
      }
      const onAbort = () => {
        const i = this.line.indexOf(entry)
        if (i >= 0) {
          this.line.splice(i, 1)
          this.tellPlaces(i)
        }
        entry.refuse(signal.reason)
      }
      signal.addEventListener('abort', onAbort, { once: true })
      this.line.push(entry)
      onPlace(this.line.length)
    })
  }

  private releaser(): () => void {
    let released = false
    return () => {
      if (released) return
      released = true
      this.running--
      this.admitNext()
    }
  }

  private admitNext(): void {
    while (this.running < Math.max(1, this.slots()) && this.line.length > 0) {
      const next = this.line.shift()!
      this.running++
      next.admit(this.releaser())
      this.tellPlaces(0)
    }
  }

  private tellPlaces(from: number): void {
    for (let i = from; i < this.line.length; i++) this.line[i].onPlace(i + 1)
  }
}

function envInt(name: string, fallback: number): number {
  const n = Number.parseInt(process.env[name] ?? '', 10)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

/**
 * The process's gate. BACKENLY_IMPORT_CONCURRENCY (default 1) imports run at
 * once; BACKENLY_IMPORT_QUEUE (default 10) more may wait.
 */
export const IMPORT_GATE = new ImportGate(
  () => envInt('BACKENLY_IMPORT_CONCURRENCY', 1),
  () => envInt('BACKENLY_IMPORT_QUEUE', 10),
)

/**
 * The gate for LOOKING at a source: the Review step's read (up to five
 * minutes) and the quick check before a start. Each reads the source the way
 * an import does and can hold as much while it does, but answers a request
 * that is waiting, so it cannot queue behind an import for hours. It has
 * slots of its own beside the import's: BACKENLY_IMPORT_LOOK_CONCURRENCY
 * (default 1) at once, BACKENLY_IMPORT_LOOK_QUEUE (default 4) waiting.
 */
export const LOOK_GATE = new ImportGate(
  () => envInt('BACKENLY_IMPORT_LOOK_CONCURRENCY', 1),
  () => envInt('BACKENLY_IMPORT_LOOK_QUEUE', 4),
)

let looks = 0

/**
 * Run `fn` holding one of `gate`'s slots. With the line full, or after
 * `waitMs` in it, throws `busy()` without running `fn`.
 */
export async function withSlot<T>(gate: ImportGate, opts: { waitMs: number; busy: () => Error }, fn: () => Promise<T>): Promise<T> {
  if (!gate.hasRoom()) throw opts.busy()
  const wait = new AbortController()
  const timer = setTimeout(() => wait.abort(opts.busy()), Math.max(0, opts.waitMs))
  const release = await gate.acquire(`look-${++looks}`, wait.signal).finally(() => clearTimeout(timer))
  try {
    return await fn()
  } finally {
    release()
  }
}
