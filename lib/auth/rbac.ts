import { prisma } from '@/lib/db'

/**
 * Permission constants
 */
export const Permissions = {
  // Projects
  PROJECT_READ: 'project:read',
  PROJECT_WRITE: 'project:write',
  PROJECT_DELETE: 'project:delete',
  
  // Database
  DATABASE_READ: 'database:read',
  DATABASE_WRITE: 'database:write',
  DATABASE_DELETE: 'database:delete',
  
  // API Keys
  API_KEY_READ: 'api_key:read',
  API_KEY_WRITE: 'api_key:write',
  API_KEY_DELETE: 'api_key:delete',
  
  // Users
  USER_READ: 'user:read',
  USER_WRITE: 'user:write',
  USER_DELETE: 'user:delete',
  
  // Settings
  SETTINGS_READ: 'settings:read',
  SETTINGS_WRITE: 'settings:write',
  
  // AI Workspace
  AI_WORKSPACE_READ: 'ai_workspace:read',
  AI_WORKSPACE_WRITE: 'ai_workspace:write',
  
  // Storage
  STORAGE_READ: 'storage:read',
  STORAGE_WRITE: 'storage:write',
  STORAGE_DELETE: 'storage:delete',
  
  // Security
  SECURITY_READ: 'security:read',
  SECURITY_WRITE: 'security:write',
  
  // Monitoring
  MONITORING_READ: 'monitoring:read',
  
  // Logs
  LOGS_READ: 'logs:read',
  
  // Admin
  ADMIN: 'admin:*',
} as const

export type Permission = typeof Permissions[keyof typeof Permissions]

/**
 * Check if user has a specific permission
 */
export async function hasPermission(
  userId: string,
  permission: Permission
): Promise<boolean> {
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { role: true },
    })

    if (!user) {
      return false
    }

    // Admin has all permissions
    if (user.role?.permissions.includes(Permissions.ADMIN)) {
      return true
    }

    // Check role permissions
    if (user.role?.permissions.includes(permission)) {
      return true
    }

    return false
  } catch (error) {
    console.error('Error checking permission:', error)
    return false
  }
}

/**
 * Check if user has any of the specified permissions
 */
export async function hasAnyPermission(
  userId: string,
  permissions: Permission[]
): Promise<boolean> {
  for (const permission of permissions) {
    if (await hasPermission(userId, permission)) {
      return true
    }
  }
  return false
}

/**
 * Check if user has all of the specified permissions
 */
export async function hasAllPermissions(
  userId: string,
  permissions: Permission[]
): Promise<boolean> {
  for (const permission of permissions) {
    if (!(await hasPermission(userId, permission))) {
      return false
    }
  }
  return true
}

/**
 * Get all permissions for a user
 */
export async function getUserPermissions(userId: string): Promise<Permission[]> {
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { role: true },
    })

    if (!user || !user.role) {
      return []
    }

    return user.role.permissions as Permission[]
  } catch (error) {
    console.error('Error getting user permissions:', error)
    return []
  }
}

/**
 * Check if user owns a resource (by userId field)
 */
export async function ownsResource(
  userId: string,
  resourceUserId: string | null | undefined
): Promise<boolean> {
  if (!resourceUserId) {
    return false
  }
  return userId === resourceUserId
}

/**
 * Check if user can access a project
 */
export async function canAccessProject(
  userId: string,
  projectId: string
): Promise<boolean> {
  try {
    // Check if user has project read permission
    if (await hasPermission(userId, Permissions.PROJECT_READ)) {
      return true
    }

    // Check if user owns the project
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { userId: true },
    })

    if (!project) {
      return false
    }

    return ownsResource(userId, project.userId)
  } catch (error) {
    console.error('Error checking project access:', error)
    return false
  }
}

