/**
 * EXECUTION GUARD — Permission / Authorization Layer
 * ====================================================
 * Checks whether a user is allowed to perform a given action on a project.
 *
 * Permission model:
 *   owner  → all permissions
 *   admin  → all permissions (future team member with admin role)
 *   member → read + limited write (no deploy, no integration changes)
 *   viewer → read only
 *
 * Every autonomous agent action must pass this check before execution.
 */

import { prisma } from '@/lib/db/prisma'

export type ExecutionPermission =
  | 'schema:read'         // LIST_TABLES, introspect
  | 'schema:write'        // CREATE_TABLE, ADD_COLUMN, ALTER, DROP
  | 'api:write'           // GENERATE_API, DELETE_API
  | 'auth:write'          // ENABLE_AUTH, ADD_PROVIDER
  | 'integration:write'   // Enable integrations, store API keys
  | 'deploy:write'        // TRIGGER_DEPLOY
  | 'agent:fix'           // FIX intent (schema repair)
  | 'agent:build'         // BUILD intent
  | 'agent:modify'        // MODIFY intent
  | 'key:read'            // Decrypt API keys (server-side only)

export type UserRole = 'owner' | 'admin' | 'member' | 'viewer'

export interface GuardResult {
  allowed: boolean
  role: UserRole
  reason?: string
}

/** Permissions per role. */
const ROLE_PERMISSIONS: Record<UserRole, ExecutionPermission[]> = {
  owner: [
    'schema:read', 'schema:write',
    'api:write', 'auth:write',
    'integration:write', 'deploy:write',
    'agent:fix', 'agent:build', 'agent:modify',
    'key:read',
  ],
  admin: [
    'schema:read', 'schema:write',
    'api:write', 'auth:write',
    'integration:write', 'deploy:write',
    'agent:fix', 'agent:build', 'agent:modify',
    'key:read',
  ],
  member: [
    'schema:read', 'schema:write',
    'api:write',
    'agent:build', 'agent:modify', 'agent:fix',
  ],
  viewer: ['schema:read'],
}

/**
 * Determine the user's role on a project.
 * Owners are users whose userId matches the project's userId.
 */
async function getUserRole(userId: string, projectId: string): Promise<UserRole> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { userId: true },
  })

  if (!project) return 'viewer'
  if (project.userId === userId) return 'owner'

  // Future: check project team membership table here
  // For now, non-owners default to viewer (safe)
  return 'viewer'
}

/**
 * Check if a user has a specific permission on a project.
 */
export async function canExecute(
  userId: string,
  projectId: string,
  permission: ExecutionPermission
): Promise<GuardResult> {
  const role = await getUserRole(userId, projectId)
  const allowed = ROLE_PERMISSIONS[role]?.includes(permission) ?? false

  if (!allowed) {
    return {
      allowed: false,
      role,
      reason: `Role "${role}" does not have permission "${permission}" on this project.`,
    }
  }

  return { allowed: true, role }
}

/**
 * Map an IntentType to the required permission.
 */
export function intentToPermission(intent: string): ExecutionPermission {
  switch (intent) {
    case 'BUILD': return 'agent:build'
    case 'MODIFY': return 'agent:modify'
    case 'FIX': return 'agent:fix'
    case 'INTEGRATION': return 'integration:write'
    case 'QUESTION': return 'schema:read'
    default: return 'schema:read'
  }
}

/**
 * Map an AIAction to the required permission.
 */
export function actionToPermission(action: string): ExecutionPermission {
  if (['CREATE_TABLE', 'ADD_COLUMN', 'RENAME_COLUMN', 'ADD_CONSTRAINT', 'CREATE_INDEX'].includes(action)) {
    return 'schema:write'
  }
  if (['GENERATE_API', 'LIST_APIS'].includes(action)) return 'api:write'
  if (['ENABLE_AUTH', 'ADD_PROVIDER'].includes(action)) return 'auth:write'
  if (['TRIGGER_DEPLOY', 'ROLLBACK_DEPLOY'].includes(action)) return 'deploy:write'
  if (['LIST_TABLES', 'INFO', 'GET_METRICS'].includes(action)) return 'schema:read'
  return 'schema:write'
}
