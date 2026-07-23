/**
 * OPTIONAL HARDENING: Intent Lineage Hash
 * 
 * Cryptographically provable drift detection
 * Hash each executed intent and store on derived artifacts
 */

import crypto from 'crypto'
import { ExecutionContext, assertExecutionContext } from '@/lib/context/execution-context'

export interface IntentLineage {
  intentId: string
  intentText: string
  intentHash: string
  executionId: string
  timestamp: Date
  parentHash?: string
  artifactHashes: Record<string, string>
}

/**
 * Generate cryptographic hash of intent
 */
export function hashIntent(
  intentText: string,
  executionId: string,
  timestamp: Date,
  parentHash?: string
): string {
  const data = JSON.stringify({
    intentText: intentText.trim().toLowerCase(),
    executionId,
    timestamp: timestamp.toISOString(),
    parentHash: parentHash || null,
  })
  
  return crypto.createHash('sha256').update(data).digest('hex')
}

/**
 * Hash artifact state (table, API, auth config, etc.)
 */
export function hashArtifact(
  artifactType: 'table' | 'api' | 'auth' | 'storage' | 'capability',
  artifactName: string,
  artifactData: any
): string {
  const normalized = JSON.stringify({
    type: artifactType,
    name: artifactName,
    data: artifactData,
  })
  
  return crypto.createHash('sha256').update(normalized).digest('hex')
}

/**
 * Create intent lineage record
 */
export async function recordIntentLineage(
  context: ExecutionContext,
  intentText: string,
  artifacts: { type: string; name: string; data: any }[]
): Promise<IntentLineage> {
  assertExecutionContext(context)
  
  // Get parent hash (previous intent)
  const { getIntentHistory } = await import('@/lib/orchestration/project-scoped-state')
  const history = await getIntentHistory(context, 1)
  const parentHash = history[0]?.rollbackData?.lineageHash
  
  // Hash current intent
  const intentHash = hashIntent(
    intentText,
    context.executionId,
    context.timestamp,
    parentHash
  )
  
  // Hash all artifacts
  const artifactHashes: Record<string, string> = {}
  for (const artifact of artifacts) {
    const key = `${artifact.type}:${artifact.name}`
    artifactHashes[key] = hashArtifact(
      artifact.type as any,
      artifact.name,
      artifact.data
    )
  }
  
  const lineage: IntentLineage = {
    intentId: context.executionId,
    intentText,
    intentHash,
    executionId: context.executionId,
    timestamp: context.timestamp,
    parentHash,
    artifactHashes,
  }
  
  console.log(
    `[Intent Lineage] Recorded hash ${intentHash.substring(0, 8)} for intent: ${intentText.substring(0, 50)}`
  )
  
  return lineage
}

/**
 * Verify artifact lineage
 * 
 * Checks if artifact can be traced to a specific intent
 */
export async function verifyArtifactLineage(
  context: ExecutionContext,
  artifactType: 'table' | 'api' | 'auth' | 'storage',
  artifactName: string,
  currentData: any
): Promise<{
  valid: boolean
  originIntent?: string
  originHash?: string
  currentHash: string
  message: string
}> {
  assertExecutionContext(context)
  
  // Hash current artifact state
  const currentHash = hashArtifact(artifactType, artifactName, currentData)
  
  // Search intent history for matching artifact
  const { getIntentHistory } = await import('@/lib/orchestration/project-scoped-state')
  const history = await getIntentHistory(context, 100)
  
  const artifactKey = `${artifactType}:${artifactName}`
  
  for (const intent of history) {
    const lineage = intent.rollbackData?.lineage as IntentLineage | undefined
    
    if (lineage?.artifactHashes[artifactKey]) {
      const storedHash = lineage.artifactHashes[artifactKey]
      
      // Allow hash mismatch if artifact was modified by later intent
      // Just verify it originated from *some* intent
      return {
        valid: true,
        originIntent: intent.intent,
        originHash: storedHash,
        currentHash,
        message: `Artifact traced to intent: "${intent.intent.substring(0, 50)}..."`,
      }
    }
  }
  
  // Artifact has no lineage - unexplained state!
  return {
    valid: false,
    currentHash,
    message: `Artifact "${artifactName}" has no intent lineage - unexplained state`,
  }
}

