import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest } from '@/lib/auth/middleware'
import { hasPermission, hasAnyPermission, Permission, canAccessProject } from '@/lib/auth/rbac'

/**
 * Middleware to require a specific permission
 */
export function requirePermission(permission: Permission) {
  return async (request: NextRequest) => {
    const auth = await authenticateRequest(request)
    
    if (!auth.authenticated || !auth.userId) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      )
    }

    const hasAccess = await hasPermission(auth.userId, permission)
    
    if (!hasAccess) {
      return NextResponse.json(
        { error: 'Forbidden: Insufficient permissions' },
        { status: 403 }
      )
    }

    return null // Continue to handler
  }
}

/**
 * Middleware to require any of the specified permissions
 */
export function requireAnyPermission(permissions: Permission[]) {
  return async (request: NextRequest) => {
    const auth = await authenticateRequest(request)
    
    if (!auth.authenticated || !auth.userId) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      )
    }

    const hasAccess = await hasAnyPermission(auth.userId, permissions)
    
    if (!hasAccess) {
      return NextResponse.json(
        { error: 'Forbidden: Insufficient permissions' },
        { status: 403 }
      )
    }

    return null
  }
}

/**
 * Middleware to require project access
 */
export function requireProjectAccess() {
  return async (request: NextRequest) => {
    const auth = await authenticateRequest(request)
    
    if (!auth.authenticated || !auth.userId) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      )
    }

    const projectId = request.nextUrl.searchParams.get('projectId')
    
    if (!projectId) {
      return NextResponse.json(
        { error: 'projectId is required' },
        { status: 400 }
      )
    }

    const hasAccess = await canAccessProject(auth.userId, projectId)
    
    if (!hasAccess) {
      return NextResponse.json(
        { error: 'Forbidden: Cannot access this project' },
        { status: 403 }
      )
    }

    return null
  }
}

/**
 * Helper to wrap API route handlers with RBAC
 */
export function withRBAC(
  handler: (request: NextRequest, context?: any) => Promise<NextResponse>,
  permission?: Permission | Permission[]
) {
  return async (request: NextRequest, context?: any) => {
    const auth = await authenticateRequest(request)
    
    if (!auth.authenticated || !auth.userId) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      )
    }

    if (permission) {
      const permissions = Array.isArray(permission) ? permission : [permission]
      const hasAccess = await hasAnyPermission(auth.userId, permissions)
      
      if (!hasAccess) {
        return NextResponse.json(
          { error: 'Forbidden: Insufficient permissions' },
          { status: 403 }
        )
      }
    }

    return handler(request, context)
  }
}

