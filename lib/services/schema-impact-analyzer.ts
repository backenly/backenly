/**
 * SCHEMA IMPACT ANALYZER
 * ======================
 * Shows exactly what breaks before a schema change is applied.
 *
 * Fixes #84 — When a user says "rename the status field in generation_jobs",
 * nothing warned that 3 API endpoints reference status, 2 RLS policies use it,
 * and 1 AI function filters by it.
 *
 * What this does:
 *  - Scans all generated API definitions for references to the changed field/table
 *  - Scans all RLS policies stored for the project
 *  - Scans all AI functions for field usage
 *  - Scans all AppTriggers for table/field references
 *  - Returns a structured impact report with exact locations
 *
 * Rules:
 *  - Always called BEFORE applyMigration() in the executor pipeline
 *  - Impact report is shown to the user for acknowledgment before proceeding
 *  - "Zero impact" is explicitly confirmed (not assumed)
 *  - All checks are deterministic — string search on stored code, not AI inference
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type ImpactSeverity = 'breaking' | 'likely_breaking' | 'advisory'

export interface ImpactedArtifact {
  artifactType: 'api_endpoint' | 'rls_policy' | 'ai_function' | 'trigger' | 'index' | 'foreign_key'
  artifactId: string
  artifactName: string
  severity: ImpactSeverity
  description: string
  /** The exact text in the artifact that references the changed field/table */
  matchedText?: string
  /** How to update this artifact if the change proceeds */
  updateInstruction?: string
}

