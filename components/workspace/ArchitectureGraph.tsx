'use client'

import { motion } from 'framer-motion'
import { Table2 } from 'lucide-react'

interface Entity {
  name: string
  fieldCount: number
  fields?: Array<{ name: string; type: string }>
}

interface ArchitectureGraphProps {
  entities: Entity[]
}

interface Edge {
  parent: string
  child: string
  via: string
}

function detectEdges(entities: Entity[]): Edge[] {
  const entityNames = new Set(entities.map(e => e.name))
  const edges: Edge[] = []
  entities.forEach(child => {
    ;(child.fields || []).forEach(field => {
      const camel = field.name.match(/^(.+?)Id$/)
      const snake = field.name.match(/^(.+?)_id$/)
      const raw = camel?.[1] || snake?.[1]
      if (!raw) return
      for (const candidate of [raw, raw + 's', raw.replace(/s$/, '')]) {
        if (entityNames.has(candidate) && candidate !== child.name) {
          if (!edges.some(e => e.parent === candidate && e.child === child.name)) {
            edges.push({ parent: candidate, child: child.name, via: field.name })
          }
          break
        }
      }
    })
  })
  return edges
}

/**
 * Build flat rows — one row per relationship path.
 * Chains: follow edge chains (parent → child → grandchild) into one row.
 * Each edge that isn't part of a chain becomes its own row.
 *
 * e.g. users→posts, posts→comments, users→reviews, users→comments
 * → Row 1: users → posts → comments  (chain)
 * → Row 2: users → reviews            (direct edge)
 * → Row 3: users → comments           (direct edge, even if comments already in row 1)
 */
/**
 * Build display rows from FK edges.
 *
 * Rules:
 * 1. Build chains starting from root nodes (nodes with no inbound FK).
 * 2. A node already shown as part of a chain is NOT shown again as a
 *    standalone target from another parent — that would be misleading
 *    (e.g. users→comments when comments already appears via users→posts→comments).
 * 3. Only show a direct edge A→B if B has NOT already been placed in any chain.
 */
function buildRows(edges: Edge[]): Array<string[]> {
  if (edges.length === 0) return []

  // Build adjacency: parent → [children]
  const childrenOf = new Map<string, string[]>()
  edges.forEach(({ parent, child }) => {
    if (!childrenOf.has(parent)) childrenOf.set(parent, [])
    childrenOf.get(parent)!.push(child)
  })

  // Root parents: appear as parent but never as a child of anyone else
  const childNodes = edges.map(e => e.child)
  const allParents = edges.map(e => e.parent).filter((v, i, a) => a.indexOf(v) === i)
  const roots = allParents.filter(n => childNodes.indexOf(n) === -1)

  // Track every node that has been placed in a row (to avoid duplicates)
  const placed = new Set<string>()
  const rows: Array<string[]> = []

  // Walk from each root, one chain per child
  roots.forEach(root => {
    placed.add(root)
    // Sort children so those with their own children (chain starters) come first
    const children = (childrenOf.get(root) ?? []).slice().sort((a, b) => {
      const aHasKids = (childrenOf.get(a) ?? []).length > 0 ? -1 : 1
      const bHasKids = (childrenOf.get(b) ?? []).length > 0 ? -1 : 1
      return aHasKids - bHasKids
    })
    children.forEach(child => {
      // Skip if already placed by a previous chain (e.g. comments placed via posts→comments)
      if (placed.has(child)) return
      // Build chain: root → child → grandchild → ...
      const chain = [root, child]
      placed.add(child)
      let current = child
      while (true) {
        const grandchildren = childrenOf.get(current) ?? []
        // Pick the first grandchild not yet placed
        const next = grandchildren.find(c => !placed.has(c))
        if (!next) break
        placed.add(next)
        chain.push(next)
        current = next
      }
      rows.push(chain)
    })
  })

  // Remaining edges whose child was never placed (truly disconnected pairs)
  edges.forEach(({ parent, child }) => {
    if (!placed.has(child)) {
      placed.add(child)
      rows.push([parent, child])
    }
  })

  return rows
}

function TablePill({ name, fieldCount }: { name: string; fieldCount: number }) {
  return (
    <div className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-slate-700/70 bg-[#0d1220] flex-shrink-0">
      <Table2 className="w-3 h-3 text-slate-500 flex-shrink-0" />
      <span className="text-[12px] font-semibold text-slate-300">{name}</span>
      <span className="text-[10px] text-slate-600 ml-0.5">{fieldCount}</span>
    </div>
  )
}

function Arrow() {
  return (
    <div className="flex items-center px-1 flex-shrink-0">
      <div className="w-4 h-px bg-slate-700" />
      <svg width="5" height="7" viewBox="0 0 5 7" className="text-slate-700">
        <polyline points="0,0 5,3.5 0,7" stroke="currentColor" strokeWidth="1.5"
          fill="none" strokeLinejoin="round" strokeLinecap="round" />
      </svg>
    </div>
  )
}

export function ArchitectureGraph({ entities }: ArchitectureGraphProps) {
  if (entities.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-8 text-slate-600">
        <p className="text-xs">No tables yet</p>
        <p className="text-[10px] mt-1">Create your first table to see the structure</p>
      </div>
    )
  }

  const edges = detectEdges(entities)
  const rows = buildRows(edges)
  const entityMap = new Map(entities.map(e => [e.name, e]))

  // Orphans: entities with no edges at all
  const involved = new Set(edges.flatMap(e => [e.parent, e.child]))
  const orphans = entities.filter(e => !involved.has(e.name))

  return (
    <div className="p-4">
      {/* Header */}
      <div className="flex items-center justify-between mb-0.5">
        <p className="text-[10px] text-slate-500 uppercase tracking-wide font-semibold">
          Backend Structure
        </p>
        <p className="text-[10px] text-slate-600">
          {entities.length} table{entities.length !== 1 ? 's' : ''}
          {edges.length > 0 && ` · ${edges.length} relationship${edges.length !== 1 ? 's' : ''}`}
        </p>
      </div>
      <p className="text-[10px] text-slate-600 mb-4">How your data connects</p>

      <div className="space-y-2">
        {rows.length > 0 ? (
          <>
            {rows.map((row, ri) => (
              <motion.div
                key={row.join('>')}
                initial={{ opacity: 0, x: -4 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: ri * 0.05 }}
                className="flex items-center flex-wrap gap-0"
              >
                {row.map((name, idx) => {
                  const entity = entityMap.get(name)
                  return (
                    <div key={`${ri}-${name}-${idx}`} className="flex items-center">
                      <TablePill name={name} fieldCount={entity?.fieldCount ?? 0} />
                      {idx < row.length - 1 && <Arrow />}
                    </div>
                  )
                })}
              </motion.div>
            ))}
          </>
        ) : (
          /* No relationships */
          <div className="flex flex-wrap gap-1.5">
            {entities.map((entity, idx) => (
              <motion.div
                key={entity.name}
                initial={{ opacity: 0, x: -4 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: idx * 0.05 }}
              >
                <TablePill name={entity.name} fieldCount={entity.fieldCount} />
              </motion.div>
            ))}
          </div>
        )}

        {/* Orphans */}
        {orphans.length > 0 && rows.length > 0 && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: rows.length * 0.05 + 0.04 }}
            className="flex flex-wrap gap-1.5 pt-1"
          >
            {orphans.map(e => (
              <TablePill key={e.name} name={e.name} fieldCount={e.fieldCount} />
            ))}
          </motion.div>
        )}
      </div>
    </div>
  )
}
