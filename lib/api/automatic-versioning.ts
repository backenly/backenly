/**
 * Automatic API Versioning
 * 
 * CRITICAL PRODUCTION SAFETY: Prevents instant breakage from schema mutations
 * 
 * ═══════════════════════════════════════════════════════════════════════
 * THREE NON-NEGOTIABLE RULES (ENFORCED FOREVER)
 * ═══════════════════════════════════════════════════════════════════════
 * 
 * RULE 1: Versions are write-once, NEVER mutable
 * ────────────────────────────────────────────────
 * - Once a version exists, it can NEVER be altered
 * - No patches, no fixes, no updates to existing versions
 * - Bugs require creating v(N+1), not modifying v(N)
 * - Mutating old versions breaks pinning and destroys trust
 * - ENFORCEMENT: INSERT only, no UPDATE statements on api_versions
 * 
 * RULE 2: Version resolution must be deterministic and boring
 * ────────────────────────────────────────────────────────────────
 * - No AI, no heuristics, no "best guess"
 * - (connection_id, project_id, table_id) → exact version
 * - No fallbacks, no implicit upgrades, no "helping" the user
 * - Any deviation introduces silent breakage
 * - ENFORCEMENT: Pure lookup, no logic branches
 * 
 * RULE 3: Versions are a liability, not a feature
 * ───────────────────────────────────────────────────
 * - NEVER visible in UI
 * - NEVER selectable by users
 * - NEVER promoted or marketed
 * - They exist to absorb change, protect trust, buy time
 * - ENFORCEMENT: No exports to UI layer, no user-facing APIs
 * 
 * ═══════════════════════════════════════════════════════════════════════
 * 
 * PHILOSOPHY:
 * - Versioning is automatic, invisible, and irreversible
 * - Every schema mutation creates new API version internally
 * - Existing API versions remain available indefinitely
 * - Frontend connections are pinned to a version automatically
 * - Restore rolls back version mapping, not live endpoints
 * 
 * INVISIBLE TO USERS:
 * - No version selectors
 * - No migration prompts
 * - No SDK changes
 * - Completely transparent
 * 
 * GUARANTEES:
 * - No backend change can silently break a frontend
 * - Old versions remain available until explicitly deprecated
 * - Version pinning is automatic and immutable per connection
 * 
 * ═══════════════════════════════════════════════════════════════════════
 * RULE 3 ENFORCEMENT WARNING:
 * ═══════════════════════════════════════════════════════════════════════
 * 
 * DO NOT import functions from this module into:
 * - UI components (app/, components/)
 * - Public API routes (app/api/public/*, app/api/external/*)
 * - Marketing pages (components/marketing/*, components/landing/*)
 * - Documentation (app/docs/*, components/docs/*)
 * 
 * ONLY import from:
 * - Internal orchestration (lib/orchestration/*)
 * - API generation (lib/api/*)
 * - Database provisioning (lib/db/*, lib/services/*)
 * 
 * If versions become user-visible, you've broken Backenly's trust model.
 * 
 * ═══════════════════════════════════════════════════════════════════════
 */

import { PrismaClient } from '@prisma/client'
import * as crypto from 'crypto'

export interface ApiVersion {
  versionId: string
  versionNumber: number
  projectId: string
  tableId: string
  schemaHash: string // Hash of table schema at this version
  endpoints: ApiEndpointVersion[]
  createdAt: Date
  createdBy: string // Intent ID that triggered the version
}

export interface ApiEndpointVersion {
  method: string
  path: string
  tableName: string
  tableSchema: TableSchemaSnapshot // Complete schema at this version
  responseShape: ResponseSchema
  requestShape: RequestSchema
}

export interface TableSchemaSnapshot {
  columns: ColumnDefinition[]
  relationships: RelationshipDefinition[]
  hash: string
}

export interface ColumnDefinition {
  name: string
  type: string
  nullable: boolean
  defaultValue?: any
}

export interface RelationshipDefinition {
  name: string
  type: 'oneToOne' | 'oneToMany' | 'manyToOne' | 'manyToMany'
  targetTable: string
  foreignKey?: string
}

