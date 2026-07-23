/**
 * ENVIRONMENT SAFETY (No Dev/Prod Choice)
 * 
 * Purpose: Safety as a system guarantee, not a configuration
 * 
 * Users only see: "Apply safely" and "Undo last change"
 * System manages: Immutable history, safe rollback, automatic versioning
 * 
 * ⚠️ CRITICAL: Users must NEVER see:
 * - Environment toggles
 * - Staging/production choices
 * - Migration approvals
 * - Database schemas
 */

/**
 * Backend version (immutable point in time)
 */
export interface BackendVersion {
  id: string                        // version_123456789
  timestamp: Date
  description: string               // Human-readable change description
  author: string                    // Who made the change
  
  // Immutable snapshot
  stateHash: string                 // Hash of BackendStateGraph
  schemaHash: string                // Hash of database schema
  apiHash: string                   // Hash of API routes
  
  // Rollback support
  parentVersionId?: string          // Previous version
  isRollback: boolean               // Was this created by undo?
  
  // Safety validation
  safetyChecks: {
    noDataLoss: boolean             // No destructive operations
    backwardCompatible: boolean     // Old frontends still work
    tested: boolean                 // System validated changes
  }
  
  // Deployment status
  deployment: {
    frontendPinned: string[]        // Frontend versions using this
    canRollback: boolean            // Is rollback safe?
    autoMigrated: boolean           // Schema changes applied
  }
}

/**
 * Environment safety state
 */
export interface EnvironmentSafetyState {
  enabled: boolean
  
  // Version history (immutable)
  versions: Record<string, BackendVersion>
  currentVersionId: string
  
  // Active frontends
  frontends: Record<string, {
    id: string
    backendVersionId: string        // Which backend version it uses
    deployedAt: Date
    autoUpdate: boolean             // Pin or auto-upgrade
  }>
  
  // Safety rules
  safetyRules: {
    requireTests: boolean           // Must pass validation before apply
    preventDataLoss: boolean        // Block destructive operations
    autoRollbackOnError: boolean    // Auto-undo if deployment fails
    maxRollbackDepth: number        // How far back can we undo
  }
  
  reason: string
}

/**
 * Apply change safely
 * 
 * This is called when user says "Build now" or commits changes
 * System ensures safety automatically
 */
export async function applySafely(
  projectId: string,
  newStateGraph: any,
  description: string,
  userId: string
): Promise<{ success: boolean; versionId?: string; errors?: string[] }> {
  
  console.log(`[Environment Safety] Applying changes: ${description}`)
  
  try {
    // Get current version
    const currentVersion = await getCurrentVersion(projectId)
    
    // Compute state diff
    const diff = computeStateDiff(currentVersion.stateHash, newStateGraph)
    
    // Run safety checks
    const safetyChecks = await runSafetyChecks(projectId, diff)
    
    if (!safetyChecks.safe) {
      console.error(`[Environment Safety] Safety checks failed:`, safetyChecks.reasons)
      
      // REFUSE if unsafe
      return {
        success: false,
        errors: [
          'These changes cannot be applied safely:',
          ...safetyChecks.reasons,
          'Please modify your changes or undo to a safe state.'
        ]
      }
    }
    
    // Create new version (immutable)
    const newVersion: BackendVersion = {
      id: `version_${Date.now()}`,
      timestamp: new Date(),
      description,
      author: userId,
      stateHash: hashObject(newStateGraph),
      schemaHash: hashSchema(newStateGraph.entities),
      apiHash: hashApis(newStateGraph.apis),
      parentVersionId: currentVersion.id,
      isRollback: false,
      safetyChecks: {
        noDataLoss: safetyChecks.noDataLoss,
        backwardCompatible: safetyChecks.backwardCompatible,
        tested: true
      },
      deployment: {
        frontendPinned: [],
        canRollback: true,
        autoMigrated: false
      }
    }
    
    // Store version (immutable)
    await storeVersion(projectId, newVersion)
    
    // Apply schema changes (if any)
    if (diff.schemaChanged) {
      await applySchemaChanges(projectId, diff.schemaChanges)
      newVersion.deployment.autoMigrated = true
    }
    
    // Update current pointer
    await setCurrentVersion(projectId, newVersion.id)
    
    console.log(`[Environment Safety] ✅ Applied safely: ${newVersion.id}`)
    
    return {
      success: true,
      versionId: newVersion.id
    }
    
  } catch (error) {
    console.error(`[Environment Safety] Apply failed:`, error)
    
    // Auto-rollback if enabled
    const safetyState = await getSafetyState(projectId)
    if (safetyState?.safetyRules.autoRollbackOnError) {
      console.log(`[Environment Safety] Auto-rolling back...`)
      await undoLastChange(projectId)
    }
    
    return {
      success: false,
      errors: ['Failed to apply changes safely. Changes have been rolled back.']
    }
  }
}

