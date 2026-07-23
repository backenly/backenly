/**
 * BUILD GRAPH
 * ===========
 * DAG of BuildNodes with full status tracking.
 *
 * Responsibilities:
 *  - Add/update nodes
 *  - Resolve execution order (topological sort)
 *  - Determine which nodes are ready to run (deps satisfied)
 *  - Compute aggregate BuildJobStatus from node statuses
 *  - Never stores LLM opinion — only real execution state
 */

import type {
  BuildNode,
  BuildPhase,
  BuildJob,
  BuildJobStatus,
  NodeStatus,
  BlockedReason,
} from './types'

// ── BuildGraph class ──────────────────────────────────────────────────────────

export class BuildGraph {
  private nodes: Map<string, BuildNode> = new Map()
  private phases: BuildPhase[] = []

  constructor(phases: BuildPhase[]) {
    this.phases = phases
    for (const phase of phases) {
      for (const node of phase.nodes) {
        this.nodes.set(node.id, node)
      }
    }
  }

  // ── Query ─────────────────────────────────────────────────────────────────

  getNode(id: string): BuildNode | undefined {
    return this.nodes.get(id)
  }

  getAllNodes(): BuildNode[] {
    return Array.from(this.nodes.values())
  }

  getPhases(): BuildPhase[] {
    return this.phases
  }

  getNodesByStatus(status: NodeStatus): BuildNode[] {
    return Array.from(this.nodes.values()).filter(n => n.status === status)
  }

  getNodesByPhase(phaseNumber: number): BuildNode[] {
    return Array.from(this.nodes.values()).filter(n => n.phase === phaseNumber)
  }

  /**
   * Returns nodes that are ready to execute:
   *  - status is 'pending'
   *  - all dependencies are 'verified' or 'partial' (or have no deps)
   *
   * 'partial' deps count as satisfied — the node ran and produced partial results.
   * Downstream nodes should still proceed rather than staying stuck pending.
   */
  getReadyNodes(): BuildNode[] {
    return Array.from(this.nodes.values()).filter(node => {
      if (node.status !== 'pending') return false
      return node.dependencies.every(depId => {
        const dep = this.nodes.get(depId)
        return dep?.status === 'verified' || dep?.status === 'partial'
      })
    })
  }

  /**
   * Returns nodes blocked only because a dependency is blocked.
   * These are transitively blocked — not directly blocked on credentials.
   */
  getTransitivelyBlockedNodes(): BuildNode[] {
    return Array.from(this.nodes.values()).filter(node => {
      if (node.status !== 'pending') return false
      return node.dependencies.some(depId => {
        const dep = this.nodes.get(depId)
        return dep?.status === 'blocked' || dep?.status === 'failed'
      })
    })
  }

  // ── Mutation ──────────────────────────────────────────────────────────────

  setStatus(nodeId: string, status: NodeStatus, detail?: {
    executionDetail?: string
    failureReason?: string
    executedAt?: string
    verifiedAt?: string
    startedAt?: string
    blockedReason?: BlockedReason
  }): void {
    const node = this.nodes.get(nodeId)
    if (!node) return

    node.status = status
    if (detail?.executionDetail) node.executionDetail = detail.executionDetail
    if (detail?.failureReason) node.failureReason = detail.failureReason
    if (detail?.executedAt) node.executedAt = detail.executedAt
    if (detail?.verifiedAt) node.verifiedAt = detail.verifiedAt
    if (detail?.startedAt) node.startedAt = detail.startedAt
    if (detail?.blockedReason) node.blockedReason = detail.blockedReason

    // Sync back to phases array
    this.syncNodeToPhase(node)
  }

  markRunning(nodeId: string): void {
    this.setStatus(nodeId, 'running', { startedAt: new Date().toISOString() })
  }

  markVerified(nodeId: string, detail?: string): void {
    this.setStatus(nodeId, 'verified', {
      executedAt: new Date().toISOString(),
      verifiedAt: new Date().toISOString(),
      executionDetail: detail,
    })
  }

  markBlocked(nodeId: string, reason: BlockedReason): void {
    this.setStatus(nodeId, 'blocked', { blockedReason: reason })
  }

  markFailed(nodeId: string, reason: string): void {
    this.setStatus(nodeId, 'failed', { failureReason: reason })
  }

  markPartial(nodeId: string, detail?: string): void {
    this.setStatus(nodeId, 'partial', {
      executedAt: new Date().toISOString(),
      executionDetail: detail,
    })
  }

  /**
   * Unblock a node — called when a credential becomes available.
   * Also unblocks any nodes that were transitively blocked on this one.
   */
  unblock(nodeId: string): void {
    const node = this.nodes.get(nodeId)
    if (!node || node.status !== 'blocked') return
    node.status = 'pending'
    node.blockedReason = undefined
    this.syncNodeToPhase(node)

    // Check if any pending nodes were waiting on this — no-op if already pending
    // (transitive unblocking happens via getReadyNodes() on next pass)
  }

