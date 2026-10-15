/**
 * Where a project's data lives: the region-to-connection registry.
 *
 * Pure functions with an injected environment, so this runs without a
 * database. The database-backed half, which proves a regional project's
 * queries reach the regional database and never the home one, is
 * tests/integration/project-region.spec.ts.
 */
import {
  RegionNotConfiguredError,
  UnknownRegionError,
  regionDatabaseUrl,
  regionEnvName,
  regionOfRecord,
  requireRegionDatabaseUrl,
  type DataPlaneRole,
} from '@/lib/data-plane/regional'
import { CLOUD_REGIONS, HOME_REGION } from '@/lib/regions'

const ROLES: DataPlaneRole[] = ['app', 'direct', 'backup', 'admin']

const ENV = {
  DATABASE_URL: 'postgresql://home.example.test/db',
  DATABASE_URL_US_EAST_1: 'postgresql://virginia.example.test/db',
  DATABASE_URL_US_WEST_2: '   ',
}

describe('regionEnvName', () => {
  it('keeps the home region on the variables it always used', () => {
    expect(ROLES.map((role) => regionEnvName(HOME_REGION, role))).toEqual([
      'DATABASE_URL',
      'DIRECT_URL',
      'BACKUP_DATABASE_URL',
      'BACKENLY_ADMIN_DATABASE_URL',
    ])
  })

  it('appends the region everywhere else', () => {
    expect(regionEnvName('us-east-1')).toBe('DATABASE_URL_US_EAST_1')
    expect(regionEnvName('eu-central-1', 'direct')).toBe('DIRECT_URL_EU_CENTRAL_1')
    expect(regionEnvName('ap-southeast-1', 'admin')).toBe('BACKENLY_ADMIN_DATABASE_URL_AP_SOUTHEAST_1')
  })

  it('gives every region and role a variable of its own', () => {
    const names = CLOUD_REGIONS.flatMap((region) => ROLES.map((role) => regionEnvName(region.id, role)))
    expect(new Set(names).size).toBe(names.length)
  })
})

describe('regionDatabaseUrl', () => {
  it("reads each region's own variable", () => {
    expect(regionDatabaseUrl(HOME_REGION, 'app', ENV)).toBe(ENV.DATABASE_URL)
    expect(regionDatabaseUrl('us-east-1', 'app', ENV)).toBe(ENV.DATABASE_URL_US_EAST_1)
  })

  it('never answers with the home database for another region', () => {
    expect(regionDatabaseUrl('eu-central-1', 'app', ENV)).toBeUndefined()
    expect(regionDatabaseUrl('us-east-1', 'direct', ENV)).toBeUndefined()
  })

  it('treats a blank variable as unset', () => {
    expect(regionDatabaseUrl('us-west-2', 'app', ENV)).toBeUndefined()
  })
})

describe('requireRegionDatabaseUrl', () => {
  it('refuses a region with no connection, naming the variable and the project', () => {
    let thrown: unknown
    try {
      requireRegionDatabaseUrl('eu-central-1', 'app', { env: ENV, projectId: 'p-frankfurt' })
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(RegionNotConfiguredError)
    const error = thrown as RegionNotConfiguredError
    expect(error.code).toBe('REGION_NOT_CONFIGURED')
    expect(error.region).toBe('eu-central-1')
    expect(error.variable).toBe('DATABASE_URL_EU_CENTRAL_1')
    expect(error.message).toContain('DATABASE_URL_EU_CENTRAL_1')
    expect(error.message).toContain('p-frankfurt')
    // A configuration error names variables, never connection strings.
    expect(error.message).not.toContain('postgresql://')
  })

  it('keeps the message the home region has always given', () => {
    expect(() => requireRegionDatabaseUrl(HOME_REGION, 'app', { env: {} })).toThrow('DATABASE_URL is not set')
  })

  it('returns the configured connection', () => {
    expect(requireRegionDatabaseUrl('us-east-1', 'app', { env: ENV })).toBe(ENV.DATABASE_URL_US_EAST_1)
  })
})

describe('regionOfRecord', () => {
  it('reads null as the home region', () => {
    expect(regionOfRecord('p', null)).toBe(HOME_REGION)
  })

  it('resolves a known region even before it opens', () => {
    // `open` decides where new projects may go, not whether one can be reached.
    expect(CLOUD_REGIONS.find((region) => region.id === 'us-east-1')?.open).toBe(false)
    expect(regionOfRecord('p', 'us-east-1')).toBe('us-east-1')
  })

  it('refuses a value this build does not know rather than reading it as home', () => {
    expect(() => regionOfRecord('p-odd', 'mars-north-1')).toThrow(UnknownRegionError)
    expect(() => regionOfRecord('p-odd', 'mars-north-1')).toThrow(/mars-north-1/)
    expect(() => regionOfRecord('p-odd', '')).toThrow(UnknownRegionError)
  })
})
