/**
 * Edition resolution: which implementation of the seams is in force.
 *
 * `BACKENLY_EDITION` selects it, and the DEFAULT is `single-tenant`: a fresh
 * public clone is a self-host install with no configuration at all. Cloud is
 * the thing you opt into, never the thing you land on by forgetting.
 *
 * Both edition objects are imported statically here, and that is correct rather
 * than temporary: the files below are thin ADAPTERS, not implementations. Since
 * Phase 7 the Cloud control plane lives in the private repository and is reached
 * through the `@cloud/*` alias, which resolves `lib/cloud/*` when an overlay has
 * been composed and `lib/edition/oss/*` when it has not. So a public checkout
 * type-checks and builds with every one of these imports present, and the thing
 * that varies is what the alias resolved to.
 *
 * A `cloud` edition that has no private provider must EXIT rather than fall
 * back. Falling back would be the worst available outcome: the single-tenant
 * resolver treats every authenticated user as an operator, so running it
 * against the multi-tenant production database would hand any logged-in user
 * somebody else's project. That refusal is assertEditionCompositionOrExit in
 * lib/edition/cloud-extension.ts, and it matters more now than it did before
 * Phase 8, because single-tenant is what an unconfigured process resolves to.
 * The count guard in single-tenant/project-resolver.ts is the second backstop.
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

/**
 * An unconfigured Backenly is a self-hosted, single-project deployment.
 *
 * This is safe only BECAUSE an explicit `cloud` fails closed: a Cloud process
 * with no private overlay exits at startup rather than falling back here. See
 * lib/edition/cloud-extension.ts. Without that, a Cloud deployment whose
 * environment failed to load would quietly adopt the single-tenant resolver,
 * which treats every authenticated account as an operator of whichever project
 * it names -- a cross-tenant bypass produced by a missing variable.
 *
 * Contract pinned in __tests__/edition/default-edition.test.ts.
 */
const DEFAULT_EDITION: Edition = 'single-tenant'

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
