/**
 * BLUEPRINT VERIFIER
 * ==================
 * Compares a ProductBlueprint (what was planned) against the actual BuildJob
 * node states (what was built). Produces a structured gap report that the
 * repair loop uses to identify which failed nodes can be retried.
 *
 * Gap categories:
 *  - 'missing'  : blueprint item has no corresponding node in the graph
 *  - 'failed'   : node exists but status=failed (execution error — retryable)
 *  - 'blocked'  : node exists but status=blocked on credentials (not retryable)
 *
 * The repair loop only retries 'failed' gaps. 'missing' gaps indicate compiler
 * logic did not produce the node (engineering issue, not runtime). 'blocked' gaps
 * are surfaced to the user as credential actions.
 */

import type { BuildJob, BuildNode } from './types'
import type { ProductBlueprint } from '@/lib/ai/goal-understanding-engine'

// ── Gap Types ─────────────────────────────────────────────────────────────────

export interface BlueprintGap {
  blueprintItem: string
  nodeId: string | null
  nodeType: 'schema' | 'storage' | 'integration' | 'function' | 'realtime'
  reason: 'missing' | 'failed' | 'blocked'
  description: string
  /** Credential env var required to unblock — only set when reason=blocked */
  requiredEnvVar?: string
  /** Integration ID for the credential connect flow */
  integrationId?: string
}

export interface BlueprintGapReport {
  hasGaps: boolean
  /** All gaps including blocked and unretryable */
  gaps: BlueprintGap[]
  /** Failed nodes that CAN be retried without credentials */
  repairable: BlueprintGap[]
  /** Nodes blocked on missing credentials — user action required */
  credentialBlocked: BlueprintGap[]
  /** Items in blueprint that have no corresponding node in the graph */
  missingNodes: BlueprintGap[]
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Diff a ProductBlueprint against the actual BuildJob node states.
 * Returns a structured gap report for the repair loop and user messaging.
 */
export function checkBlueprintGaps(
  job: BuildJob,
  blueprint: ProductBlueprint,
): BlueprintGapReport {
  const allNodes = buildNodeIndex(job)
  const gaps: BlueprintGap[] = []

  // ── Schema entities ────────────────────────────────────────────────────────
  for (const entity of blueprint.entities) {
    const nodeId = `schema.${entity.name.toLowerCase()}`
    const node = allNodes.get(nodeId)

    if (!node) {
      gaps.push({
        blueprintItem: entity.name,
        nodeId: null,
        nodeType: 'schema',
        reason: 'missing',
        description: `Table '${entity.name}' was planned but not found in build graph`,
      })
    } else if (node.status === 'failed') {
      gaps.push({
        blueprintItem: entity.name,
        nodeId,
        nodeType: 'schema',
        reason: 'failed',
        description: `Table '${entity.name}' failed: ${node.failureReason ?? 'unknown error'}`,
      })
    }
    // 'blocked' schema nodes are the blueprint entity filter — not real gaps
  }

  // ── Storage buckets ────────────────────────────────────────────────────────
  for (const bucket of blueprint.storageBuckets) {
    const bucketId = bucket.name.toLowerCase().replace(/[^a-z0-9_-]/g, '-')
    const nodeId = `storage.${bucketId}`
    const node = allNodes.get(nodeId)

    if (!node) {
      gaps.push({
        blueprintItem: bucket.name,
        nodeId: null,
        nodeType: 'storage',
        reason: 'missing',
        description: `Storage bucket '${bucket.name}' was planned but not found in build graph`,
      })
    } else if (node.status === 'failed') {
      gaps.push({
        blueprintItem: bucket.name,
        nodeId,
        nodeType: 'storage',
        reason: 'failed',
        description: `Storage bucket '${bucket.name}' failed: ${node.failureReason ?? 'unknown error'}`,
      })
    }
  }

  // ── Integrations ───────────────────────────────────────────────────────────
  for (const integration of blueprint.integrations) {
    const name = integration.name.toLowerCase()
    // Find any node whose ID starts with 'integration.{name}'
    const node = findNodeByPrefix(allNodes, `integration.${name}`)

    if (!node) {
      if (integration.required) {
        gaps.push({
          blueprintItem: integration.name,
          nodeId: null,
          nodeType: 'integration',
          reason: 'missing',
          description: `Required integration '${integration.name}' not in build graph`,
        })
      }
      // Optional integrations that are absent are not gaps
    } else if (node.status === 'failed') {
      gaps.push({
        blueprintItem: integration.name,
        nodeId: node.id,
        nodeType: 'integration',
        reason: 'failed',
        description: `Integration '${integration.name}' failed: ${node.failureReason ?? 'unknown error'}`,
      })
    } else if (node.status === 'blocked') {
      gaps.push({
        blueprintItem: integration.name,
        nodeId: node.id,
        nodeType: 'integration',
        reason: 'blocked',
        description: node.blockedReason?.description ?? `${integration.name} credentials not provided`,
        requiredEnvVar: node.blockedReason?.requiredEnvVar,
        integrationId: node.blockedReason?.resumeOnIntegration ?? name,
      })
    }
  }

  // ── Functions ──────────────────────────────────────────────────────────────
  for (const fn of blueprint.functions) {
    const nodeId = `function.${fn.name}`
    const node = allNodes.get(nodeId)

    if (!node) {
      gaps.push({
        blueprintItem: fn.name,
        nodeId: null,
        nodeType: 'function',
        reason: 'missing',
        description: `Function '${fn.name}' was planned but not found in build graph`,
      })
    } else if (node.status === 'failed') {
      gaps.push({
        blueprintItem: fn.name,
        nodeId,
        nodeType: 'function',
        reason: 'failed',
        description: `Function '${fn.name}' failed: ${node.failureReason ?? 'unknown error'}`,
      })
    }
  }

  // ── Realtime channels ──────────────────────────────────────────────────────
  if (blueprint.realtimeChannels.length > 0) {
    const realtimeNodes = [...allNodes.values()].filter(n => n.type === 'realtime')
    if (realtimeNodes.length === 0) {
      gaps.push({
        blueprintItem: blueprint.realtimeChannels.join(', '),
        nodeId: null,
        nodeType: 'realtime',
        reason: 'missing',
        description: `Realtime channels (${blueprint.realtimeChannels.join(', ')}) were planned but not in build graph`,
      })
    } else {
      const failedRt = realtimeNodes.find(n => n.status === 'failed')
      if (failedRt) {
        gaps.push({
          blueprintItem: blueprint.realtimeChannels.join(', '),
          nodeId: failedRt.id,
          nodeType: 'realtime',
          reason: 'failed',
          description: `Realtime setup failed: ${failedRt.failureReason ?? 'unknown error'}`,
        })
      }
    }
  }

  // ── Categorize ────────────────────────────────────────────────────────────
  const repairable = gaps.filter(g => g.reason === 'failed' && g.nodeId !== null)
  const credentialBlocked = gaps.filter(g => g.reason === 'blocked')
  const missingNodes = gaps.filter(g => g.reason === 'missing')

  return {
    hasGaps: gaps.length > 0,
    gaps,
    repairable,
    credentialBlocked,
    missingNodes,
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildNodeIndex(job: BuildJob): Map<string, BuildNode> {
  const index = new Map<string, BuildNode>()
  for (const phase of job.phases) {
    for (const node of phase.nodes) {
      index.set(node.id, node)
    }
  }
  return index
}

function findNodeByPrefix(index: Map<string, BuildNode>, prefix: string): BuildNode | undefined {
  for (const [id, node] of index) {
    if (id.startsWith(prefix)) return node
  }
  return undefined
}
