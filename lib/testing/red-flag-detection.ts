/**
 * RED FLAG DETECTION SYSTEM
 * 
 * Continuous monitoring for system integrity violations
 * 
 * 🚨 RED FLAGS (System is broken if any detected):
 * 1. Advanced Mode shows something user didn't describe
 * 2. Storage exists without user-facing behavior
 * 3. APIs exist without intent explanation
 * 4. Undo removes logic but leaves artifacts
 * 5. Deployment succeeds with drift
 */

import { ExecutionContext } from '@/lib/context/execution-context'
import { getIntentHistory } from '@/lib/orchestration/project-scoped-state'
import { loadGraph } from '@/lib/orchestration/backend-state-graph'
import { projectAdvancedView } from '@/lib/orchestration/advanced-view-projection'

export interface RedFlag {
  type: 'UNEXPLAINED_STATE' | 'ORPHANED_STORAGE' | 'ORPHANED_API' | 'INCOMPLETE_ROLLBACK' | 'DEPLOYMENT_DRIFT'
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM'
  message: string
  evidence: any
  recommendation: string
}

export interface RedFlagReport {
  projectId: string
  timestamp: Date
  flags: RedFlag[]
  systemHealthy: boolean
}

/**
 * Scan for Red Flag #1: Advanced Mode shows unexplained state
 */
async function detectUnexplainedState(
  context: ExecutionContext
): Promise<RedFlag[]> {
  const flags: RedFlag[] = []
  
  const intentHistory = await getIntentHistory(context, 100)
  const graph = await loadGraph(context.projectId)
  const advancedView = await projectAdvancedView(graph)
  
  // Check each table
  for (const table of advancedView.tables) {
    const hasIntent = intentHistory.some(intent =>
      intent.intent.toLowerCase().includes(table.name.toLowerCase()) ||
      intent.canonicalIntent?.entities?.includes(table.name)
    )
    
    if (!hasIntent) {
      flags.push({
        type: 'UNEXPLAINED_STATE',
        severity: 'CRITICAL',
        message: `Table "${table.name}" exists in Advanced Mode but cannot be traced to any intent`,
        evidence: { tableName: table.name, fields: table.fields },
        recommendation: 'Remove table or find originating intent. System integrity compromised.',
      })
    }
  }
  
  // Check each API
  for (const api of advancedView.apis) {
    const hasIntent = intentHistory.some(intent =>
      intent.intent.toLowerCase().includes(api.path.toLowerCase()) ||
      intent.canonicalIntent?.apis?.some((a: any) => a.path === api.path)
    )
    
    if (!hasIntent) {
      flags.push({
        type: 'ORPHANED_API',
        severity: 'CRITICAL',
        message: `API "${api.path}" exists without intent explanation`,
        evidence: { path: api.path, methods: api.methods },
        recommendation: 'Remove API or find originating intent. System integrity compromised.',
      })
    }
  }
  
  return flags
}

/**
 * Scan for Red Flag #2: Storage exists without user-facing behavior
 */
async function detectOrphanedStorage(
  context: ExecutionContext
): Promise<RedFlag[]> {
  const flags: RedFlag[] = []
  
  // Check for storage-related intents
  const intentHistory = await getIntentHistory(context, 100)
  const hasStorageIntent = intentHistory.some(intent =>
    intent.intent.toLowerCase().includes('upload') ||
    intent.intent.toLowerCase().includes('file') ||
    intent.intent.toLowerCase().includes('image') ||
    intent.intent.toLowerCase().includes('picture') ||
    intent.intent.toLowerCase().includes('document')
  )
  
  // Check if storage is configured
  const graph = await loadGraph(context.projectId)
  const hasStorageConfig = graph.storage !== undefined
  
  if (hasStorageConfig && !hasStorageIntent) {
    flags.push({
      type: 'ORPHANED_STORAGE',
      severity: 'HIGH',
      message: 'Storage is configured but no user-facing upload behavior exists',
      evidence: { storageConfig: graph.storage },
      recommendation: 'Storage should only exist to support user-described upload features.',
    })
  }
  
  return flags
}

/**
 * Scan for Red Flag #3: APIs exist without intent explanation
 */
async function detectOrphanedAPIs(
  context: ExecutionContext
): Promise<RedFlag[]> {
  // Already covered in detectUnexplainedState
  // Kept separate for clarity in red flag reporting
  return []
}

/**
 * Scan for Red Flag #4: Undo removes logic but leaves artifacts
 */
async function detectIncompleteRollback(
  context: ExecutionContext
): Promise<RedFlag[]> {
  const flags: RedFlag[] = []
  
  const intentHistory = await getIntentHistory(context, 100)
  
  // Check for rollback intents
  const rollbackIntents = intentHistory.filter(intent =>
    intent.intent.toLowerCase().includes('undo') ||
    intent.intent.toLowerCase().includes('rollback')
  )
  
  for (const rollback of rollbackIntents) {
    // Verify rollback was complete
    if (rollback.success && rollback.rollbackData) {
      // Check if all affected resources were actually removed
      const affectedResources = rollback.rollbackData.affectedResources || []
      
      // Verify resources no longer exist
      const graph = await loadGraph(context.projectId)
      
      for (const resource of affectedResources) {
        if (resource.startsWith('table:')) {
          const tableName = resource.replace('table:', '')
          if (graph.entities[tableName]) {
            flags.push({
              type: 'INCOMPLETE_ROLLBACK',
              severity: 'CRITICAL',
              message: `Rollback claimed to remove table "${tableName}" but it still exists`,
              evidence: { rollbackIntent: rollback.intent, orphanedTable: tableName },
              recommendation: 'Rollback must remove ALL artifacts. System state is inconsistent.',
            })
          }
        }
      }
    }
  }
  
  return flags
}

