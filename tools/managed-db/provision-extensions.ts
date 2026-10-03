/**
 * LAYER 2: provision the extensions a managed Backenly database requires.
 *
 * The only mutation this module can express is `CREATE EXTENSION IF NOT EXISTS`
 * on a name that appears in the closed REQUIRED_EXTENSIONS manifest. It cannot
 * drop an extension, cannot touch roles, grants, server settings or Layer 4
 * provisioning, and cannot be pointed at an arbitrary name from a CLI or
 * environment variable.
 *
 * The dependency runs one way: this module imports the read-only spec, and the
 * spec must never import this. That is what keeps the spec safe to bundle into
 * the read-only production capture.
 *
 * ── Why it refuses more often than it installs ──────────────────────────────
 *
 * Only `available_not_installed` is eligible. Everything else is a different
 * problem with a different owner, and in particular an installed extension that
 * does not work is NOT repaired by dropping and recreating it: an extension can
 * own objects and data, so that is a diagnosis, not a fix.
 */

import type { CapabilityReport, ExtensionCapability } from '../migration-lineage/probe/capabilities'
import { capabilityStatus, type CapabilityStatus } from '../migration-lineage/probe/capabilities'
import type { PgClient } from '../migration-lineage/probe/connect'
import { REQUIRED_EXTENSION_NAMES, REQUIRED_EXTENSIONS, extensionSpec } from './extension-spec'

export class ProvisionRefusal extends Error {}

export type ProvisionDecision = 'install' | 'already_operational' | 'refuse'

export interface ProvisionStep {
  name: string
  status: CapabilityStatus
  decision: ProvisionDecision
  reason: string
}

export interface ProvisionPlan {
  steps: ProvisionStep[]
  installable: string[]
  refusals: ProvisionStep[]
}

const DECISION: Record<CapabilityStatus, { decision: ProvisionDecision; reason: string }> = {
  operational: { decision: 'already_operational', reason: 'installed and proven to work; nothing to do' },
  available_not_installed: { decision: 'install', reason: 'available on this server and not installed' },
  preload_missing: {
    decision: 'refuse',
    reason: 'shared_preload_libraries does not load it; CREATE EXTENSION would fail. Layer 1 owns this',
  },
  unavailable: { decision: 'refuse', reason: 'the package is not available on this server; engine or image problem' },
  installed_not_operational: {
    decision: 'refuse',
    reason: 'installed but not working. An extension can own objects and data, so this is diagnosed, never dropped and recreated',
  },
}

export function planExtensionProvisioning(report: CapabilityReport): ProvisionPlan {
  const byName = new Map(report.extensions.map(e => [e.name, e]))
  const steps: ProvisionStep[] = REQUIRED_EXTENSIONS.map(spec => {
    const capability = byName.get(spec.name)
    if (!capability) {
      return { name: spec.name, status: 'unavailable', decision: 'refuse', reason: 'no capability reading for this extension' }
    }
    const status = capabilityStatus(capability)
    return { name: spec.name, status, ...DECISION[status] }
  })

  return {
    steps,
    installable: steps.filter(s => s.decision === 'install').map(s => s.name),
    refusals: steps.filter(s => s.decision === 'refuse'),
  }
}

/** The entire mutation vocabulary of Layer 2, built only from the closed manifest. */
export function extensionInstallSql(name: string): string {
  if (!REQUIRED_EXTENSION_NAMES.includes(name)) {
    throw new ProvisionRefusal(`extension not declared by the managed platform: ${name}`)
  }
  return `CREATE EXTENSION IF NOT EXISTS "${name.replace(/"/g, '""')}"`
}

export interface ExtensionIdentity {
  name: string
  version: string
  schema: string
}

/** extname, extversion and the schema it landed in: all three matter. */
export async function extensionIdentities(client: PgClient): Promise<ExtensionIdentity[]> {
  const { rows } = await client.query(
    `SELECT e.extname AS name, e.extversion AS version, n.nspname AS schema
       FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
      WHERE e.extname = ANY($1) ORDER BY 1`,
    [REQUIRED_EXTENSION_NAMES],
  )
  return rows as ExtensionIdentity[]
}

export interface ProvisionOutcome {
  plan: ProvisionPlan
  executed: string[]
  identities: ExtensionIdentity[]
  operational: Array<{ name: string; operational: boolean | null; error: string | null }>
  failures: string[]
}

/**
 * Install exactly the eligible extensions, then prove each one works.
 *
 * Refuses the whole run if any required extension is in a state Layer 2 does not
 * own: installing two of three and reporting success would leave the platform in
 * a state nobody planned.
 */
export async function provisionExtensions(
  client: PgClient,
  report: CapabilityReport,
  recapture: (client: PgClient) => Promise<CapabilityReport>,
): Promise<ProvisionOutcome> {
  const plan = planExtensionProvisioning(report)
  if (plan.refusals.length > 0) {
    const detail = plan.refusals.map(r => `  ${r.name} (${r.status}): ${r.reason}`).join('\n')
    throw new ProvisionRefusal(`Layer 2 cannot provision this database:\n${detail}`)
  }

  const executed: string[] = []
  for (const name of plan.installable) {
    await client.query(extensionInstallSql(name))
    executed.push(name)
  }

  const after = await recapture(client)
  const failures: string[] = []
  const operational = after.extensions.map((e: ExtensionCapability) => {
    const status = capabilityStatus(e)
    if (status !== 'operational') failures.push(`${e.name} is ${status} after provisioning`)
    return { name: e.name, operational: e.operational, error: e.operationalError }
  })

  // "Same extension, different schema" is a real difference to the lineage
  // comparison, so provisioning holds the same line rather than reporting a
  // pass for an extension that landed somewhere else.
  const identities = await extensionIdentities(client)
  for (const identity of identities) {
    const expected = extensionSpec(identity.name)?.expectedSchema
    if (expected && identity.schema !== expected) {
      failures.push(`${identity.name} is installed in schema ${identity.schema}, expected ${expected}`)
    }
  }

  return { plan, executed, identities, operational, failures }
}

export { extensionSpec }
