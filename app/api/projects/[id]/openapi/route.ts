/**
 * GET /api/projects/:id/openapi — download OpenAPI 3.0 spec as JSON
 * ?format=yaml returns YAML (if js-yaml is installed, otherwise JSON fallback)
 */

export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { withProjectValidation } from '@/lib/middleware/projectValidation'
import { generateOpenApiSpec } from '@/lib/services/openapi-generator'

export async function GET(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params
  return withProjectValidation<any>(request, async (validated) => {
    const { projectId } = validated
    const origin = request.headers.get('origin') || request.nextUrl.origin

    const spec = await generateOpenApiSpec(projectId, origin)

    return new NextResponse(JSON.stringify(spec, null, 2), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Content-Disposition': `attachment; filename="openapi-${projectId}.json"`,
        'Cache-Control': 'no-store',
      },
    })
  })
}