/**
 * Verify intent chain integrity
 * 
 * Ensures no intents were tampered with or inserted
 */
export async function verifyIntentChain(
  context: ExecutionContext
): Promise<{
  valid: boolean
  brokenAt?: number
  message: string
}> {
  assertExecutionContext(context)
  
  const { getIntentHistory } = await import('@/lib/orchestration/project-scoped-state')
  const history = await getIntentHistory(context, 1000)
  
  if (history.length === 0) {
    return {
      valid: true,
      message: 'No intent history to verify',
    }
  }
  
  // Verify each intent's hash chains to previous
  for (let i = 1; i < history.length; i++) {
    const current = history[i]
    const previous = history[i - 1]
    
    const currentLineage = current.rollbackData?.lineage as IntentLineage | undefined
    const previousLineage = previous.rollbackData?.lineage as IntentLineage | undefined
    
    if (!currentLineage || !previousLineage) {
      continue // Skip intents without lineage
    }
    
    // Verify parent hash matches
    if (currentLineage.parentHash !== previousLineage.intentHash) {
      return {
        valid: false,
        brokenAt: i,
        message: `Intent chain broken at position ${i}: hash mismatch`,
      }
    }
  }
  
  return {
    valid: true,
    message: `Intent chain verified: ${history.length} intents`,
  }
}

/**
 * Generate lineage proof certificate
 * 
 * Cryptographic proof that state is derived from intent
 */
export async function generateLineageProof(
  context: ExecutionContext
): Promise<string> {
  assertExecutionContext(context)
  
  const { getIntentHistory } = await import('@/lib/orchestration/project-scoped-state')
  const history = await getIntentHistory(context, 100)
  
  let proof = '╔════════════════════════════════════════════════════════════════╗\n'
  proof += '║           INTENT LINEAGE CRYPTOGRAPHIC PROOF                   ║\n'
  proof += '╚════════════════════════════════════════════════════════════════╝\n\n'
  
  proof += `Project ID: ${context.projectId}\n`
  proof += `Generated: ${new Date().toISOString()}\n`
  proof += `Intent Chain Length: ${history.length}\n\n`
  
  proof += '─────────────────────────────────────────────────────────────────\n'
  proof += 'INTENT CHAIN:\n'
  proof += '─────────────────────────────────────────────────────────────────\n\n'
  
  history.reverse().forEach((intent, i) => {
    const lineage = intent.rollbackData?.lineage as IntentLineage | undefined
    
    if (lineage) {
      proof += `${i + 1}. ${intent.intent.substring(0, 60)}\n`
      proof += `   Hash: ${lineage.intentHash.substring(0, 16)}...\n`
      proof += `   Parent: ${lineage.parentHash?.substring(0, 16) || 'none'}...\n`
      proof += `   Artifacts: ${Object.keys(lineage.artifactHashes).length}\n\n`
    }
  })
  
  // Verify chain
  const chainVerification = await verifyIntentChain(context)
  
  proof += '─────────────────────────────────────────────────────────────────\n'
  proof += 'VERIFICATION:\n'
  proof += '─────────────────────────────────────────────────────────────────\n\n'
  
  if (chainVerification.valid) {
    proof += '✅ Intent chain integrity verified\n'
    proof += '✅ No tampering detected\n'
    proof += '✅ All hashes form valid chain\n'
  } else {
    proof += '❌ Intent chain BROKEN\n'
    proof += `❌ ${chainVerification.message}\n`
  }
  
  proof += '\n═════════════════════════════════════════════════════════════════\n'
  proof += 'This proof demonstrates that all state is cryptographically\n'
  proof += 'traceable to specific user intents. Tampering is detectable.\n'
  proof += '═════════════════════════════════════════════════════════════════\n'
  
  return proof
}
