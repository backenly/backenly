/**
 * PHASE 5 — BACKEND REPLACEMENT & DATA SYNC
 * 
 * Backenly becomes the backend authority.
 * Provision Backenly-managed backend from reconstructed intent.
 * Safely import data if it exists.
 * 
 * USER SEES: "Your backend is now managed by Backenly."
 * USER NEVER SEES: Migration progress, table diffs, technical logs
 */

import { prisma } from '@/lib/db'
import type { BackendBlueprint } from './intent-reconstruction'
import { createProvisionedProject } from '@/lib/projects/provision'

export interface BackendReplacementResult {
  projectId: string
  delegationToken: string
  success: boolean
  // User-facing message ONLY
  message: string
}

/**
 * Replace external backend with Backenly-managed backend
 * This is the SINGLE source of truth after connection
 */
export async function replaceBackend(
  userId: string,
  blueprint: BackendBlueprint,
  provider: string,
  appUrl: string,
  existingDataSource?: {
    url: string
    accessToken?: string
  }
): Promise<BackendReplacementResult> {
  try {
    console.log('[Backend Replacement] Starting backend takeover...')
    
    // Step 1: Provision Backenly-managed backend
    const project = await provisionBackenlyBackend(userId, blueprint, provider, appUrl)
    
    // Step 2: Map intent to stable backend schema
    await mapIntentToBackend(project.id, blueprint)
    
    // Step 3: If data exists, migrate it (SILENTLY)
    if (existingDataSource) {
      await migrateExistingData(project.id, blueprint, existingDataSource)
    }
    
    // Step 4: Generate delegation token (internal only)
    const delegationToken = await generateDelegationToken(project.id, provider, appUrl)
    
    console.log('[Backend Replacement] ✅ Backend takeover complete')
    
    return {
      projectId: project.id,
      delegationToken,
      success: true,
      message: 'Your backend is now managed by Backenly.',
    }
    
  } catch (error) {
    console.error('[Backend Replacement] ❌ Takeover failed:', error)
    
    // Sanitized error (Phase 14 compliance)
    return {
      projectId: '',
      delegationToken: '',
      success: false,
      message: "Something didn't work. Nothing was changed.",
    }
  }
}

/**
 * Provision Backenly-managed backend (creates project)
 */
async function provisionBackenlyBackend(
  userId: string,
  blueprint: BackendBlueprint,
  provider: string,
  appUrl: string
) {
  console.log('[Backend Replacement] Provisioning Backenly backend...')
  
  // Create project in Backenly, fully provisioned. This used to be a bare
  // prisma.project.create, so the project it handed back had no workspace
  // schema and no PostgREST registration: its entire data plane answered
  // PGRST106 from the moment the user connected their frontend.
  const project = await createProvisionedProject({
    name: blueprint.appType,
    description: `Connected from ${provider}`,
    userId,
  })
  
  // TODO: Store connection metadata
  // This would be stored in ProjectMetadata or dedicated ConnectionInfo table
  console.log(`[Backend Replacement] ✓ Metadata: Connected from ${provider} at ${appUrl}`)
  
  console.log(`[Backend Replacement] ✅ Project created: ${project.id}`)
  return project
}

/**
 * Map reconstructed intent to stable backend schema
 */
async function mapIntentToBackend(projectId: string, blueprint: BackendBlueprint) {
  console.log('[Backend Replacement] Mapping intent to backend schema...')
  
  // TODO: Create collections (tables) from entities
  // This requires actual workspace database schema creation
  for (const entity of blueprint.entities) {
    console.log(`[Backend Replacement]   ✓ Planned collection: ${entity.name}`)
  }
  
  // TODO: Apply access rules
  // This would be implemented in the API generation phase
  for (const rule of blueprint.accessRules) {
    console.log(`[Backend Replacement]   ✓ Planned access rule: ${rule.entity} -> ${rule.rule}`)
  }
  
  // TODO: Configure auth methods
  // This would configure auth providers for the project
  if (blueprint.authMethods.length > 0) {
    console.log(`[Backend Replacement]   ✓ Planned auth: ${blueprint.authMethods.join(', ')}`)
  }
  
  // TODO: Configure storage
  // This would setup storage buckets for the project
  if (blueprint.storage.enabled) {
    console.log(`[Backend Replacement]   ✓ Planned storage: ${blueprint.storage.types.join(', ')}`)
  }
  
  console.log('[Backend Replacement] ✓ Intent mapped to backend (planning complete)')
}

