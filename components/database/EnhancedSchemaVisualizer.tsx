'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Key, Database as DatabaseIcon, Loader2, Search,
  Hash, Clock, Type, Link2, Eye, EyeOff, ZoomIn, ZoomOut,
  RefreshCw, X, Circle, Calendar, FileText, Check, AlertCircle, Grid3X3,
} from 'lucide-react'
import { getTables, getStructure, type TableInfo, type ColumnInfo } from '@/lib/api/database'
import type { DatabaseType } from '@/lib/api/database'

interface Relationship {
  from: { table: string; column: string }
  to: { table: string; column: string }
  constraintName: string
  relationType?: string
}

interface TableNode {
  name: string
  columns: ColumnInfo[]
  x: number
  y: number
  width: number
  height: number
  group?: 'auth' | 'commerce' | 'analytics' | 'core'
}

interface EnhancedSchemaVisualizerProps {
  schema: string
  databaseType: DatabaseType
  projectId?: string
  view?: 'platform' | 'workspace' | 'all'
}

const TABLE_WIDTH = 300
const COL_HEIGHT = 34
const HEADER_HEIGHT = 70
const FOOTER_HEIGHT = 36
const MIN_HEIGHT = 160
const H_GAP = 100
const V_GAP = 80

// ── Data-type icon ────────────────────────────────────────────────────────────
function getTypeIcon(type: string) {
  const t = type.toLowerCase()
  if (t.includes('int') || t.includes('serial') || t.includes('number')) return <Hash className="w-3 h-3" />
  if (t.includes('varchar') || t.includes('text') || t.includes('char')) return <Type className="w-3 h-3" />
  if (t.includes('date') || t.includes('time') || t.includes('timestamp')) return <Clock className="w-3 h-3" />
  if (t.includes('bool')) return <Check className="w-3 h-3" />
  if (t.includes('json')) return <FileText className="w-3 h-3" />
  return <Circle className="w-2.5 h-2.5" />
}

// ── Auto-detect group ─────────────────────────────────────────────────────────
function detectGroup(name: string): TableNode['group'] {
  const l = name.toLowerCase()
  if (l.includes('user') || l.includes('auth') || l.includes('session') || l.includes('role')) return 'auth'
  if (l.includes('product') || l.includes('order') || l.includes('payment') || l.includes('cart')) return 'commerce'
  if (l.includes('analytic') || l.includes('log') || l.includes('metric') || l.includes('event')) return 'analytics'
  return 'core'
}

// Kit-palette group tones — violet / sky / emerald / amber, used semantically
// to code table domains (data-viz, not decoration).
const GROUP_COLORS = {
  auth:      { border: '#a78bfa', bg: '#8b5cf6' },
  commerce:  { border: '#7dd3fc', bg: '#38bdf8' },
  analytics: { border: '#6ee7b7', bg: '#34d399' },
  core:      { border: '#fcd34d', bg: '#f59e0b' },
}

