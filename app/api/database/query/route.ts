export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { withProjectAccess } from '@/lib/auth/route-protection'
import { getWorkspacePostgresClient } from '@/lib/services/workspaceDatabase'
import { workspaceSchemaName } from '@/lib/security/workspace-schema'

const querySchema = z.object({
  type: z.enum(['postgresql', 'mongodb']),
  schema: z.string().optional(),
  query: z.string().min(1).max(50_000),
  projectId: z.string().optional(),
})

/**
 * Block list of SQL tokens that must never appear in a developer query against
 * their own workspace. We're not trying to build a full SQL parser — we're
 * narrowing the blast radius of a feature that exists so the project owner can
 * inspect their data. Anything that smells like accessing another schema,
 * Postgres internals, or extension primitives is rejected.
 */
const FORBIDDEN_TOKENS: RegExp[] = [
  /\binformation_schema\b/i,
  /\bpg_catalog\b/i,
  /\bpg_user\b/i,
  /\bpg_roles\b/i,
  /\bpg_authid\b/i,
  /\bpg_shadow\b/i,
  /\bpg_stat\w*\b/i,
  /\bpg_settings\b/i,
  /\bpg_largeobject\b/i,
  /\bpg_proc\b/i,
  /\bpg_class\b/i,
  /\bpg_namespace\b/i,
  /\bdblink\b/i,
  /\bpostgres_fdw\b/i,
  /\bcopy\b/i,                 // file IO via COPY ... PROGRAM
  /\blo_import\b/i,
  /\blo_export\b/i,
  /\bcurrent_user\b/i,
  /\bsession_user\b/i,
  /\bset\s+role\b/i,
  /\bset\s+session\b/i,
  /\bset\s+local\b/i,
  /;\s*\S/,                    // any second statement (queryRaw also refuses, defense-in-depth)
]

/**
 * Look at every schema-qualified identifier in the query (e.g. `foo.bar` or
 * `"foo"."bar"`) and assert each schema is the project's own workspace schema.
 * Quoted identifiers are unwrapped; unquoted ones are lowercased per Postgres.
 */
function extractReferencedSchemas(query: string): string[] {
  const out: string[] = []
  // Strip string literals so quotes inside strings don't confuse us.
  const sanitized = query.replace(/'(?:''|[^'])*'/g, "''")
  // Match optional-quoted schema followed by a dot and an identifier
  const re = /(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_$]*))\s*\.\s*(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_$]*)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(sanitized)) !== null) {
    const schema = (m[1] ?? m[2] ?? '').trim()
    if (schema) out.push(m[1] ? schema : schema.toLowerCase())
  }
  return out
}

/**
 * POST /api/database/query — Execute a read-only SELECT against the caller's
 * own workspace schema.
 *
 * 🔒 Protected:
 *   - Auth required (withProjectAccess)
 *   - PostgreSQL only
 *   - SELECT or WITH only (no DML/DDL)
 *   - No semicolon-separated statements
 *   - No information_schema / pg_catalog / dblink / COPY / etc.
 *   - Any schema-qualified table MUST be the caller's own workspace_<projectId>
 */
export const POST = withProjectAccess(async (request: NextRequest, { projectId: validatedProjectId }) => {
  try {
    const body = await request.json()
    const validated = querySchema.parse(body)

    if (validated.type !== 'postgresql') {
      return NextResponse.json(
        { success: false, error: 'SQL queries are only supported for PostgreSQL' },
        { status: 400 }
      )
    }

    const projectId = validatedProjectId
    const ownSchema = workspaceSchemaName(projectId)

    const queryText = validated.query.trim()
    const normalized = queryText.toUpperCase()

    if (!normalized.startsWith('SELECT') && !normalized.startsWith('WITH')) {
      return NextResponse.json(
        { success: false, error: 'Only SELECT/WITH queries are allowed' },
        { status: 400 }
      )
    }

    // Block dangerous tokens
    for (const re of FORBIDDEN_TOKENS) {
      if (re.test(queryText)) {
        return NextResponse.json(
          { success: false, error: 'Query references a forbidden token' },
          { status: 400 }
        )
      }
    }

    // Any schema-qualified reference must be the caller's own workspace schema.
    const referenced = extractReferencedSchemas(queryText)
    for (const schema of referenced) {
      if (schema !== ownSchema) {
        return NextResponse.json(
          { success: false, error: 'Cross-schema references are not allowed' },
          { status: 403 }
        )
      }
    }

    const workspaceClient = await getWorkspacePostgresClient(projectId)
    if (!workspaceClient) {
      return NextResponse.json(
        { success: false, error: 'Database connection not available' },
        { status: 500 }
      )
    }

    const results = await workspaceClient.queryRaw(queryText)
    return NextResponse.json({
      success: true,
      data: Array.isArray(results) ? results : [results],
    })
  } catch (error: any) {
    console.error('SQL query error:', error?.message ?? 'unknown')
    return NextResponse.json(
      { success: false, error: 'Query failed' },
      { status: 500 }
    )
  }
})
