/**
 * OPTIONAL HARDENING: Time-Travel Diff Viewer
 * 
 * Internal tool to trace any artifact back to its originating intent
 * "This table exists because of Intent #4"
 * 
 * UI sugar - logically already present in the system
 */

import { ExecutionContext, assertExecutionContext } from '@/lib/context/execution-context'
import { getIntentHistory } from '@/lib/orchestration/project-scoped-state'
import { loadGraph } from '@/lib/orchestration/backend-state-graph'

export interface ArtifactOrigin {
  artifactType: 'table' | 'api' | 'auth' | 'storage'
  artifactName: string
  originIntent: string
  intentNumber: number
  timestamp: Date
  changes: any
  explanation: string
}

export interface TimeTravelState {
  intentNumber: number
  intent: string
  timestamp: Date
  tables: string[]
  apis: string[]
  authProviders: string[]
  storageConfig: any
}

/**
 * Find which intent created an artifact
 */
export async function findArtifactOrigin(
  context: ExecutionContext,
  artifactType: 'table' | 'api' | 'auth' | 'storage',
  artifactName: string
): Promise<ArtifactOrigin | null> {
  assertExecutionContext(context)
  
  const history = await getIntentHistory(context, 1000)
  
  // Search chronologically (oldest first)
  const chronological = [...history].reverse()
  
  for (let i = 0; i < chronological.length; i++) {
    const intent = chronological[i]
    const changes = intent.changes
    
    if (!changes) continue
    
    // Check if this intent created the artifact
    let found = false
    
    switch (artifactType) {
      case 'table':
        found = changes.entities?.includes(artifactName) ||
                changes.tables?.some((t: any) => t.name === artifactName)
        break
      
      case 'api':
        found = changes.apis?.some((a: any) => a.path === artifactName)
        break
      
      case 'auth':
        found = changes.auth?.providers?.includes(artifactName)
        break
      
      case 'storage':
        found = changes.storage !== undefined
        break
    }
    
    if (found) {
      return {
        artifactType,
        artifactName,
        originIntent: intent.intent,
        intentNumber: i + 1,
        timestamp: intent.timestamp,
        changes,
        explanation: `This ${artifactType} "${artifactName}" was created by intent #${i + 1}: "${intent.intent}"`,
      }
    }
  }
  
  return null
}

/**
 * Generate time-travel explanation for artifact
 */
export async function explainArtifact(
  context: ExecutionContext,
  artifactType: 'table' | 'api' | 'auth' | 'storage',
  artifactName: string
): Promise<string> {
  const origin = await findArtifactOrigin(context, artifactType, artifactName)
  
  if (!origin) {
    return `❌ ${artifactType} "${artifactName}" has no recorded origin.\n` +
           `This is a RED FLAG - unexplained state.`
  }
  
  let explanation = `✅ ${artifactType.toUpperCase()}: "${artifactName}"\n\n`
  explanation += `Origin: Intent #${origin.intentNumber}\n`
  explanation += `Date: ${origin.timestamp.toLocaleString()}\n`
  explanation += `Intent: "${origin.originIntent}"\n\n`
  explanation += `This artifact exists because you said:\n`
  explanation += `"${origin.originIntent}"\n`
  
  return explanation
}

/**
 * Get system state at specific intent number
 */
export async function getStateAtIntent(
  context: ExecutionContext,
  intentNumber: number
): Promise<TimeTravelState | null> {
  assertExecutionContext(context)
  
  const history = await getIntentHistory(context, 1000)
  
  // Get intents up to and including target
  const chronological = [...history].reverse()
  
  if (intentNumber > chronological.length || intentNumber < 1) {
    return null
  }
  
  const targetIntent = chronological[intentNumber - 1]
  
  // Reconstruct state up to this point
  const tables: Set<string> = new Set()
  const apis: Set<string> = new Set()
  const authProviders: Set<string> = new Set()
  let storageConfig: any = null
  
  for (let i = 0; i < intentNumber; i++) {
    const intent = chronological[i]
    const changes = intent.changes
    
    if (!changes) continue
    
    // Add entities/tables
    if (changes.entities) {
      changes.entities.forEach((e: string) => tables.add(e))
    }
    if (changes.tables) {
      changes.tables.forEach((t: any) => tables.add(t.name))
    }
    
    // Add APIs
    if (changes.apis) {
      changes.apis.forEach((a: any) => apis.add(a.path))
    }
    
    // Add auth providers
    if (changes.auth?.providers) {
      changes.auth.providers.forEach((p: string) => authProviders.add(p))
    }
    
    // Update storage config
    if (changes.storage) {
      storageConfig = changes.storage
    }
  }
  
  return {
    intentNumber,
    intent: targetIntent.intent,
    timestamp: targetIntent.timestamp,
    tables: Array.from(tables),
    apis: Array.from(apis),
    authProviders: Array.from(authProviders),
    storageConfig,
  }
}

/**
 * Generate time-travel diff between two intent states
 */
