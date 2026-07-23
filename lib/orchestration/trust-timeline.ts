/**
 * Phase 8: Trust Timeline Generator
 * PHASE 5 ENHANCEMENT: Timeline Granularity Upgrade
 * 
 * Generate plain-English summaries from intent + execution.
 * Users see: "Enabled Google sign-in"
 * Users DON'T see: SQL, migrations, logs, stack traces
 * 
 * PHASE 5: Now includes granular details for verification:
 * - Entity names and fields
 * - Endpoint URLs and methods
 * - Auth provider configurations
 * - Storage bucket details
 * - Integration settings
 * - Deployment metadata
 * 
 * This builds psychological trust through transparency.
 */

import { CanonicalIntent } from './types'
import { ExecutionPlan, ExecutionStep } from './execution-plan-generator'
import { ExecutionResult, ExecutionChange, ChangeDetails } from './atomic-executor'

/**
 * PHASE 5: Enhanced Timeline Entry with granular change tracking
 */
export interface TimelineEntry {
  id: string
  timestamp: string
  title: string // Plain English, one line
  description: string // Human-readable detail
  expandedDetails?: TimelineDetail[] // Optional "What Backenly did"
  granularChanges?: GranularChangeGroup[] // PHASE 5: Detailed change breakdown
  category: TimelineCategory
  userVisible: boolean
}

export type TimelineCategory =
  | 'feature_added'
  | 'feature_removed'
  | 'data_updated'
  | 'security_changed'
  | 'deployment'
  | 'configuration'

export interface TimelineDetail {
  type: 'step' | 'impact' | 'note'
  content: string
  technical: boolean // If true, hide by default
}

/**
 * PHASE 5: Granular change groups for verification
 * Groups related changes by type for easy user verification
 */
export interface GranularChangeGroup {
  type: 'entities' | 'fields' | 'apis' | 'auth' | 'storage' | 'integrations' | 'deployments'
  label: string // User-friendly label (e.g., "Tables Created")
  items: GranularChangeItem[]
}

/**
 * PHASE 5: Individual granular change item
 */
export interface GranularChangeItem {
  name: string // Entity name, field name, endpoint path, etc.
  details: string // Human-readable details
  metadata?: ChangeDetails // Full technical metadata for advanced users
}

/**
 * Generate user-friendly timeline entry from execution
 * 
 * CRITICAL: NEVER expose technical details in main title/description
 * PHASE 5: Now includes granularChanges for user verification
 */
export function generateTimelineEntry(
  intent: CanonicalIntent,
  executionResult: ExecutionResult
): TimelineEntry {
  const timestamp = new Date().toISOString()
  const id = `timeline_${Date.now()}`
  
  // Generate human-readable title
  const title = generateHumanTitle(intent, executionResult)
  
  // Generate human-readable description
  const description = generateHumanDescription(intent, executionResult)
  
  // Generate expanded details (optional)
  const expandedDetails = generateExpandedDetails(intent, executionResult)
  
  // PHASE 5: Generate granular changes for verification
  const granularChanges = generateGranularChanges(executionResult.changes)
  
  // Categorize the change
  const category = categorizeChange(intent)
  
  return {
    id,
    timestamp,
    title,
    description,
    expandedDetails,
    granularChanges,
    category,
    userVisible: true,
  }
}

/**
 * Generate plain-English title
 */
