/**
 * PHASE 19 — DATA OWNERSHIP & EXIT SAFETY
 * 
 * Users must be able to export ALL their data anytime.
 * No lock-in fear. Complete data ownership.
 * 
 * Export format: Clean JSON with NO backend terminology
 * - "users" not "auth"
 * - "data" not "database"
 * - "connections" not "APIs"
 */

import { prisma } from '@/lib/db'

export interface DataExport {
  exportedAt: string
  project: {
    id: string
    name: string
    createdAt: string
  }
  users: Array<{
    id: string
    email: string
    createdAt: string
  }>
  data: Array<{
    collection: string
    records: Record<string, unknown>[]
  }>
  connections: Array<{
    type: string
    name: string
    createdAt: string
  }>
  files: Array<{
    name: string
    size: number
    url: string
    createdAt: string
  }>
  changes: Array<{
    description: string
    madeAt: string
    type: string
  }>
}

/**
 * Export all user data for a project
 * Returns clean JSON with user-friendly terminology
 */
export async function exportProjectData(projectId: string, userId: string): Promise<DataExport> {
  console.log(`[Data Export] Starting export for project ${projectId}`)

  // Get project details
  const project = await prisma.project.findUnique({
    where: { id: projectId, userId },
    select: {
      id: true,
      name: true,
      createdAt: true,
    },
  })

  if (!project) {
    throw new Error('Project not found')
  }

  // Get all users (if multi-user project)
  const projectUsers = await prisma.user.findMany({
    where: {
      projects: {
        some: { id: projectId },
      },
    },
    select: {
      id: true,
      email: true,
      createdAt: true,
    },
  })

  // Get all database data (from workspace database)
  const data = await exportDatabaseData(projectId)

  // Get all API keys/connections
  const connections = await exportConnections(projectId)

  // Get all files (from storage)
  const files = await exportFiles(projectId)

  // Get change history
  const changes = await exportChanges(projectId)

  const exportData: DataExport = {
    exportedAt: new Date().toISOString(),
    project: {
      id: project.id,
      name: project.name,
      createdAt: project.createdAt.toISOString(),
    },
    users: projectUsers.map((u) => ({
      id: u.id,
      email: u.email || '',
      createdAt: u.createdAt.toISOString(),
    })),
    data,
    connections,
    files,
    changes,
  }

  console.log(`[Data Export] Export complete: ${data.length} collections, ${files.length} files`)

  return exportData
}

/**
 * Export all database data
 */
async function exportDatabaseData(
  projectId: string
): Promise<Array<{ collection: string; records: Record<string, unknown>[] }>> {
  // TODO: Implement full database export
  // This requires proper workspace database introspection
  console.log('[Data Export] Database export not yet implemented')
  return []
}

/**
 * Export all API keys/connections
 */
async function exportConnections(
  projectId: string
): Promise<Array<{ type: string; name: string; createdAt: string }>> {
  try {
    const apiKeys = await prisma.apiKey.findMany({
      where: { projectId },
      select: {
        name: true,
        createdAt: true,
      },
    })

    return apiKeys.map((key) => ({
      type: 'connection', // User-friendly: "connection" not "API key"
      name: key.name,
      createdAt: key.createdAt.toISOString(),
    }))
  } catch (error) {
    console.error('[Data Export] Failed to export connections:', error)
    return []
  }
}

/**
 * Export all files from storage
 */
async function exportFiles(
  projectId: string
): Promise<Array<{ name: string; size: number; url: string; createdAt: string }>> {
  try {
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { storageBuckets: true },
    })

    if (!project?.storageBuckets || project.storageBuckets.length === 0) {
      return []
    }

    // TODO: Integrate with actual storage provider (S3, etc.)
    // For now, return empty array
    return []
  } catch (error) {
    console.error('[Data Export] Failed to export files:', error)
    return []
  }
}

/**
 * Export change history
 */
async function exportChanges(
  projectId: string
): Promise<Array<{ description: string; madeAt: string; type: string }>> {
  try {
    // Check if AuditLog table exists
    const auditLogs = await prisma.auditLog.findMany({
      where: { projectId },
      orderBy: { timestamp: 'desc' },
      take: 1000, // Last 1000 changes
      select: {
        action: true,
        timestamp: true,
        metadata: true,
      },
    })

    return auditLogs.map((log) => ({
      description: log.action, // User-friendly description
      madeAt: log.timestamp.toISOString(),
      type: typeof log.metadata === 'object' && log.metadata && 'type' in log.metadata 
        ? String(log.metadata.type) 
        : 'change',
    }))
  } catch (error) {
    console.error('[Data Export] Failed to export changes:', error)
    return []
  }
}

/**
 * Validate export data size (prevent abuse)
 */
export function validateExportSize(exportData: DataExport): { valid: boolean; sizeMB: number } {
  const jsonString = JSON.stringify(exportData)
  const sizeMB = Buffer.byteLength(jsonString, 'utf8') / (1024 * 1024)

  // Max 100MB export size
  const valid = sizeMB <= 100

  return { valid, sizeMB }
}

/**
 * Generate human-readable export filename
 */
export function generateExportFilename(projectName: string): string {
  const timestamp = new Date().toISOString().split('T')[0] // YYYY-MM-DD
  const safeName = projectName.replace(/[^a-z0-9]/gi, '-').toLowerCase()
  return `${safeName}-export-${timestamp}.json`
}
