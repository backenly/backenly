/**
 * Password hashing leaves the event loop free (production QA, 2026-11-09).
 *
 * Sign-up's p95 was 8.5 s, and uploads of a few bytes took 5.5 s at p95 on the
 * same one-vCPU web task. Hashing ran bcryptjs on the event loop: one cost-12
 * hash is about 0.4 s of CPU, done in 100 ms slices, and every other request in
 * the process waited out each slice. Native bcrypt hashes on libuv's worker
 * threads; the algorithm, cost and format are the same.
 */
import { monitorEventLoopDelay } from 'perf_hooks'
import bcryptjs from 'bcryptjs'
import { hashPassword, verifyPassword, verifyPasswordAgainstDecoy } from '@/lib/auth/password'

describe('password hashing', () => {
  it('leaves the event loop free while four passwords hash at once', async () => {
    const delay = monitorEventLoopDelay({ resolution: 1 })
    delay.enable()
    const hashes = await Promise.all([1, 2, 3, 4].map((i) => hashPassword(`password-${i}`)))
    delay.disable()
    expect(hashes.every((h) => /^\$2[ab]\$12\$/.test(h))).toBe(true)
    // bcryptjs held the loop for 100 ms at a time, and four hashes in turn for
    // 400 ms: a request's every step waited that long.
    expect(delay.percentile(99) / 1e6).toBeLessThan(50)
  }, 30_000)

  it('verifies the hashes bcryptjs made, and bcryptjs verifies the new ones', async () => {
    // Every stored hash so far was made by bcryptjs ($2a$); functions can
    // still use bcryptjs on what sign-up stores.
    const old = bcryptjs.hashSync('pässwörd-ü', 12)
    expect(await verifyPassword('pässwörd-ü', old)).toBe(true)
    expect(await verifyPassword('passwörd-ü', old)).toBe(false)

    const made = await hashPassword('pässwörd-ü')
    expect(bcryptjs.compareSync('pässwörd-ü', made)).toBe(true)
    expect(bcryptjs.compareSync('pässwörd-u', made)).toBe(false)
    expect(bcryptjs.getRounds(made)).toBe(12)
  }, 30_000)

  it('treats the 72 bytes bcrypt reads the same way bcryptjs did', async () => {
    const stored = bcryptjs.hashSync('x'.repeat(72) + 'one ending', 4)
    expect(await verifyPassword('x'.repeat(72) + 'another ending', stored)).toBe(true)
  })

  it('never matches the decoy', async () => {
    await expect(verifyPasswordAgainstDecoy('anything')).resolves.toBe(false)
  }, 30_000)
})
