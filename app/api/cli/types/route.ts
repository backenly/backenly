export const dynamic = 'force-dynamic'

/**
 * GET /api/cli/types?format=dts|client|openapi — code-generation surface for
 * @backenly/cli (`backenly types`, `backenly openapi`, `backenly diff`).
 *
 * Auth: x-api-key scoped key (same guard as /api/mcp/*). This is the key-authed
 * sibling of /api/typegen, which requires a platform-JWT dashboard session the
 * CLI does not have. Both delegate to the same lib/typegen generators, so the
 * dashboard download and the CLI artifact can never drift.
 *
 *   format=dts     → backenly.types.ts source (text/plain)
 *   format=client  → backenly.client.ts typed client (text/plain)
 *   format=openapi → OpenAPI 3.0 spec (application/json)
 *
 * Every response carries X-Backenly-Schema-Hash — a stable content hash of the
 * generated dts. `backenly diff` compares it against the local artifact to
 * detect contract drift in CI without downloading anything twice.
 */

import crypto from 'crypto'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db/prisma'
import { mcpGuard, recordMcpCall } from '@/lib/mcp/guard'
import { readWorkspaceSchema } from '@/lib/typegen/schema-reader'
import { generateTypes } from '@/lib/typegen/type-generator'
import { generateTypedClient } from '@/lib/typegen/client-generator'
import { generateOpenApiSpec } from '@/lib/typegen/openapi-generator'

const ENDPOINT = '/api/cli/types'

export async function GET(request: NextRequest) {
  const startedAt = Date.now()
  const guard = await mcpGuard(request)
  if (guard.response) return guard.response
  const auth = guard.auth!

  const format = request.nextUrl.searchParams.get('format') ?? 'dts'
  if (!['dts', 'client', 'openapi'].includes(format)) {
    return NextResponse.json(
      { ok: false, error: `Unknown format '${format}' — use dts, client, or openapi`, code: 'VALIDATION_ERROR' },
      { status: 400 },
    )
  }

  try {
    const schema = await readWorkspaceSchema(auth.projectId)
    const types = generateTypes(schema)
    const schemaHash = crypto.createHash('sha256').update(types.source).digest('hex').slice(0, 16)

    const baseHeaders = {
      'X-Backenly-Generated': schema.generatedAt,
      'X-Backenly-Schema-Hash': schemaHash,
    }

    let res: NextResponse
    if (format === 'dts') {
      res = new NextResponse(types.source, {
        status: 200,
        headers: { ...baseHeaders, 'Content-Type': 'text/plain; charset=utf-8' },
      })
    } else if (format === 'client') {
      const client = generateTypedClient(schema, types, { projectId: auth.projectId })
      res = new NextResponse(client.source, {
        status: 200,
        headers: { ...baseHeaders, 'Content-Type': 'text/plain; charset=utf-8' },
      })
    } else {
      const project = await prisma.project.findUnique({
        where: { id: auth.projectId },
        select: { name: true },
      })
      const spec = generateOpenApiSpec(schema, {
        title: project?.name ? `${project.name} API` : 'Backenly Project API',
        serverUrl: `https://backenly.com/api/v1/${auth.projectId}`,
      })
      res = NextResponse.json(spec, { status: 200, headers: baseHeaders })
    }

    recordMcpCall(
      { keyId: auth.keyId, projectId: auth.projectId, userId: auth.userId, endpoint: ENDPOINT, startedAt },
      { statusCode: 200, mutation: false, summary: `format=${format}` },
    )
    return res
  } catch (error: any) {
    recordMcpCall(
      { keyId: auth.keyId, projectId: auth.projectId, userId: auth.userId, endpoint: ENDPOINT, startedAt },
      { statusCode: 500, mutation: false, error: error?.message },
    )
    return NextResponse.json(
      { ok: false, error: 'Type generation failed', code: 'INTERNAL_ERROR' },
      { status: 500 },
    )
  }
}
