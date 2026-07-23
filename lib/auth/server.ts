/**
 * 🔒 SERVER-SIDE AUTHENTICATION & AUTHORIZATION
 * 
 * CTO-Grade Security Enforcement
 * DO NOT trust client - verify everything server-side
 */

import { cookies, headers } from 'next/headers'
import { verifyToken } from './jwt'
import { prisma } from '@/lib/db/postgres'
import { verifyProjectAccess } from './project-access'

export class UnauthorizedError extends Error {
  constructor(message = 'Unauthorized') {
    super(message)
    this.name = 'UnauthorizedError'
  }
}

export class ForbiddenError extends Error {
  constructor(message = 'Forbidden - Access denied') {
    super(message)
    this.name = 'ForbiddenError'
  }
}

/**
 * 🔒 REQUIRE USER - Server-side session enforcement
 * 
 * Use in every server component, server action, and API route
 * DO NOT proceed without valid user
 */
export async function requireUser() {
  const cookieStore = await cookies()
  const token = cookieStore.get('auth-token')?.value

  if (!token) {
    throw new UnauthorizedError('No authentication token')
  }

  const payload = verifyToken(token)
  if (!payload) {
    throw new UnauthorizedError('Invalid token')
  }

  // Verify session exists in database
  const session = await prisma.session.findUnique({
    where: { token },
    include: {
      user: {
        include: {
          role: true,
        },
      },
    },
  })

  if (!session || session.expiresAt < new Date()) {
    throw new UnauthorizedError('Session expired')
  }

  if (session.user.deletedAt) {
    throw new UnauthorizedError('Account no longer exists')
  }

  if (session.user.suspendedAt) {
    throw new UnauthorizedError('Account suspended')
  }

  return {
    userId: session.userId,
    email: session.user.email,
    role: session.user.role?.name,
    user: session.user,
  }
}

/**
 * 🔒 GET USER FROM HEADERS (set by middleware)
 * 
 * Faster alternative for API routes (middleware already validated)
 */
export async function getUserFromHeaders() {
  const headersList = await headers()
  const userId = headersList.get('x-user-id')
  const email = headersList.get('x-user-email')
  const role = headersList.get('x-user-role')

  if (!userId || !email) {
    throw new UnauthorizedError()
  }

  return { userId, email, role }
}

/**
 * 🔒 PROJECT CONTEXT RESOLVER - Authorization Enforcement
 * 
 * CRITICAL: Validates user has access to project
 * Prevents cross-tenant data leakage
 * 
 * Usage: const ctx = await getProjectContext(projectId)
 */
export async function getProjectContext(projectId: string) {
  const user = await requireUser()

  // Validate project exists and user has access
  const project = await prisma.project.findFirst({
    where: {
      id: projectId,
      // User must own the project
      userId: user.userId,
    },
    include: {
      workspaces: true,
    },
  })

  if (!project) {
    throw new ForbiddenError(
      'Project not found or you do not have access'
    )
  }

  return {
    user,
    project,
    projectId: project.id,
    userId: user.userId,
  }
}

/**
 * 🔒 WORKSPACE CONTEXT RESOLVER
 * 
 * Validates workspace access with full tenant isolation
 */
export async function getWorkspaceContext(
  projectId: string,
  workspaceId?: string
) {
  const ctx = await getProjectContext(projectId)

  if (!workspaceId) {
    return ctx
  }

  // Validate workspace belongs to project
  const workspace = await prisma.workspace.findFirst({
    where: {
      id: workspaceId,
      projectId: projectId,
    },
  })

  if (!workspace) {
    throw new ForbiddenError(
      'Workspace not found or does not belong to this project'
    )
  }

  return {
    ...ctx,
    workspace,
    workspaceId: workspace.id,
  }
}

/**
 * 🔒 VALIDATE API KEY - For external API access
 * 
 * Returns project context if key is valid
 */
export async function validateApiKey(apiKey: string) {
  // Hash the API key to look it up securely
  const crypto = await import('crypto')
  const keyHash = crypto.createHash('sha256').update(apiKey).digest('hex')
  
  const key = await prisma.apiKey.findUnique({
    where: { keyHash },
    include: {
      project: true,
      user: true,
    },
  })

  if (!key) {
    throw new UnauthorizedError('Invalid API key')
  }

  if (key.expiresAt && key.expiresAt < new Date()) {
    throw new ForbiddenError('API key has expired')
  }

  // Update last used timestamp
  await prisma.apiKey.update({
    where: { id: key.id },
    data: { lastUsed: new Date() },
  })

  return {
    apiKey: key,
    projectId: key.projectId,
    userId: key.userId,
    project: key.project,
  }
}

/**
 * 🔒 REQUIRE ADMIN - Role-based access control
 */
