/**
 * GET /api/projects/:id/openapi — download OpenAPI 3.0 spec as JSON
 * ?format=yaml returns YAML (if js-yaml is installed, otherwise JSON fallback)
 * ?branchId=<id> describes that preview branch's data API instead of main's
 */

export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { withProjectValidation } from '@/lib/middleware/projectValidation'
import { generateOpenApiSpec } from '@/lib/services/openapi-generator'
import { prisma } from '@/lib/db/prisma'

export async function GET(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params
  return withProjectValidation<any>(request, async (validated) => {
    const { projectId } = validated
    const origin = request.headers.get('origin') || request.nextUrl.origin

    // Resolved on THIS project, and only while active: the branch's schema is
    // what the spec reads, so an id from another project must describe nothing.
    const branchId = request.nextUrl.searchParams.get('branchId')
    let branch: { name: string; schemaName: string } | null = null
    if (branchId) {
      branch = await prisma.workspaceBranch.findFirst({
        where: { id: branchId, projectId, status: 'active' },
        select: { name: true, schemaName: true },
      })
      if (!branch) {
        return NextResponse.json(
          { error: 'No active preview branch with that id on this project.', code: 'BRANCH_NOT_FOUND' },
          { status: 404 },
        )
      }
    }

    const spec = await generateOpenApiSpec(projectId, origin, branch)
    const file = branch ? `openapi-${projectId}-${branch.name}.json` : `openapi-${projectId}.json`

    return new NextResponse(JSON.stringify(spec, null, 2), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Content-Disposition': `attachment; filename="${file}"`,
        'Cache-Control': 'no-store',
      },
    })
  })
}