/**
 * Scan for Red Flag #5: Deployment succeeds with drift
 */
async function detectDeploymentDrift(
  context: ExecutionContext
): Promise<RedFlag[]> {
  const flags: RedFlag[] = []
  
  // Check if there are unexplained state items
  const unexplainedFlags = await detectUnexplainedState(context)
  
  if (unexplainedFlags.length > 0) {
    flags.push({
      type: 'DEPLOYMENT_DRIFT',
      severity: 'CRITICAL',
      message: `System has ${unexplainedFlags.length} unexplained state items`,
      evidence: { unexplainedItems: unexplainedFlags },
      recommendation: '⛔ BLOCK DEPLOYMENT until all state is explained by intent history.',
    })
  }
  
  return flags
}

/**
 * Run complete red flag scan
 */
export async function scanForRedFlags(
  context: ExecutionContext
): Promise<RedFlagReport> {
  console.log(`[Red Flag Detection] Scanning project ${context.projectId}`)
  
  const allFlags: RedFlag[] = []
  
  // Run all detectors
  const unexplainedState = await detectUnexplainedState(context)
  const orphanedStorage = await detectOrphanedStorage(context)
  const orphanedAPIs = await detectOrphanedAPIs(context)
  const incompleteRollback = await detectIncompleteRollback(context)
  const deploymentDrift = await detectDeploymentDrift(context)
  
  allFlags.push(...unexplainedState)
  allFlags.push(...orphanedStorage)
  allFlags.push(...orphanedAPIs)
  allFlags.push(...incompleteRollback)
  allFlags.push(...deploymentDrift)
  
  const systemHealthy = allFlags.length === 0
  
  if (!systemHealthy) {
    console.error(`[Red Flag Detection] 🚨 ${allFlags.length} RED FLAGS DETECTED`)
    allFlags.forEach(flag => {
      console.error(`  🚨 [${flag.severity}] ${flag.type}: ${flag.message}`)
    })
  } else {
    console.log('[Red Flag Detection] ✅ No red flags detected. System healthy.')
  }
  
  return {
    projectId: context.projectId,
    timestamp: new Date(),
    flags: allFlags,
    systemHealthy,
  }
}

/**
 * Generate red flag report
 */
export function generateRedFlagReport(report: RedFlagReport): string {
  let output = '╔════════════════════════════════════════════════════════════════╗\n'
  output += '║                   RED FLAG DETECTION REPORT                    ║\n'
  output += '╚════════════════════════════════════════════════════════════════╝\n\n'
  
  output += `Project ID: ${report.projectId}\n`
  output += `Timestamp: ${report.timestamp.toISOString()}\n`
  output += `System Status: ${report.systemHealthy ? '✅ HEALTHY' : '🚨 COMPROMISED'}\n`
  output += `Red Flags: ${report.flags.length}\n\n`
  
  if (report.flags.length === 0) {
    output += '─────────────────────────────────────────────────────────────────\n'
    output += '✅ NO RED FLAGS DETECTED\n'
    output += '─────────────────────────────────────────────────────────────────\n'
    output += '✅ Advanced Mode shows only described state\n'
    output += '✅ Storage tied to user behaviors\n'
    output += '✅ All APIs explained by intent\n'
    output += '✅ Rollbacks complete cleanly\n'
    output += '✅ No deployment drift\n\n'
    output += '🎯 System is fundamentally correct.\n'
  } else {
    output += '─────────────────────────────────────────────────────────────────\n'
    output += '🚨 RED FLAGS DETECTED - SYSTEM INTEGRITY COMPROMISED\n'
    output += '─────────────────────────────────────────────────────────────────\n\n'
    
    report.flags.forEach((flag, i) => {
      output += `🚨 RED FLAG #${i + 1} [${flag.severity}]\n`
      output += `Type: ${flag.type}\n`
      output += `Message: ${flag.message}\n`
      output += `Recommendation: ${flag.recommendation}\n\n`
    })
    
    output += '─────────────────────────────────────────────────────────────────\n'
    output += '⛔ CRITICAL ACTION REQUIRED\n'
    output += '─────────────────────────────────────────────────────────────────\n'
    output += '1. Fix all red flags immediately\n'
    output += '2. Block deployment until system is healthy\n'
    output += '3. Investigate root cause of integrity violations\n'
    output += '4. Re-run verification after fixes\n'
  }
  
  output += '\n═════════════════════════════════════════════════════════════════\n'
  
  return output
}

/**
 * Continuous monitoring: should be called periodically
 */
export async function monitorSystemIntegrity(
  context: ExecutionContext
): Promise<void> {
  const report = await scanForRedFlags(context)
  
  if (!report.systemHealthy) {
    // Log to monitoring system
    console.error('[System Integrity] RED FLAGS DETECTED')
    console.error(generateRedFlagReport(report))
    
    // Could trigger alerts, disable deployments, etc.
  }
}