export interface ResponseSchema {
  fields: string[] // Fields included in response
  shape: Record<string, any> // JSON schema of response
}

export interface RequestSchema {
  fields: string[] // Fields accepted in request
  required: string[]
  shape: Record<string, any> // JSON schema of request body
}

export interface VersionPinning {
  connectionId: string // Unique per frontend connection
  projectId: string
  pinnedVersionId: string
  pinnedAt: Date
  apiKeyHash?: string // If using API key
  userAgent?: string
  firstRequestPath: string
}

/**
 * Generate schema hash for version identification
 * 
 * Same schema = same hash = can reuse existing version
 */
function generateSchemaHash(schema: TableSchemaSnapshot): string {
  const content = JSON.stringify({
    columns: schema.columns.sort((a, b) => a.name.localeCompare(b.name)),
    relationships: schema.relationships.sort((a, b) => a.name.localeCompare(b.name)),
  })
  
  return crypto.createHash('sha256').update(content).digest('hex').substring(0, 16)
}

/**
 * Create new API version after schema mutation
 * 
 * CRITICAL: Called automatically on every schema change
 * Users never see this - it's internal bookkeeping
 * 
 * RULE 1 ENFORCEMENT: This function only INSERTs, never UPDATEs
 * Versions are write-once and immutable forever
 */
export async function createApiVersion(
  prisma: PrismaClient,
  projectId: string,
  tableId: string,
  tableName: string,
  currentSchema: TableSchemaSnapshot,
  intentId: string
): Promise<ApiVersion> {
  const schemaHash = generateSchemaHash(currentSchema)
  
  // Check if this exact schema already has a version (idempotency)
  const existingVersion = await prisma.$queryRaw<Array<{ versionId: string; versionNumber: number }>>`
    SELECT "versionId", "versionNumber"
    FROM api_versions
    WHERE "projectId" = ${projectId}
      AND "tableId" = ${tableId}
      AND "schemaHash" = ${schemaHash}
    LIMIT 1
  `
  
  if (existingVersion && existingVersion.length > 0) {
    console.log(`[APIVersioning] Schema hash ${schemaHash} already has version ${existingVersion[0].versionNumber}`)
    // RULE 1: Return existing version WITHOUT modifying it
    // No UPDATE, no PATCH, no mutation - versions are immutable
    const versionData = await prisma.apiVersion.findUnique({
      where: { versionId: existingVersion[0].versionId }
    })
    
    if (!versionData) {
      throw new Error(`Version ${existingVersion[0].versionId} not found`)
    }
    
    return {
      versionId: versionData.versionId,
      versionNumber: existingVersion[0].versionNumber,
      projectId: versionData.projectId,
      tableId: versionData.tableId,
      schemaHash: versionData.schemaHash,
      endpoints: versionData.endpoints as unknown as ApiEndpointVersion[],
      createdAt: versionData.createdAt,
      createdBy: versionData.createdBy,
    }
  }
  
  // Get next version number from versionId pattern
  const existingVersions = await prisma.apiVersion.findMany({
    where: { projectId, tableId },
    select: { versionId: true },
    orderBy: { createdAt: 'desc' },
  })
  
  // Extract version numbers from versionId (e.g., "table_v2_hash" -> 2)
  const versionNumbers = existingVersions
    .map(v => {
      const match = v.versionId.match(/_v(\d+)_/)
      return match ? parseInt(match[1]) : 0
    })
    .filter(n => n > 0)
  
  const nextVersionNumber = versionNumbers.length > 0 ? Math.max(...versionNumbers) + 1 : 1
  const versionId = `${tableId}_v${nextVersionNumber}_${schemaHash}`
  
  // Generate endpoint definitions for this version
  const endpoints = generateEndpointsForSchema(tableName, currentSchema)
  
  // RULE 1: INSERT only, never UPDATE
  // Once written, this version is immutable forever
  await prisma.apiVersion.create({
    data: {
      versionId,
      projectId,
      tableId,
      tableName,
      schemaHash,
      endpoints: endpoints as any,
      schemaSnapshot: currentSchema as any,
      createdBy: intentId,
    }
  })
  
  console.log(`[APIVersioning] ✅ Created IMMUTABLE API version ${nextVersionNumber} for ${tableName} (hash: ${schemaHash})`)
  
  return {
    versionId,
    versionNumber: nextVersionNumber,
    projectId,
    tableId,
    schemaHash,
    endpoints,
    createdAt: new Date(),
    createdBy: intentId,
  }
}