// ── Hierarchical layout (parent tables above children) ───────────────────────
// Uses Kahn's topological sort to assign levels, then centers each level row.
// rel.from = parent (PK table), rel.to = child (FK table)
function buildLayout(
  tables: TableInfo[],
  structures: Map<string, ColumnInfo[]>,
  relationships: Relationship[]
): TableNode[] {
  if (tables.length === 0) return []

  const tableNames = new Set(tables.map(t => t.name))

  // directed edges: parent → children, child → parents
  const childrenMap = new Map<string, Set<string>>()
  const parentsMap  = new Map<string, Set<string>>()
  for (const t of tables) {
    childrenMap.set(t.name, new Set())
    parentsMap.set(t.name, new Set())
  }
  for (const rel of relationships) {
    const parent = rel.from.table
    const child  = rel.to.table
    if (tableNames.has(parent) && tableNames.has(child) && parent !== child) {
      childrenMap.get(parent)?.add(child)
      parentsMap.get(child)?.add(parent)
    }
  }

  // Kahn's topological sort + max-level assignment
  const inDegree = new Map<string, number>()
  for (const t of tables) inDegree.set(t.name, parentsMap.get(t.name)?.size ?? 0)

  const levels = new Map<string, number>()
  const queue: string[] = []
  for (const [name, deg] of inDegree) {
    if (deg === 0) { queue.push(name); levels.set(name, 0) }
  }

  while (queue.length > 0) {
    const cur = queue.shift()!
    const curLevel = levels.get(cur) ?? 0
    for (const child of childrenMap.get(cur) ?? []) {
      const childLevel = levels.get(child) ?? -1
      if (curLevel + 1 > childLevel) levels.set(child, curLevel + 1)
      const newDeg = (inDegree.get(child) ?? 1) - 1
      inDegree.set(child, newDeg)
      if (newDeg === 0) queue.push(child)
    }
  }
  // Any unprocessed nodes (cycles / disconnected) fallback to level 0
  for (const t of tables) { if (!levels.has(t.name)) levels.set(t.name, 0) }

  // Group by level row
  const maxLevel = Math.max(...levels.values(), 0)
  const byLevel: string[][] = Array.from({ length: maxLevel + 1 }, () => [])
  for (const [name, level] of levels) byLevel[level].push(name)

  // Canvas width = widest row
  const maxCols = Math.max(...byLevel.map(r => r.length), 1)
  const canvasWidth = maxCols * (TABLE_WIDTH + H_GAP) + H_GAP

  const nodes: TableNode[] = []
  let currentY = V_GAP

  for (let level = 0; level <= maxLevel; level++) {
    const row = byLevel[level]
    if (row.length === 0) continue

    const rowW  = row.length * TABLE_WIDTH + (row.length - 1) * H_GAP
    const startX = (canvasWidth - rowW) / 2

    let rowMaxH = 0
    row.forEach((name, i) => {
      const columns = structures.get(name) || []
      const height  = Math.max(MIN_HEIGHT, HEADER_HEIGHT + columns.length * COL_HEIGHT + FOOTER_HEIGHT)
      nodes.push({
        name,
        columns,
        x: startX + i * (TABLE_WIDTH + H_GAP),
        y: currentY,
        width: TABLE_WIDTH,
        height,
        group: detectGroup(name),
      })
      if (height > rowMaxH) rowMaxH = height
    })
    currentY += rowMaxH + V_GAP * 2.5
  }

  return nodes
}

// ── Smart orthogonal path ─────────────────────────────────────────────────────
// Connects two points with an elbow. When tables are vertically separated (parent
// above child in hierarchical layout) it routes via the vertical midpoint so
// the lines don't criss-cross horizontally.
function orthogonalPath(x1: number, y1: number, x2: number, y2: number) {
  const dy = Math.abs(y2 - y1)
  const dx = Math.abs(x2 - x1)
  if (dy > dx) {
    // Primarily vertical: go straight down then across (S-bend through midY)
    const midY = (y1 + y2) / 2
    return `M ${x1} ${y1} L ${x1} ${midY} L ${x2} ${midY} L ${x2} ${y2}`
  }
  // Primarily horizontal: classic horizontal elbow
  const midX = (x1 + x2) / 2
  return `M ${x1} ${y1} L ${midX} ${y1} L ${midX} ${y2} L ${x2} ${y2}`
}

