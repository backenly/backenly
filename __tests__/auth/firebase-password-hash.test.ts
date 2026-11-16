/**
 * Firebase password hashes, checked by Backenly's end-user sign-in.
 *
 * Users moved in from Firebase keep their passwords: their Firebase scrypt
 * hashes arrive with the project's hash parameters (lib/auth/firebase-scrypt.ts),
 * sign-in accepts one once, and replaces it with bcrypt
 * (lib/auth/end-user-password.ts), which both sign-in servers run.
 *
 * The vector is Firebase's own, from the README of github.com/firebase/scrypt
 * (the sample project's hash parameters and its exported user1@test.com):
 * the implementation is right only if it reproduces Firebase's hash exactly.
 *
 * Database-free: the users row is an in-memory value handed to the same
 * compare-and-swap the route's writer runs in SQL.
 */

import fs from 'fs'
import path from 'path'
import bcrypt from 'bcrypt'
import {
  encodeFirebaseHash,
  firebaseParamsProblem,
  firebaseScryptHash,
  isFirebaseHash,
  parseFirebaseHash,
  verifyFirebaseHash,
  type FirebaseHashParams,
} from '@/lib/auth/firebase-scrypt'
import {
  FAILED_CHECK_FLOOR_MS,
  checkEndUserPassword,
  endUserPasswordWriter,
  failedCheckPadding,
  replaceImportedPasswordHash,
  startPasswordCheckTimer,
  type CheckClock,
} from '@/lib/auth/end-user-password'

// github.com/firebase/scrypt README: "Sample Password hash parameters from Firebase Console"
const README_PARAMS: FirebaseHashParams = {
  signerKey: 'jxspr8Ki0RYycVU8zykbdLGjFQ3McFUH0uiiTvC8pVMXAn210wjLNmdZJzxUECKbm0QsEmYUSDzZvpjeJ9WmXA==',
  saltSeparator: 'Bw==',
  rounds: 8,
  memoryCost: 14,
}
// …and the exported account: kYi4EvWQlQTKSfnJ3dRSP6IH3ed2, user1@test.com
const README_SALT = '42xEC+ixf3L2lw=='
const README_PASSWORD = 'user1password'
const README_HASH = 'lSrfV15cpx95/sZS2W9c9Kp6i/LVgQNDNC/qzrCnh1SAyZvqmZqAjTdn3aoItz+VHjoZilo78198JAdRuid5lQ=='

