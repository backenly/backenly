/**
 * An import's reads and writes are bounded, so it cannot crowd out the website
 * it runs beside (Backenly Cloud: one web task per region, 1 vCPU, 2 GB).
 *
 *   - One import runs at a time per process; the rest wait in order, told
 *     their place, and a cancel while waiting leaves the line (lib/import/gate.ts).
 *     A look at a source (the preview, the check) takes a slot of its own
 *     gate, waits a little, and is refused rather than stacked.
 *   - A batch of rows is sized by bytes, not only by count (lib/import/pg-engine.ts).
 *   - Memory: an import pauses while the process is over its limit and stops
 *     if it stays there; parallel downloads share a byte budget (lib/import/pressure.ts).
 *   - The pre-checks compare a source with what is LEFT of the plan (lib/import/limits.ts).
 *     What a source reports can be wrong, so rows are counted as they are
 *     written and the import stops at the room (RowRoom); tables and users
 *     are capped per import.
 */
import { ImportInputError } from '@/lib/import/driver'
import { ImportGate, withSlot } from '@/lib/import/gate'
import { BATCH_TARGET_BYTES, approxBytes, batchSizeFor, initialBatchSize, nextBatchSize, rowCost } from '@/lib/import/pg-engine'
import { ByteBudget, ImportMemoryError, containerMemoryLimit, memoryIsTight, waitForHeadroom } from '@/lib/import/pressure'
import {
  MAX_IMPORT_ROW_BYTES,
  MAX_IMPORT_TABLES,
  MAX_IMPORT_USERS,
  PAGE_SLACK_BYTES,
  RowRoom,
  STORED_PER_COUNTED,
  fileRefusal,
  limitsLeft,
  roomRefusal,
  rowRefusal,
  tableCountRefusal,
  userCountRefusal,
  writeWithinRoom,
} from '@/lib/import/limits'

const MB = 1024 * 1024
const flush = () => new Promise((r) => setImmediate(r))

describe('one import at a time, the rest in line', () => {
  it('starts the first at once and lines up the next ones in order, telling each its place', async () => {
    const gate = new ImportGate(() => 1, () => 10)
    const places: Record<string, number[]> = { b: [], c: [] }
    const releaseA = await gate.acquire('a', new AbortController().signal)
    let bStarted = false
    let cStarted = false
    const b = gate.acquire('b', new AbortController().signal, (p) => places.b.push(p)).then((r) => ((bStarted = true), r))
    const c = gate.acquire('c', new AbortController().signal, (p) => places.c.push(p)).then((r) => ((cStarted = true), r))
    await flush()
    expect(gate.counts()).toEqual({ running: 1, waiting: 2 })
    expect(places).toEqual({ b: [1], c: [2] })
    expect([bStarted, cStarted]).toEqual([false, false])

    releaseA()
    const releaseB = await b
    await flush()
    expect(bStarted && !cStarted).toBe(true)
    expect(places.c).toEqual([2, 1])

    releaseB()
    releaseB() // a second call changes nothing
    const releaseC = await c
    expect(gate.counts()).toEqual({ running: 1, waiting: 0 })
    releaseC()
    expect(gate.counts()).toEqual({ running: 0, waiting: 0 })
  })

  it('takes a canceled import out of the line and moves the ones behind it up', async () => {
    const gate = new ImportGate(() => 1, () => 10)
    const release = await gate.acquire('a', new AbortController().signal)
    const cancelB = new AbortController()
    const placesC: number[] = []
    const b = gate.acquire('b', cancelB.signal)
    const c = gate.acquire('c', new AbortController().signal, (p) => placesC.push(p))
    cancelB.abort(new Error('canceled'))
    await expect(b).rejects.toThrow('canceled')
    expect(placesC).toEqual([2, 1])
    expect(gate.counts().waiting).toBe(1)
    release()
    await c
  })

  it('refuses room only when every slot is busy and the line is full', async () => {
    const gate = new ImportGate(() => 1, () => 1)
    expect(gate.hasRoom()).toBe(true)
    await gate.acquire('a', new AbortController().signal)
    expect(gate.hasRoom()).toBe(true)
    void gate.acquire('b', new AbortController().signal)
    await flush()
    expect(gate.hasRoom()).toBe(false)
  })

  it('runs as many at once as it is given slots', async () => {
    const gate = new ImportGate(() => 2, () => 0)
    await gate.acquire('a', new AbortController().signal)
    await gate.acquire('b', new AbortController().signal)
    expect(gate.counts()).toEqual({ running: 2, waiting: 0 })
    expect(gate.hasRoom()).toBe(false)
  })
})

