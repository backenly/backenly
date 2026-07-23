export const dynamic = 'force-dynamic'

/**
 * GET /api/typegen?projectId=xxx[&format=dts|client|handoff|all][&framework=react|nextjs|typescript|cursor]
 *
 * Returns generated TypeScript types and integration assets for a project.
 *
 * format=dts       → raw .d.ts source (download as backenly.types.ts)
 * format=client    → typed client wrapper (download as backenly.client.ts)
 * format=handoff   → framework-specific snippet (combine with &framework=)
 * format=all       → JSON bundle with all assets (default)
 *
 * Authentication: platform JWT (same as all dashboard routes)
 */

import { NextRequest, NextResponse } from 'next/server'
import { withProjectAccess } from '@/lib/auth/route-protection'
import { readWorkspaceSchema } from '@/lib/typegen/schema-reader'
import { generateTypes } from '@/lib/typegen/type-generator'
import { generateTypedClient } from '@/lib/typegen/client-generator'
import { generateHandoffAsset, generateHandoffAssets, type HandoffFramework } from '@/lib/typegen/handoff-generator'
import { generateOpenApiSpec } from '@/lib/typegen/openapi-generator'

export const GET = withProjectAccess(async (request: NextRequest, { projectId }) => {
  try {
    const { searchParams } = request.nextUrl
    const format = searchParams.get('format') ?? 'all'
    const framework = (searchParams.get('framework') ?? 'cursor') as HandoffFramework

    // ── Read live schema ────────────────────────────────────────────────────
    const schema = await readWorkspaceSchema(projectId)
    const types = generateTypes(schema)

    // ── Short-circuit for single-file downloads ─────────────────────────────

    if (format === 'dts') {
      return new NextResponse(types.source, {
        status: 200,
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'Content-Disposition': 'attachment; filename="backenly.types.ts"',
          'X-Backenly-Generated': schema.generatedAt,
        },
      })
    }

    if (format === 'client') {
      const client = generateTypedClient(schema, types, { projectId })
      return new NextResponse(client.source, {
        status: 200,
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'Content-Disposition': 'attachment; filename="backenly.client.ts"',
          'X-Backenly-Generated': schema.generatedAt,
        },
      })
    }

    // ── format=openapi — OpenAPI 3.0 spec ──────────────────────────────────
    if (format === 'openapi') {
      const spec = generateOpenApiSpec(schema, {
        serverUrl: process.env.NEXT_PUBLIC_APP_URL ?? 'https://backenly.com',
      })
      const download = searchParams.get('download') === 'true'
      if (download) {
        return new NextResponse(JSON.stringify(spec, null, 2), {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'Content-Disposition': 'attachment; filename="openapi.json"',
            'X-Backenly-Generated': schema.generatedAt,
          },
        })
      }
      return NextResponse.json(spec)
    }

    if (format === 'handoff') {
      const asset = generateHandoffAsset(framework, schema, types, projectId)
      return new NextResponse(asset.source, {
        status: 200,
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'Content-Disposition': `attachment; filename="${asset.filename}"`,
          'X-Backenly-Generated': schema.generatedAt,
        },
      })
    }

    // ── format=all — JSON bundle ────────────────────────────────────────────

    const clientGen = generateTypedClient(schema, types, { projectId })
    const handoffAssets = generateHandoffAssets(schema, types, projectId)

    return NextResponse.json({
      projectId,
      generatedAt: schema.generatedAt,
      tables: types.tableNames,
      assets: {
        /** Drop directly into your project as-is */
        'backenly.types.ts': types.source,
        'backenly.client.ts': clientGen.source,
        /** Framework-specific helpers — pick one */
        handoff: Object.fromEntries(
          handoffAssets.map(a => [a.framework, { filename: a.filename, source: a.source }])
        ),
      },
      /** Convenience download URLs */
      downloadUrls: {
        types: `/api/typegen?projectId=${projectId}&format=dts`,
        client: `/api/typegen?projectId=${projectId}&format=client`,
        react: `/api/typegen?projectId=${projectId}&format=handoff&framework=react`,
        nextjs: `/api/typegen?projectId=${projectId}&format=handoff&framework=nextjs`,
        typescript: `/api/typegen?projectId=${projectId}&format=handoff&framework=typescript`,
        cursor: `/api/typegen?projectId=${projectId}&format=handoff&framework=cursor`,
        /** OpenAPI 3.0 spec — importable into Postman / Insomnia / openapi-generator */
        openapi: `/api/typegen?projectId=${projectId}&format=openapi`,
        openapiDownload: `/api/typegen?projectId=${projectId}&format=openapi&download=true`,
      },
    })
  } catch (error: any) {
    console.error('[typegen] Error generating types:', error)
    return NextResponse.json(
      { error: 'Failed to generate types', detail: error?.message },
      { status: 500 }
    )
  }
})
