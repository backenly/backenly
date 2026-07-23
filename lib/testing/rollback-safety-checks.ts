/**
 * Rollback safety helpers
 *
 * Utilities used by the rollback verification test suite to reason about
 * BackendStateGraph equality and artifact counts across surfaces.
 */

import { type BackendStateGraph } from '@/lib/orchestration/backend-state-graph'

export interface GraphArtifactCounts {
  tables: number
  apis: number
  authProviders: number
  buckets: number
}

export function countArtifacts(graph: BackendStateGraph | null | undefined): GraphArtifactCounts {
  if (!graph) {
    return { tables: 0, apis: 0, authProviders: 0, buckets: 0 }
  }

  const tables = Object.keys(graph.entities || {}).length
  const apis = Object.keys(graph.apis || {}).length
  const authProviders = Object.keys(graph.auth?.providers || {}).length
  const buckets = Object.keys(graph.storage?.buckets || {}).length

  return { tables, apis, authProviders, buckets }
}

export function graphsEqual(
  a: BackendStateGraph | null | undefined,
  b: BackendStateGraph | null | undefined
): boolean {
  if (!a || !b) return false

  const normalize = (value: any): any => {
    if (Array.isArray(value)) {
      return value.map(normalize).sort((left, right) => {
        const l = JSON.stringify(left)
        const r = JSON.stringify(right)
        if (l < r) return -1
        if (l > r) return 1
        return 0
      })
    }

    if (value && typeof value === 'object') {
      const keys = Object.keys(value).sort()
      const result: any = {}
      for (const key of keys) {
        result[key] = normalize((value as any)[key])
      }
      return result
    }

    return value
  }

  const normalizedA = normalize(a)
  const normalizedB = normalize(b)

  // Strict structural equality on normalized graphs. If this fails,
  // rollback did not restore the exact previous intent state.
  return JSON.stringify(normalizedA) === JSON.stringify(normalizedB)
}
