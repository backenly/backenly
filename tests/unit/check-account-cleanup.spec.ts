/**
 * The timing of check-account cleanup (lib/services/check-account-cleanup.ts):
 * a sign-up a check gave up waiting for is purged again later, and each
 * project is swept for stale check accounts at most once an hour per process.
 * The purge itself is replaced: what is under test is when it is asked for.
 */
const purge = jest.fn(async (..._args: unknown[]) => [] as Array<{ table: string; deleted: number }>)
jest.mock('@/lib/services/end-user-auth-table', () => ({
  purgeSyntheticAuthArtifacts: (...args: unknown[]) => purge(...args),
}))

import {
  PURGE_AGAIN_AFTER_MS,
  STALE_CHECK_ACCOUNT_MINUTES,
  purgeAgainLater,
  resetCheckAccountSweeps,
  sweepStaleCheckAccounts,
} from '@/lib/services/check-account-cleanup'

beforeEach(() => {
  purge.mockClear()
  resetCheckAccountSweeps()
})

describe('purgeAgainLater', () => {
  afterEach(() => jest.useRealTimers())

  it("purges the address again once the delay has passed, and not before", async () => {
    jest.useFakeTimers()
    purgeAgainLater('p1', '__cv_late@backenly.internal')
    jest.advanceTimersByTime(PURGE_AGAIN_AFTER_MS - 1)
    expect(purge).not.toHaveBeenCalled()
    jest.advanceTimersByTime(1)
    await Promise.resolve()
    await new Promise(jest.requireActual('timers').setImmediate)
    expect(purge).toHaveBeenCalledWith('p1', { email: '__cv_late@backenly.internal' })
  })
})

describe('sweepStaleCheckAccounts', () => {
  it('sweeps a project for accounts older than the stale age, once an hour', async () => {
    purge.mockResolvedValueOnce([{ table: 'users', deleted: 2 }])
    const t = Date.UTC(2026, 10, 16, 12)
    expect(await sweepStaleCheckAccounts('p1', t)).toBe(2)
    expect(purge).toHaveBeenCalledWith('p1', { olderThanMinutes: STALE_CHECK_ACCOUNT_MINUTES })

    expect(await sweepStaleCheckAccounts('p1', t + 59 * 60_000)).toBe(0)
    expect(purge).toHaveBeenCalledTimes(1)

    await sweepStaleCheckAccounts('p2', t + 59 * 60_000)
    await sweepStaleCheckAccounts('p1', t + 60 * 60_000)
    expect(purge).toHaveBeenCalledTimes(3)
  })

  it('never throws', async () => {
    purge.mockRejectedValueOnce(new Error('database unreachable'))
    await expect(sweepStaleCheckAccounts('p1')).resolves.toBe(0)
  })
})
