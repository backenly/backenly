/**
 * Managed platform capabilities, read from the server rather than assumed.
 *
 * The three platform extensions have different operational semantics, and the
 * difference decides who owns fixing them:
 *
 *   pg_stat_statements  needs shared_preload_libraries and a restart. On RDS
 *                       that is parameter-group and reboot semantics, so it can
 *                       cross out of the database and into the instance.
 *   pgstattuple         ordinary database-level provisioning, no preload.
 *   vector              ordinary database-level provisioning, no preload.
 *
 * So this reports four separate facts per extension: is the package available on
 * this server at all, is it installed in this database, at what version, and
 * does it actually work. "Installed" is not the same as "operational", and for
 * pg_stat_statements neither is the same as "preloaded".
 *
 * Every statement here is a read. The parameter group says what is CONFIGURED;
 * `SHOW shared_preload_libraries` says what the running server actually has.
 */

import type { PgClient } from './connect'

export interface ExtensionCapability {
  name: string
  /** Present in pg_available_extensions: the package exists on this server. */
  available: boolean
  availableVersion: string | null
  /** Non-null when installed in THIS database. */
  installedVersion: string | null
  /** Whether a harmless use of it succeeded. Null when it is not installed. */
  operational: boolean | null
  operationalError: string | null
  /** True for extensions that need shared_preload_libraries. */
  needsPreload: boolean
  preloaded: boolean | null
}

export interface CapabilityReport {
  sharedPreloadLibraries: {
    setting: string
    source: string
    context: string
    pendingRestart: boolean
  } | null
  extensions: ExtensionCapability[]
}

import { extensionSpec, REQUIRED_EXTENSION_NAMES } from '../../managed-db/extension-spec'

export async function captureCapabilities(client: PgClient, names: string[]): Promise<CapabilityReport> {
  const settings = await client.query(
    `SELECT setting, source, context, pending_restart
       FROM pg_settings WHERE name = 'shared_preload_libraries'`,
  )
  const preload = settings.rows[0]
    ? {
        setting: String(settings.rows[0].setting ?? ''),
        source: String(settings.rows[0].source ?? ''),
        context: String(settings.rows[0].context ?? ''),
        pendingRestart: settings.rows[0].pending_restart === true,
      }
    : null

  const loaded = new Set(
    (preload?.setting ?? '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean),
  )

  const available = await client.query(
    `SELECT name, default_version, installed_version
       FROM pg_available_extensions WHERE name = ANY($1) ORDER BY name`,
    [names],
  )
  const byName = new Map(available.rows.map(r => [String(r.name), r]))

  const extensions: ExtensionCapability[] = []
  for (const name of [...names].sort()) {
    const row = byName.get(name)
    const spec = extensionSpec(name)
    const installedVersion = (row?.installed_version as string | null) ?? null
    let operational: boolean | null = null
    let operationalError: string | null = null

    if (installedVersion && spec) {
      try {
        await client.query(spec.operationalProbe)
        operational = true
      } catch (err) {
        operational = false
        operationalError = err instanceof Error ? err.message : String(err)
      }
    }

    extensions.push({
      name,
      available: Boolean(row),
      availableVersion: (row?.default_version as string | null) ?? null,
      installedVersion,
      operational,
      operationalError,
      needsPreload: spec?.requiresPreload ?? false,
      preloaded: spec?.requiresPreload ? loaded.has(name) : null,
    })
  }

  return { sharedPreloadLibraries: preload, extensions }
}

/** The extensions this platform depends on, defined in tools/managed-db/extension-spec.ts. */
export const PLATFORM_EXTENSIONS = REQUIRED_EXTENSION_NAMES

export type CapabilityStatus =
  | 'operational'
  | 'installed_not_operational'
  | 'available_not_installed'
  | 'preload_missing'
  | 'unavailable'

/**
 * What would have to happen for this extension to work, which is the question
 * the baseline project actually needs answered.
 */
export function capabilityStatus(cap: ExtensionCapability): CapabilityStatus {
  if (!cap.available) return 'unavailable'
  if (cap.needsPreload && cap.preloaded === false) return 'preload_missing'
  if (!cap.installedVersion) return 'available_not_installed'
  return cap.operational === false ? 'installed_not_operational' : 'operational'
}
