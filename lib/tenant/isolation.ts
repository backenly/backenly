/**
 * Tenant Isolation Service
 * 
 * Provides utilities for enforcing multi-tenant isolation in Backenly.
 * Ensures that all data operations are scoped to the current project/tenant.
 */

import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import { authenticateRequest } from '@/lib/auth/middleware'
import { recordSecurityEvent } from '@/lib/platform/controls'
import { Prisma } from '@prisma/client'

export class TenantIsolationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TenantIsolationError'
  }
}

/**
 * Extract project ID from request, validating that the authenticated user
 * actually owns the requested project.
 *
 * Priority:
 * 1. X-Project-Id header (for API requests) — verified against caller's projects
 * 2. projectId query parameter — verified against caller's projects
 * 3. projectId from authenticated user's default project (always owned)
 *
 * SECURITY: previously this function returned whatever projectId the client
 * sent in the header/query without checking ownership — which made every
 * route that used it IDOR-vulnerable (auth/generate-code, storage/files/...,
 * database-brain/*, ai-workspace/*, workspace/files/...). The helper now
 * always enforces ownership, with the cross-tenant signal surfaced on the
 * Security tab.
 */
export async function getCurrentProjectId(request: NextRequest): Promise<string> {
  const headerProjectId = request.headers.get('x-project-id')
  const url = new URL(request.url)
  const queryProjectId = url.searchParams.get('projectId')
  const requested = headerProjectId ?? queryProjectId

  const auth = await authenticateRequest(request)
  if (!auth.authenticated || !auth.userId) {
    throw new TenantIsolationError('Authentication required')
  }

  if (requested) {
    // Verify the caller actually owns the requested project.
    const owned = await prisma.project.findFirst({
      where: { id: requested, userId: auth.userId },
      select: { id: true },
    })
    if (owned) return owned.id

    // Cross-tenant probe — high-value signal for the Security tab.
    const ip =
      request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
      request.headers.get('x-real-ip') ||
      null
    recordSecurityEvent({
      kind: 'cross_tenant',
      severity: 'high',
      userId: auth.userId,
      userEmail: auth.userEmail ?? null,
      projectId: requested,
      ip,
      summary: `User ${auth.userEmail ?? auth.userId} requested a project they do not own`,
      detail: { requestedProjectId: requested, path: request.nextUrl.pathname, method: request.method, via: 'getCurrentProjectId' },
    }).catch(() => {})
    throw new TenantIsolationError('Project not found or access denied')
  }

  // No projectId provided — fall back to user's default project.
  const userProject = await prisma.project.findFirst({
    where: { userId: auth.userId },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
  })

  if (userProject) {
    return userProject.id
  }

  throw new TenantIsolationError('Project ID is required. Provide X-Project-Id header or projectId query parameter.')
}

/**
 * Require project ID - throws if not provided
 */
export async function requireProjectId(request: NextRequest): Promise<string> {
  const projectId = await getCurrentProjectId(request)
  
  if (!projectId) {
    throw new TenantIsolationError('Project ID is required')
  }

  // Validate that the project exists and user has access
  const auth = await authenticateRequest(request)
  if (auth.authenticated && auth.userId) {
    const project = await prisma.project.findFirst({
      where: {
        id: projectId,
        userId: auth.userId, // Ensure user owns the project
      },
    })

    if (!project) {
      // A logged-in user asked for a project they don't own. This is the
      // single highest-value tenant-isolation signal — surface it loudly on
      // the Security tab. Fire-and-forget; never block the throw.
      const ip =
        request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
        request.headers.get('x-real-ip') ||
        null
      recordSecurityEvent({
        kind: 'cross_tenant',
        severity: 'high',
        userId: auth.userId,
        userEmail: auth.userEmail ?? null,
        projectId,
        ip,
        summary: `User ${auth.userEmail ?? auth.userId} requested a project they do not own`,
        detail: { requestedProjectId: projectId, path: request.nextUrl.pathname, method: request.method },
      })
      throw new TenantIsolationError('Project not found or access denied')
    }
  }

  return projectId
}

/**
 * Validate that a resource belongs to the specified project
 */
export async function validateProjectOwnership(
  projectId: string,
  resourceProjectId: string | null | undefined,
  resourceType: string = 'Resource'
): Promise<void> {
  if (!resourceProjectId) {
    throw new TenantIsolationError(`${resourceType} is not associated with a project`)
  }

  if (resourceProjectId !== projectId) {
    throw new TenantIsolationError(`${resourceType} does not belong to the specified project`)
  }
}

/**
 * Create a Prisma where clause that enforces tenant isolation
 */
export function withTenantScope(
  projectId: string,
  additionalWhere?: any
): any {
  return {
    ...additionalWhere,
    projectId: projectId,
  }
}

/**
 * Create a Prisma where clause for models with optional projectId
 * (for system-wide resources that can optionally be scoped)
 */
export function withOptionalTenantScope(
  projectId: string | null | undefined,
  additionalWhere?: any
): any {
  if (!projectId) {
    return additionalWhere
  }

  return {
    ...additionalWhere,
    projectId: projectId,
  }
}

/**
 * Middleware to extract and validate project ID from request
 * Adds projectId to request context
 */
export async function withTenantIsolation<T>(
  request: NextRequest,
  handler: (projectId: string, request: NextRequest) => Promise<T>
): Promise<T> {
  const projectId = await requireProjectId(request)
  return handler(projectId, request)
}

/**
 * Validate that an API key belongs to a project
 * API keys are user-scoped but should also be project-scoped for tenant isolation
 */
export async function validateApiKeyProject(
  apiKeyId: string,
  projectId: string
): Promise<void> {
  const apiKey = await prisma.apiKey.findUnique({
    where: { id: apiKeyId },
    select: { userId: true },
  })

  if (!apiKey) {
    throw new TenantIsolationError('API key not found')
  }

  // Check if the API key's user has access to this project
  const project = await prisma.project.findFirst({
    where: {
      id: projectId,
      userId: apiKey.userId,
    },
  })

  if (!project) {
    throw new TenantIsolationError('API key does not have access to this project')
  }
}

/**
 * Get all project IDs that a user has access to
 */
export async function getUserProjectIds(userId: string): Promise<string[]> {
  const projects = await prisma.project.findMany({
    where: { userId },
    select: { id: true },
  })

  return projects.map(p => p.id)
}

/**
 * Check if user has access to a project
 */
export async function userHasProjectAccess(userId: string, projectId: string): Promise<boolean> {
  const project = await prisma.project.findFirst({
    where: {
      id: projectId,
      userId,
    },
  })

  return !!project
}

