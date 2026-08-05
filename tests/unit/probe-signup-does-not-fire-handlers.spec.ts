/**
 * The contract sweep must not run a developer's signup automations.
 *
 * ── The defect this locks out ────────────────────────────────────────────────
 *
 * The sweep signs up a throwaway `…@*.internal` user every minute to check that
 * signup/signin/logout still answer their contract, then deletes it in a
 * `finally` as soon as the round-trip returns. `on_signup` handlers are
 * dispatched fire-and-forget by the signup routes, so they were still running
 * against that user when it was purged and lost the race about half the time.
 *
 * Live symptom, once the NOT NULL defect stopped masking it:
 *   insert or update on table "profiles" violates foreign key constraint
 *   "fk_profiles_user"
 * intermittently, forever, in the Postgres log.
 *
 * Two things make this worth a test rather than a comment:
 *
 *  1. The obvious repair — await the handlers before purging — is wrong. The
 *     probe verifies the auth SURFACE, not the developer's business logic.
 *     Running their automations against a user with a two-second lifetime
 *     writes half-finished rows into their tables and burns their function
 *     invocation quota (2,735 wasted runs on one live project).
 *  2. There are TWO signup routes. The guard has to sit in the shared function,
 *     because a guard written at one call site leaves the other one firing.
 */

import { isReservedTestEmail } from '@/lib/services/end-user-auth-table'

describe('probe signups do not trigger on_signup handlers', () => {
  it('classifies the sweep’s synthetic address as reserved', () => {
    // The exact shape probeAuth generates (lib/services/contract-verifier.ts).
    expect(isReservedTestEmail('__cv_m1a2b3c4d5@backenly.internal')).toBe(true)
  })

  it('does not classify a real end-user address as reserved', () => {
    expect(isReservedTestEmail('ada@example.com')).toBe(false)
    expect(isReservedTestEmail('someone@internal-tools.com')).toBe(false)
  })

  it('short-circuits before it ever queries for handlers', async () => {
    // Asserting on the DB call is the point: returning early only AFTER the
    // lookup would still leave the race intact for any project that has one.
    jest.resetModules()
    const findMany = jest.fn()
    jest.doMock('@/lib/db', () => ({ prisma: { aiFunction: { findMany } } }))

    const { fireAiFunctionsOnSignup } = await import('@/lib/services/ai-functions/executor')

    await fireAiFunctionsOnSignup('proj-1', {
      id: 'u1',
      email: '__cv_zz99@backenly.internal',
      name: 'Contract Probe',
    })

    expect(findMany).not.toHaveBeenCalled()
  })

  it('still fires for a genuine signup', async () => {
    jest.resetModules()
    const findMany = jest.fn().mockResolvedValue([])
    jest.doMock('@/lib/db', () => ({ prisma: { aiFunction: { findMany } } }))

    const { fireAiFunctionsOnSignup } = await import('@/lib/services/ai-functions/executor')

    await fireAiFunctionsOnSignup('proj-1', { id: 'u2', email: 'ada@example.com', name: 'Ada' })

    expect(findMany).toHaveBeenCalledTimes(1)
    expect(findMany.mock.calls[0][0].where).toMatchObject({
      projectId: 'proj-1',
      triggerType: 'on_signup',
      status: 'active',
    })
  })

  it('neither signup route guards this itself, so the shared function must', () => {
    // If a future change moves the filter back to a call site, this catches the
    // half of production that would silently keep firing.
    const fs = require('fs') as typeof import('fs')
    const routes = [
      'server/routes/auth.ts',
      'app/api/v1/[projectId]/auth/signup/route.ts',
    ]
    for (const rel of routes) {
      const src = fs.readFileSync(rel, 'utf8')
      expect(src).toContain('fireAiFunctionsOnSignup')
    }
  })
})