describe('looking at a source (the preview, the check before a start) takes a slot too', () => {
  const busy = () => new Error('busy')

  it('lets one look read at a time and the next one wait for it', async () => {
    const gate = new ImportGate(() => 1, () => 4)
    let finishFirst: () => void = () => {}
    const order: string[] = []
    const first = withSlot(gate, { waitMs: 5_000, busy }, async () => {
      order.push('first reads')
      await new Promise<void>((r) => (finishFirst = r))
      order.push('first done')
    })
    const second = withSlot(gate, { waitMs: 5_000, busy }, async () => {
      order.push('second reads')
    })
    await flush()
    expect(order).toEqual(['first reads'])
    expect(gate.counts()).toEqual({ running: 1, waiting: 1 })
    finishFirst()
    await Promise.all([first, second])
    expect(order).toEqual(['first reads', 'first done', 'second reads'])
    expect(gate.counts()).toEqual({ running: 0, waiting: 0 })
  })

  it('refuses a look that waited too long, or found the line full, without reading', async () => {
    const gate = new ImportGate(() => 1, () => 1)
    let finish: () => void = () => {}
    const held = withSlot(gate, { waitMs: 5_000, busy }, () => new Promise<void>((r) => (finish = r)))
    const read = jest.fn(async () => {})
    await expect(withSlot(gate, { waitMs: 20, busy }, read)).rejects.toThrow('busy')
    expect(read).not.toHaveBeenCalled()
    expect(gate.counts()).toEqual({ running: 1, waiting: 0 })

    // One waits in the line of one; the next finds it full.
    const waiting = withSlot(gate, { waitMs: 5_000, busy }, read)
    await flush()
    await expect(withSlot(gate, { waitMs: 5_000, busy }, read)).rejects.toThrow('busy')
    finish()
    await held
    await waiting
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('frees the slot when the look fails', async () => {
    const gate = new ImportGate(() => 1, () => 0)
    await expect(
      withSlot(gate, { waitMs: 0, busy }, async () => {
        throw new Error('source refused')
      }),
    ).rejects.toThrow('source refused')
    expect(gate.counts()).toEqual({ running: 0, waiting: 0 })
    await expect(withSlot(gate, { waitMs: 0, busy }, async () => 'read')).resolves.toBe('read')
  })
})

describe('a batch of rows is sized by bytes', () => {
  const table = (rows: number, bytes: number, columns = 5) => ({ rows, bytes, copy: new Array(columns).fill(null) as any[] })

  it('starts from the source table’s average row, within the parameter limit', () => {
    expect(initialBatchSize(table(1_000_000, 100 * 1_000_000))).toBe(batchSizeFor(5)) // 100-byte rows: the count limit
    expect(initialBatchSize(table(1_000, 1_000 * 2 * MB))).toBe(4) // 2 MB rows: four fit 8 MB
    expect(initialBatchSize(table(10, 10 * 500 * MB))).toBe(1) // never fewer than one
    expect(initialBatchSize(table(0, 0))).toBe(50) // nothing known: a cautious few
  })

  it('follows what the last batch measured, growing at most twofold', () => {
    expect(nextBatchSize(10, 10, 10 * 100, 5)).toBe(20)
    expect(nextBatchSize(200, 200, 200 * MB, 5)).toBe(8) // 1 MB rows → 8 per batch
    expect(nextBatchSize(50, 50, 50 * 64 * MB, 5)).toBe(1)
    expect(nextBatchSize(1000, 1000, 1000 * 10, 100)).toBe(batchSizeFor(100))
    expect(nextBatchSize(7, 0, 0, 5)).toBe(7)
  })

  it('keeps a batch of measured rows near the byte target', () => {
    const wide = Array.from({ length: 4 }, () => ['x'.repeat(2 * MB), { a: 'y'.repeat(1000) }, null, 5, new Date()])
    const bytes = approxBytes(wide)
    expect(bytes).toBeGreaterThan(8 * MB)
    expect(bytes).toBeLessThan(8 * MB + 10_000)
    expect(approxBytes([[Buffer.alloc(1234)]])).toBe(1234)
    const next = nextBatchSize(4, 4, bytes, 5)
    expect(next * (bytes / 4)).toBeLessThanOrEqual(BATCH_TARGET_BYTES)
  })
})

describe('memory: the import waits for headroom, and downloads share a budget', () => {
  const GB = 1024 * MB
  const calm = { rss: 600 * MB, heapUsed: 200 * MB, heapLimit: 1 * GB, rssLimit: 2 * GB }

  it('calls memory tight only past 85% of a real limit', () => {
    expect(memoryIsTight(calm)).toBe(false)
    expect(memoryIsTight({ ...calm, rss: 1.8 * GB })).toBe(true) // past 85% of the 2 GB container
    expect(memoryIsTight({ ...calm, heapUsed: 0.9 * GB })).toBe(true) // past 85% of the heap
    // No container limit (a laptop): a big resting process is not tight by itself.
    expect(memoryIsTight({ ...calm, rss: 1.9 * GB, rssLimit: null })).toBe(false)
  })

  it('reads the container limit from cgroup v2, then v1, and treats "max" as none', () => {
    const files = (map: Record<string, string>) => (p: string) => {
      if (p in map) return map[p]
      throw new Error('ENOENT')
    }
    expect(containerMemoryLimit(files({ '/sys/fs/cgroup/memory.max': '2147483648\n' }))).toBe(2 * GB)
    expect(containerMemoryLimit(files({ '/sys/fs/cgroup/memory.max': 'max' }))).toBeNull()
    expect(containerMemoryLimit(files({ '/sys/fs/cgroup/memory/memory.limit_in_bytes': '1073741824' }))).toBe(GB)
    expect(containerMemoryLimit(files({ '/sys/fs/cgroup/memory/memory.limit_in_bytes': '9223372036854771712' }))).toBeNull()
    expect(containerMemoryLimit(files({}))).toBeNull()
  })

  it('goes on at once while memory is not tight', async () => {
    await expect(waitForHeadroom(new AbortController().signal, { readings: () => calm })).resolves.toBeUndefined()
  })

  it('waits while memory is tight, then goes on', async () => {
    let tight = true
    let t = 0
    const slept: number[] = []
    await waitForHeadroom(new AbortController().signal, {
      readings: () => (tight ? { ...calm, rss: 1.9 * GB } : calm),
      now: () => t,
      sleep: async (ms) => {
        slept.push(ms)
        t += ms
        if (slept.length === 3) tight = false
      },
    })
    expect(slept).toEqual([1000, 1000, 1000])
  })

  it('stops the import when memory has not come down in time, and says so', async () => {
    let t = 0
    const err = await waitForHeadroom(new AbortController().signal, {
      maxWaitMs: 5_000,
      readings: () => ({ ...calm, rss: 1.9 * GB }),
      now: () => t,
      sleep: async (ms) => {
        t += ms
      },
    }).catch((e) => e)
    expect(err).toBeInstanceOf(ImportMemoryError)
    expect(err.message).toMatch(/short of memory/)
  })

  it('stops waiting when the import is canceled', async () => {
    const c = new AbortController()
    c.abort(new Error('canceled'))
    await expect(waitForHeadroom(c.signal, { readings: () => ({ ...calm, rss: 1.9 * GB }) })).rejects.toThrow('canceled')
  })

  it('holds parallel downloads to the budget, and lets a larger file through alone', async () => {
    const budget = new ByteBudget(100)
    const r1 = await budget.acquire(60)
    let r2Got = false
    const r2 = budget.acquire(60).then((r) => ((r2Got = true), r))
    await flush()
    expect(r2Got).toBe(false)
    expect(budget.held()).toBe(60)
    r1()
    const release2 = await r2
    expect(budget.held()).toBe(60)
    let bigGot = false
    const big = budget.acquire(500).then((r) => ((bigGot = true), r))
    await flush()
    expect(bigGot).toBe(false)
    release2()
    const releaseBig = await big
    expect(budget.held()).toBe(500)
    releaseBig()
    expect(budget.held()).toBe(0)
  })
})

describe('the pre-checks count what the organization already uses', () => {
  it('leaves the plan less the usage, never below zero', () => {
    const l = limitsLeft({ planRowBytes: 500 * MB, planFileBytes: 1024 * MB, usedRowBytes: 380 * MB, usedFileBytes: 2000 * MB, planName: 'Free' })
    expect(l.maxRowBytes).toBe(120 * MB)
    expect(l.maxFileBytes).toBe(0)
    const unlimited = limitsLeft({ planRowBytes: null, planFileBytes: null, usedRowBytes: 0, usedFileBytes: 0, planName: 'Enterprise' })
    expect(unlimited.maxRowBytes).toBe(MAX_IMPORT_ROW_BYTES)
    expect(unlimited.maxFileBytes).toBeNull()
  })

  it('says what is left when part of the plan is in use', () => {
    const l = limitsLeft({ planRowBytes: 500 * MB, planFileBytes: 1024 * MB, usedRowBytes: 380 * MB, usedFileBytes: 1000 * MB, planName: 'Free' })
    expect(rowRefusal(200 * MB, l)).toBe(
      'This source holds about 200 MB of rows, and the organization has 120 MB left of the 500 MB of database storage on Free. Free some space or upgrade the organization, then import.',
    )
    expect(fileRefusal(100 * MB, l)).toMatch(/has 24 MB left of the 1 GB of file storage on Free\. Leave files out/)
    expect(rowRefusal(100 * MB, l)).toBeNull()
  })

  it('keeps the plain wording when nothing is in use yet', () => {
    const l = limitsLeft({ planRowBytes: 500 * MB, planFileBytes: null, usedRowBytes: 0, usedFileBytes: 0, planName: 'Free' })
    expect(rowRefusal(600 * MB, l)).toBe(
      'This source holds about 600 MB of rows, and Free includes 500 MB of database storage. Upgrade the organization, then import.',
    )
  })
})

describe('rows are written only as far as the room lets them in', () => {
  // 120 MB left of the plan's 500 MB.
  const free = limitsLeft({ planRowBytes: 500 * MB, planFileBytes: null, usedRowBytes: 380 * MB, usedFileBytes: 0, planName: 'Free' })
  const counted = (c: number) => c

  /** The import's tables, standing in: each row written adds `storedPerRow` to what measuring them says. */
  function tables(storedPerRow: number) {
    let held = 0
    const writes: number[] = []
    return {
      measure: jest.fn(async () => held),
      write: async (rows: number[]) => {
        writes.push(rows.length)
        held += rows.length * storedPerRow
        return rows.length
      },
      held: () => held,
      writes,
    }
  }

  it('lets rows in without measuring while even eight times their count fits', async () => {
    const t = tables(1024)
    const room = new RowRoom(free, t.measure)
    await expect(writeWithinRoom(room, Array.from({ length: 1000 }, () => 1024), counted, t.write)).resolves.toBe(1000)
    expect(t.measure).not.toHaveBeenCalled()
    expect(t.writes).toEqual([1000])
  })

  it('measures as the room fills, fills it when rows are stored at about their count, and stops there in the pre-check words', async () => {
    const t = tables(MB)
    const room = new RowRoom(free, t.measure)
    const err = await writeWithinRoom(room, Array.from({ length: 200 }, () => MB), counted, t.write).catch((e) => e)
    expect(err).toBeInstanceOf(ImportInputError)
    expect(err.message).toBe(
      'Backenly stopped the import after 112 MB of rows: the organization has 120 MB left of the 500 MB of database storage on Free. Free some space or upgrade the organization, then import again.',
    )
    expect(t.held()).toBeLessThanOrEqual(free.maxRowBytes)
    // Within eight rows' worst case (and the page slack) of the room.
    expect(t.held()).toBeGreaterThanOrEqual(free.maxRowBytes - STORED_PER_COUNTED * MB - PAGE_SLACK_BYTES)
  })

  it('never lets the tables hold more than the room, even when rows are stored at six times their count', async () => {
    // A jsonb array of one-digit numbers is stored at about six times its text.
    const t = tables(600 * 1024)
    const room = new RowRoom(free, t.measure)
    await expect(writeWithinRoom(room, Array.from({ length: 1000 }, () => 100 * 1024), counted, t.write)).rejects.toBeInstanceOf(ImportInputError)
    expect(t.held()).toBeLessThanOrEqual(free.maxRowBytes)
    expect(t.held()).toBeGreaterThan(free.maxRowBytes - 8 * 600 * 1024)
  })

  it('takes nothing more on trust when the tables cannot be measured', async () => {
    const written: number[] = []
    const room = new RowRoom(free, async () => {
      throw new Error('measurement failed')
    })
    const err = await writeWithinRoom(room, Array.from({ length: 100 }, () => MB), counted, async (rows) => {
      written.push(rows.length)
      return rows.length
    }).catch((e) => e)
    // What fit at eight times its count went in; then the worst case of that count stands,
    // and the refusal says the rows could not be measured, not that the worst case was written.
    expect(written).toEqual([14])
    expect(err).toBeInstanceOf(ImportInputError)
    expect(err.message).toBe(
      'Backenly stopped the import because it could not measure the rows already written, and without that it cannot keep within the 120 MB the organization has left. Start it again in a few minutes.',
    )
  })

  it('counts a value at its length but at least 8 bytes, plus 8, and each row at 64 more', () => {
    expect(rowCost([null, undefined])).toBe(64)
    // A number PostgreSQL holds in 8 bytes can be one character of text.
    expect(rowCost(['1'])).toBe(64 + 16)
    expect(rowCost(['x'.repeat(100), 'abc'])).toBe(64 + 108 + 16)
  })

  it('says the plan, or the one-import limit, when nothing else is in use', () => {
    const plain = limitsLeft({ planRowBytes: 500 * MB, planFileBytes: null, usedRowBytes: 0, usedFileBytes: 0, planName: 'Free' })
    expect(roomRefusal(499 * MB, plain)).toBe(
      'Backenly stopped the import after 499 MB of rows: Free includes 500 MB of database storage. Upgrade the organization, then import again.',
    )
    expect(roomRefusal(5 * 1024 * MB, undefined)).toBe(
      'Backenly stopped the import after 5 GB of rows; one import moves up to 5 GB. Contact us to move a larger database.',
    )
  })

  it('caps the tables and users one import moves', () => {
    expect(MAX_IMPORT_TABLES).toBe(1000)
    expect(MAX_IMPORT_USERS).toBe(1_000_000)
    expect(tableCountRefusal(1500)).toBe('This source has 1,500 tables; one import moves up to 1,000. Contact us to move a larger database.')
    expect(userCountRefusal(null)).toBe('This source has more than 1,000,000 users; one import moves up to 1,000,000. Contact us to move more.')
  })
})
