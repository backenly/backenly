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
  regionApiOrigin,
  regionDatabaseUrl,
  regionEnvName,
  regionOfRecord,
  regionPostgrest,
  regionSetting,
  requireRegionDatabaseUrl,
  type DataPlaneRole,
} from '@/lib/data-plane/regional'
import { CLOUD_REGIONS, HOME_REGION } from '@/lib/regions'
import { projectIdOfWorkspaceSchema } from '@/lib/security/workspace-schema'

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

describe('regionSetting', () => {
  const SETTING_ENV = {
    DIRECT_DB_HOST: 'db.home.test',
    DIRECT_DB_HOST_US_EAST_1: 'db.virginia.test',
    DIRECT_DB_HOST_US_WEST_2: '  ',
  }

  it('names and reads the home setting as is, and every other region’s with the region appended', () => {
    expect(regionSetting('DIRECT_DB_HOST', HOME_REGION, SETTING_ENV)).toEqual({
      variable: 'DIRECT_DB_HOST',
      value: 'db.home.test',
    })
    expect(regionSetting('DIRECT_DB_HOST', 'us-east-1', SETTING_ENV)).toEqual({
      variable: 'DIRECT_DB_HOST_US_EAST_1',
      value: 'db.virginia.test',
    })
  })

  it('never answers with the home value for another region, and treats blank as unset', () => {
    expect(regionSetting('DIRECT_DB_HOST', 'eu-central-1', SETTING_ENV)).toEqual({
      variable: 'DIRECT_DB_HOST_EU_CENTRAL_1',
      value: undefined,
    })
    expect(regionSetting('DIRECT_DB_HOST', 'us-west-2', SETTING_ENV).value).toBeUndefined()
  })
})

describe('regionPostgrest', () => {
  const POSTGREST_ENV = {
    POSTGREST_URL: 'http://postgrest.home.test:3000',
    POSTGREST_JWT_SECRET: 'home-secret',
    POSTGREST_URL_US_EAST_1: 'http://postgrest.virginia.test:3000',
    POSTGREST_JWT_SECRET_US_EAST_1: 'virginia-secret',
    POSTGREST_URL_US_WEST_2: 'http://postgrest.oregon.test:3000',
  }

  it('keeps the home region on POSTGREST_URL and POSTGREST_JWT_SECRET', () => {
    expect(regionPostgrest(HOME_REGION, POSTGREST_ENV)).toEqual({
      url: 'http://postgrest.home.test:3000',
      jwtSecret: 'home-secret',
    })
  })

  it("reads each region's own pair", () => {
    expect(regionPostgrest('us-east-1', POSTGREST_ENV)).toEqual({
      url: 'http://postgrest.virginia.test:3000',
      jwtSecret: 'virginia-secret',
    })
  })

  it('never answers with the home PostgREST for another region', () => {
    expect(regionPostgrest('eu-central-1', POSTGREST_ENV)).toBeNull()
  })

  it('needs both the URL and the secret', () => {
    // Oregon has a URL and no secret of its own; the home secret is not borrowed.
    expect(regionPostgrest('us-west-2', POSTGREST_ENV)).toBeNull()
    expect(regionPostgrest(HOME_REGION, { POSTGREST_URL: 'http://x.test', POSTGREST_JWT_SECRET: '  ' })).toBeNull()
  })
})

describe('regionApiOrigin', () => {
  const HOME = 'https://backenly.com'
  const API_ENV = {
    PUBLIC_API_ORIGIN: 'https://not-read-for-home.test',
    PUBLIC_API_ORIGIN_US_EAST_1: 'https://us-east-1.api.backenly.com/',
    PUBLIC_API_ORIGIN_US_WEST_2: '  ',
    PUBLIC_API_ORIGIN_EU_CENTRAL_1: 'eu-central-1.api.backenly.com',
  }

  it('answers the home region with the origin it was given, as before', () => {
    expect(regionApiOrigin(HOME_REGION, HOME, { env: API_ENV })).toBe(HOME)
  })

  it("answers another region with that region's own address, as an origin", () => {
    expect(regionApiOrigin('us-east-1', HOME, { env: API_ENV })).toBe('https://us-east-1.api.backenly.com')
  })

  it('never hands out the home address for another region', () => {
    for (const region of ['us-west-2', 'ap-southeast-1'] as const) {
      let caught: unknown
      try {
        regionApiOrigin(region, HOME, { env: API_ENV, projectId: 'p1' })
      } catch (err) {
        caught = err
      }
      expect(caught).toBeInstanceOf(RegionNotConfiguredError)
      expect((caught as RegionNotConfiguredError).variable).toBe(regionSetting('PUBLIC_API_ORIGIN', region).variable)
      expect((caught as Error).message).toContain('No API address for project p1')
    }
  })

  it('refuses a value that is not an http(s) URL', () => {
    expect(() => regionApiOrigin('eu-central-1', HOME, { env: API_ENV })).toThrow(RegionNotConfiguredError)
    expect(() => regionApiOrigin('eu-central-1', HOME, { env: { PUBLIC_API_ORIGIN_EU_CENTRAL_1: 'ftp://x.test' } }))
      .toThrow(/not an http\(s\) URL/)
  })
})

describe('projectIdOfWorkspaceSchema', () => {
  const id = '0b5c1a3e-7d2f-4c8e-9a61-3f0d2e4b5c6a'

  it("finds the project behind its own schema and the schemas named after it", () => {
    expect(projectIdOfWorkspaceSchema(`workspace_${id}`)).toBe(id)
    expect(projectIdOfWorkspaceSchema(`workspace_${id}_br_feature_x`)).toBe(id)
    expect(projectIdOfWorkspaceSchema(`workspace_${id}_staging`)).toBe(id)
  })

  it('answers null for anything else', () => {
    expect(projectIdOfWorkspaceSchema('public')).toBeNull()
    expect(projectIdOfWorkspaceSchema('workspace_not-a-uuid')).toBeNull()
    expect(projectIdOfWorkspaceSchema(`workspace_${id}-x`)).toBeNull()
    expect(projectIdOfWorkspaceSchema(`x_workspace_${id}`)).toBeNull()
  })
})
