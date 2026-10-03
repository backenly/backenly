/**
 * Managed platform capability parity — deliberately NOT part of the lineage verdict.
 *
 * Lineage asks "is production's state explained?". This asks a different
 * question: "can every managed environment actually do what the platform
 * depends on?". Production being explained says nothing about staging being
 * able to run the detectors, and folding the two together is how one verdict
 * hides the other.
 *
 * The required set is read from the provisioning manifests rather than restated
 * here, so adding a platform extension to a manifest automatically extends this
 * check.
 *
 * An environment that was not captured is UNKNOWN, never a pass: inability to
 * compare is not parity.
 */

import type { Manifest } from '../migration-lineage/attribute'

export interface RequiredCapability {
  name: string
  required: boolean
  ownership?: string
  serverPrerequisite?: string
  validation?: string
  evidence: string[]
}

export function requiredExtensions(manifests: Manifest[]): RequiredCapability[] {
  return manifests
    .flatMap(m => m.entries)
    .filter(e => e.subtype === 'platform_extension')
    .map(e => ({
      name: e.key.replace(/^extension\s+/, ''),
      required: e.required ?? false,
      ownership: e.ownership,
      serverPrerequisite: e.serverPrerequisite,
      validation: e.validation,
      evidence: e.evidence ?? [],
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

export interface EnvironmentExtensions {
  environment: string
  /** Null when that environment was not captured. */
  extensions: Array<{ name: string; version: string | null }> | null
}

export interface ParityResult {
  parity: 'PASS' | 'FAIL' | 'UNKNOWN'
  required: RequiredCapability[]
  byEnvironment: Array<{
    environment: string
    captured: boolean
    present: Array<{ name: string; version: string | null }>
    missing: string[]
  }>
  reasons: string[]
}

export function capabilityParity(
  environments: EnvironmentExtensions[],
  required: RequiredCapability[],
): ParityResult {
  const mustHave = required.filter(r => r.required).map(r => r.name)
  const reasons: string[] = []

  const byEnvironment = environments.map(env => {
    if (!env.extensions) {
      return { environment: env.environment, captured: false, present: [], missing: [] }
    }
    const names = new Set(env.extensions.map(e => e.name))
    const missing = mustHave.filter(name => !names.has(name))
    return {
      environment: env.environment,
      captured: true,
      present: env.extensions.filter(e => mustHave.includes(e.name)),
      missing,
    }
  })

  const captured = byEnvironment.filter(e => e.captured)
  for (const e of byEnvironment) {
    if (!e.captured) reasons.push(`${e.environment} was not captured, so its capabilities are unknown`)
    else if (e.missing.length) reasons.push(`${e.environment} is missing ${e.missing.join(', ')}`)
  }

  if (mustHave.length === 0) return { parity: 'UNKNOWN', required, byEnvironment, reasons: ['no required capabilities are declared'] }
  if (captured.length < 2) {
    reasons.push('parity needs at least two captured environments to compare')
    return { parity: 'UNKNOWN', required, byEnvironment, reasons }
  }
  const failed = captured.some(e => e.missing.length > 0)
  return { parity: failed ? 'FAIL' : 'PASS', required, byEnvironment, reasons }
}
