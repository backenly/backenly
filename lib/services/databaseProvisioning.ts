/**
 * The names a project's workspace data is kept under.
 *
 * A project's tables live in the PostgreSQL schema `workspace_{projectId}`, in
 * the database of the project's region (lib/data-plane/regional.ts). The schema
 * is created with the project, by createProvisionedProject
 * (lib/projects/provision.ts), which also writes its name to
 * `Workspace.postgresSchema`. Nothing here creates anything.
 */

import * as crypto from 'crypto'

/**
 * Sanitize identifier for use in database names/schemas
 * Only allow alphanumeric, underscore, and hyphen
 */
function sanitizeIdentifier(id: string): string {
  // Remove any characters that aren't alphanumeric, underscore, or hyphen
  return id.replace(/[^a-zA-Z0-9_-]/g, '_')
}

/**
 * Generate a short, unique MongoDB database name from projectId
 * MongoDB Atlas has a 38-byte limit, so we use a hash-based approach
 * Format: ws_<first-8-chars-of-hash> (max 11 chars, well under 38 bytes)
 */
function generateShortMongoDbName(projectId: string): string {
  // Create a hash of the projectId to ensure uniqueness
  const hash = crypto.createHash('sha256').update(projectId).digest('hex')
  // Use first 8 characters of hash + prefix = 11 chars total (well under 38 bytes)
  const shortHash = hash.substring(0, 8)
  return `ws_${shortHash}`
}

/**
 * The workspace schema a project's tables are in, and the name of its optional
 * MongoDB database.
 */
export function getWorkspaceDatabaseNames(projectId: string): {
  postgresSchema: string
  mongodbDatabase: string
} {
  const sanitized = sanitizeIdentifier(projectId)
  return {
    postgresSchema: `workspace_${sanitized}`,
    mongodbDatabase: generateShortMongoDbName(projectId),
  }
}
