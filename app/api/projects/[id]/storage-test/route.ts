import { NextRequest, NextResponse } from 'next/server'
import { verifySession } from '@/lib/auth/session'
import { canAccessProject } from '@/lib/edition/guard'

export async function POST(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const token = request.cookies.get('auth-token')?.value
    if (!token) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const session = await verifySession(token)
    if (!session.valid || !session.userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const projectId = params.id
    const formData = await request.formData()

    // Verify project ownership
    if (!(await canAccessProject(session.userId, projectId))) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    // TODO: Implement actual file upload to storage
    const file = formData.get('file') as File
    if (!file) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 })
    }

    // Mock response for now
    return NextResponse.json({
      success: true,
      file: {
        id: Math.random().toString(36).substring(7),
        name: file.name,
        size: file.size,
        url: `/storage/${projectId}/${file.name}`,
      },
    })
  } catch (error) {
    console.error('Failed to upload file:', error)
    return NextResponse.json(
      { error: 'Failed to upload file' },
      { status: 500 }
    )
  }
}

export async function GET(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const token = request.cookies.get('auth-token')?.value
    if (!token) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const session = await verifySession(token)
    if (!session.valid || !session.userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const projectId = params.id

    // Verify project ownership
    if (!(await canAccessProject(session.userId, projectId))) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    // TODO: Implement actual file listing from storage
    return NextResponse.json({
      files: [],
    })
  } catch (error) {
    console.error('Failed to list files:', error)
    return NextResponse.json(
      { error: 'Failed to list files' },
      { status: 500 }
    )
  }
}