const toUrlSafe = (b64: string) => b64.replace(/\+/g, '-').replace(/\//g, '_')

describe("Firebase's modified scrypt (official vector)", () => {
  it('reproduces the README hash for user1password', async () => {
    const hash = await firebaseScryptHash(README_PASSWORD, README_PARAMS, README_SALT)
    expect(hash.toString('base64')).toBe(README_HASH)
  })

  it('stores the hash with an explicit scheme marker and the project parameters', () => {
    const stored = encodeFirebaseHash(README_PARAMS, { salt: README_SALT, passwordHash: README_HASH })!
    expect(stored).toBe(
      `$firebase-scrypt$v=1$mem=14,rounds=8$Bw==$${README_PARAMS.signerKey}$${README_SALT}$${README_HASH}`,
    )
    expect(isFirebaseHash(stored)).toBe(true)
    expect(isFirebaseHash('$2b$12$abcdefghijklmnopqrstuv')).toBe(false)
    const parsed = parseFirebaseHash(stored)!
    expect(parsed.rounds).toBe(8)
    expect(parsed.memoryCost).toBe(14)
    expect(parsed.hash.toString('base64')).toBe(README_HASH)
  })

  it('accepts the url-safe base64 Identity Toolkit returns, and stores it as standard base64', () => {
    const stored = encodeFirebaseHash(README_PARAMS, { salt: toUrlSafe(README_SALT), passwordHash: toUrlSafe(README_HASH) })
    expect(stored).toBe(encodeFirebaseHash(README_PARAMS, { salt: README_SALT, passwordHash: README_HASH }))
  })

  it('verifies the right password and refuses wrong ones, a changed salt and a changed hash', async () => {
    const stored = encodeFirebaseHash(README_PARAMS, { salt: README_SALT, passwordHash: README_HASH })!
    await expect(verifyFirebaseHash(README_PASSWORD, stored)).resolves.toBe(true)
    await expect(verifyFirebaseHash('user1password ', stored)).resolves.toBe(false)
    await expect(verifyFirebaseHash('User1password', stored)).resolves.toBe(false)
    await expect(verifyFirebaseHash('', stored)).resolves.toBe(false)

    const otherSalt = encodeFirebaseHash(README_PARAMS, { salt: 'AAxEC+ixf3L2lw==', passwordHash: README_HASH })!
    await expect(verifyFirebaseHash(README_PASSWORD, otherSalt)).resolves.toBe(false)

    const bytes = Buffer.from(README_HASH, 'base64')
    bytes[10] ^= 0x01
    const flipped = encodeFirebaseHash(README_PARAMS, { salt: README_SALT, passwordHash: bytes.toString('base64') })!
    await expect(verifyFirebaseHash(README_PASSWORD, flipped)).resolves.toBe(false)
  })

  it('refuses parameters outside Firebase range, so a stored value cannot ask for more work', async () => {
    expect(firebaseParamsProblem(README_PARAMS)).toBeNull()
    expect(firebaseParamsProblem({ ...README_PARAMS, rounds: 9 })).toMatch(/outside Firebase's own range/)
    expect(firebaseParamsProblem({ ...README_PARAMS, memoryCost: 15 })).toMatch(/outside Firebase's own range/)
    expect(firebaseParamsProblem({ ...README_PARAMS, signerKey: '' })).toMatch(/no signer key/)
    expect(firebaseParamsProblem(null)).toMatch(/did not return/)
    expect(encodeFirebaseHash({ ...README_PARAMS, memoryCost: 20 }, { salt: README_SALT, passwordHash: README_HASH })).toBeNull()

    const stored = encodeFirebaseHash(README_PARAMS, { salt: README_SALT, passwordHash: README_HASH })!
    const greedy = stored.replace('mem=14,rounds=8', 'mem=20,rounds=8')
    expect(parseFirebaseHash(greedy)).toBeNull()
    await expect(verifyFirebaseHash(README_PASSWORD, greedy)).resolves.toBe(false)
  })

  it('refuses malformed stored values and user halves', () => {
    expect(parseFirebaseHash('$firebase-scrypt$v=2$mem=14,rounds=8$a$b$c$d')).toBeNull()
    expect(parseFirebaseHash('$firebase-scrypt$v=1$mem=14,rounds=8$Bw==$x')).toBeNull()
    expect(parseFirebaseHash('$firebase-scrypt$v=1$mem=14,rounds=8$Bw==$not base64!$c$d')).toBeNull()
    // A hash must be exactly as long as the signer key (AES-CTR keeps the length).
    expect(encodeFirebaseHash(README_PARAMS, { salt: README_SALT, passwordHash: 'c2hvcnQ=' })).toBeNull()
    expect(encodeFirebaseHash(README_PARAMS, { salt: README_SALT, passwordHash: '' })).toBeNull()
  })
})

describe('end-user sign-in: a Firebase hash is accepted once, then replaced with bcrypt', () => {
  const firebaseStored = () => encodeFirebaseHash(README_PARAMS, { salt: README_SALT, passwordHash: README_HASH })!

  /** The users row's password column, and the compare-and-swap the route's UPDATE performs. */
  function row(initial: string) {
    const state = { password: initial, writes: 0 }
    const write = async (newHash: string, oldHash: string) => {
      state.writes++
      if (state.password !== oldHash) return false
      state.password = newHash
      return true
    }
    return { state, write }
  }

  it('signs in with the Firebase hash, stores bcrypt, and the Firebase hash is gone', async () => {
    const { state, write } = row(firebaseStored())

    const first = await checkEndUserPassword(README_PASSWORD, state.password)
    expect(first).toEqual({ valid: true, rehash: true })
    await expect(replaceImportedPasswordHash(README_PASSWORD, firebaseStored(), write)).resolves.toBe(true)

    expect(state.password.startsWith('$2')).toBe(true)
    expect(isFirebaseHash(state.password)).toBe(false)
    expect(await bcrypt.compare(README_PASSWORD, state.password)).toBe(true)
    // bcrypt at the product's cost factor (lib/auth/password.ts).
    expect(state.password.slice(0, 7)).toMatch(/^\$2[aby]\$12\$/)

    const second = await checkEndUserPassword(README_PASSWORD, state.password)
    expect(second).toEqual({ valid: true, rehash: false })
    expect(await checkEndUserPassword('wrong-password', state.password)).toEqual({ valid: false, rehash: false })
  })

  it('refuses a wrong password against a Firebase hash, and replaces nothing', async () => {
    const { state } = row(firebaseStored())
    expect(await checkEndUserPassword('not-the-password', state.password)).toEqual({ valid: false, rehash: false })
    expect(state.password).toBe(firebaseStored())
  })

  it('never overwrites a password reset that landed between the check and the write', async () => {
    const { state, write } = row(firebaseStored())
    const check = await checkEndUserPassword(README_PASSWORD, state.password)
    expect(check.rehash).toBe(true)
    state.password = await bcrypt.hash('a-newer-reset-password', 4)
    const newer = state.password
    await expect(replaceImportedPasswordHash(README_PASSWORD, firebaseStored(), write)).resolves.toBe(false)
    expect(state.password).toBe(newer)
  })

  it('answers no, at the decoy cost, when nothing is stored (no user, or a provider-only user)', async () => {
    expect(await checkEndUserPassword(README_PASSWORD, null)).toEqual({ valid: false, rehash: false })
    expect(await checkEndUserPassword(README_PASSWORD, undefined)).toEqual({ valid: false, rehash: false })
  })

  it('a stored Firebase value it cannot read is a wrong password, never an error', async () => {
    expect(await checkEndUserPassword(README_PASSWORD, '$firebase-scrypt$v=1$mem=14,rounds=8$garbage')).toEqual({ valid: false, rehash: false })
  })

  it('the SQL writer refuses an unsafe column name before reaching a database', () => {
    expect(() => endUserPasswordWriter('p1', 'workspace_p1', 'password"; DROP TABLE users; --', 'a@example.com')).toThrow(/Unexpected password column/)
    expect(typeof endUserPasswordWriter('p1', 'workspace_p1', 'password_hash', 'a@example.com')).toBe('function')
  })

  it('both sign-in servers run this check and replace an imported hash', () => {
    const root = path.resolve(__dirname, '../..')
    for (const file of ['app/api/v1/[projectId]/auth/signin/route.ts', 'server/routes/auth.ts']) {
      const src = fs.readFileSync(path.join(root, file), 'utf8')
      expect(src).toMatch(/from '@\/lib\/auth\/end-user-password'/)
      expect(src).toMatch(/checkEndUserPassword\(password, storedHash\)/)
      expect(src).toMatch(/replaceImportedPasswordHash\(password, storedHash, endUserPasswordWriter\(/)
      // The old direct bcrypt comparison would refuse every imported password.
      expect(src).not.toMatch(/verifyPassword\(password, storedHash\)/)
    }
  })
})

describe('every failed sign-in answers at the same moment, whatever was stored', () => {
  const firebaseStored = () => encodeFirebaseHash(README_PARAMS, { salt: README_SALT, passwordHash: README_HASH })!

  /** A clock a test moves by hand. */
  function scriptedClock() {
    let t = 1_000_000
    const sleeps: number[] = []
    const clock: CheckClock = {
      now: () => t,
      sleep: async (ms) => {
        sleeps.push(ms)
        t += ms
      },
    }
    return { clock, sleeps, advance: (ms: number) => (t += ms), at: () => t }
  }

  it('holds each failure to the floor, measured from the start of its check', async () => {
    // What each path costs on a normal day: the decoy for an unknown address, a
    // bcrypt comparison, and one scrypt plus the decoy for a Firebase account.
    const work = { unknownAddress: 262, bcryptAccount: 258, firebaseAccount: 305, providerOnlyAccount: 260 }
    const ends: Record<string, number> = {}
    for (const [kind, ms] of Object.entries(work)) {
      const { clock, sleeps, advance, at } = scriptedClock()
      const startedAt = at()
      const timer = startPasswordCheckTimer(clock)
      advance(ms) // the check's own work
      await timer.failed()
      ends[kind] = at() - startedAt
      expect(sleeps).toEqual([FAILED_CHECK_FLOOR_MS - ms])
    }
    expect(new Set(Object.values(ends))).toEqual(new Set([FAILED_CHECK_FLOOR_MS]))
  })

  it('holds work that ran past the floor to the next whole multiple, so loaded paths still share a boundary', () => {
    expect(failedCheckPadding(0)).toBe(1_000)
    expect(failedCheckPadding(-5)).toBe(1_000)
    expect(failedCheckPadding(Number.NaN)).toBe(1_000)
    expect(failedCheckPadding(999.5)).toBeCloseTo(0.5, 9)
    expect(failedCheckPadding(1_000)).toBe(0)
    // A bcrypt account and a Firebase account on a loaded server: the 45 ms of
    // scrypt between them disappears into the same boundary.
    expect(1_210 + failedCheckPadding(1_210)).toBe(2_000)
    expect(1_255 + failedCheckPadding(1_255)).toBe(2_000)
    expect(2_400 + failedCheckPadding(2_400, 1_000)).toBe(3_000)
    expect(130 + failedCheckPadding(130, 500)).toBe(500)
  })

  /**
   * The real checks, on the real hashes, with a clock that reads real time but
   * never waits: a sleep is recorded and added to it. What a failure costs is
   * then (the check's own measured time) + (the hold), read from the same
   * clock, so the assertion needs no tolerance and cannot be flaky. A floor far
   * above any machine's work keeps every path in the first boundary.
   */
  function virtualClock() {
    let held = 0
    const reads: number[] = []
    const sleeps: number[] = []
    const clock: CheckClock = {
      now: () => {
        const t = performance.now() + held
        reads.push(t)
        return t
      },
      sleep: async (ms) => {
        sleeps.push(ms)
        held += ms
      },
    }
    return { clock, reads, sleeps }
  }

  async function failureCost(storedHash: string | null, password: string) {
    const floor = 60_000
    const v = virtualClock()
    const timer = startPasswordCheckTimer(v.clock, floor)
    const check = await checkEndUserPassword(password, storedHash)
    expect(check.valid).toBe(false)
    await timer.failed()
    const work = v.reads[1] - v.reads[0]
    expect(v.sleeps).toHaveLength(1)
    return { work, total: work + v.sleeps[0], floor }
  }

  it('makes the real unknown-address, bcrypt and Firebase failures cost exactly the same', async () => {
    const bcryptStored = await bcrypt.hash(README_PASSWORD, 12)
    const unknown = await failureCost(null, 'a-wrong-password')
    const bcryptAccount = await failureCost(bcryptStored, 'a-wrong-password')
    const firebaseAccount = await failureCost(firebaseStored(), 'a-wrong-password')

    // CONTROL: each path did real work (a decoy, a comparison, a scrypt), so
    // the equal totals below come from the hold, not from paths that did nothing.
    for (const p of [unknown, bcryptAccount, firebaseAccount]) expect(p.work).toBeGreaterThan(20)

    for (const p of [unknown, bcryptAccount, firebaseAccount]) expect(p.total).toBeCloseTo(p.floor, 6)
  })

  it('never holds a success', async () => {
    for (const stored of [firebaseStored(), await bcrypt.hash(README_PASSWORD, 4)]) {
      const v = virtualClock()
      startPasswordCheckTimer(v.clock)
      const check = await checkEndUserPassword(README_PASSWORD, stored)
      expect(check.valid).toBe(true)
      // The routes call failed() only for a failure; a success answers as soon as it is known.
      expect(v.sleeps).toEqual([])
    }
  })

  it('both sign-in routes time the check and hold the failure before answering 401', () => {
    const root = path.resolve(__dirname, '../..')
    for (const file of ['app/api/v1/[projectId]/auth/signin/route.ts', 'server/routes/auth.ts']) {
      const src = fs.readFileSync(path.join(root, file), 'utf8')
      const timer = src.indexOf('const checkTimer = startPasswordCheckTimer()')
      const check = src.indexOf('const check = await checkEndUserPassword(password, storedHash)')
      const hold = src.indexOf('await checkTimer.failed()')
      const refuse = src.indexOf("'Invalid email or password', 401")
      expect(timer).toBeGreaterThan(0)
      // Started just before the check, held after it, and only then refused.
      expect(timer).toBeLessThan(check)
      expect(check).toBeLessThan(hold)
      expect(hold).toBeLessThan(refuse)
      expect(src.slice(timer, check).trim().split('\n')).toHaveLength(1)
      // Nothing answers 401 for a wrong password anywhere else in the route.
      expect(src.split("'Invalid email or password', 401").length).toBe(2)
    }
  })
})