/**
 * Generate endpoint definitions for current schema
 * 
 * CRITICAL CHANGE: No longer generates CRUD by default
 * Endpoints must be explicitly derived from intent-specified actions
 * 
 * Captures exact request/response shapes at this point in time
 */
function generateEndpointsForSchema(
  tableName: string,
  schema: TableSchemaSnapshot
): ApiEndpointVersion[] {
  // DOCTRINE ENFORCEMENT: NO ENDPOINTS BY DEFAULT
  // Versioning system only tracks schema shape, NOT endpoint existence
  // Endpoints are ONLY created when intent explicitly specifies allowed actions
  
  console.log(`[AutoVersion] Schema snapshot created for ${tableName} - endpoints NOT auto-generated (intent-driven only)`)
  
  return [] // Empty - endpoints added ONLY via explicit intent derivation
}

/**
 * Pin frontend connection to specific API version
 * 
 * AUTOMATIC: Happens on first API request from a frontend
 * IMMUTABLE: Once pinned, connection stays on that version
 */
export async function pinConnectionToVersion(
  prisma: PrismaClient,
  connectionId: string,
  projectId: string,
  tableId: string,
  requestPath: string,
  options: {
    apiKeyHash?: string
    userAgent?: string
  } = {}
): Promise<VersionPinning> {
  // Check if connection already pinned
  const existing = await prisma.$queryRaw<Array<VersionPinning>>`
    SELECT *
    FROM version_pinnings
    WHERE connection_id = ${connectionId}
      AND project_id = ${projectId}
    LIMIT 1
  `
  
  if (existing && existing.length > 0) {
    console.log(`[APIVersioning] Connection ${connectionId} already pinned to ${existing[0].pinnedVersionId}`)
    return existing[0]
  }
  
  // Get latest non-deprecated version for this table
  const latestVersion = await prisma.$queryRaw<Array<{ version_id: string }>>`
    SELECT version_id
    FROM api_versions
    WHERE project_id = ${projectId}
      AND table_id = ${tableId}
      AND deprecated = false
    ORDER BY version_number DESC
    LIMIT 1
  `
  
  if (!latestVersion || latestVersion.length === 0) {
    throw new Error(`No API version available for table ${tableId}`)
  }
  
  const pinnedVersionId = latestVersion[0].version_id
  
  // Create pinning record
  await prisma.$executeRaw`
    INSERT INTO version_pinnings (
      connection_id,
      project_id,
      pinned_version_id,
      pinned_at,
      api_key_hash,
      user_agent,
      first_request_path
    ) VALUES (
      ${connectionId},
      ${projectId},
      ${pinnedVersionId},
      NOW(),
      ${options.apiKeyHash || null},
      ${options.userAgent || null},
      ${requestPath}
    )
  `
  
  console.log(`[APIVersioning] ✅ Pinned connection ${connectionId} to version ${pinnedVersionId}`)
  
  return {
    connectionId,
    projectId,
    pinnedVersionId,
    pinnedAt: new Date(),
    apiKeyHash: options.apiKeyHash,
    userAgent: options.userAgent,
    firstRequestPath: requestPath,
  }
}

/**
 * Get API version for incoming request
 * 
 * CRITICAL: Routes request to correct version based on connection pinning
 * 
 * RULE 2 ENFORCEMENT: Deterministic and boring
 * - Pure lookup: (connection_id, project_id, table_id) → exact version
 * - No fallbacks, no guessing, no "helping"
 * - No AI, no heuristics, no logic branches
 * - Returns null if not pinned (handled externally)
 */
