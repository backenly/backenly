/**
 * What would have to happen for a platform extension to work.
 *
 * The distinction these cases encode is the one that decides ownership: a
 * missing preload is instance configuration (parameter group, restart), while a
 * missing install is ordinary database provisioning. Collapsing them into
 * "missing" is how a five-minute fix and a reboot get planned as the same task.
 */

import { capabilityStatus, type ExtensionCapability } from '../../tools/migration-lineage/probe/capabilities'

const cap = (patch: Partial<ExtensionCapability>): ExtensionCapability => ({
  name: 'pgstattuple',
  available: true,
  availableVersion: '1.5',
  installedVersion: '1.5',
  operational: true,
  operationalError: null,
  needsPreload: false,
  preloaded: null,
  ...patch,
})

describe('capability status', () => {
  it('is operational only when it is installed and actually worked', () => {
    expect(capabilityStatus(cap({}))).toBe('operational')
    expect(capabilityStatus(cap({ operational: false, operationalError: 'boom' }))).toBe('installed_not_operational')
  })

  it('separates "not installed" from "not available on this server"', () => {
    expect(capabilityStatus(cap({ installedVersion: null, operational: null }))).toBe('available_not_installed')
    expect(capabilityStatus(cap({ available: false, availableVersion: null, installedVersion: null, operational: null }))).toBe('unavailable')
  })

  it('reports a missing preload as its own case, because the fix is a restart', () => {
    const pss = cap({ name: 'pg_stat_statements', needsPreload: true, preloaded: false, installedVersion: null, operational: null })
    expect(capabilityStatus(pss)).toBe('preload_missing')
    // Preload missing outranks "not installed": CREATE EXTENSION would fail.
    expect(capabilityStatus({ ...pss, installedVersion: '1.10' })).toBe('preload_missing')
  })

  it('treats a preloaded but uninstalled extension as ordinary provisioning', () => {
    const pss = cap({ name: 'pg_stat_statements', needsPreload: true, preloaded: true, installedVersion: null, operational: null })
    expect(capabilityStatus(pss)).toBe('available_not_installed')
  })

  it('does not require a preload verdict for extensions that need none', () => {
    expect(capabilityStatus(cap({ preloaded: null }))).toBe('operational')
  })
})
