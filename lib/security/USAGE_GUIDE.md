/**
 * 🔒 SECURITY USAGE GUIDE
 * 
 * How to use the CTO-grade security system in your code
 */

// ============================================================================
// 1. API ROUTES - Always use getProjectContext
// ============================================================================

import { NextRequest, NextResponse } from 'next/server'
import { getProjectContext } from '@/lib/auth/server'

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { projectId } = body

    // ✅ STEP 1: Validate user has access to project
    const ctx = await getProjectContext(projectId)
    
    // ✅ STEP 2: Use ctx.projectId for all queries (auto-scoped)
    const tables = await prisma.table.findMany({
      where: {
        projectId: ctx.projectId // Guaranteed to be user's project
      }
    })

    return NextResponse.json({ tables })
  } catch (error: any) {
    if (error.name === 'UnauthorizedError') {
      return NextResponse.json({ error: error.message }, { status: 401 })
    }
    if (error.name === 'ForbiddenError') {
      return NextResponse.json({ error: error.message }, { status: 403 })
    }
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}

// ============================================================================
// 2. SERVER COMPONENTS - Always use requireUser or getProjectContext
// ============================================================================

import { requireUser, getProjectContext } from '@/lib/auth/server'

export default async function DatabasePage({ 
  params 
}: { 
  params: { projectId: string } 
}) {
  // ✅ Validate user and project access
  const ctx = await getProjectContext(params.projectId)

  // ✅ Now safe to query - user has access
  const tables = await prisma.table.findMany({
    where: { projectId: ctx.projectId }
  })

  return (
    <div>
      <h1>Project: {ctx.project.name}</h1>
      <p>Tables: {tables.length}</p>
    </div>
  )
}

// ============================================================================
// 3. SERVER ACTIONS - Use getProjectContext
// ============================================================================

'use server'

import { getProjectContext } from '@/lib/auth/server'
import { prisma } from '@/lib/db/postgres'

export async function createTable(
  projectId: string, 
  tableName: string
) {
  // ✅ Validate access
  const ctx = await getProjectContext(projectId)

  // ✅ Create with validated projectId
  const table = await prisma.table.create({
    data: {
      name: tableName,
      projectId: ctx.projectId, // Guaranteed valid
      tableName: tableName,
    }
  })

  return { success: true, table }
}

// ============================================================================
// 4. USING PRISMA MIDDLEWARE (Automatic Filtering)
// ============================================================================

import { createTenantMiddleware, createSafePrismaClient } from '@/lib/db/prisma-middleware'
import { prisma } from '@/lib/db/postgres'

// Option A: Add middleware globally
const setupMiddleware = (projectId: string) => {
  prisma.$use(createTenantMiddleware(projectId))
}

// Option B: Create scoped client
const safePrisma = createSafePrismaClient(prisma, projectId, workspaceId)

// ✅ All queries now auto-filtered!
const tables = await safePrisma.table.findMany() 
// Automatically adds: where: { projectId: 'xxx' }

const newTable = await safePrisma.table.create({
  data: { name: 'users' }
})
// Automatically adds: projectId: 'xxx'

// ============================================================================
// 5. API KEY AUTHENTICATION (External APIs)
// ============================================================================

import { validateApiKey } from '@/lib/auth/server'

export async function POST(request: NextRequest) {
  try {
    const apiKey = request.headers.get('x-api-key')
    
    if (!apiKey) {
      return NextResponse.json(
        { error: 'API key required' }, 
        { status: 401 }
      )
    }

    // ✅ Validate API key and get project context
    const ctx = await validateApiKey(apiKey)
    
    // ✅ Now ctx.projectId is validated and scoped
    const data = await prisma.table.findMany({
      where: { projectId: ctx.projectId }
    })

    return NextResponse.json({ data })
  } catch (error: any) {
    return NextResponse.json(
      { error: error.message }, 
      { status: 401 }
    )
  }
}

// ============================================================================
// 6. WORKSPACE CONTEXT (For workspace-level operations)
// ============================================================================

import { getWorkspaceContext } from '@/lib/auth/server'

export async function GET(
  request: NextRequest,
  { params }: { params: { projectId: string; workspaceId: string } }
) {
  // ✅ Validates both project AND workspace access
  const ctx = await getWorkspaceContext(
    params.projectId, 
    params.workspaceId
  )

  // ✅ ctx.workspace is guaranteed to belong to ctx.project
  const files = await prisma.workspaceFile.findMany({
    where: {
      projectId: ctx.projectId,
      workspaceId: ctx.workspaceId,
    }
  })

  return NextResponse.json({ 
    workspace: ctx.workspace,
    files 
  })
}