export default function EnhancedSchemaVisualizer({
  schema,
  databaseType,
  projectId,
  view = 'workspace',
}: EnhancedSchemaVisualizerProps) {
  const [tables, setTables] = useState<TableInfo[]>([])
  const [structures, setStructures] = useState<Map<string, ColumnInfo[]>>(new Map())
  const [relationships, setRelationships] = useState<Relationship[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [searchTerm, setSearchTerm] = useState('')
  const [focusedTable, setFocusedTable] = useState<string | null>(null)
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [isPanning, setIsPanning] = useState(false)
  const [panStart, setPanStart] = useState({ x: 0, y: 0 })
  const [showMinimap, setShowMinimap] = useState(true)
  const canvasRef = useRef<HTMLDivElement>(null)

  // ── Fetch tables + structures ────────────────────────────────────────────────
  useEffect(() => {
    if (!schema || databaseType !== 'postgresql') return
    let cancelled = false

    async function load() {
      setLoading(true)
      setError(null)
      try {
        const tableList = await getTables(databaseType, schema, { projectId, view })
        if (cancelled) return

        const structureEntries = await Promise.all(
          tableList.map(async (t) => {
            try {
              const cols = await getStructure(databaseType, t.name, schema, { projectId, view })
              return [t.name, cols] as [string, ColumnInfo[]]
            } catch {
              return [t.name, []] as [string, ColumnInfo[]]
            }
          })
        )
        if (cancelled) return

        const structMap = new Map<string, ColumnInfo[]>(structureEntries)
        if (!cancelled) {
          setTables(tableList)
          setStructures(structMap)
        }
      } catch (err: any) {
        if (!cancelled) setError(err.message || 'Failed to load schema')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    load()
    return () => { cancelled = true }
  }, [schema, databaseType, projectId, view])

  // ── Fetch relationships separately so it isn't cancelled by rapid re-renders ─
  useEffect(() => {
    if (!schema || databaseType !== 'postgresql' || !projectId) return
    let cancelled = false

    async function fetchRels() {
      try {
        const url = `/api/database/relationships?schema=${encodeURIComponent(schema)}${projectId ? `&projectId=${encodeURIComponent(projectId)}` : ''}`
        const res = await fetch(url, { credentials: 'include' })
        if (cancelled) return
        if (res.ok) {
          const data = await res.json()
          if (data.success && Array.isArray(data.data)) {
            // Normalize table names to lowercase so they match graph entity names
            // (DB stores quoted table names as PascalCase e.g. "Projects",
            //  but the graph and tableNodes use lowercase "projects")
            const rels = data.data.map((r: any) => ({
              from: { table: r.from.table.toLowerCase(), column: r.from.column },
              to:   { table: r.to.table.toLowerCase(),   column: r.to.column },
              constraintName: r.name,
              relationType: r.relationType,
            }))
            if (!cancelled) setRelationships(rels)
          }
        } else {
          console.warn('Relationships API error:', res.status, await res.text().catch(() => ''))
        }
      } catch (e) {
        console.warn('Could not fetch relationships:', e)
      }
    }

    fetchRels()
    return () => { cancelled = true }
  }, [schema, projectId])

  // ── Pan handlers ────────────────────────────────────────────────────────────
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button === 0 && !e.defaultPrevented) {
      setIsPanning(true)
      setPanStart({ x: e.clientX - pan.x, y: e.clientY - pan.y })
    }
  }, [pan])

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (isPanning) setPan({ x: e.clientX - panStart.x, y: e.clientY - panStart.y })
  }, [isPanning, panStart])

  const handleMouseUp = useCallback(() => setIsPanning(false), [])

  // ── Zoom ────────────────────────────────────────────────────────────────────
  const zoomIn = () => setZoom(z => Math.min(z + 0.15, 2.5))
  const zoomOut = () => setZoom(z => Math.max(z - 0.15, 0.3))
  const zoomReset = () => { setZoom(1); setPan({ x: 0, y: 0 }) }

  // ── Auto-layout reset ───────────────────────────────────────────────────────
  const autoLayout = () => { setZoom(1); setPan({ x: 0, y: 0 }) }

  // ── Loading / error / empty states ──────────────────────────────────────────
  if (loading) return (
    <div className="flex items-center justify-center h-full">
      <div className="flex flex-col items-center gap-3">
        <Loader2 className="w-4 h-4 text-zinc-500 animate-spin" />
        <p className="text-[12px] text-zinc-500">Loading data model…</p>
      </div>
    </div>
  )

  if (error) return (
    <div className="flex items-center justify-center h-full">
      <div className="text-center">
        <AlertCircle className="w-4 h-4 text-rose-300 mx-auto mb-3" />
        <p className="text-[13px] font-semibold text-zinc-200 mb-1">Couldn&apos;t load the data model</p>
        <p className="text-[12px] text-zinc-500">{error}</p>
      </div>
    </div>
  )

  if (tables.length === 0) return (
    <div className="flex items-center justify-center h-full">
      <div className="text-center">
        <DatabaseIcon className="w-4 h-4 text-zinc-600 mx-auto mb-3" />
        <p className="text-[13px] font-semibold text-zinc-200 mb-1">No tables yet</p>
        <p className="text-[12px] text-zinc-500">Tables land here as your agent builds the backend.</p>
      </div>
    </div>
  )

  // ── Build layout ────────────────────────────────────────────────────────────
  const tableNodes = buildLayout(tables, structures, relationships)

  const maxX = Math.max(...tableNodes.map(n => n.x + n.width)) + H_GAP
  const maxY = Math.max(...tableNodes.map(n => n.y + n.height)) + V_GAP

  // ── Filter ──────────────────────────────────────────────────────────────────
  const visibleNodes = searchTerm
    ? tableNodes.filter(n =>
        n.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
        n.columns.some(c => c.name.toLowerCase().includes(searchTerm.toLowerCase()))
      )
    : tableNodes

  const visibleNames = new Set(visibleNodes.map(n => n.name))

  return (
    <div className="h-full w-full relative bg-[#101116]">
      {/* Quiet engineering grid — neutral, near-invisible */}
      <div
        className="absolute inset-0"
        style={{
          backgroundImage: `
            linear-gradient(rgba(255,255,255,0.025) 1px, transparent 1px),
            linear-gradient(90deg, rgba(255,255,255,0.025) 1px, transparent 1px)
          `,
          backgroundSize: '40px 40px',
        }}
      />

      {/* ── Toolbar ──────────────────────────────────────────────────────────── */}
      <div className="absolute top-6 left-6 right-6 z-30 flex items-center justify-between pointer-events-none">
        {/* Left: search + layout */}
        <div className="flex items-center gap-2 pointer-events-auto">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-zinc-600" />
            <input
              type="text"
              placeholder="Search tables or fields…"
              value={searchTerm}
              onChange={e => setSearchTerm(e.target.value)}
              className="h-8 pl-8 pr-8 bg-[#16171d] border border-white/[0.07] rounded-lg text-[12.5px] text-zinc-50 placeholder:text-zinc-600 focus:outline-none focus:border-violet-400/40 focus:ring-2 focus:ring-violet-400/15 w-64 transition-colors shadow-[0_16px_44px_-28px_rgba(0,0,0,0.9)]"
            />
            {searchTerm && (
              <button onClick={() => setSearchTerm('')} className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded-md text-zinc-500 hover:text-zinc-200 hover:bg-white/[0.06] transition-colors">
                <X className="w-3 h-3" />
              </button>
            )}
          </div>

          <button
            onClick={autoLayout}
            className="inline-flex items-center gap-1.5 h-8 px-3 bg-[#16171d] border border-white/[0.07] rounded-lg text-[12px] font-medium text-zinc-200 hover:border-white/[0.14] hover:bg-white/[0.04] transition-colors shadow-[0_16px_44px_-28px_rgba(0,0,0,0.9)]"
          >
            <Grid3X3 className="w-3.5 h-3.5 text-zinc-500" />
            Auto-layout
          </button>
        </div>

        {/* Right: stats + zoom + minimap */}
        <div className="flex items-center gap-2 pointer-events-auto">
          <div className="h-8 bg-[#16171d] border border-white/[0.07] rounded-lg px-3 flex items-center gap-3 shadow-[0_16px_44px_-28px_rgba(0,0,0,0.9)]">
            <span className="inline-flex items-baseline gap-1.5">
              <span className="font-mono text-[12px] font-medium tabular-nums text-zinc-100">{tables.length}</span>
              <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-600">tables</span>
            </span>
            <div className="w-px h-3.5 bg-white/[0.08]" />
            <span className="inline-flex items-baseline gap-1.5">
              <span className="font-mono text-[12px] font-medium tabular-nums text-zinc-100">{relationships.length}</span>
              <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-600">relations</span>
            </span>
          </div>

          <div className="h-8 bg-[#16171d] border border-white/[0.07] rounded-lg p-0.5 flex items-center shadow-[0_16px_44px_-28px_rgba(0,0,0,0.9)]">
            <button onClick={zoomOut} aria-label="Zoom out" className="p-1.5 rounded-md text-zinc-400 hover:text-zinc-100 hover:bg-white/[0.06] transition-colors"><ZoomOut className="w-3.5 h-3.5" /></button>
            <button onClick={zoomReset} title="Reset view" className="px-2 py-1 rounded-md hover:bg-white/[0.06] transition-colors">
              <span className="text-[11px] text-zinc-300 font-mono font-medium tabular-nums">{Math.round(zoom * 100)}%</span>
            </button>
            <button onClick={zoomIn} aria-label="Zoom in" className="p-1.5 rounded-md text-zinc-400 hover:text-zinc-100 hover:bg-white/[0.06] transition-colors"><ZoomIn className="w-3.5 h-3.5" /></button>
          </div>

          <button
            onClick={() => setShowMinimap(v => !v)}
            title={showMinimap ? 'Hide minimap' : 'Show minimap'}
            className="inline-flex items-center justify-center w-8 h-8 bg-[#16171d] border border-white/[0.07] rounded-lg text-zinc-400 hover:text-zinc-100 hover:border-white/[0.14] hover:bg-white/[0.04] transition-colors shadow-[0_16px_44px_-28px_rgba(0,0,0,0.9)]"
          >
            {showMinimap ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
          </button>
        </div>
      </div>

      {/* ── Canvas ────────────────────────────────────────────────────────────── */}
      <div
        ref={canvasRef}
        className="absolute inset-0 overflow-hidden"
        style={{ cursor: isPanning ? 'grabbing' : 'grab' }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onClick={() => setFocusedTable(null)}
      >
        <div
          className="relative"
          style={{
            width: maxX,
            height: maxY,
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
            transformOrigin: '0 0',
            transition: isPanning ? 'none' : 'transform 0.15s ease-out',
          }}
        >
          {/* ── Relationship lines ─────────────────────────────────────────── */}
          <svg className="absolute inset-0 pointer-events-none" style={{ width: maxX, height: maxY, overflow: 'visible' }}>
            <defs>
              <marker id="arrow-fk" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto">
                <path d="M 0 0 L 8 4 L 0 8" stroke="#52525b" strokeWidth="1.5" fill="none" />
              </marker>
              <marker id="arrow-fk-hi" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto">
                <path d="M 0 0 L 8 4 L 0 8" stroke="#a78bfa" strokeWidth="1.5" fill="none" />
              </marker>
              {/* One-side tick */}
              <marker id="tick-one" markerWidth="6" markerHeight="10" refX="0" refY="5" orient="auto">
                <line x1="0" y1="1" x2="0" y2="9" stroke="#52525b" strokeWidth="2" />
              </marker>
              <marker id="tick-one-hi" markerWidth="6" markerHeight="10" refX="0" refY="5" orient="auto">
                <line x1="0" y1="1" x2="0" y2="9" stroke="#a78bfa" strokeWidth="2" />
              </marker>
            </defs>

            {relationships.map((rel, idx) => {
              const fromNode = tableNodes.find(n => n.name === rel.from.table)
              const toNode = tableNodes.find(n => n.name === rel.to.table)
              if (!fromNode || !toNode) return null
              if (!visibleNames.has(fromNode.name) || !visibleNames.has(toNode.name)) return null

              const fromCols = structures.get(fromNode.name) || []
              const toCols = structures.get(toNode.name) || []

              const fromIdx = fromCols.findIndex(c => c.name === rel.from.column)
              const toIdx = toCols.findIndex(c => c.name === rel.to.column)

              const fromColY = fromNode.y + HEADER_HEIGHT + (fromIdx >= 0 ? fromIdx * COL_HEIGHT + COL_HEIGHT / 2 : COL_HEIGHT / 2)
              const toColY   = toNode.y   + HEADER_HEIGHT + (toIdx   >= 0 ? toIdx   * COL_HEIGHT + COL_HEIGHT / 2 : COL_HEIGHT / 2)

              // Choose connection side based on relative position:
              // If parent is clearly above child → connect bottom of parent to top of child
              // Otherwise → connect left/right sides
              const verticalDiff = toNode.y - fromNode.y
              const horizontalDiff = Math.abs(toNode.x - fromNode.x)
              const isMainlyVertical = verticalDiff > 60 && verticalDiff > horizontalDiff * 0.5

              let fromX: number, fromY: number, toX: number, toY: number
              if (isMainlyVertical) {
                // Top-to-bottom connection
                fromX = fromNode.x + fromNode.width / 2
                fromY = fromNode.y + fromNode.height  // bottom edge of parent
                toX   = toNode.x   + toNode.width / 2
                toY   = toNode.y                       // top edge of child
              } else {
                // Left-right connection
                const fromRight = toNode.x > fromNode.x
                fromX = fromRight ? fromNode.x + fromNode.width : fromNode.x
                fromY = fromColY
                toX   = fromRight ? toNode.x : toNode.x + toNode.width
                toY   = toColY
              }

              const path = orthogonalPath(fromX, fromY, toX, toY)

              const isHighlighted = focusedTable === rel.from.table || focusedTable === rel.to.table
              const isDimmed = focusedTable != null && !isHighlighted

              const stroke = isHighlighted ? '#a78bfa' : '#52525b'
              const markerEnd = isHighlighted ? 'url(#arrow-fk-hi)' : 'url(#arrow-fk)'
              const markerStart = isHighlighted ? 'url(#tick-one-hi)' : 'url(#tick-one)'

              return (
                <g key={idx}>
                  <path
                    d={path}
                    stroke={stroke}
                    strokeWidth={isHighlighted ? 1.8 : 1.4}
                    fill="none"
                    opacity={isDimmed ? 0.12 : isHighlighted ? 0.95 : 0.55}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    markerStart={markerStart}
                    markerEnd={markerEnd}
                  />
                  {/* Endpoint dots */}
                  <circle cx={fromX} cy={fromY} r="2.5" fill={stroke} opacity={isDimmed ? 0.12 : 0.9} />
                  <circle cx={toX} cy={toY} r="2.5" fill={stroke} opacity={isDimmed ? 0.12 : 0.9} />
                </g>
              )
            })}
          </svg>

          {/* ── Table cards ────────────────────────────────────────────────── */}
          {visibleNodes.map(node => {
            const fkCols = new Set(
              relationships.filter(r => r.to.table === node.name).map(r => r.to.column)
            )
            const pkCols = node.columns.filter(c => c.primary)
            const isFocused = focusedTable === node.name
            const isDimmed = focusedTable != null && !isFocused
            const isSearchHit = searchTerm && node.name.toLowerCase().includes(searchTerm.toLowerCase())
            const gc = GROUP_COLORS[node.group || 'core']

            return (
              <motion.div
                key={node.name}
                initial={{ opacity: 0, scale: 0.97 }}
                animate={{ opacity: isDimmed ? 0.25 : 1, scale: isFocused ? 1.02 : 1 }}
                transition={{ duration: 0.18 }}
                onClick={e => { e.stopPropagation(); setFocusedTable(isFocused ? null : node.name) }}
                className="absolute rounded-xl shadow-[0_16px_44px_-28px_rgba(0,0,0,0.9)] overflow-hidden cursor-pointer border transition-colors duration-150"
                style={{
                  left: node.x,
                  top: node.y,
                  width: node.width,
                  minHeight: node.height,
                  background: '#16171d',
                  borderColor: isFocused ? gc.border : isSearchHit ? '#fcd34d' : 'rgba(255,255,255,0.07)',
                }}
              >
                {/* Group accent — one thin strip along the top edge */}
                <div className="absolute inset-x-0 top-0 h-[2px]" style={{ backgroundColor: gc.border, opacity: 0.7 }} />

                {/* Header */}
                <div className="px-4 py-3 border-b border-white/[0.06]">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <DatabaseIcon className="w-3.5 h-3.5 flex-shrink-0" style={{ color: gc.border, opacity: 0.8 }} />
                      <h3 className="text-[12.5px] font-semibold text-zinc-100 font-mono truncate">{node.name}</h3>
                    </div>
                    <span className="font-mono text-[10.5px] text-zinc-600 tabular-nums flex-shrink-0">
                      {node.columns.length} fields
                    </span>
                  </div>
                </div>

                {/* Column list */}
                <div className="py-1 overflow-y-auto" style={{ maxHeight: 420 }}>
                  {node.columns.map(col => {
                    const isPk = col.primary
                    const isFk = fkCols.has(col.name)
                    return (
                      <div
                        key={col.name}
                        className="flex items-center justify-between py-1.5 px-3.5 hover:bg-white/[0.025] transition-colors"
                        style={{ minHeight: COL_HEIGHT }}
                      >
                        <div className="flex items-center gap-2 min-w-0 flex-1">
                          <span className={isPk ? 'text-emerald-300/80' : isFk ? 'text-sky-300/80' : 'text-zinc-600'}>
                            {getTypeIcon(col.type)}
                          </span>
                          <span className={`font-mono text-[11.5px] truncate ${isPk ? 'text-emerald-300 font-medium' : isFk ? 'text-sky-300 font-medium' : 'text-zinc-300'}`}>
                            {col.name}
                          </span>
                          <div className="flex items-center gap-1.5 flex-shrink-0">
                            {isPk && <span className="font-mono text-[9px] font-semibold text-emerald-300/70">PK</span>}
                            {isFk && <span className="font-mono text-[9px] font-semibold text-sky-300/70">FK</span>}
                          </div>
                        </div>
                        <span className="text-[10px] text-zinc-600 ml-2 flex-shrink-0 font-mono">
                          {col.type.length > 12 ? col.type.slice(0, 10) + '…' : col.type}
                        </span>
                      </div>
                    )
                  })}
                </div>

                {/* Footer */}
                <div className="px-4 py-2 border-t border-white/[0.06] flex items-center justify-between font-mono text-[10px] text-zinc-600 tabular-nums">
                  <span>{pkCols.length} PK · {fkCols.size} FK</span>
                  <span className="capitalize">{node.group || 'core'}</span>
                </div>
              </motion.div>
            )
          })}
        </div>
      </div>

      {/* ── Minimap ───────────────────────────────────────────────────────────── */}
      <AnimatePresence>
        {showMinimap && (
          <motion.div
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.9 }}
            className="absolute bottom-6 right-6 w-52 h-36 bg-[#16171d] border border-white/[0.07] rounded-xl overflow-hidden z-20 shadow-[0_16px_44px_-28px_rgba(0,0,0,0.9)]"
          >
            <div className="p-3">
              <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-600 mb-2">Minimap</p>
              <div className="relative w-full h-24 bg-white/[0.02] rounded-lg border border-white/[0.06]">
                {tableNodes.map((node, i) => {
                  const scaleX = (52 * 4 - 24) / maxX
                  const scaleY = (96 - 8) / maxY
                  const gc = GROUP_COLORS[node.group || 'core']
                  return (
                    <div
                      key={i}
                      className="absolute rounded-sm cursor-pointer hover:scale-125 transition-transform"
                      style={{
                        left: node.x * scaleX,
                        top: node.y * scaleY,
                        width: Math.max(6, node.width * scaleX),
                        height: Math.max(4, node.height * scaleY),
                        backgroundColor: gc.bg,
                        opacity: focusedTable === node.name ? 1 : 0.4,
                      }}
                      onClick={e => {
                        e.stopPropagation()
                        setFocusedTable(node.name)
                        setPan({ x: -node.x * zoom + 300, y: -node.y * zoom + 200 })
                      }}
                    />
                  )
                })}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Legend ────────────────────────────────────────────────────────────── */}
      <div className="absolute bottom-6 left-6 bg-[#16171d] border border-white/[0.07] rounded-xl px-3.5 py-3 z-20 shadow-[0_16px_44px_-28px_rgba(0,0,0,0.9)]">
        <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-600 mb-2">Groups</p>
        <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
          {Object.entries(GROUP_COLORS).map(([key, c]) => (
            <div key={key} className="flex items-center gap-1.5">
              <span className="h-[5px] w-[5px] rounded-full" style={{ backgroundColor: c.border }} />
              <span className="font-mono text-[10.5px] text-zinc-400 capitalize">{key}</span>
            </div>
          ))}
        </div>
        {relationships.length > 0 && (
          <div className="mt-2.5 pt-2 border-t border-white/[0.06] flex items-center gap-1.5">
            <div className="w-5 h-px bg-zinc-600" />
            <span className="font-mono text-[10.5px] text-zinc-500">FK relation</span>
          </div>
        )}
      </div>
    </div>
  )
}
