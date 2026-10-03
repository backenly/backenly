/**
 * What the Layer 2 provisioner is allowed to be.
 *
 * The production capture is audited for containing NO mutation. This is the
 * opposite shape: Layer 2 must contain exactly one mutation vocabulary and
 * nothing else, so that "extension provisioner" cannot slowly become a generic
 * admin runner. Both audits check the built artifact rather than intentions.
 *
 * Not imported by the provisioner: its patterns would otherwise be bundled into
 * the code it audits and it would flag itself.
 */

export interface ForbiddenInProvisioner {
  pattern: RegExp
  why: string
}

/** The only mutation Layer 2 may express. */
export const ALLOWED_MUTATION = /CREATE\s+EXTENSION\s+IF\s+NOT\s+EXISTS/i

export const FORBIDDEN_IN_PROVISIONER: ForbiddenInProvisioner[] = [
  { pattern: /DROP\s+EXTENSION/i, why: 'an extension can own objects and data; this is diagnosed, never dropped' },
  { pattern: /ALTER\s+EXTENSION/i, why: 'version moves are their own decision, not provisioning' },
  { pattern: /ALTER\s+SYSTEM/i, why: 'server configuration is Layer 1, owned by infrastructure' },
  { pattern: /\b(CREATE|ALTER|DROP)\s+ROLE\b/i, why: 'roles are Layer 4 and cluster-wide' },
  { pattern: /\b(GRANT|REVOKE)\b/i, why: 'privileges are Layer 4' },
  { pattern: /\bCREATE\s+EVENT\s+TRIGGER\b/i, why: 'event triggers are Layer 4' },
  { pattern: /\bALTER\s+DEFAULT\s+PRIVILEGES\b/i, why: 'default privileges are Layer 4' },
  { pattern: /workspace_[0-9a-f]/i, why: 'tenant state is never provisioner-owned' },
  { pattern: /\bbackenly_pgrst_\w+/i, why: 'PostgREST provisioning is Layer 4' },
  { pattern: /\bbackenly_direct_\w+/i, why: 'direct-access provisioning is Layer 4' },
  { pattern: /prisma\/build|migrate\s+deploy|_prisma_migrations/i, why: 'the migration runner is Layer 3' },
]

/** Modules Layer 2 must not reach, checked against the bundler's input list. */
export const FORBIDDEN_MODULES = [
  'tools/migration-lineage/probe/scratch.ts',
  'tools/migration-lineage/probe/input.ts',
  'tools/migration-lineage/probe/rls-control.ts',
  'tools/migration-lineage/build-inputs.ts',
  'tools/migration-lineage/derive-manifests.ts',
  'scripts/lib/staging-fargate-task.ts',
]

export interface ProvisionerAuditFinding {
  pattern: string
  why: string
  excerpt: string
}

export function auditProvisionerBundle(code: string): ProvisionerAuditFinding[] {
  const findings = FORBIDDEN_IN_PROVISIONER.flatMap(({ pattern, why }) => {
    const match = code.match(pattern)
    if (!match) return []
    const at = match.index ?? 0
    return [{ pattern: String(pattern), why, excerpt: code.slice(Math.max(0, at - 60), at + 60).replace(/\s+/g, ' ') }]
  })

  // A provisioner that cannot install anything is not safe, it is broken, and a
  // silently empty vocabulary would pass every rule above.
  if (!ALLOWED_MUTATION.test(code)) {
    findings.push({
      pattern: String(ALLOWED_MUTATION),
      why: 'the provisioner contains no CREATE EXTENSION IF NOT EXISTS; it cannot do its job',
      excerpt: '(absent)',
    })
  }
  return findings
}

export function assertProvisionerBundle(code: string): void {
  const findings = auditProvisionerBundle(code)
  if (findings.length === 0) return
  const detail = findings.map(f => `  ${f.pattern} ${f.why}\n    …${f.excerpt}…`).join('\n')
  throw new Error(`the Layer 2 provisioner bundle is not what Layer 2 may be:\n${detail}`)
}

export function auditProvisionerModules(inputs: string[]): string[] {
  const normalised = inputs.map(i => i.replace(/\\/g, '/'))
  return FORBIDDEN_MODULES.filter(forbidden => normalised.some(input => input.endsWith(forbidden)))
}

export function assertProvisionerModules(inputs: string[]): void {
  const reached = auditProvisionerModules(inputs)
  if (reached.length === 0) return
  throw new Error(`the Layer 2 provisioner reaches modules it does not own:\n${reached.map(m => `  ${m}`).join('\n')}`)
}