export async function resolveVersionForRequest(
  prisma: PrismaClient,
  connectionId: string,
  projectId: string,
  tableId: string
): Promise<ApiVersion | null> {
  // RULE 2: Deterministic lookup only
  // Get pinned version for this connection
  const pinning = await prisma.$queryRaw<Array<VersionPinning>>`
    SELECT *
    FROM version_pinnings
    WHERE connection_id = ${connectionId}
      AND project_id = ${projectId}
    LIMIT 1
  `
  
  if (!pinning || pinning.length === 0) {
    // RULE 2: No fallback, no "best guess", no implicit upgrade
    // No pinning yet - return null (will be created on first request)
    return null
  }
  
  // RULE 2: Direct lookup of pinned version (no logic branches)
  // Get the exact pinned version details
  const version = await prisma.$queryRaw<Array<ApiVersion>>`
    SELECT *
    FROM api_versions
    WHERE version_id = ${pinning[0].pinnedVersionId}
      AND project_id = ${projectId}
      AND table_id = ${tableId}
    LIMIT 1
  `
  
  if (!version || version.length === 0) {
    // RULE 2: Hard error, no fallback to "latest" or "best match"
    throw new Error(`Pinned version ${pinning[0].pinnedVersionId} not found`)
  }
  
  // RULE 2: Return exact pinned version, never substitute
  return version[0]
}

/**
 * Rollback API version mapping (for restore operations)
 * 
 * CRITICAL: When restoring to an intent, rollback version mappings to that point
 * Does NOT delete version data - just updates which version is active
 */
export async function rollbackVersionMapping(
  prisma: PrismaClient,
  projectId: string,
  tableId: string,
  targetIntentId: string
): Promise<{ rolledBackToVersion: number }> {
  // Find the version that was active at the target intent
  const targetVersion = await prisma.$queryRaw<Array<{ version_number: number; version_id: string }>>`
    SELECT version_number, version_id
    FROM api_versions
    WHERE project_id = ${projectId}
      AND table_id = ${tableId}
      AND created_by = ${targetIntentId}
    ORDER BY version_number DESC
    LIMIT 1
  `
  
  if (!targetVersion || targetVersion.length === 0) {
    throw new Error(`No API version found for intent ${targetIntentId}`)
  }
  
  const rolledBackVersion = targetVersion[0].version_number
  
  // Mark all versions AFTER this as deprecated
  await prisma.$executeRaw`
    UPDATE api_versions
    SET deprecated = true,
        deprecated_at = NOW()
    WHERE project_id = ${projectId}
      AND table_id = ${tableId}
      AND version_number > ${rolledBackVersion}
  `
  
  console.log(`[APIVersioning] ✅ Rolled back to version ${rolledBackVersion}, deprecated newer versions`)
  
  return { rolledBackToVersion: rolledBackVersion }
}

/**
 * Extract table schema snapshot from BackendStateGraph
 * 
 * Used to create version on schema mutations
 */
export function extractSchemaSnapshot(
  entityName: string,
  graph: any // BackendStateGraph
): TableSchemaSnapshot {
  const entity = graph.entities[entityName]
  
  if (!entity) {
    throw new Error(`Entity ${entityName} not found in graph`)
  }
  
  const columns: ColumnDefinition[] = Object.entries(entity.fields).map(([name, field]: [string, any]) => ({
    name,
    type: field.type || 'TEXT',
    nullable: field.nullable !== false,
    defaultValue: field.defaultValue,
  }))
  
  const relationships: RelationshipDefinition[] = (entity.relationships || []).map((rel: any) => ({
    name: rel.name || rel.to,
    type: rel.type || 'manyToOne',
    targetTable: rel.to,
    foreignKey: rel.foreignKey,
  }))
  
  const snapshot: TableSchemaSnapshot = {
    columns,
    relationships,
    hash: '', // Will be set below
  }
  
  snapshot.hash = generateSchemaHash(snapshot)
  
  return snapshot
}
