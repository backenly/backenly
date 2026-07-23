import { PrismaClient } from '@prisma/client'
import { generateToken } from '../lib/auth/jwt'

const prisma = new PrismaClient()

async function setupTestEnvironment() {
  console.log('🔧 Setting up test environment...')
  
  try {
    // Create test user
    const user = await prisma.user.upsert({
      where: { email: 'test@backenly.com' },
      update: {},
      create: {
        email: 'test@backenly.com',
        name: 'Test User',
        provider: 'email',
      },
    })
    console.log('✅ Test user created/updated:', user.id)
    
    // Create test project
    const project = await prisma.project.upsert({
      where: { id: '33a511e8-71f3-4c92-b764-d9a6b997ad3f' },
      update: {},
      create: {
        id: '33a511e8-71f3-4c92-b764-d9a6b997ad3f',
        name: 'Test Debug Project',
        slug: 'test-debug-project',
        userId: user.id,
      },
    })
    console.log('✅ Test project created/updated:', project.id)
    
    // Create auth session
    const token = generateToken({
      userId: user.id,
      email: user.email,
      name: user.name || 'Test User',
      role: 'admin'
    })
    
    await prisma.session.upsert({
      where: { token },
      update: {
        userId: user.id,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
      create: {
        userId: user.id,
        token,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    })
    console.log('✅ Test session created')
    
    // Create initial backend graph
    const { createEmptyGraph } = await import('../lib/orchestration/backend-state-graph')
    const initialGraph = createEmptyGraph(project.id)
    
    const backendGraph = await prisma.backendGraph.upsert({
      where: { 
        projectId_sequenceNumber: {
          projectId: project.id,
          sequenceNumber: 1
        }
      },
      update: {},
      create: {
        projectId: project.id,
        graphData: initialGraph as any,
        sequenceNumber: 1,
      },
    })
    console.log('✅ Initial backend graph created')
    
    // Update project with active graph
    await prisma.project.update({
      where: { id: project.id },
      data: { activeGraphId: backendGraph.id },
    })
    console.log('✅ Project active graph set')
    
    console.log('\n📋 Test environment ready!')
    console.log('Project ID:', project.id)
    console.log('Auth token:', token)
    console.log('Use this token in your requests as:')
    console.log(`Authorization: Bearer ${token}`)
    
  } catch (error) {
    console.error('❌ Setup failed:', error)
  } finally {
    await prisma.$disconnect()
  }
}

setupTestEnvironment()