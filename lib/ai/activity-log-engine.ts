/**
 * ACTIVITY LOG + NOTIFICATION ENGINE
 * ===================================
 * Auto-triggers activity logs and notifications on database operations.
 * Fire-and-forget, non-blocking.
 */

export interface ActivityLogEntry {
  action: 'created' | 'updated' | 'deleted'
  entityType: string
  entityId: string
  description: string
  actorId?: string
  metadata?: Record<string, any>
  projectId: string
}

export interface NotificationPayload {
  userId: string
  title: string
  body: string
  type: string
  actionUrl?: string
  metadata?: Record<string, any>
  projectId: string
}

// Tables that should be auto-logged
const LOGGABLE_TABLES = [
  'projects', 'tasks', 'orders', 'posts', 'articles',
  'users', 'organizations', 'workspaces', 'products', 'listings',
  'invitations', 'subscriptions', 'payments',
]

// Tables/actions that trigger notifications
const NOTIFICATION_TRIGGERS: Record<string, Record<string, string>> = {
  tasks: {
    created: 'A new task was created',
    updated: 'A task was updated',
  },
  comments: {
    created: 'Someone commented',
  },
  invitations: {
    created: 'You have a new invitation',
  },
  orders: {
    created: 'New order received',
    updated: 'Order status updated',
  },
}

export function shouldAutoLog(tableName: string): boolean {
  return LOGGABLE_TABLES.includes(tableName.toLowerCase())
}

export function shouldAutoNotify(tableName: string, action: string): boolean {
  const triggers = NOTIFICATION_TRIGGERS[tableName.toLowerCase()]
  return !!(triggers && triggers[action])
}

export function buildNotificationFromActivity(
  entry: ActivityLogEntry,
  targetUserId: string,
  tableName: string
): NotificationPayload {
  const triggers = NOTIFICATION_TRIGGERS[tableName.toLowerCase()]
  const body = triggers?.[entry.action] || `${tableName} was ${entry.action}`

  return {
    userId: targetUserId,
    title: `${tableName.charAt(0).toUpperCase() + tableName.slice(1, -1)} ${entry.action}`,
    body,
    type: `${tableName}_${entry.action}`,
    metadata: { entityId: entry.entityId, actorId: entry.actorId },
    projectId: entry.projectId,
  }
}

export async function logActivity(entry: ActivityLogEntry): Promise<void> {
  try {
    const { prisma } = await import('@/lib/db')
    const { getWorkspaceDatabaseNames } = await import('@/lib/services/databaseProvisioning')
    const { postgresSchema } = getWorkspaceDatabaseNames(entry.projectId)

    // Check if activity_logs table exists in workspace
    const tableExists = await prisma.$queryRawUnsafe<{ exists: boolean }[]>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables
         WHERE table_schema = $1 AND table_name = 'activity_logs'
       ) as exists`,
      postgresSchema
    )

    if (!tableExists[0]?.exists) return

    await prisma.$executeRawUnsafe(
      `INSERT INTO "${postgresSchema}"."activity_logs"
       (action, entity_type, entity_id, description, actor_id, metadata, created_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, NOW())
       ON CONFLICT DO NOTHING`,
      entry.action,
      entry.entityType,
      entry.entityId,
      entry.description,
      entry.actorId || null,
      JSON.stringify(entry.metadata || {})
    )
  } catch (err: any) {
    // Non-fatal: activity logging should never break the main operation
    console.warn(`[Activity Log] Failed to log ${entry.action} on ${entry.entityType}:`, err?.message?.slice(0, 80))
  }
}

export async function triggerNotification(payload: NotificationPayload): Promise<void> {
  try {
    const { prisma } = await import('@/lib/db')
    const { getWorkspaceDatabaseNames } = await import('@/lib/services/databaseProvisioning')
    const { postgresSchema } = getWorkspaceDatabaseNames(payload.projectId)

    // Check if notifications table exists
    const tableExists = await prisma.$queryRawUnsafe<{ exists: boolean }[]>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables
         WHERE table_schema = $1 AND table_name = 'notifications'
       ) as exists`,
      postgresSchema
    )

    if (!tableExists[0]?.exists) return

    await prisma.$executeRawUnsafe(
      `INSERT INTO "${postgresSchema}"."notifications"
       (user_id, title, body, type, read, metadata, created_at)
       VALUES ($1, $2, $3, $4, false, $5::jsonb, NOW())
       ON CONFLICT DO NOTHING`,
      payload.userId,
      payload.title,
      payload.body,
      payload.type,
      JSON.stringify(payload.metadata || {})
    )
  } catch (err: any) {
    console.warn(`[Notifications] Failed to create notification:`, err?.message?.slice(0, 80))
  }
}

export async function triggerActivityAndNotification(
  projectId: string,
  action: 'created' | 'updated' | 'deleted',
  entityType: string,
  entityId: string,
  actorId: string | undefined,
  data: Record<string, any>
): Promise<void> {
  // Fire-and-forget — never await this from main operations
  const logEntry: ActivityLogEntry = {
    action,
    entityType,
    entityId,
    description: `${entityType} ${action} by ${actorId || 'system'}`,
    actorId,
    metadata: { data },
    projectId,
  }

  // Log activity (fire-and-forget)
  logActivity(logEntry).catch((err) => console.error('[ActivityLogEngine] logActivity failed:', err))

  // Trigger notifications if applicable
  if (shouldAutoNotify(entityType, action)) {
    // Find relevant users to notify based on entity type
    try {
      const { prisma } = await import('@/lib/db')
      const { getWorkspaceDatabaseNames } = await import('@/lib/services/databaseProvisioning')
      const { postgresSchema } = getWorkspaceDatabaseNames(projectId)

      // For tasks: notify assignee
      if (entityType === 'tasks' && data.assigned_to && data.assigned_to !== actorId) {
        const notification = buildNotificationFromActivity(logEntry, data.assigned_to, entityType)
        triggerNotification(notification).catch((err) => console.error('[ActivityLogEngine] triggerNotification failed:', err))
      }

      // For comments: notify post/task owner
      if (entityType === 'comments' && (data.task_id || data.post_id)) {
        const parentTable = data.task_id ? 'tasks' : 'posts'
        const parentId = data.task_id || data.post_id

        const parentRow = await prisma.$queryRawUnsafe<{ user_id?: string; author_id?: string }[]>(
          `SELECT user_id, author_id FROM "${postgresSchema}"."${parentTable}" WHERE id = $1 LIMIT 1`,
          parentId
        ).catch(() => [])

        const ownerId = parentRow[0]?.user_id || parentRow[0]?.author_id
        if (ownerId && ownerId !== actorId) {
          const notification = buildNotificationFromActivity(logEntry, ownerId, entityType)
          triggerNotification(notification).catch((err) => console.error('[ActivityLogEngine] triggerNotification failed:', err))
        }
      }
    } catch (err) { console.error('[ActivityLogEngine] notification lookup failed (non-fatal):', err) }
  }
}