  /**
   * Unblock all nodes that were blocked on a specific integration.
   * Called when a credential for that integration arrives.
   */
  unblockByIntegration(integrationId: string): string[] {
    const unblocked: string[] = []
    for (const node of this.nodes.values()) {
      if (
        node.status === 'blocked' &&
        node.blockedReason?.resumeOnIntegration === integrationId
      ) {
        this.unblock(node.id)
        unblocked.push(node.id)
      }
    }
    return unblocked
  }

  // ── Topological Sort ──────────────────────────────────────────────────────

  /**
   * Return all nodes in execution order (Kahn's algorithm).
   * Preserves phase ordering within the same dependency tier.
   */
  topoSort(): BuildNode[] {
    const inDegree = new Map<string, number>()
    const adj = new Map<string, string[]>()

    for (const node of this.nodes.values()) {
      inDegree.set(node.id, node.dependencies.length)
      adj.set(node.id, [])
    }

    for (const node of this.nodes.values()) {
      for (const dep of node.dependencies) {
        const list = adj.get(dep) || []
        list.push(node.id)
        adj.set(dep, list)
      }
    }

    // Start with nodes that have no dependencies, ordered by phase then node id
    const queue: BuildNode[] = Array.from(this.nodes.values())
      .filter(n => (inDegree.get(n.id) || 0) === 0)
      .sort((a, b) => a.phase - b.phase || a.id.localeCompare(b.id))

    const result: BuildNode[] = []
    const visited = new Set<string>()

    while (queue.length > 0) {
      const node = queue.shift()!
      if (visited.has(node.id)) continue
      visited.add(node.id)
      result.push(node)

      const successors = (adj.get(node.id) || [])
        .map(id => this.nodes.get(id)!)
        .filter(Boolean)
        .sort((a, b) => a.phase - b.phase || a.id.localeCompare(b.id))

      for (const succ of successors) {
        const newDegree = (inDegree.get(succ.id) || 0) - 1
        inDegree.set(succ.id, newDegree)
        if (newDegree === 0) queue.push(succ)
      }
    }

    return result
  }

  // ── Aggregate Status ──────────────────────────────────────────────────────

  /**
   * Compute the overall BuildJobStatus from real node statuses.
   * This is the single source of truth — never inferred from LLM output.
   */
  computeJobStatus(): BuildJobStatus {
    const all = Array.from(this.nodes.values())

    if (all.length === 0) return 'pending'

    const counts = {
      pending: 0,
      running: 0,
      blocked: 0,
      partial: 0,
      verified: 0,
      failed: 0,
    }

    for (const n of all) counts[n.status]++

    if (counts.running > 0) return 'running'
    if (counts.failed > 0 && counts.verified === 0 && counts.pending === 0) return 'failed'

    // All required nodes verified
    const requiredNodes = all.filter(n => !n.optional)
    const allRequired = requiredNodes.every(n => n.status === 'verified' || n.status === 'blocked')
    if (allRequired && requiredNodes.every(n => n.status === 'verified')) return 'verified'

    // No more progress possible — only blocked + verified remain
    if (counts.pending === 0 && counts.running === 0 && counts.partial === 0) {
      if (counts.blocked > 0) return 'blocked'
      if (counts.failed > 0) return 'failed'
      return 'verified'
    }

    // Some done, some remaining
    if (counts.verified > 0 || counts.partial > 0) return 'partial'

    return 'pending'
  }

  // ── Serialization ─────────────────────────────────────────────────────────

  toJSON(): BuildPhase[] {
    // Return phases with current node state (nodes have been mutated in-place)
    return this.phases
  }

  static fromPhases(phases: BuildPhase[]): BuildGraph {
    return new BuildGraph(phases)
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  private syncNodeToPhase(node: BuildNode): void {
    for (const phase of this.phases) {
      const idx = phase.nodes.findIndex(n => n.id === node.id)
      if (idx >= 0) {
        phase.nodes[idx] = node
        break
      }
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build a BuildGraph from a BuildJob's phases.
 */
export function graphFromJob(job: BuildJob): BuildGraph {
  return new BuildGraph(job.phases)
}

/**
 * Describe what the graph produced (for prompt injection).
 * Summarizes verified/blocked/pending counts — no LLM.
 */
export function summarizeGraph(graph: BuildGraph): string {
  const all = graph.getAllNodes()
  const verified = all.filter(n => n.status === 'verified').map(n => n.label)
  const blocked = all.filter(n => n.status === 'blocked').map(n => `${n.label} (${n.blockedReason?.requiredEnvVar ?? 'manual step'})`)
  const failed = all.filter(n => n.status === 'failed').map(n => `${n.label}: ${n.failureReason ?? 'error'}`)
  const remaining = all.filter(n => n.status === 'pending').map(n => n.label)

  const lines: string[] = ['[BUILD GRAPH STATE]']
  if (verified.length) lines.push(`  Verified: ${verified.join(', ')}`)
  if (blocked.length) lines.push(`  Blocked: ${blocked.join(', ')}`)
  if (failed.length) lines.push(`  Failed: ${failed.join(', ')}`)
  if (remaining.length) lines.push(`  Remaining: ${remaining.join(', ')}`)
  return lines.join('\n')
}
