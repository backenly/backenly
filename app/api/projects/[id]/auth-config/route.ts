import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db/postgres'
import { verifySession } from '@/lib/auth/session'

export async function GET(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    // Get token from cookies
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
    const project = await prisma.project.findFirst({
      where: {
        id: projectId,
        userId: session.userId,
      },
    })

    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    // Get auth config from project metadata
    const metadata = await prisma.projectMetadata.findUnique({
      where: { projectId },
    })

    const config = (metadata?.backendStateGraph as any)?.authConfig || {
      providers: { email: true, google: false, github: false },
      session: { expiryDuration: 24, refreshTokens: false },
      roles: { admin: true, user: true, editor: false },
    }

    return NextResponse.json({ config })
  } catch (error) {
    console.error('Failed to get auth config:', error)
    return NextResponse.json(
      { error: 'Failed to get auth config' },
      { status: 500 }
    )
  }
}

export async function POST(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    // Get token from cookies
    const token = request.cookies.get('auth-token')?.value
    if (!token) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const session = await verifySession(token)
    if (!session.valid || !session.userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const projectId = params.id
    const { config } = await request.json()

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

    // Get existing metadata
    const metadata = await prisma.projectMetadata.findUnique({
      where: { projectId },
    })

    if (!metadata) {
      return NextResponse.json({ error: 'Metadata not found' }, { status: 404 })
    }

    // Update auth config in backend state graph
    const backendStateGraph = (metadata.backendStateGraph as any) || {}
    backendStateGraph.authConfig = config

    await prisma.projectMetadata.update({
      where: { projectId },
      data: {
        backendStateGraph: backendStateGraph,
      },
    })

    return NextResponse.json({ success: true, config })
  } catch (error) {
    console.error('Failed to save auth config:', error)
    return NextResponse.json(
      { error: 'Failed to save auth config' },
      { status: 500 }
    )
  }
}
