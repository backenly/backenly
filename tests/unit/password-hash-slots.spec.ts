/**
 * At most two passwords hash at once (lib/auth/password.ts).
 *
 * Hashing is all CPU. On the one-vCPU web task more at once finishes none of
 * them sooner, and each one holds one of libuv's four worker threads, which DNS
 * lookups and file reads wait for too.
 */
type Pending = { resolve: (v: string) => void; reject: (e: Error) => void }
const pending: Pending[] = []
let inFlight = 0
let mostAtOnce = 0

jest.mock('bcrypt', () => {
  const run = () =>
    new Promise<string>((resolve, reject) => {
      inFlight++
      mostAtOnce = Math.max(mostAtOnce, inFlight)
      pending.push({
        resolve: (v) => { inFlight--; resolve(v) },
        reject: (e) => { inFlight--; reject(e) },
      })
    })
  return { hash: jest.fn(run), compare: jest.fn(run) }
})

import { hashPassword, verifyPassword } from '@/lib/auth/password'

const settle = () => new Promise((r) => setImmediate(r))

it('runs two at a time, hands each finished slot to the next, and frees a slot on failure', async () => {
  const results = [
    hashPassword('a'),
    verifyPassword('b', 'hash'),
    hashPassword('c'),
    hashPassword('d'),
    verifyPassword('e', 'hash'),
  ].map((p) => p.then((v) => ({ ok: true, v }), (e: Error) => ({ ok: false, v: e.message })))

  await settle()
  expect(pending).toHaveLength(2)

  pending.shift()!.reject(new Error('boom'))
  await settle()
  expect(pending).toHaveLength(2)

  while (pending.length) {
    pending.shift()!.resolve('done')
    await settle()
  }
  expect(await Promise.all(results)).toEqual([
    { ok: false, v: 'boom' },
    { ok: true, v: 'done' },
    { ok: true, v: 'done' },
    { ok: true, v: 'done' },
    { ok: true, v: 'done' },
  ])
  expect(mostAtOnce).toBe(2)
  expect(inFlight).toBe(0)
})