// ============================================================================
// 7. HANDLING SECURITY ERRORS
// ============================================================================

import { 
  UnauthorizedError, 
  ForbiddenError 
} from '@/lib/auth/server'

export async function POST(request: NextRequest) {
  try {
    const ctx = await getProjectContext(projectId)
    // ... your logic
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      // User not logged in
      return NextResponse.json(
        { error: 'Please login' }, 
        { status: 401 }
      )
    }
    
    if (error instanceof ForbiddenError) {
      // User doesn't have access to this project
      return NextResponse.json(
        { error: 'Access denied' }, 
        { status: 403 }
      )
    }
    
    // Other errors
    console.error('Error:', error)
    return NextResponse.json(
      { error: 'Internal server error' }, 
      { status: 500 }
    )
  }
}

// ============================================================================
// 8. ADMIN-ONLY ROUTES
// ============================================================================

import { requireAdmin } from '@/lib/auth/server'

export async function DELETE(request: NextRequest) {
  // ✅ Only admins can proceed
  const user = await requireAdmin()
  
  // Admin-only logic here
  await prisma.project.deleteMany({
    where: { userId: user.userId }
  })

  return NextResponse.json({ success: true })
}

// ============================================================================
// 9. AI ASSISTANT (Already secured)
// ============================================================================

// The AI chat endpoint is already secured with:
// - withProjectValidation middleware
// - Scoped context building
// - No global data access

// When calling AI:
fetch('/api/ai/chat', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Cookie': 'auth-token=xxx' // Middleware validates this
  },
  body: JSON.stringify({
    message: 'Create a users table',
    projectId: 'xxx' // Only this project's context used
  })
})

// ============================================================================
// 10. TESTING SECURITY
// ============================================================================

// Run security test suite:
// npx ts-node scripts/test-security.ts

// Manual tests:
const testCrossProjectAccess = async () => {
  try {
    // Try to access project you don't own
    const ctx = await getProjectContext('someone-elses-project')
    console.error('❌ SECURITY BREACH: Got access to wrong project!')
  } catch (error) {
    console.log('✅ Security working: Access denied')
  }
}

// ============================================================================
// ❌ ANTI-PATTERNS - DO NOT DO THIS
// ============================================================================

// ❌ DON'T: Query without projectId filter
const allTables = await prisma.table.findMany() // LEAKS DATA!

// ❌ DON'T: Trust client-provided userId
const { userId } = await request.json() // CAN BE SPOOFED!

// ❌ DON'T: Skip validation
if (!projectId) return // WRONG! Always validate access

// ❌ DON'T: Use global context in AI
const allProjects = await prisma.project.findMany() // AI sees everything!

// ============================================================================
// ✅ CORRECT PATTERNS
// ============================================================================

// ✅ DO: Always validate server-side
const ctx = await getProjectContext(projectId)

// ✅ DO: Use ctx.userId (from validated session)
const user = ctx.userId // VERIFIED

// ✅ DO: Filter by validated projectId
where: { projectId: ctx.projectId }

// ✅ DO: Use scoped context for AI
const context = await buildProjectContext(ctx.projectId)

// ============================================================================
// 🔒 SECURITY CHECKLIST FOR NEW FEATURES
// ============================================================================

/**
 * Before adding any new feature, ask:
 * 
 * [ ] Does it validate user authentication?
 * [ ] Does it validate project ownership?
 * [ ] Does it filter queries by projectId?
 * [ ] Does it prevent cross-tenant access?
 * [ ] Does it handle security errors properly?
 * [ ] Have you tested with multiple users/projects?
 * [ ] Does AI only see scoped data?
 * [ ] Are API keys project-scoped?
 * [ ] Are file paths project-scoped?
 * [ ] Are logs project-scoped?
 */

export const SECURITY_CHECKLIST = [
  'User authenticated?',
  'Project ownership validated?',
  'Queries filtered by projectId?',
  'Cross-tenant access prevented?',
  'Errors handled securely?',
  'Tested with multiple tenants?',
  'AI context scoped?',
  'API keys validated?',
  'Storage paths scoped?',
  'Logs project-filtered?',
]