export async function requireAdmin() {
  const user = await requireUser()

  if (user.role !== 'admin' && user.role !== 'super_admin') {
    throw new ForbiddenError('Admin access required')
  }

  return user
}

/**
 * 🔒 REQUIRE PROJECT ACCESS - Validates user has access to project
 * 
 * This is the MANDATORY check for all project-scoped operations.
 * Extracts projectId from header (x-project-id) or returns error.
 * 
 * Usage in API route:
 *   const ctx = await requireProjectAccess(request)
 *   // ctx.user, ctx.project, ctx.projectId are now available
 */
export async function requireProjectAccess(request: Request) {
  const callId = crypto.randomUUID().slice(0, 8);
  console.log(`[${callId}] 🔒 requireProjectAccess() called`);
  console.log(`[${callId}] 📋 Request URL:`, request.url);
  console.log(`[${callId}] 📋 Request method:`, request.method);
  
  // Step 1: Require authenticated user
  let user;
  try {
    user = await requireUser();
    console.log(`[${callId}] ✅ User authenticated:`, { userId: user.userId, email: user.email });
  } catch (error: any) {
    console.error(`[${callId}] ❌ User authentication failed:`, error.message);
    throw error;
  }

  // Step 2: Extract projectId from request
  const url = new URL(request.url);
  const projectIdFromQuery = url.searchParams.get('projectId');
  const projectIdFromHeader = request.headers.get('x-project-id');

  // Extract from URL path — handles /api/projects/[id]/... routes where withProjectAccess
  // is used but the Next.js route params are not forwarded into this function.
  const pathMatch = url.pathname.match(/\/projects\/([a-zA-Z0-9-_]+)/)
  const projectIdFromPath = pathMatch?.[1] ?? null;

  console.log(`[${callId}] 🔍 Looking for projectId...`);
  console.log(`[${callId}]   - From query: ${projectIdFromQuery}`);
  console.log(`[${callId}]   - From header: ${projectIdFromHeader}`);
  console.log(`[${callId}]   - From path: ${projectIdFromPath}`);

  let projectIdFromBody = null;
  // Only try to read body for non-GET requests
  // 🔧 FIX: Clone body for handler to re-read, or parse and pass through context
  let parsedBody: any = null;
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    try {
      // Clone the request to allow route handler to read body again
      const clonedRequest = request.clone();
      parsedBody = await clonedRequest.json().catch(() => ({}));
      projectIdFromBody = parsedBody.projectId;
      console.log(`[${callId}]   - From body: ${projectIdFromBody}`);
    } catch (e) {
      console.log(`[${callId}]   - Body parse skipped (likely GET request)`);
    }
  }

  const projectId = projectIdFromQuery || projectIdFromHeader || projectIdFromBody || projectIdFromPath;

  console.log(`[${callId}] 📌 Selected projectId: ${projectId}`);

  if (!projectId) {
    console.error(`[${callId}] ❌ No projectId found in request`);
    throw new ForbiddenError('Missing projectId - project context required');
  }

  // Step 3: Validate project access
  console.log(`[${callId}] 🔄 Validating project access for user ${user.userId} on project ${projectId}`);
  let project;
  try {
    project = await verifyProjectAccess(projectId, user.userId);
    console.log(`[${callId}] ✅ Project access verified:`, { projectId: project.id, projectName: project.name });
  } catch (error: any) {
    console.error(`[${callId}] ❌ Project access denied:`, error.message);
    
    // 🚫 CRITICAL: Return correct status code based on error type
    if (error.message === 'PROJECT_NOT_FOUND') {
      throw new ForbiddenError('Project not found'); // This triggers 404 in route handler
    }
    if (error.message === 'PROJECT_FORBIDDEN') {
      throw new ForbiddenError('You do not have access to this project'); // 403
    }
    throw new ForbiddenError('Invalid project access');
  }

  // STEP 4: SDK-first architecture - no auto-origin learning needed
  // CORS is handled by static allowlist in middleware
  // This simplifies the architecture and removes database dependency for CORS

  console.log(`[${callId}] ✅ requireProjectAccess() complete`);

  return {
    user,
    project, // Already includes workspaces from verifyProjectAccess
    projectId: project.id,
    userId: user.userId,
  };
}

/**
 * 🔒 REQUIRE ROLE - Role-based access control for projects
 * 
 * Usage:
 *   await requireRole(request, 'owner')
 *   await requireRole(request, ['admin', 'owner'])
 */
export async function requireRole(
  request: Request,
  allowedRoles: string | string[]
) {
  const ctx = await requireProjectAccess(request)
  const roles = Array.isArray(allowedRoles) ? allowedRoles : [allowedRoles]

  // Check if user has required role
  const userRole = ctx.user.role || 'member'
  
  if (!roles.includes(userRole)) {
    throw new ForbiddenError(
      `Required role: ${roles.join(' or ')}. Your role: ${userRole}`
    )
  }

  return ctx
}