function generateHumanTitle(
  intent: CanonicalIntent,
  result: ExecutionResult
): string {
  // Auth changes
  if (intent.domain === 'AUTH') {
    if (intent.action === 'ENABLE') {
      const provider = intent.feature?.replace('_SIGN_IN', '').toLowerCase()
      return `Enabled ${capitalizeFirst(provider || 'authentication')}`
    }
    if (intent.action === 'DISABLE') {
      const provider = intent.feature?.replace('_SIGN_IN', '').toLowerCase()
      return `Disabled ${capitalizeFirst(provider || 'authentication')}`
    }
  }
  
  // Storage changes
  if (intent.domain === 'STORAGE') {
    if (intent.feature === 'FILE_UPLOAD') {
      if (intent.action === 'ENABLE') {
        return 'Added profile pictures'
      }
      if (intent.action === 'DISABLE') {
        return 'Removed profile pictures'
      }
    }
    return 'Updated file storage'
  }
  
  // Access control
  if (intent.intent_type === 'ACCESS_CONTROL') {
    if (intent.action === 'RESTRICT') {
      return 'Restricted access to paid users'
    }
    if (intent.action === 'ALLOW') {
      return 'Made content publicly accessible'
    }
  }
  
  // Database changes
  if (intent.intent_type === 'DATA_MODEL_ADD') {
    const entityCount = result.changes.filter(c => c.type === 'table').length
    if (entityCount === 1) {
      return `Your app can now remember ${intent.target || 'new information'}`
    }
    return `Your app can now remember ${entityCount} types of information`
  }
  
  if (intent.intent_type === 'DATA_MODEL_REMOVE') {
    return `Your app no longer tracks ${intent.target || 'that information'}`
  }
  
  // Deployment
  if (intent.intent_type === 'DEPLOYMENT') {
    return 'Your app is now live'
  }

  // Restore
  if (intent.intent_type === 'RESTORE') {
    return 'Restored a previous version'
  }

  // Export
  if (intent.intent_type === 'EXPORT') {
    return 'Exported project data'
  }
  
  // Fallback
  return 'Updated your backend'
}

/**
 * Generate plain-English description
 */
function generateHumanDescription(
  intent: CanonicalIntent,
  result: ExecutionResult
): string {
  const changes = result.changes
  
  // Auth changes
  if (intent.domain === 'AUTH' && intent.action === 'ENABLE') {
    const provider = intent.feature?.replace('_SIGN_IN', '').toLowerCase()
    return `Users can now sign in with their ${capitalizeFirst(provider || 'account')}.`
  }
  
  // Storage changes
  if (intent.domain === 'STORAGE' && intent.feature === 'FILE_UPLOAD') {
    if (intent.action === 'ENABLE') {
      return 'Users can now upload and store profile pictures. Files are stored securely.'
    }
    if (intent.action === 'DISABLE') {
      return 'Removed the ability to upload profile pictures.'
    }
  }
  
  // Access control
  if (intent.intent_type === 'ACCESS_CONTROL') {
    if (intent.action === 'RESTRICT') {
      return 'Only users with active subscriptions can access content.'
    }
    if (intent.action === 'ALLOW') {
      return 'Anyone can view content without signing in.'
    }
  }
  
  // Database changes
  if (intent.intent_type === 'DATA_MODEL_ADD') {
    const tablesCreated = changes.filter(c => c.type === 'table').length
    const fieldsAdded = changes.filter(c => c.type === 'column').length
    const apisCreated = changes.filter(c => c.type === 'api').length
    
    const parts: string[] = []
    if (tablesCreated > 0) {
      parts.push(`your app can now remember ${tablesCreated === 1 ? 'a new type of' : `${tablesCreated} types of`} information`)
    }
    if (fieldsAdded > 0) {
      parts.push(`added ${fieldsAdded === 1 ? 'a new detail to track' : `${fieldsAdded} details to track`}`)
    }
    if (apisCreated > 0) {
      parts.push(`users can now do ${apisCreated === 1 ? 'something new' : `${apisCreated} new things`}`)
    }
    
    return `${capitalizeFirst(parts.join(', '))}. Your data is ready to use.`
  }
  
  // Deployment
  if (intent.intent_type === 'DEPLOYMENT') {
    // Extract deployment URL from changes if available
    const deploymentChange = result.changes.find(c => c.type === 'capability' && c.target === 'production')
    const deploymentUrl = deploymentChange?.details?.url
    
    if (deploymentUrl) {
      return `Your backend is now live. All changes are available to users.\n\n🌐 Deployment URL: ${deploymentUrl}`
    }
    return 'Your backend is now live. All changes are available to users.'
  }

  // Restore
  if (intent.intent_type === 'RESTORE') {
    return 'Your backend has been restored to a previous state.'
  }

  // Export
  if (intent.intent_type === 'EXPORT') {
    return 'A full export of your backend structure and data was generated for your records.'
  }
  
  // Fallback
  return 'Your backend has been updated and is ready to use.'
}

/**
 * Generate expanded details (optional section)
 */
