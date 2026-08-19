import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db/postgres'
import { verifySession } from '@/lib/auth/session'

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
    const { searchParams } = new URL(request.url)
    const tableName = searchParams.get('table')

    if (!tableName) {
      return NextResponse.json({ error: 'Table name required' }, { status: 400 })
    }

    // Verify project ownership
    const project = await prisma.project.findFirst({
      where: {
        id: projectId,
        userId: session.userId,
      },
    })

    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    // TODO: Implement actual schema introspection
    // For now, return mock schema
    return NextResponse.json({
      fields: [
        { name: 'id', type: 'integer', required: true },
        { name: 'name', type: 'text', required: true },
        { name: 'created_at', type: 'timestamp', required: false },
      ],
    })
  } catch (error) {
    console.error('Failed to get table schema:', error)
    return NextResponse.json(
      { error: 'Failed to get table schema' },
      { status: 500 }
    )
  }
}
