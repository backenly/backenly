/**
 * Background sweeps walk projects a few at a time (lib/scheduler/bounded.ts),
 * so reaching each project's database never opens every database at once, and
 * their results are exactly what Promise.allSettled gave them before.
 */
import fs from 'fs'
import path from 'path'
import { SWEEP_CONCURRENCY, allSettledBounded } from '@/lib/scheduler/bounded'

const tick = () => new Promise((resolve) => setTimeout(resolve, 1))

describe('allSettledBounded', () => {
  it('answers exactly as Promise.allSettled does, in the order of the items', async () => {
    const items = [5, 1, 4, 2, 3, 0, 6]
    const fn = async (n: number) => {
      for (let i = 0; i < n; i++) await tick()
      if (n % 3 === 0) throw new Error(`no ${n}`)
      return n * 10
    }
    expect(await allSettledBounded(items, fn)).toEqual(await Promise.allSettled(items.map(fn)))
  })

  it('runs at most four at once by default, and keeps every slot busy', async () => {
    let running = 0
    let most = 0
    const items = Array.from({ length: 13 }, (_, i) => i)
    await allSettledBounded(items, async (i) => {
      running++
      most = Math.max(most, running)
      for (let k = 0; k < (i % 4) + 1; k++) await tick()
      running--
    })
    expect(SWEEP_CONCURRENCY).toBe(4)
    expect(most).toBe(4)
  })

  it('takes another bound, and never fewer than one', async () => {
    const order: number[] = []
    await allSettledBounded([1, 2, 3], async (n) => {
      order.push(n)
      await tick()
    }, 0)
    expect(order).toEqual([1, 2, 3])
  })

  it('records a synchronous throw as a rejection and carries on', async () => {
    const results = await allSettledBounded([1, 2], ((n: number) => {
      if (n === 1) throw new Error('at once')
      return Promise.resolve(n)
    }) as (n: number) => Promise<number>)
    expect(results).toEqual([
      { status: 'rejected', reason: new Error('at once') },
      { status: 'fulfilled', value: 2 },
    ])
  })

  it('answers an empty list with an empty list', async () => {
    expect(await allSettledBounded([], async () => 1)).toEqual([])
  })
})

describe('the sweeps that reach every project’s database', () => {
  const read = (file: string) => fs.readFileSync(path.join(process.cwd(), file), 'utf8')

  it('measure database storage a few projects at a time', () => {
    const src = read('lib/usage/db-storage.ts')
    const fn = src.slice(src.indexOf('export async function snapshotScheduledDbStorage'))
    expect(fn).toContain('allSettledBounded(targets, (t) => snapshotProjectDbStorage(t.id))')
    expect(fn).not.toMatch(/Promise\.allSettled\(targets\.map/)
  })

  it('sample the database baseline a few projects at a time', () => {
    const src = read('instrumentation.ts')
    expect(src).toContain('allSettledBounded(projects, p => collectBaseline(p.id))')
  })
})