function generateExpandedDetails(
  intent: CanonicalIntent,
  result: ExecutionResult
): TimelineDetail[] {
  const details: TimelineDetail[] = []
  
  // Group changes by type
  const changesByType = groupChangesByType(result.changes)
  
  // Data models created
  if (changesByType.tables.length > 0) {
    details.push({
      type: 'step',
      content: `Your app can now remember ${changesByType.tables.length === 1 ? 'a new type of' : `${changesByType.tables.length} types of`} information`,
      technical: false,
    })
    
    // List what your app can remember
    changesByType.tables.forEach(change => {
      details.push({
        type: 'impact',
        content: `  • ${change.target}`,
        technical: false,
      })
    })
  }
  
  // Fields added
  if (changesByType.columns.length > 0) {
    details.push({
      type: 'step',
      content: `Added ${changesByType.columns.length === 1 ? 'a new detail to track' : `${changesByType.columns.length} details to track`}`,
      technical: false,
    })
  }
  
  // Ways for users to interact
  if (changesByType.apis.length > 0) {
    details.push({
      type: 'step',
      content: `Users can now do ${changesByType.apis.length === 1 ? 'something new' : `${changesByType.apis.length} new things`} with your app`,
      technical: false,
    })
  }
  
  // Auth changes
  if (changesByType.auth.length > 0) {
    details.push({
      type: 'step',
      content: 'Updated authentication settings',
      technical: false,
    })
  }
  
  // Storage changes
  if (changesByType.storage.length > 0) {
    details.push({
      type: 'step',
      content: 'Set up secure file storage',
      technical: false,
    })
  }
  
  // Add reassurance note
  if (details.length > 0) {
    details.push({
      type: 'note',
      content: 'All changes are reversible if needed.',
      technical: false,
    })
  }
  
  return details
}

/**
 * Group changes by type
 */
function groupChangesByType(changes: ExecutionChange[]): {
  tables: ExecutionChange[]
  columns: ExecutionChange[]
  apis: ExecutionChange[]
  auth: ExecutionChange[]
  storage: ExecutionChange[]
} {
  return {
    tables: changes.filter(c => c.type === 'table'),
    columns: changes.filter(c => c.type === 'column'),
    apis: changes.filter(c => c.type === 'api'),
    auth: changes.filter(c => c.type === 'auth'),
    storage: changes.filter(c => c.type === 'storage'),
  }
}

/**
 * PHASE 5: Generate granular changes for user verification
 * Transforms technical ExecutionChanges into user-friendly granular change groups
 */
function generateGranularChanges(changes: ExecutionChange[]): GranularChangeGroup[] {
  const groups: GranularChangeGroup[] = []
  
  // Group 1: Entities/Tables created
  const tables = changes.filter(c => c.type === 'table' && c.action === 'created')
  if (tables.length > 0) {
    groups.push({
      type: 'entities',
      label: `Tables Created (${tables.length})`,
      items: tables.map(change => ({
        name: change.target,
        details: change.details.entityName || change.target,
        metadata: change.details,
      })),
    })
  }
  
  // Group 2: Fields added
  const columns = changes.filter(c => c.type === 'column' && c.action === 'created')
  if (columns.length > 0) {
    groups.push({
      type: 'fields',
      label: `Fields Added (${columns.length})`,
      items: columns.map(change => {
        const [tableName, fieldName] = change.target.split('.')
        const fieldType = change.details.type || change.details.fieldType || 'unknown'
        return {
          name: change.target,
          details: `${fieldName}: ${fieldType}`,
          metadata: change.details,
        }
      }),
    })
  }
  
  // Group 3: APIs/Endpoints created
  const apis = changes.filter(c => c.type === 'api' && c.action === 'created')
  if (apis.length > 0) {
    groups.push({
      type: 'apis',
      label: `Endpoints Generated (${apis.length})`,
      items: apis.map(change => {
        const methods = change.details.methods || [change.details.method] || ['GET']
        const methodsList = Array.isArray(methods) ? methods.join(', ') : methods
        return {
          name: change.target,
          details: `${methodsList} ${change.target}`,
          metadata: change.details,
        }
      }),
    })
  }
  
  // Group 4: Auth configurations
  const authChanges = changes.filter(c => c.type === 'auth')
  if (authChanges.length > 0) {
    groups.push({
      type: 'auth',
      label: `Authentication Configured (${authChanges.length})`,
      items: authChanges.map(change => {
        const provider = change.details.authProvider || change.target
        const action = change.action === 'enabled' || change.details.enabled ? 'Enabled' : 'Configured'
        return {
          name: provider,
          details: `${action} ${provider} sign-in`,
          metadata: change.details,
        }
      }),
    })
  }
  
  // Group 5: Storage resources
  const storageChanges = changes.filter(c => c.type === 'storage' && c.action === 'created')
  if (storageChanges.length > 0) {
    groups.push({
      type: 'storage',
      label: `Storage Buckets Created (${storageChanges.length})`,
      items: storageChanges.map(change => {
        const bucketName = change.details.bucketName || change.target
        const purpose = change.details.purpose || 'file storage'
        return {
          name: bucketName,
          details: `Bucket for ${purpose}`,
          metadata: change.details,
        }
      }),
    })
  }
  
  // Group 6: Integrations/Capabilities
  const capabilities = changes.filter(c => c.type === 'capability')
  if (capabilities.length > 0) {
    groups.push({
      type: 'integrations',
      label: `Integrations Enabled (${capabilities.length})`,
      items: capabilities.map(change => {
        const capType = change.details.capabilityType || change.details.integrationName || change.target
        return {
          name: capType,
          details: `${capType} integration active`,
          metadata: change.details,
        }
      }),
    })
  }
  
  // Group 7: Deployments
  const deployments = changes.filter(c => c.type === 'deployment')
  if (deployments.length > 0) {
    groups.push({
      type: 'deployments',
      label: `Deployments (${deployments.length})`,
      items: deployments.map(change => {
        const env = change.details.environment || 'production'
        const url = change.details.deploymentUrl || 'Pending...'
        return {
          name: env,
          details: `Deployed to ${env}: ${url}`,
          metadata: change.details,
        }
      }),
    })
  }
  
  return groups
}

