/**
 * Backenly Cloud regions: one list, and a region can only be chosen once it
 * actually runs.
 *
 *   - The five decided regions are listed, each once, and only the home region
 *     (Mumbai, where Cloud runs today) is open.
 *   - A create request may name an open region or none at all. A region that is
 *     not on the list, or not open yet, is refused, never swapped for another,
 *     so nobody gets a project somewhere they did not ask for.
 *   - Every surface names a region the same way.
 *
 * When the next region opens, the "only Mumbai is open" case below is the one
 * to change, together with the infra, the Project.region column and routing
 * that lib/regions.ts lists.
 */
import { checkRequestedRegion, CLOUD_REGIONS, findRegion, HOME_REGION, regionLabel, stagingOpenRegions } from '@/lib/regions'

describe('Backenly Cloud regions', () => {
  it('lists the five decided regions, each once', () => {
    const ids = CLOUD_REGIONS.map((region) => region.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect([...ids].sort()).toEqual(['ap-south-1', 'ap-southeast-1', 'eu-central-1', 'us-east-1', 'us-west-2'])
  })

  it('opens only the home region, Mumbai, where Cloud runs today', () => {
    expect(HOME_REGION).toBe('ap-south-1')
    expect(CLOUD_REGIONS.filter((region) => region.open).map((region) => region.id)).toEqual([HOME_REGION])
  })

  it('names a region the same way everywhere, and reads an unknown id as home', () => {
    expect(regionLabel('ap-south-1')).toBe('Mumbai (ap-south-1)')
    expect(regionLabel('eu-central-1')).toBe('Frankfurt (eu-central-1)')
    expect(regionLabel(undefined)).toBe('Mumbai (ap-south-1)')
    expect(regionLabel('nowhere-1')).toBe('Mumbai (ap-south-1)')
    expect(findRegion('nowhere-1')).toBeUndefined()
  })

  describe('a create request', () => {
    it('without a region goes to the home region', () => {
      expect(checkRequestedRegion(undefined)).toEqual({ ok: true, region: HOME_REGION })
      expect(checkRequestedRegion(null)).toEqual({ ok: true, region: HOME_REGION })
      expect(checkRequestedRegion('')).toEqual({ ok: true, region: HOME_REGION })
    })

    it('naming an open region is accepted', () => {
      expect(checkRequestedRegion('ap-south-1')).toEqual({ ok: true, region: 'ap-south-1' })
    })

    it('naming a region that is not open yet is refused, not replaced', () => {
      for (const region of CLOUD_REGIONS.filter((r) => !r.open)) {
        const check = checkRequestedRegion(region.id)
        expect(check.ok).toBe(false)
        if (check.ok === false) {
          expect(check.code).toBe('REGION_NOT_OPEN')
          expect(check.message).toContain(region.city)
        }
      }
    })

    it('naming a region that does not exist is refused', () => {
      const check = checkRequestedRegion('eu-west-1')
      expect(check).toEqual(expect.objectContaining({ ok: false, code: 'UNKNOWN_REGION' }))
    })
  })

  describe('a region staging opens to qualify it before customers can choose it', () => {
    const staging = { BACKENLY_ENV: 'staging', BACKENLY_STAGING_OPEN_REGIONS: 'us-east-1, mars-north-1' }

    it('is accepted on staging only', () => {
      expect(checkRequestedRegion('us-east-1', staging)).toEqual({ ok: true, region: 'us-east-1' })
      expect(stagingOpenRegions(staging)).toEqual(new Set(['us-east-1']))
    })

    it('is ignored anywhere that is not staging, including production and an unset environment', () => {
      for (const env of [
        { ...staging, BACKENLY_ENV: 'production' },
        { ...staging, BACKENLY_ENV: undefined },
        { ...staging, BACKENLY_ENV: '' },
      ]) {
        expect(checkRequestedRegion('us-east-1', env)).toEqual(expect.objectContaining({ ok: false, code: 'REGION_NOT_OPEN' }))
        expect(stagingOpenRegions(env).size).toBe(0)
      }
    })

    it('opens only the regions it names, and never one this build does not know', () => {
      expect(checkRequestedRegion('eu-central-1', staging)).toEqual(expect.objectContaining({ ok: false, code: 'REGION_NOT_OPEN' }))
      expect(checkRequestedRegion('mars-north-1', staging)).toEqual(expect.objectContaining({ ok: false, code: 'UNKNOWN_REGION' }))
    })
  })
})
