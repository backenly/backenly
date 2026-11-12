/**
 * One request for what several of the console's components read at once
 * (lib/client/shared-read.ts; production QA, 2026-11-09: every console page
 * asked for the same things two to five times as each component mounted).
 */
import { forgetSharedReads, REUSE_MS, sharedRead } from '@/lib/client/shared-read'

type Answer = { ok: boolean; status: number; json: () => Promise<unknown> }
let pending: Array<{ resolve: (a: Answer) => void; reject: (e: Error) => void }> = []
const fetchMock = jest.fn(() => new Promise<Answer>((resolve, reject) => pending.push({ resolve, reject })))
const answer = (body: unknown, status = 200): Answer => ({ ok: status < 400, status, json: async () => body })
const settle = () => new Promise((r) => setImmediate(r))

beforeAll(() => {
  ;(global as any).fetch = fetchMock
})

beforeEach(() => {
  forgetSharedReads()
  fetchMock.mockClear()
  pending = []
})

it('makes one request for reads at the same moment, and gives each the answer', async () => {
  const reads = [sharedRead('/api/a'), sharedRead('/api/a'), sharedRead('/api/a')]
  expect(fetchMock).toHaveBeenCalledTimes(1)
  expect(fetchMock).toHaveBeenCalledWith('/api/a', { credentials: 'include', cache: 'no-store' })
  pending[0].resolve(answer({ n: 1 }))
  expect(await Promise.all(reads)).toEqual([
    { ok: true, status: 200, data: { n: 1 } },
    { ok: true, status: 200, data: { n: 1 } },
    { ok: true, status: 200, data: { n: 1 } },
  ])
})

it('reuses an answer for two seconds, then asks again', async () => {
  const first = sharedRead('/api/b')
  pending[0].resolve(answer({ n: 1 }))
  await first
  await settle()
  expect(await sharedRead('/api/b')).toEqual({ ok: true, status: 200, data: { n: 1 } })
  expect(fetchMock).toHaveBeenCalledTimes(1)

  const later = Date.now() + REUSE_MS + 1
  const clock = jest.spyOn(Date, 'now').mockReturnValue(later)
  try {
    const again = sharedRead('/api/b')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    pending[1].resolve(answer({ n: 2 }))
    expect((await again).data).toEqual({ n: 2 })
  } finally {
    clock.mockRestore()
  }
})

it('reads afresh when asked, but joins a request already on its way', async () => {
  const first = sharedRead('/api/c')
  const joined = sharedRead('/api/c', { fresh: true })
  expect(fetchMock).toHaveBeenCalledTimes(1)
  pending[0].resolve(answer({ n: 1 }))
  await Promise.all([first, joined])
  await settle()

  const fresh = sharedRead('/api/c', { fresh: true })
  expect(fetchMock).toHaveBeenCalledTimes(2)
  pending[1].resolve(answer({ n: 2 }))
  expect((await fresh).data).toEqual({ n: 2 })
})

it('keeps a refusal like any answer, but never a request that failed', async () => {
  const refused = sharedRead('/api/d')
  pending[0].resolve(answer({ error: 'nope' }, 403))
  expect(await refused).toEqual({ ok: false, status: 403, data: { error: 'nope' } })

  const failed = sharedRead('/api/e')
  const joined = sharedRead('/api/e')
  pending[1].reject(new Error('offline'))
  await expect(failed).rejects.toThrow('offline')
  await expect(joined).rejects.toThrow('offline')
  await settle()
  void sharedRead('/api/e')
  expect(fetchMock).toHaveBeenCalledTimes(3)
})

it('answers null for a body that is not JSON, and forgets what it is told to', async () => {
  const read = sharedRead('/api/f/1')
  pending[0].resolve({ ok: true, status: 204, json: async () => { throw new Error('no body') } })
  expect(await read).toEqual({ ok: true, status: 204, data: null })
  await settle()

  forgetSharedReads('/api/f/')
  void sharedRead('/api/f/1')
  expect(fetchMock).toHaveBeenCalledTimes(2)
})
