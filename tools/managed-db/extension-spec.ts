/**
 * Layer 2: the extensions a managed Backenly database must have.
 *
 * One definition, used by the capability capture, the parity check and, later,
 * the provisioning job. Anything that needs to know "which extensions and how do
 * we prove they work" reads this rather than restating it.
 *
 * Deliberately absent: the `CREATE EXTENSION` statement itself. This module is
 * bundled into the read-only production capture, whose artifact is audited for
 * mutation primitives before it may ship. A provisioning job builds its own
 * statements; a checking module must not carry them.
 */

export interface ExtensionSpec {
  name: string
  required: boolean
  layer: 'extensions'
  requiresPreload: boolean
  /** A harmless read proving the extension does something, not merely exists. */
  operationalProbe: string
  /**
   * The schema the extension must land in.
   *
   * Measured, not assumed: production's capture and the Layer 2 scratch
   * rehearsal both put all three in `public` (2026-09-16). The lineage
   * comparison treats "same extension, different schema" as a real difference,
   * so provisioning holds the same line.
   */
  expectedSchema: string
  why: string
  evidence: string[]
}

export const REQUIRED_EXTENSIONS: ExtensionSpec[] = [
  {
    name: 'pg_stat_statements',
    required: true,
    layer: 'extensions',
    requiresPreload: true,
    operationalProbe: 'SELECT 1 FROM pg_stat_statements LIMIT 1',
    expectedSchema: 'public',
    why: 'Feeds measured slow-query detection. Without it the invariant is reported UNCHECKED, never satisfied.',
    evidence: ['lib/autonomy/platform-capabilities.ts', 'lib/ai/infra-intelligence.ts', 'AGENTS.md'],
  },
  {
    name: 'pgstattuple',
    required: true,
    layer: 'extensions',
    requiresPreload: false,
    // pg_class is small, so this stays cheap.
    operationalProbe: "SELECT 1 FROM pgstattuple('pg_class') LIMIT 1",
    expectedSchema: 'public',
    why: 'Index-bloat leaf density is unavailable without it.',
    evidence: ['lib/autonomy/platform-capabilities.ts', 'lib/autonomy/index-bloat.ts'],
  },
  {
    name: 'vector',
    required: true,
    layer: 'extensions',
    requiresPreload: false,
    operationalProbe: "SELECT '[1,2,3]'::vector IS NOT NULL AS ok",
    expectedSchema: 'public',
    why: 'Backs the shipped enable_vector_search capability (embedding column, cosine index, /vector-search).',
    evidence: ['lib/ai/minimal-executor.ts', 'lib/ai/brain/capabilities.ts', 'lib/ai/embeddings.ts'],
  },
]

export const REQUIRED_EXTENSION_NAMES = REQUIRED_EXTENSIONS.map(e => e.name)

export function extensionSpec(name: string): ExtensionSpec | undefined {
  return REQUIRED_EXTENSIONS.find(e => e.name === name)
}