export async function generateTimeTravelDiff(
  context: ExecutionContext,
  fromIntent: number,
  toIntent: number
): Promise<string> {
  assertExecutionContext(context)
  
  const beforeState = await getStateAtIntent(context, fromIntent)
  const afterState = await getStateAtIntent(context, toIntent)
  
  if (!beforeState || !afterState) {
    return '❌ Invalid intent numbers'
  }
  
  let diff = '╔════════════════════════════════════════════════════════════════╗\n'
  diff += '║                    TIME-TRAVEL DIFF                            ║\n'
  diff += '╚════════════════════════════════════════════════════════════════╝\n\n'
  
  diff += `From: Intent #${fromIntent} (${beforeState.timestamp.toLocaleString()})\n`
  diff += `To:   Intent #${toIntent} (${afterState.timestamp.toLocaleString()})\n\n`
  
  diff += '─────────────────────────────────────────────────────────────────\n'
  diff += 'TABLES:\n'
  diff += '─────────────────────────────────────────────────────────────────\n'
  
  const addedTables = afterState.tables.filter(t => !beforeState.tables.includes(t))
  const removedTables = beforeState.tables.filter(t => !afterState.tables.includes(t))
  
  if (addedTables.length === 0 && removedTables.length === 0) {
    diff += '  (no changes)\n'
  } else {
    addedTables.forEach(t => diff += `  + ${t}\n`)
    removedTables.forEach(t => diff += `  - ${t}\n`)
  }
  
  diff += '\n─────────────────────────────────────────────────────────────────\n'
  diff += 'APIs:\n'
  diff += '─────────────────────────────────────────────────────────────────\n'
  
  const addedApis = afterState.apis.filter(a => !beforeState.apis.includes(a))
  const removedApis = beforeState.apis.filter(a => !afterState.apis.includes(a))
  
  if (addedApis.length === 0 && removedApis.length === 0) {
    diff += '  (no changes)\n'
  } else {
    addedApis.forEach(a => diff += `  + ${a}\n`)
    removedApis.forEach(a => diff += `  - ${a}\n`)
  }
  
  diff += '\n─────────────────────────────────────────────────────────────────\n'
  diff += 'AUTH PROVIDERS:\n'
  diff += '─────────────────────────────────────────────────────────────────\n'
  
  const addedAuth = afterState.authProviders.filter(p => !beforeState.authProviders.includes(p))
  const removedAuth = beforeState.authProviders.filter(p => !afterState.authProviders.includes(p))
  
  if (addedAuth.length === 0 && removedAuth.length === 0) {
    diff += '  (no changes)\n'
  } else {
    addedAuth.forEach(p => diff += `  + ${p}\n`)
    removedAuth.forEach(p => diff += `  - ${p}\n`)
  }
  
  diff += '\n═════════════════════════════════════════════════════════════════\n'
  
  return diff
}

/**
 * Generate full intent timeline with state at each point
 */
export async function generateIntentTimeline(
  context: ExecutionContext
): Promise<string> {
  assertExecutionContext(context)
  
  const history = await getIntentHistory(context, 1000)
  const chronological = [...history].reverse()
  
  let timeline = '╔════════════════════════════════════════════════════════════════╗\n'
  timeline += '║                    INTENT TIMELINE                             ║\n'
  timeline += '╚════════════════════════════════════════════════════════════════╝\n\n'
  
  timeline += `Project: ${context.projectId}\n`
  timeline += `Total Intents: ${chronological.length}\n\n`
  
  for (let i = 0; i < chronological.length; i++) {
    const intent = chronological[i]
    const state = await getStateAtIntent(context, i + 1)
    
    if (!state) continue
    
    timeline += '─────────────────────────────────────────────────────────────────\n'
    timeline += `Intent #${i + 1}\n`
    timeline += '─────────────────────────────────────────────────────────────────\n'
    timeline += `Date: ${state.timestamp.toLocaleString()}\n`
    timeline += `Text: "${intent.intent}"\n`
    timeline += `Status: ${intent.success ? '✅ Success' : '❌ Failed'}\n\n`
    
    timeline += `State after this intent:\n`
    timeline += `  Tables: ${state.tables.length} (${state.tables.join(', ') || 'none'})\n`
    timeline += `  APIs: ${state.apis.length} (${state.apis.slice(0, 3).join(', ')}${state.apis.length > 3 ? '...' : ''})\n`
    timeline += `  Auth: ${state.authProviders.join(', ') || 'none'}\n`
    timeline += `  Storage: ${state.storageConfig ? 'configured' : 'none'}\n\n`
  }
  
  timeline += '═════════════════════════════════════════════════════════════════\n'
  
  return timeline
}

/**
 * Interactive time-travel query
 * 
 * Example: "Show me all tables that existed after intent 5"
 */
export async function timeTravelQuery(
  context: ExecutionContext,
  query: {
    intentNumber: number
    artifactType?: 'table' | 'api' | 'auth' | 'storage'
  }
): Promise<any> {
  assertExecutionContext(context)
  
  const state = await getStateAtIntent(context, query.intentNumber)
  
  if (!state) {
    return { error: 'Invalid intent number' }
  }
  
  if (query.artifactType) {
    switch (query.artifactType) {
      case 'table':
        return { tables: state.tables }
      case 'api':
        return { apis: state.apis }
      case 'auth':
        return { authProviders: state.authProviders }
      case 'storage':
        return { storageConfig: state.storageConfig }
    }
  }
  
  return state
}
