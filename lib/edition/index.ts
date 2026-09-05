/**
 * Edition resolution: which implementation of the seams is in force.
 *
 * `BACKENLY_EDITION` selects it. Today the default is `cloud`, so this commit
 * changes no running behaviour; the default flips to `single-tenant` in the
 * commit that makes a fresh public clone a self-host install with no
 * configuration.
 *
 * Both providers are imported statically here, and that is temporary. Once the
 * Cloud control plane lives in the private repository, the cloud provider is
 * loaded dynamically and a `cloud` edition that cannot load its provider must
 * EXIT rather than fall back. Falling back would be the worst available
 * outcome: the single-tenant resolver treats every authenticated user as an
 * operator, so running it against the multi-tenant production database would
 * hand any logged-in user somebody else's project. The count guard in
 * single-tenant/project-resolver.ts is the backstop for exactly that mistake
 * and is already live.
 */
import { cloudFleetScheduler } from './cloud/fleet-scheduler'
import { cloudProjectLifecycle } from './cloud/project-lifecycle'
import { cloudProjectResolver } from './cloud/project-resolver'
import { singleTenantFleetScheduler } from './single-tenant/fleet-scheduler'
import { singleTenantProjectLifecycle } from './single-tenant/project-lifecycle'
import { singleTenantProjectResolver } from './single-tenant/project-resolver'
import type { Edition, ProjectLifecycle, ProjectResolver } from './types'
import type { FleetScheduler } from './fleet-types'

export * from './types'
export * from './fleet-types'

const DEFAULT_EDITION: Edition = 'cloud'

export function currentEdition(): Edition {
  const raw = process.env.BACKENLY_EDITION?.trim().toLowerCase()
  if (!raw) return DEFAULT_EDITION
  if (raw === 'cloud' || raw === 'single-tenant') return raw
  // A typo must not silently pick an edition. Choosing wrong in either
  // direction is an authorization outcome, not a configuration nicety.
  throw new Error(
    `BACKENLY_EDITION must be "cloud" or "single-tenant", got "${raw}".`
  )
}

/**
 * The one authority for project access.
 *
 * Read per call rather than captured at module load, so tests and a future
 * hot-reload of configuration cannot end up holding a stale edition.
 */
export function getProjectResolver(): ProjectResolver {
  return currentEdition() === 'single-tenant' ? singleTenantProjectResolver : cloudProjectResolver
}

/**
 * Who may create and list projects, and what creating one does.
 *
 * Read per call for the same reason as the resolver: the edition is a
 * configuration value, and capturing it at module load is how a test that sets
 * BACKENLY_EDITION ends up asserting against the previous one.
 */
export function getProjectLifecycle(): ProjectLifecycle {
  return currentEdition() === 'single-tenant' ? singleTenantProjectLifecycle : cloudProjectLifecycle
}

/**
 * Which projects a scheduled or background pass runs against.
 *
 * Per-project execution stays public and unchanged: this answers only WHICH,
 * never WHAT. See lib/edition/fleet-types.ts for why the interface is this
 * narrow.
 */
export function getFleetScheduler(): FleetScheduler {
  return currentEdition() === 'single-tenant' ? singleTenantFleetScheduler : cloudFleetScheduler
}