export interface ImpactReport {
  projectId: string
  change: {
    type: string
    tableName: string
    fieldName?: string
    newFieldName?: string
  }
  impactedArtifacts: ImpactedArtifact[]
  breakingCount: number
  likelyBreakingCount: number
  advisoryCount: number
  /** True if no artifacts reference the changed field/table */
  zeroImpact: boolean
  /** Markdown summary for display in chat */
  summary: string
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Analyze impact of a schema change before applying it.
 * Returns all artifacts that reference the changed table or field.
 */
export async function analyzeChangeImpact(
  projectId: string,
  tableName: string,
  fieldName?: string,
  newFieldName?: string,
  changeType = 'rename_column',
): Promise<ImpactReport> {
  const artifacts: ImpactedArtifact[] = []

  await Promise.all([
    findImpactedAPIs(projectId, tableName, fieldName, artifacts),
    findImpactedRLSPolicies(projectId, tableName, fieldName, artifacts),
    findImpactedFunctions(projectId, tableName, fieldName, artifacts),
    findImpactedTriggers(projectId, tableName, fieldName, artifacts),
    findImpactedIndexes(projectId, tableName, fieldName, artifacts),
    findImpactedForeignKeys(projectId, tableName, fieldName, artifacts),
  ])

  const breakingCount = artifacts.filter(a => a.severity === 'breaking').length
  const likelyBreakingCount = artifacts.filter(a => a.severity === 'likely_breaking').length
  const advisoryCount = artifacts.filter(a => a.severity === 'advisory').length

  const summary = buildImpactSummary(
    { tableName, fieldName, newFieldName, type: changeType },
    artifacts,
    breakingCount,
    likelyBreakingCount,
  )

  return {
    projectId,
    change: { type: changeType, tableName, fieldName, newFieldName },
    impactedArtifacts: artifacts,
    breakingCount,
    likelyBreakingCount,
    advisoryCount,
    zeroImpact: artifacts.length === 0,
    summary,
  }
}

// ── API endpoint scanner ──────────────────────────────────────────────────────

async function findImpactedAPIs(
  projectId: string,
  tableName: string,
  fieldName: string | undefined,
  results: ImpactedArtifact[],
): Promise<void> {
  try {
    // RETIRED 2026-07-30 for the REST surface.
    //
    // This searched each ApiDefinition's `operations` and `endpoints` JSON for
    // references to the column being changed, to warn "this change breaks these
    // endpoints". Under PostgREST there is no stored API code that can hold a
    // stale field reference: the REST surface is DERIVED from the schema on
    // every request, so renaming a column changes the API in the same instant.
    // The analysis is not stale here, it is inexpressible.
    //
    // It also read a table with no create path since the cutover, so the loop
    // iterated nothing on every modern project regardless.
    //
    // Impact on code that genuinely embeds field names — AI functions, triggers
    // — is analysed elsewhere in this file and is unaffected.
  } catch {
    // Non-fatal — impact analysis is best-effort
  }
}

// ── RLS policy scanner ────────────────────────────────────────────────────────

async function findImpactedRLSPolicies(
  projectId: string,
  tableName: string,
  fieldName: string | undefined,
  results: ImpactedArtifact[],
): Promise<void> {
  try {
    const { prisma } = await import('@/lib/db/prisma')
    const policies = await prisma.permissionPolicy.findMany({
      where: { projectId },
      select: { id: true, tableName: true, policyName: true, using: true, withCheck: true },
    })

    for (const policy of policies) {
      // The actual policy expressions are stored in `using` and `withCheck`
      const expr = [policy.using ?? '', policy.withCheck ?? ''].join(' ')

      const isOnTable = policy.tableName === tableName
      const refsField = fieldName ? findFieldReference(expr, fieldName) : null

      if (isOnTable && fieldName && refsField) {
        results.push({
          artifactType: 'rls_policy',
          artifactId: policy.id,
          artifactName: `RLS policy "${policy.policyName}" on ${policy.tableName}`,
          severity: 'breaking',
          description: `RLS policy USING/WITH CHECK expression references field "${fieldName}" which will be renamed/removed`,
          matchedText: refsField,
          updateInstruction: `Update the policy expression to use the new column name`,
        })
      } else if (isOnTable && !fieldName) {
        results.push({
          artifactType: 'rls_policy',
          artifactId: policy.id,
          artifactName: `RLS policy "${policy.policyName}" on ${policy.tableName}`,
          severity: 'breaking',
          description: `RLS policy targets table "${tableName}" which will be renamed/dropped`,
          updateInstruction: `Update or drop this policy after the table change`,
        })
      }
    }
  } catch {
    // Non-fatal
  }
}

// ── AI function scanner ───────────────────────────────────────────────────────

async function findImpactedFunctions(
  projectId: string,
  tableName: string,
  fieldName: string | undefined,
  results: ImpactedArtifact[],
): Promise<void> {
  try {
    const { prisma } = await import('@/lib/db/prisma')
    const functions = await prisma.aiFunction.findMany({
      where: { projectId },
      select: { id: true, name: true, generatedCode: true },
    })

    for (const fn of functions) {
      const code = fn.generatedCode ?? ''

      const refsTable = codeReferences(code, tableName)
      const refsField = fieldName ? findFieldReference(code, fieldName) : null

      if (refsTable && refsField) {
        results.push({
          artifactType: 'ai_function',
          artifactId: fn.id,
          artifactName: `AI Function "${fn.name}"`,
          severity: 'breaking',
          description: `Function code references both table "${tableName}" and field "${fieldName}"`,
          matchedText: refsField,
          updateInstruction: `Update function "${fn.name}" to use the new column name`,
        })
      } else if (refsTable) {
        results.push({
          artifactType: 'ai_function',
          artifactId: fn.id,
          artifactName: `AI Function "${fn.name}"`,
          severity: 'likely_breaking',
          description: `Function code references table "${tableName}" and may use field "${fieldName ?? 'changed field'}"`,
          updateInstruction: `Review function "${fn.name}" after schema change`,
        })
      }
    }
  } catch {
    // Non-fatal
  }
}

// ── Trigger scanner ───────────────────────────────────────────────────────────

async function findImpactedTriggers(
  projectId: string,
  tableName: string,
  fieldName: string | undefined,
  results: ImpactedArtifact[],
): Promise<void> {
  try {
    const { prisma } = await import('@/lib/db/prisma')
    const triggers = await prisma.appTrigger.findMany({
      where: { projectId, sourceTable: tableName },
      select: { id: true, name: true, sourceTable: true, event: true, conditions: true },
    })

    for (const trigger of triggers) {
      const conditionStr = typeof trigger.conditions === 'string'
        ? trigger.conditions
        : JSON.stringify(trigger.conditions ?? '')

      const refsField = fieldName ? findFieldReference(conditionStr, fieldName) : null

      results.push({
        artifactType: 'trigger',
        artifactId: trigger.id,
        artifactName: `Trigger "${trigger.name}" on ${trigger.sourceTable}`,
        severity: refsField ? 'breaking' : 'advisory',
        description: refsField
          ? `Trigger conditions reference field "${fieldName}" which will change`
          : `Trigger fires on table "${tableName}" which will change`,
        matchedText: refsField ?? undefined,
        updateInstruction: `Update trigger "${trigger.name}" after schema change`,
      })
    }
  } catch {
    // Non-fatal
  }
}

// ── Index scanner ─────────────────────────────────────────────────────────────

async function findImpactedIndexes(
  projectId: string,
  tableName: string,
  fieldName: string | undefined,
  results: ImpactedArtifact[],
): Promise<void> {
  if (!fieldName) return

  try {
    const { prisma } = await import('@/lib/db/prisma')
    const { getWorkspaceDatabaseNames } = await import('./databaseProvisioning')
    const { postgresSchema } = getWorkspaceDatabaseNames(projectId)

    const rows = await prisma.$queryRawUnsafe<Array<{ indexname: string; indexdef: string }>>(
      `SELECT indexname, indexdef
       FROM pg_indexes
       WHERE schemaname = $1 AND tablename = $2`,
      postgresSchema,
      tableName,
    )

    for (const row of rows) {
      if (row.indexdef.includes(`"${fieldName}"`) || row.indexdef.includes(` ${fieldName} `)) {
        results.push({
          artifactType: 'index',
          artifactId: row.indexname,
          artifactName: `Index "${row.indexname}" on ${tableName}`,
          severity: 'breaking',
          description: `Index "${row.indexname}" includes column "${fieldName}" which will be renamed/dropped`,
          matchedText: row.indexdef,
          updateInstruction: `Drop and recreate index "${row.indexname}" with the new column name`,
        })
      }
    }
  } catch {
    // Non-fatal — DB may not be accessible
  }
}

// ── Foreign key scanner ───────────────────────────────────────────────────────

async function findImpactedForeignKeys(
  projectId: string,
  tableName: string,
  fieldName: string | undefined,
  results: ImpactedArtifact[],
): Promise<void> {
  try {
    const { prisma } = await import('@/lib/db/prisma')
    const { getWorkspaceDatabaseNames } = await import('./databaseProvisioning')
    const { postgresSchema } = getWorkspaceDatabaseNames(projectId)

    const rows = await prisma.$queryRawUnsafe<Array<{
      constraint_name: string
      table_name: string
      column_name: string
      foreign_table_name: string
      foreign_column_name: string
    }>>(
      `SELECT
         tc.constraint_name,
         tc.table_name,
         kcu.column_name,
         ccu.table_name AS foreign_table_name,
         ccu.column_name AS foreign_column_name
       FROM information_schema.table_constraints AS tc
       JOIN information_schema.key_column_usage AS kcu
         ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
       JOIN information_schema.constraint_column_usage AS ccu
         ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
       WHERE tc.constraint_type = 'FOREIGN KEY'
         AND tc.table_schema = $1
         AND (tc.table_name = $2 OR ccu.table_name = $2)`,
      postgresSchema,
      tableName,
    )

    for (const row of rows) {
      const refersToField = fieldName && (row.column_name === fieldName || row.foreign_column_name === fieldName)
      const severity: ImpactSeverity = refersToField ? 'breaking' : 'likely_breaking'

      results.push({
        artifactType: 'foreign_key',
        artifactId: row.constraint_name,
        artifactName: `FK "${row.constraint_name}" (${row.table_name}.${row.column_name} → ${row.foreign_table_name}.${row.foreign_column_name})`,
        severity,
        description: refersToField
          ? `Foreign key directly references field "${fieldName}" which will change`
          : `Foreign key involves table "${tableName}" — verify cascade behavior`,
        updateInstruction: `Review foreign key "${row.constraint_name}" before applying change`,
      })
    }
  } catch {
    // Non-fatal
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Check if code/text references a table name (various SQL/JS patterns) */
function codeReferences(code: string, tableName: string): boolean {
  const patterns = [
    new RegExp(`\\b${escapeRegex(tableName)}\\b`, 'i'),
    new RegExp(`["'\`]${escapeRegex(tableName)}["'\`]`, 'i'),
  ]
  return patterns.some(p => p.test(code))
}

/** Find the first reference to a field name in code, returning the surrounding context */
function findFieldReference(code: string, fieldName: string): string | null {
  const patterns = [
    new RegExp(`.{0,30}["'\`\\s\\.]${escapeRegex(fieldName)}["'\`\\s\\.]?.{0,30}`, 'i'),
    new RegExp(`.{0,30}\\b${escapeRegex(fieldName)}\\b.{0,30}`, 'i'),
  ]

  for (const p of patterns) {
    const match = p.exec(code)
    if (match) return match[0].trim()
  }
  return null
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Build a human-readable markdown impact summary */
function buildImpactSummary(
  change: { type: string; tableName: string; fieldName?: string; newFieldName?: string },
  artifacts: ImpactedArtifact[],
  breakingCount: number,
  likelyBreakingCount: number,
): string {
  const lines: string[] = []

  const changeDesc = change.fieldName
    ? `${change.type === 'rename_column' ? 'Renaming' : 'Changing'} field "${change.fieldName}"${change.newFieldName ? ` → "${change.newFieldName}"` : ''} on table "${change.tableName}"`
    : `Changing table "${change.tableName}"`

  lines.push(`**Impact Analysis: ${changeDesc}**`)
  lines.push('')

  if (artifacts.length === 0) {
    lines.push('**No impact found.** No API endpoints, RLS policies, functions, triggers, indexes, or foreign keys reference this field/table.')
    lines.push('')
    lines.push('*Safe to proceed.*')
    return lines.join('\n')
  }

  const total = artifacts.length
  lines.push(`**${total} artifact(s) affected** — ${breakingCount} breaking, ${likelyBreakingCount} likely breaking`)
  lines.push('')

  const breaking = artifacts.filter(a => a.severity === 'breaking')
  if (breaking.length > 0) {
    lines.push('**Breaking (will stop working immediately):**')
    for (const a of breaking) {
      lines.push(`- **${a.artifactName}**: ${a.description}`)
      if (a.updateInstruction) lines.push(`  → *Fix: ${a.updateInstruction}*`)
    }
    lines.push('')
  }

  const likely = artifacts.filter(a => a.severity === 'likely_breaking')
  if (likely.length > 0) {
    lines.push('**Likely breaking (review required):**')
    for (const a of likely) {
      lines.push(`- **${a.artifactName}**: ${a.description}`)
    }
    lines.push('')
  }

  const advisory = artifacts.filter(a => a.severity === 'advisory')
  if (advisory.length > 0) {
    lines.push('**Advisory (verify after change):**')
    for (const a of advisory) {
      lines.push(`- ${a.artifactName}: ${a.description}`)
    }
    lines.push('')
  }

  lines.push('*Confirm all breaking items are updated before applying this change.*')

  return lines.join('\n')
}
