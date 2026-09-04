/**
 * SELF-HOSTED RUNS WITHOUT BILLING, AND WITHOUT A SECOND PROJECT
 * ==============================================================
 * Two invariants of the single-tenant edition that have nothing to do with
 * authorization, and everything to do with whether a fresh clone actually runs.
 *
 * 1. Entitlements resolve with no Plan and no Subscription row.
 *
 *    `resolveFreePlan()` THROWS when neither SANDBOX nor FREE exists, so an
 *    unseeded database used to break signup and checkout on a fresh self-host
 *    install. That is not a hypothetical: the README quickstart omitted
 *    `npm run db:seed` entirely, so the documented path produced exactly that
 *    database. Single-tenant now answers from a constant.
 *
 * 2. Application code cannot create a second project.
 *
 *    One deployment is one project. The one project is provisioned by
 *    `npm run bootstrap`, which reconciles rather than inserts, so creation
 *    afterwards is refused rather than silently producing the two-project state
 *    the resolver would then refuse to operate against.
 *
 * Database-free on purpose: both paths short-circuit on the edition before
 * touching Prisma, and asserting that they do so is half the point.
 */

import { getUserEntitlements } from '@/lib/billing'
import {
  createProvisionedProject,
  ProjectCreationUnsupportedError,
} from '@/lib/projects/provision'

const ORIGINAL = process.env.BACKENLY_EDITION

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.BACKENLY_EDITION
  else process.env.BACKENLY_EDITION = ORIGINAL
})

describe('single-tenant entitlements', () => {
  beforeEach(() => {
    process.env.BACKENLY_EDITION = 'single-tenant'
  })

  it('resolves without a Plan or Subscription row', async () => {
    // The unroutable placeholder URL is in force for this suite, so anything
    // that reached the database here would throw rather than pass.
    const ent = await getUserEntitlements('any-user-id')

    expect(ent).not.toBeNull()
    expect(ent!.planName).toBe('SELF_HOSTED')
  })

  it('meters nothing an operator already pays for', async () => {
    const ent = (await getUserEntitlements('any-user-id'))!

    // null means unlimited throughout lib/billing, which is the same shape the
    // quota kernel already understands, so nothing downstream needs an edition
    // check of its own.
    expect(ent.monthlyAiCredits).toBeNull()
    expect(ent.maxApiRequestsPerMonth).toBeNull()
    expect(ent.maxPostgresStorageMb).toBeNull()
    expect(ent.maxFileStorageMb).toBeNull()
    expect(ent.maxRealtimeConnections).toBeNull()
    expect(ent.maxAiFunctionInvocationsPerMonth).toBeNull()
    expect(ent.maxTriggersPerProject).toBeNull()
    expect(ent.maxDeploymentHistory).toBeNull()

    expect(ent.allowDeployment).toBe(true)
    expect(ent.allowWebhooks).toBe(true)
    expect(ent.allowCustomDomain).toBe(true)
    expect(ent.allowDeploymentRollback).toBe(true)
  })

  it('caps projects at one, because that is the edition', async () => {
    const ent = (await getUserEntitlements('any-user-id'))!
    expect(ent.maxProjects).toBe(1)
  })

  it('reports RBAC and SSO as absent rather than withheld', async () => {
    const ent = (await getUserEntitlements('any-user-id'))!
    // Organizations, roles and invites are the Cloud control plane. These are
    // false because the layer does not exist here, not because it is paywalled.
    expect(ent.allowRbac).toBe(false)
    expect(ent.allowSso).toBe(false)
  })
})

describe('single-tenant project creation', () => {
  it('refuses a second project, before touching the database', async () => {
    process.env.BACKENLY_EDITION = 'single-tenant'

    await expect(
      createProvisionedProject({ name: 'second', userId: 'any-user-id' })
    ).rejects.toBeInstanceOf(ProjectCreationUnsupportedError)
  })

  it('explains where the one project comes from', async () => {
    process.env.BACKENLY_EDITION = 'single-tenant'

    const err = await createProvisionedProject({ name: 'second', userId: 'any' }).then(
      () => null,
      (e: Error) => e
    )

    // A refusal that does not say what to do instead is a dead end for whoever
    // hits it, which on a self-hosted install is the operator.
    expect(err!.message).toMatch(/bootstrap/)
    expect(err!.message).toMatch(/one deployment is one project/i)
  })
})