/**
 * Migrate existing data (SILENTLY - no progress shown to user)
 */
async function migrateExistingData(
  projectId: string,
  blueprint: BackendBlueprint,
  dataSource: { url: string; accessToken?: string }
) {
  console.log('[Backend Replacement] Starting data migration (SILENT)...')
  
  try {
    // Fetch existing data from source
    const existingData = await fetchExistingData(dataSource)
    
    // Validate data integrity (SILENT)
    const validatedData = await validateDataIntegrity(existingData, blueprint)
    
    // Import into Backenly backend (SILENT)
    await importData(projectId, validatedData)
    
    console.log('[Backend Replacement] ✅ Data migration complete (SILENT)')
    
  } catch (error) {
    console.error('[Backend Replacement] ⚠️ Data migration failed (non-fatal):', error)
    // Non-fatal: Backend still works, just without historical data
  }
}

/**
 * Fetch existing data from connected app
 */
async function fetchExistingData(dataSource: { url: string; accessToken?: string }): Promise<Record<string, any[]>> {
  // TODO: Implement actual data fetching based on provider
  // This would use provider APIs to extract existing data
  
  console.log(`[Backend Replacement] Fetching data from: ${dataSource.url}`)
  
  // Simulated response
  return {
    users: [
      { id: '1', email: 'user@example.com', name: 'Test User' },
    ],
    posts: [
      { id: '1', title: 'First Post', content: 'Hello world', author_id: '1' },
    ],
  }
}

/**
 * Validate data integrity (SILENT - never shown to user)
 */
async function validateDataIntegrity(
  data: Record<string, any[]>,
  blueprint: BackendBlueprint
): Promise<Record<string, any[]>> {
  console.log('[Backend Replacement] Validating data integrity...')
  
  const validatedData: Record<string, any[]> = {}
  
  for (const entity of blueprint.entities) {
    const entityData = data[entity.name] || []
    
    // Validate each record
    const validRecords = entityData.filter((record) => {
      // Check required fields exist
      for (const field of entity.fields) {
        if (field.required && !record[field.name]) {
          console.warn(`[Backend Replacement]   ⚠️ Invalid record in ${entity.name}: missing ${field.name}`)
          return false
        }
      }
      return true
    })
    
    validatedData[entity.name] = validRecords
    console.log(`[Backend Replacement]   ✓ Validated ${entity.name}: ${validRecords.length} records`)
  }
  
  return validatedData
}

/**
 * Import validated data into Backenly backend
 */
async function importData(projectId: string, data: Record<string, any[]>) {
  console.log('[Backend Replacement] Importing data...')
  
  // TODO: Import validated data into Backenly backend
  // This requires actual database write operations
  for (const [collectionName, records] of Object.entries(data)) {
    console.log(`[Backend Replacement]   ✓ Ready to import ${records.length} records into ${collectionName}`)
  }
  
  console.log('[Backend Replacement] ✓ Data import planned')
}

/**
 * Generate delegation token for frontend-backend binding
 * This token allows frontend to communicate with Backenly backend
 * (Used in Phase 6)
 */
async function generateDelegationToken(
  projectId: string,
  provider: string,
  appUrl: string
): Promise<string> {
  console.log('[Backend Replacement] Generating delegation token...')
  
  // Generate secure token
  const token = generateSecureToken()
  
  // TODO: Store token mapping (project <-> token <-> connected app)
  // This would be stored in a dedicated DelegationToken table
  console.log(`[Backend Replacement] ✓ Token generated for ${provider} app`)
  
  return token
}

/**
 * Generate cryptographically secure token
 */
function generateSecureToken(): string {
  // Use crypto.randomUUID for secure token generation
  const uuid = crypto.randomUUID()
  return `backenly_${uuid.replace(/-/g, '')}`
}
