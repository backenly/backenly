/**
 * ONE TENANT MUST NEVER BE ABLE TO EXPORT EVERYBODY
 * ================================================
 * Deployment recovery reads the whole platform database: every project, every
 * account, every key and every stored secret. In a self-hosted install that is
 * right, because the single account IS the operator of the machine and the data
 * is already theirs - `lib/edition/guard.ts` states the same rule for projects.
 *
 * In Cloud the identical code path would be one tenant exporting everyone. No
 * role makes that acceptable, so the boundary is the EDITION rather than a
 * permission: a check that cannot be satisfied by granting somebody more.
 *
 * The ordering matters as much as the check. The edition refusal runs before
 * authentication, so it cannot be reached by way of an auth failure, and it
 * answers 404 rather than 403 - in Cloud the capability does not exist, and a
 * 403 would say it is there and merely withheld.
 */

import {
  assertSingleTenantEdition,
  assertCloudEdition,
  SelfHostOnlyFeatureError,
  CloudOnlyFeatureError,
} from '@/lib/edition/cloud-only'

const ORIGINAL_EDITION = process.env.BACKENLY_EDITION

afterEach(() => {
  if (ORIGINAL_EDITION === undefined) delete process.env.BACKENLY_EDITION
  else process.env.BACKENLY_EDITION = ORIGINAL_EDITION
})

describe('the self-host-only guard', () => {
  it('permits an unset edition, which is a self-hosted install', () => {
    // The default, and the one that has to work. A guard that refused the
    // normal configuration would be deleted within a day.
    delete process.env.BACKENLY_EDITION
    expect(() => assertSingleTenantEdition('Deployment recovery')).not.toThrow()
  })

  it('permits an explicit single-tenant edition', () => {
    process.env.BACKENLY_EDITION = 'single-tenant'
    expect(() => assertSingleTenantEdition('Deployment recovery')).not.toThrow()
  })

  it('REFUSES in Cloud', () => {
    process.env.BACKENLY_EDITION = 'cloud'
    expect(() => assertSingleTenantEdition('Deployment recovery'))
      .toThrow(SelfHostOnlyFeatureError)
  })

  it('names the capability it refused', () => {
    process.env.BACKENLY_EDITION = 'cloud'
    try {
      assertSingleTenantEdition('Deployment recovery')
      throw new Error('expected a refusal')
    } catch (err) {
      expect((err as SelfHostOnlyFeatureError).feature).toBe('Deployment recovery')
      expect((err as Error).message).toMatch(/not available in Backenly Cloud/i)
    }
  })

  it('is the exact mirror of the Cloud-only guard', () => {
    // The two must never both permit, or both refuse, in the same edition -
    // that would mean one of them is not actually keyed to the edition.
    for (const edition of ['cloud', 'single-tenant']) {
      process.env.BACKENLY_EDITION = edition
      const selfHostRefused = (() => {
        try { assertSingleTenantEdition('x'); return false } catch { return true }
      })()
      const cloudRefused = (() => {
        try { assertCloudEdition('x'); return false } catch { return true }
      })()
      expect(selfHostRefused).toBe(!cloudRefused)
    }
  })

  it('throws distinct error types, so a caller can map them differently', () => {
    process.env.BACKENLY_EDITION = 'cloud'
    expect(() => assertSingleTenantEdition('x')).toThrow(SelfHostOnlyFeatureError)
    process.env.BACKENLY_EDITION = 'single-tenant'
    expect(() => assertCloudEdition('x')).toThrow(CloudOnlyFeatureError)
  })
})

describe('the export route', () => {
  async function callExport(): Promise<Response> {
    // Imported inside the test so the module is evaluated with the edition this
    // test has set, rather than whatever was in the environment at load.
    const { POST } = await import('@/app/api/deployment/recovery/export/route')
    return POST()
  }

  it('is not there at all in Cloud', async () => {
    process.env.BACKENLY_EDITION = 'cloud'
    const response = await callExport()
    expect(response.status).toBe(404)
  })

  it('refuses in Cloud BEFORE it authenticates anybody', async () => {
    // The ordering property. If authentication ran first, an unauthenticated
    // Cloud request would get 401 - which would be a hint that the capability
    // exists and is merely gated, and a signed-in tenant would then reach code
    // that reads every other tenant's data.
    process.env.BACKENLY_EDITION = 'cloud'
    const response = await callExport()
    expect(response.status).toBe(404)
    expect(response.status).not.toBe(401)
  })

  it('answers 404 rather than 403, so it does not advertise itself', async () => {
    process.env.BACKENLY_EDITION = 'cloud'
    const response = await callExport()
    const body = await response.json()
    expect(response.status).toBe(404)
    expect(body.error).toBe('Not found')
  })

  it('gets past the edition gate in self-host and asks who is calling', async () => {
    // Proves the 404 above is the EDITION refusing rather than the route being
    // broken. With no session cookie this reaches authentication and stops
    // there, which is the next check in line.
    delete process.env.BACKENLY_EDITION
    const response = await callExport()
    expect(response.status).toBe(401)
  })
})