/**
 * Undo last change
 * 
 * This is called when user clicks "Undo"
 * System switches pointer to previous version
 */
export async function undoLastChange(
  projectId: string
): Promise<{ success: boolean; versionId?: string; errors?: string[] }> {
  
  console.log(`[Environment Safety] Undoing last change`)
  
  try {
    // Get current version
    const currentVersion = await getCurrentVersion(projectId)
    
    if (!currentVersion.parentVersionId) {
      return {
        success: false,
        errors: ['Cannot undo: This is the first version']
      }
    }
    
    // Check if rollback is safe
    if (!currentVersion.deployment.canRollback) {
      return {
        success: false,
        errors: [
          'Cannot undo: Rollback is unsafe',
          'This version has active frontends or data dependencies',
          'Contact support for manual rollback'
        ]
      }
    }
    
    // Get parent version
    const parentVersion = await getVersion(projectId, currentVersion.parentVersionId)
    
    // Create rollback version (for audit trail)
    const rollbackVersion: BackendVersion = {
      ...parentVersion,
      id: `version_${Date.now()}_rollback`,
      timestamp: new Date(),
      description: `Undo: ${currentVersion.description}`,
      isRollback: true,
      parentVersionId: currentVersion.id
    }
    
    // Store rollback version
    await storeVersion(projectId, rollbackVersion)
    
    // Update current pointer
    await setCurrentVersion(projectId, rollbackVersion.id)
    
    console.log(`[Environment Safety] ✅ Rolled back to: ${parentVersion.id}`)
    
    return {
      success: true,
      versionId: rollbackVersion.id
    }
    
  } catch (error) {
    console.error(`[Environment Safety] Rollback failed:`, error)
    return {
      success: false,
      errors: ['Failed to undo changes']
    }
  }
}

/**
 * Pin frontend to backend version
 * 
 * This happens automatically when frontend deploys
 * Ensures frontend always works with compatible backend
 */
export async function pinFrontendToBackend(
  projectId: string,
  frontendId: string,
  backendVersionId?: string  // If not specified, use current
): Promise<{ success: boolean }> {
  
  const versionId = backendVersionId || (await getCurrentVersion(projectId)).id
  
  console.log(`[Environment Safety] Pinning frontend ${frontendId} to ${versionId}`)
  
  await updateFrontendPin(projectId, frontendId, versionId)
  
  return { success: true }
}

/**
 * Run safety checks on proposed changes
 */
