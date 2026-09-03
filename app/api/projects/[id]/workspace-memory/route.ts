import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db/postgres'
import { verifySession } from '@/lib/auth/session'
import { canAccessProject } from '@/lib/edition/guard'

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

    // Get workspace memory from metadata
    const metadata = await prisma.projectMetadata.findUnique({
      where: { projectId },
    })

    const memory = (metadata?.backendStateGraph as any)?.workspaceMemory || {
      apiTests: [],
      authConfigs: [],
      storageUploads: [],
      tableInserts: [],
      lastConnectedOrigin: null,
      suggestions: [],
    }

    return NextResponse.json({ memory })
  } catch (error) {
    console.error('Failed to get workspace memory:', error)
    return NextResponse.json(
      { error: 'Failed to get workspace memory' },
      { status: 500 }
    )
  }
}

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
    const { type, data } = await request.json()

    // Verify project ownership
    if (!(await canAccessProject(session.userId, projectId))) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    // Get existing metadata
    const metadata = await prisma.projectMetadata.findUnique({
      where: { projectId },
    })

    if (!metadata) {
      return NextResponse.json({ error: 'Metadata not found' }, { status: 404 })
    }

    const backendStateGraph = (metadata.backendStateGraph as any) || {}
    const memory = backendStateGraph.workspaceMemory || {
      apiTests: [],
      authConfigs: [],
      storageUploads: [],
      tableInserts: [],
      lastConnectedOrigin: null,
      suggestions: [],
    }

    // Update memory based on type
    switch (type) {
      case 'api-test':
        memory.apiTests.push({  ...data, timestamp: new Date().toISOString() })
        memory.apiTests = memory.apiTests.slice(-10) // Keep last 10
        break
      case 'auth-config':
        memory.authConfigs.push({ ...data, timestamp: new Date().toISOString() })
        memory.authConfigs = memory.authConfigs.slice(-5) // Keep last 5
        break
      case 'storage-upload':
        memory.storageUploads.push({ ...data, timestamp: new Date().toISOString() })
        memory.storageUploads = memory.storageUploads.slice(-10) // Keep last 10
        break
      case 'table-insert':
        memory.tableInserts.push({ ...data, timestamp: new Date().toISOString() })
        memory.tableInserts = memory.tableInserts.slice(-10) // Keep last 10
        break
      case 'connected-origin':
        memory.lastConnectedOrigin = data
        break
    }

    // Generate smart suggestions
    memory.suggestions = generateSuggestions(memory)

    // Save updated memory
    backendStateGraph.workspaceMemory = memory
    await prisma.projectMetadata.update({
      where: { projectId },
      data: {
        backendStateGraph: backendStateGraph,
      },
    })

    return NextResponse.json({ success: true, memory })
  } catch (error) {
    console.error('Failed to save workspace memory:', error)
    return NextResponse.json(
      { error: 'Failed to save workspace memory' },
      { status: 500 }
    )
  }
}

function generateSuggestions(memory: any): string[] {
  const suggestions: string[] = []

  if (memory.apiTests.length === 0) {
    suggestions.push('test-api')
  }

  if (memory.authConfigs.length === 0) {
    suggestions.push('configure-auth')
  }

  if (memory.apiTests.length > 0 && !memory.lastConnectedOrigin) {
    suggestions.push('connect-frontend')
  }

  if (memory.storageUploads.length === 0) {
    suggestions.push('test-storage')
  }

  if (memory.tableInserts.length === 0) {
    suggestions.push('insert-test-data')
  }

  if (memory.lastConnectedOrigin) {
    suggestions.push('verify-connection')
  }

  return suggestions.slice(0, 3) // Top 3 suggestions
}
