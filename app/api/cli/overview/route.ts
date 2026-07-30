export const dynamic = 'force-dynamic'

/**
 * GET /api/cli/overview — project snapshot for @backenly/cli (`backenly status`).
 *
 * Auth: x-api-key (scoped key, same key the Connect → Agents page issues for
 * MCP). The CLI and the MCP server are two doors into the same agent lane, so
 * they share the guard: plan quota, per-key rate limit, usage logging.
 *
 * Read-only. Stable shape — additive changes only (the CLI pins nothing).
 */

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db/prisma'
import { mcpGuard, recordMcpCall } from '@/lib/mcp/guard'
import { readWorkspaceSchema } from '@/lib/typegen/schema-reader'
import { countExposedResources } from '@/lib/api/exposed-resources'

const ENDPOINT = '/api/cli/overview'

export async function GET(request: NextRequest) {
  const startedAt = Date.now()
  const guard = await mcpGuard(request)
  if (guard.response) return guard.response
  const auth = guard.auth!

  try {
    const [project, schema, endpointCount, functionCount] = await Promise.all([
      prisma.project.findUnique({
        where: { id: auth.projectId },
        select: {
          id: true,
          name: true,
          isDeployed: true,
          publicEnabled: true,
          projectStatus: true,
          environment: true,
        },
      }),
      readWorkspaceSchema(auth.projectId),
      countExposedResources(auth.projectId),
      prisma.aiFunction.count({ where: { projectId: auth.projectId } }),
    ])

    if (!project) {
      return NextResponse.json(
        { ok: false, error: 'Project not found', code: 'PROJECT_NOT_FOUND' },
        { status: 404 },
      )
    }

    const body = {
      ok: true as const,
      project: {
        id: project.id,
        name: project.name,
        environment: project.environment,
        status: project.projectStatus,
        deployed: project.isDeployed,
        publicEnabled: project.publicEnabled,
      },
      schema: {
        generatedAt: schema.generatedAt,
        tableCount: schema.tables.length,
        tables: schema.tables.map((t) => ({
          name: t.tableName,
          columns: t.columns.map((c) => ({
            name: c.columnName,
            type: c.dataType,
            nullable: c.isNullable,
            primaryKey: c.isPrimaryKey,
            references: c.isForeignKey && c.referencedTable
              ? `${c.referencedTable}.${c.referencedColumn ?? 'id'}`
              : undefined,
          })),
        })),
      },
      counts: {
        endpoints: endpointCount,
        functions: functionCount,
      },
      apiBase: `https://backenly.com/api/v1/${project.id}`,
    }

    recordMcpCall(
      { keyId: auth.keyId, projectId: auth.projectId, userId: auth.userId, endpoint: ENDPOINT, startedAt },
      { statusCode: 200, mutation: false },
    )
    return NextResponse.json(body)
  } catch (error: any) {
    recordMcpCall(
      { keyId: auth.keyId, projectId: auth.projectId, userId: auth.userId, endpoint: ENDPOINT, startedAt },
      { statusCode: 500, mutation: false, error: error?.message },
    )
    return NextResponse.json(
      { ok: false, error: 'Failed to read project overview', code: 'INTERNAL_ERROR' },
      { status: 500 },
    )
  }
}
