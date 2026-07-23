import { NextRequest, NextResponse } from 'next/server'
import { verifyToken } from '@/lib/auth/jwt'
import { listSchemaVersions, getSchemaVersion, rollbackToVersion } from '@/lib/versioning/schema-versions'

/**
 * GET /api/projects/[id]/schema-versions
 * List all schema versions for a project (newest first).
 * Used by the UI to show "Schema History" timeline.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const token = request.cookies.get('auth-token')?.value
      || request.headers.get('authorization')?.replace('Bearer ', '')
    if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    await verifyToken(token)

    const projectId = params.id
    const { searchParams } = new URL(request.url)
    const versionId = searchParams.get('versionId')

    // Return a specific version snapshot if requested
    if (versionId) {
      const version = await getSchemaVersion(versionId)
      if (!version) return NextResponse.json({ error: 'Version not found' }, { status: 404 })
      return NextResponse.json({ success: true, version })
    }

    const versions = await listSchemaVersions(projectId)
    return NextResponse.json({ success: true, versions, total: versions.length })
  } catch (error: any) {
    return NextResponse.json({ error: 'Failed to list schema versions' }, { status: 500 })
  }
}

/**
 * POST /api/projects/[id]/schema-versions/rollback
 * Body: { versionId: string }
 * Rollback the project schema to a specific version.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const token = request.cookies.get('auth-token')?.value
      || request.headers.get('authorization')?.replace('Bearer ', '')
    if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    await verifyToken(token)

    const projectId = params.id
    const body = await request.json()
    const { versionId } = body

    if (!versionId) {
      return NextResponse.json({ error: 'versionId is required' }, { status: 400 })
    }

    const result = await rollbackToVersion(projectId, versionId)
    return NextResponse.json({
      success: result.success,
      message: result.message,
      statementsExecuted: result.statementsExecuted,
    }, { status: result.success ? 200 : 500 })
  } catch (error: any) {
    return NextResponse.json({ error: 'Rollback failed', details: error.message }, { status: 500 })
  }
}