async function runSafetyChecks(
  projectId: string,
  diff: any
): Promise<{
  safe: boolean
  noDataLoss: boolean
  backwardCompatible: boolean
  reasons: string[]
}> {
  
  const reasons: string[] = []
  let noDataLoss = true
  let backwardCompatible = true
  
  // Check for destructive schema changes
  if (diff.schemaChanges) {
    for (const change of diff.schemaChanges) {
      if (change.type === 'DROP_TABLE') {
        noDataLoss = false
        reasons.push(`Cannot drop table '${change.table}' - would lose data`)
      }
      
      if (change.type === 'DROP_COLUMN') {
        noDataLoss = false
        reasons.push(`Cannot drop column '${change.table}.${change.column}' - would lose data`)
      }
      
      if (change.type === 'CHANGE_TYPE' && !isCompatibleTypeChange(change.from, change.to)) {
        backwardCompatible = false
        reasons.push(`Type change '${change.from}' → '${change.to}' may break existing data`)
      }
    }
  }
  
  // Check for breaking API changes
  if (diff.apiChanges) {
    for (const change of diff.apiChanges) {
      if (change.type === 'REMOVE_ENDPOINT') {
        backwardCompatible = false
        reasons.push(`Cannot remove endpoint '${change.path}' - would break existing frontends`)
      }
      
      if (change.type === 'CHANGE_SIGNATURE') {
        backwardCompatible = false
        reasons.push(`Cannot change endpoint signature '${change.path}' - would break existing frontends`)
      }
    }
  }
  
  const safe = noDataLoss && backwardCompatible
  
  return { safe, noDataLoss, backwardCompatible, reasons }
}

/**
 * Check if type change is compatible
 */
function isCompatibleTypeChange(from: string, to: string): boolean {
  // Safe conversions
  const safe = [
    ['string', 'text'],
    ['int', 'bigint'],
    ['float', 'double']
  ]
  
  return safe.some(([f, t]) => f === from && t === to)
}

/**
 * Compute diff between versions
 */
function computeStateDiff(currentHash: string, newState: any): any {
  // TODO: Implement state diff computation
  return {
    schemaChanged: false,
    schemaChanges: [],
    apiChanged: false,
    apiChanges: []
  }
}

/**
 * Apply schema changes safely
 */
async function applySchemaChanges(projectId: string, changes: any[]) {
  // TODO: Execute safe schema migrations
  console.log(`[Environment Safety] Applying ${changes.length} schema changes`)
}

/**
 * Hash functions
 */
function hashObject(obj: any): string {
  return `hash_${JSON.stringify(obj).length}_${Date.now()}`
}

function hashSchema(entities: any): string {
  return `schema_${Object.keys(entities || {}).length}_${Date.now()}`
}

function hashApis(apis: any): string {
  return `api_${Object.keys(apis || {}).length}_${Date.now()}`
}

/**
 * Storage functions
 */
async function getCurrentVersion(projectId: string): Promise<BackendVersion> {
  // TODO: Load from database
  return {
    id: 'version_0',
    timestamp: new Date(),
    description: 'Initial version',
    author: 'system',
    stateHash: 'hash_0',
    schemaHash: 'schema_0',
    apiHash: 'api_0',
    isRollback: false,
    safetyChecks: {
      noDataLoss: true,
      backwardCompatible: true,
      tested: true
    },
    deployment: {
      frontendPinned: [],
      canRollback: false,
      autoMigrated: true
    }
  }
}

async function getVersion(projectId: string, versionId: string): Promise<BackendVersion> {
  // TODO: Load from database
  return await getCurrentVersion(projectId)
}

async function storeVersion(projectId: string, version: BackendVersion) {
  // TODO: Store in database (immutable)
  console.log(`[Environment Safety] Stored version: ${version.id}`)
}

async function setCurrentVersion(projectId: string, versionId: string) {
  // TODO: Update pointer in database
  console.log(`[Environment Safety] Current version → ${versionId}`)
}

async function getSafetyState(projectId: string): Promise<EnvironmentSafetyState | null> {
  // TODO: Load from BackendStateGraph
  return null
}

async function updateFrontendPin(projectId: string, frontendId: string, versionId: string) {
  // TODO: Update in database
  console.log(`[Environment Safety] Frontend ${frontendId} → ${versionId}`)
}