/**
 * Categorize change for filtering
 */
function categorizeChange(intent: CanonicalIntent): TimelineCategory {
  // Guard against invalid intent structure
  if (!intent || !intent.intent_type) {
    console.warn('[Timeline] Invalid intent structure, defaulting to configuration')
    return 'configuration'
  }
  
  if (intent.intent_type === 'DEPLOYMENT') {
    return 'deployment'
  }
  
  if (intent.intent_type === 'EXPORT' || intent.intent_type === 'RESTORE') {
    return 'configuration'
  }
  
  if (intent.intent_type === 'ACCESS_CONTROL') {
    return 'security_changed'
  }
  
  if (intent.intent_type === 'FEATURE_ADD') {
    return 'feature_added'
  }
  
  if (intent.intent_type === 'FEATURE_REMOVE') {
    return 'feature_removed'
  }
  
  if (intent.intent_type.startsWith('DATA_MODEL')) {
    return 'data_updated'
  }
  
  return 'configuration'
}

/**
 * Capitalize first letter
 */
function capitalizeFirst(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1)
}

/**
 * Generate summary for multiple timeline entries
 */
export function generateTimelineSummary(entries: TimelineEntry[]): string {
  if (entries.length === 0) {
    return 'No changes yet. Describe what you want to build.'
  }
  
  const recentEntries = entries.slice(0, 5)
  const titles = recentEntries.map(e => e.title)
  
  if (titles.length === 1) {
    return titles[0]
  }
  
  if (titles.length === 2) {
    return `${titles[0]} and ${titles[1]}`
  }
  
  return `${titles.slice(0, -1).join(', ')}, and ${titles[titles.length - 1]}`
}

/**
 * Format timeline entry for display
 */
export function formatTimelineForDisplay(entry: TimelineEntry): {
  title: string
  description: string
  expandedSection?: string
} {
  let expandedSection: string | undefined
  
  if (entry.expandedDetails && entry.expandedDetails.length > 0) {
    const lines = entry.expandedDetails
      .filter(d => !d.technical) // Hide technical details
      .map(d => d.content)
    
    if (lines.length > 0) {
      expandedSection = lines.join('\n')
    }
  }
  
  return {
    title: entry.title,
    description: entry.description,
    expandedSection,
  }
}

/**
 * Generate timeline entry for rollback
 */
export function generateRollbackEntry(
  originalIntent: CanonicalIntent,
  rollbackTimestamp: string
): TimelineEntry {
  return {
    id: `rollback_${Date.now()}`,
    timestamp: rollbackTimestamp,
    title: 'Undid last change',
    description: 'Your backend has been restored to its previous state.',
    expandedDetails: [
      {
        type: 'note',
        content: `Reversed: ${originalIntent.source_text}`,
        technical: false,
      },
    ],
    category: 'configuration',
    userVisible: true,
  }
}
