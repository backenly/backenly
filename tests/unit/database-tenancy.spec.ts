/**
 * WHICH DATABASE A NEW PROJECT GETS: THE SWITCH
 * =============================================
 * BACKENLY_DEDICATED_DATABASES[_<REGION>] (lib/projects/database-tenancy.ts)
 * decides, per region, whether a new project gets a database of its own:
 * off (the default), staff (only accounts the platform's admin checks admit)
 * or new (every new project). Pinned here without a database: off and new
 * decide without reading anything. The staff case reads the account, and runs
 * against PostgreSQL in tests/integration/regional-bootstrap.spec.ts.
 */

import { dedicatedDatabasesMode, tenancyForNewProject } from '@/lib/projects/database-tenancy'
import { HOME_REGION } from '@/lib/regions'

const USER = '7b0c3a8e-2f6d-4a1b-9c5e-0d1f2a3b4c5d'

describe('the switch', () => {
  it('is off unless set, in every region', () => {
    expect(dedicatedDatabasesMode(HOME_REGION, {})).toEqual({ mode: 'off', variable: 'BACKENLY_DEDICATED_DATABASES' })
    expect(dedicatedDatabasesMode('us-east-1', {})).toEqual({ mode: 'off', variable: 'BACKENLY_DEDICATED_DATABASES_US_EAST_1' })
  })

  it('is read per region, and never the home value for another region', () => {
    const env = { BACKENLY_DEDICATED_DATABASES: 'new', BACKENLY_DEDICATED_DATABASES_EU_CENTRAL_1: 'staff' }
    expect(dedicatedDatabasesMode(HOME_REGION, env).mode).toBe('new')
    expect(dedicatedDatabasesMode('eu-central-1', env).mode).toBe('staff')
    expect(dedicatedDatabasesMode('us-west-2', env).mode).toBe('off')
  })

  it('reads a value it does not know as off, and says so once', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const env = { BACKENLY_DEDICATED_DATABASES_US_EAST_1: 'everyone' }
      expect(dedicatedDatabasesMode('us-east-1', env).mode).toBe('off')
      expect(dedicatedDatabasesMode('us-east-1', env).mode).toBe('off')
      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0][0])).toContain('BACKENLY_DEDICATED_DATABASES_US_EAST_1')
    } finally {
      warn.mockRestore()
    }
  })

  it('accepts its values in any case and with spaces around them', () => {
    expect(dedicatedDatabasesMode(HOME_REGION, { BACKENLY_DEDICATED_DATABASES: ' New ' }).mode).toBe('new')
    expect(dedicatedDatabasesMode(HOME_REGION, { BACKENLY_DEDICATED_DATABASES: 'STAFF' }).mode).toBe('staff')
  })
})

describe('a new project’s tenancy', () => {
  // The database here is unroutable: a decision that read anything would fail.
  it('is shared with the switch off, and dedicated with it on for new projects, reading nothing', async () => {
    expect(await tenancyForNewProject({ region: HOME_REGION, userId: USER }, {})).toBe('shared')
    expect(await tenancyForNewProject({ region: 'us-east-1', userId: USER }, { BACKENLY_DEDICATED_DATABASES: 'new' })).toBe('shared')
    expect(await tenancyForNewProject({ region: HOME_REGION, userId: USER }, { BACKENLY_DEDICATED_DATABASES: 'new' })).toBe('dedicated')
    expect(
      await tenancyForNewProject({ region: 'us-east-1', userId: USER }, { BACKENLY_DEDICATED_DATABASES_US_EAST_1: 'new' }),
    ).toBe('dedicated')
  })
})
