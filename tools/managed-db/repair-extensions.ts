/**
 * LAYER 2 PARITY REPAIR — the real database, once, under stated preconditions.
 *
 * The rehearsal proved the mechanism in a scratch database. This is the same
 * mechanism pointed at a real one, and the difference is that it refuses unless
 * the database is in exactly the state the plan was made for.
 *
 * Every precondition is re-measured at run time rather than trusted from the
 * earlier discovery:
 *
 *   every required extension is available_not_installed
 *   the available version is the one parity expects
 *   pg_stat_statements is actually preloaded, with no restart pending
 *
 * If any of those has moved, this refuses and asks for a fresh plan instead of
 * "continuing with the other two". Installing a subset would leave the platform
 * in a state nobody designed.
 */

import { captureCapabilities, capabilityStatus, type CapabilityReport } from '../migration-lineage/probe/capabilities'
import type { PgClient } from '../migration-lineage/probe/connect'
import { REQUIRED_EXTENSIONS, REQUIRED_EXTENSION_NAMES, extensionSpec } from './extension-spec'
import {
  extensionIdentities,
  provisionExtensions,
  ProvisionRefusal,
  type ExtensionIdentity,
  type ProvisionOutcome,
} from './provision-extensions'

export interface RepairExpectations {
  /** Version each extension must be available at, from the parity reference. */
  availableVersions: Record<string, string>
}

export interface RepairResult {
  repair: 'layer2-extensions'
  version: 1
  startedAt: string
  finishedAt: string
  verdict: 'PASS' | 'FAIL' | 'REFUSED' | 'INCONCLUSIVE'
  failures: string[]
  refusals: string[]
  database: string | null
  before: CapabilityReport | null
  beforeStatuses: Array<{ name: string; status: string }>
  outcome: ProvisionOutcome | null
  after: CapabilityReport | null
  afterStatuses: Array<{ name: string; status: string }>
  identities: ExtensionIdentity[]
  error: string | null
}

const statuses = (report: CapabilityReport) =>
  report.extensions.map(e => ({ name: e.name, status: capabilityStatus(e) }))

/**
 * Everything that must be true before a single statement runs.
 *
 * Returns the reasons rather than throwing, so the caller can report all of them
 * at once instead of one per attempt.
 */
export function checkRepairPreconditions(report: CapabilityReport, expectations: RepairExpectations): string[] {
  const reasons: string[] = []
  const byName = new Map(report.extensions.map(e => [e.name, e]))

  for (const name of REQUIRED_EXTENSION_NAMES) {
    const capability = byName.get(name)
    if (!capability) {
      reasons.push(`${name}: no capability reading`)
      continue
    }
    const status = capabilityStatus(capability)
    if (status !== 'available_not_installed') {
      reasons.push(`${name}: expected available_not_installed, measured ${status}`)
    }
    const expectedVersion = expectations.availableVersions[name]
    if (expectedVersion && capability.availableVersion !== expectedVersion) {
      reasons.push(`${name}: available version is ${capability.availableVersion}, parity expects ${expectedVersion}`)
    }
  }

  // Layer 1 is a precondition of Layer 2, not something Layer 2 may work around.
  const preloadNeeded = REQUIRED_EXTENSIONS.filter(s => s.requiresPreload)
  for (const spec of preloadNeeded) {
    const capability = byName.get(spec.name)
    if (capability && capability.preloaded !== true) {
      reasons.push(`${spec.name}: not preloaded; Layer 1 owns this`)
    }
  }
  if (report.sharedPreloadLibraries?.pendingRestart === true) {
    reasons.push('the server has a pending restart; shared_preload_libraries is not settled')
  }
  if (!report.sharedPreloadLibraries) {
    reasons.push('shared_preload_libraries could not be read')
  }

  return reasons
}

export async function repairExtensions(client: PgClient, expectations: RepairExpectations): Promise<RepairResult> {
  const r: RepairResult = {
    repair: 'layer2-extensions',
    version: 1,
    startedAt: new Date().toISOString(),
    finishedAt: '',
    verdict: 'INCONCLUSIVE',
    failures: [],
    refusals: [],
    database: null,
    before: null,
    beforeStatuses: [],
    outcome: null,
    after: null,
    afterStatuses: [],
    identities: [],
    error: null,
  }

  try {
    r.database = (await client.query('SELECT current_database() AS database')).rows[0]?.database ?? null

    const recapture = (c: PgClient) => captureCapabilities(c, REQUIRED_EXTENSION_NAMES)
    const before = await recapture(client)
    r.before = before
    r.beforeStatuses = statuses(before)

    const reasons = checkRepairPreconditions(before, expectations)
    if (reasons.length > 0) {
      r.refusals = reasons
      r.verdict = 'REFUSED'
      r.finishedAt = new Date().toISOString()
      return r
    }

    r.outcome = await provisionExtensions(client, before, recapture)
    for (const f of r.outcome.failures) r.failures.push(f)

    const after = await recapture(client)
    r.after = after
    r.afterStatuses = statuses(after)
    for (const s of r.afterStatuses) {
      if (s.status !== 'operational') r.failures.push(`${s.name} is ${s.status} after repair`)
    }

    r.identities = await extensionIdentities(client)
    for (const identity of r.identities) {
      const expected = extensionSpec(identity.name)?.expectedSchema
      if (expected && identity.schema !== expected) {
        r.failures.push(`${identity.name} landed in schema ${identity.schema}, expected ${expected}`)
      }
    }
    if (r.identities.length !== REQUIRED_EXTENSION_NAMES.length) {
      r.failures.push(`only ${r.identities.length} of ${REQUIRED_EXTENSION_NAMES.length} extensions are present after repair`)
    }
  } catch (err) {
    r.error = err instanceof Error ? err.message : String(err)
    if (err instanceof ProvisionRefusal) {
      r.refusals.push(r.error)
      r.verdict = 'REFUSED'
      r.finishedAt = new Date().toISOString()
      return r
    }
    r.failures.push(`repair error: ${r.error}`)
  }

  r.finishedAt = new Date().toISOString()
  r.verdict = r.refusals.length ? 'REFUSED' : r.failures.length ? 'FAIL' : 'PASS'
  return r
}
