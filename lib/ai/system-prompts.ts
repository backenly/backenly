/**
 * @deprecated All exports have moved to lib/ai/system-prompt.ts
 * This file exists only for backwards compatibility.
 */

import type { BackendStateGraph } from '@/lib/orchestration/backend-state-graph'
export { getSystemPrompt, getArchitectSystemPrompt, buildWorkspaceContextFromGraph } from './system-prompt'

// Alias used by orchestration/index.ts
export { buildWorkspaceContextFromGraph as buildWorkspaceContext } from './system-prompt'

/**
 * Lightweight heuristic: suggest relationship if pattern matches
 */
export function suggestRelationshipHeuristic(
  newTable: string,
  existingTables: string[]
): { suggest: boolean; to?: string; reason?: string } {
  const table = newTable.toLowerCase().replace(/s$/, '')

  const patterns: Record<string, { parents: string[]; reason: string }> = {
    payment: { parents: ['users', 'orders'], reason: 'Payments typically belong to users or orders' },
    order: { parents: ['users', 'customers'], reason: 'Orders are usually placed by users' },
    comment: { parents: ['posts', 'users'], reason: 'Comments belong to content and users' },
    like: { parents: ['posts', 'users'], reason: 'Likes connect users to content' },
    review: { parents: ['products', 'users'], reason: 'Reviews are written by users about items' },
    message: { parents: ['users'], reason: 'Messages are sent by users' },
    notification: { parents: ['users'], reason: 'Notifications are sent to users' },
    upload: { parents: ['users'], reason: 'Uploads are made by users' },
    task: { parents: ['users', 'projects'], reason: 'Tasks are assigned to users' },
    ticket: { parents: ['users'], reason: 'Support tickets are created by users' },
  }

  const pattern = patterns[table]
  if (!pattern) return { suggest: false }

  const parent = pattern.parents.find(p =>
    existingTables.some(t => t.toLowerCase() === p.toLowerCase())
  )

  if (!parent) return { suggest: false }

  return { suggest: true, to: parent, reason: pattern.reason }
}

/**
 * Simple feature pattern for common entities
 */
export function getFeaturePattern(tableName: string): { fields: string[]; description: string } | null {
  const patterns: Record<string, { fields: string[]; description: string }> = {
    comments: { fields: ['content', 'userId', 'postId', 'createdAt'], description: 'Users commenting on posts' },
    likes: { fields: ['userId', 'postId', 'createdAt'], description: 'Users liking posts' },
    reviews: { fields: ['rating', 'content', 'userId', 'productId', 'createdAt'], description: 'Users reviewing products' },
    payments: { fields: ['amount', 'status', 'userId', 'createdAt'], description: 'Payment transactions' },
    orders: { fields: ['total', 'status', 'userId', 'createdAt'], description: 'Customer orders' },
    notifications: { fields: ['message', 'type', 'read', 'userId', 'createdAt'], description: 'User notifications' },
    messages: { fields: ['content', 'senderId', 'receiverId', 'createdAt'], description: 'User messages' },
    tasks: { fields: ['title', 'status', 'userId', 'createdAt'], description: 'User tasks' },
    uploads: { fields: ['fileUrl', 'fileType', 'userId', 'createdAt'], description: 'File uploads' },
  }

  return patterns[tableName.toLowerCase()] ?? null
}
