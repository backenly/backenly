/**
 * Proof that the production probe cannot mutate anything.
 *
 * "It only runs SELECTs" is a claim about code someone has to keep true. This
 * turns it into a property of the artifact, in two independent ways:
 *
 *   1. the MODULE GRAPH must not contain the mutation-capable modules, and
 *   2. the BUILT CODE must not contain the SQL or the payload variable that
 *      would let it change a database.
 *
 * Both are needed, and neither is sufficient alone. Minification renames local
 * identifiers, so a pattern like `withScratchDatabase` matches nothing in a
 * minified bundle even when the function is right there — measured, not assumed.
 * Only string literals survive, which is why the text rules are literals, and
 * why the module graph does the work that names cannot.
 *
 * This module is NOT imported by the probe. If it were, its own patterns would
 * be bundled into the code it audits and it would flag itself — the failure mode
 * that made the OSS preflight scanner report clean while holding live secrets.
 */

export interface ForbiddenPrimitive {
  pattern: RegExp
  why: string
}

/**
 * Literal text that can only be there to change a database.
 *
 * Deliberately NOT here: `queryMode`. It is part of pg's own Query class and
 * appears in every bundle that contains the driver, read-only or not, so it
 * would fail the honest case and prove nothing about the dishonest one.
 */
export const FORBIDDEN_PRIMITIVES: ForbiddenPrimitive[] = [
  { pattern: /CREATE\s+DATABASE/i, why: 'creates a database' },
  { pattern: /DROP\s+DATABASE/i, why: 'drops a database' },
  { pattern: /\bCREATE\s+(TABLE|SCHEMA|ROLE|POLICY|TRIGGER|FUNCTION|INDEX|EVENT)/i, why: 'issues DDL' },
  { pattern: /\bALTER\s+(TABLE|ROLE|DATABASE|DEFAULT|SCHEMA)/i, why: 'issues DDL' },
  { pattern: /\bDROP\s+(TABLE|SCHEMA|ROLE|POLICY|TRIGGER|FUNCTION|INDEX)/i, why: 'issues DDL' },
  { pattern: /\bINSERT\s+INTO\b/i, why: 'writes rows' },
  { pattern: /\bDELETE\s+FROM\b/i, why: 'deletes rows' },
  { pattern: /\bTRUNCATE\b/i, why: 'truncates a table' },
  { pattern: /\b(GRANT|REVOKE)\s+/i, why: 'changes privileges' },
  { pattern: /LINEAGE_INPUT_B64/, why: 'accepts an arbitrary SQL payload' },
  { pattern: /rejectUnauthorized['"\s:]+false/, why: 'disables TLS verification' },
]

/**
 * Modules the production probe must not reach, by path.
 *
 * Survives minification, because it is checked against the bundler's own record
 * of what it pulled in rather than against the output text.
 */
export const FORBIDDEN_MODULES = [
  'tools/migration-lineage/probe/scratch.ts',
  'tools/migration-lineage/probe/input.ts',
  'tools/migration-lineage/probe/rls-control.ts',
  'tools/migration-lineage/probe/run.ts',
  'tools/migration-lineage/build-inputs.ts',
  'tools/migration-lineage/derive-manifests.ts',
  // Layer 2 mutation and the scratch-database machinery it rehearses in.
  'tools/managed-db/scratch-database.ts',
  'tools/managed-db/provision-extensions.ts',
  'tools/managed-db/rehearse-extensions.ts',
]

export interface AuditFinding {
  pattern: string
  why: string
  excerpt: string
}

export function auditReadOnlyBundle(code: string): AuditFinding[] {
  return FORBIDDEN_PRIMITIVES.flatMap(({ pattern, why }) => {
    const match = code.match(pattern)
    if (!match) return []
    const at = match.index ?? 0
    return [{
      pattern: String(pattern),
      why,
      excerpt: code.slice(Math.max(0, at - 60), at + 60).replace(/\s+/g, ' '),
    }]
  })
}

export function assertReadOnlyBundle(code: string): void {
  const findings = auditReadOnlyBundle(code)
  if (findings.length === 0) return
  const detail = findings.map(f => `  ${f.pattern} ${f.why}\n    …${f.excerpt}…`).join('\n')
  throw new Error(`the production probe bundle contains mutation primitives:\n${detail}`)
}

/** `inputs` is esbuild's metafile input list: every module the bundle pulled in. */
export function auditModuleGraph(inputs: string[]): string[] {
  const normalised = inputs.map(i => i.replace(/\\/g, '/'))
  return FORBIDDEN_MODULES.filter(forbidden => normalised.some(input => input.endsWith(forbidden)))
}

export function assertReadOnlyModuleGraph(inputs: string[]): void {
  const reached = auditModuleGraph(inputs)
  if (reached.length === 0) return
  throw new Error(`the production probe reaches mutation-capable modules:\n${reached.map(m => `  ${m}`).join('\n')}`)
}
