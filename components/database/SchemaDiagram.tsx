'use client'

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import {
  Table2, Key, Link2, Search, ZoomIn, ZoomOut, RotateCcw,
  Maximize2, Minimize2, Layers, ArrowRight, Shield, X,
  Rows, Compass, Map as MapIcon, Eye, EyeOff, Target
} from 'lucide-react'
import {
  getTables, getStructure, getRelationships,
  type TableInfo, type ColumnInfo, type DatabaseType
} from '@/lib/api/database'
import { EmptyState, Spinner } from '@/components/inspector/kit'

// ── Types ───────────────────────────────────────────────────────────────────

export interface SchemaDiagramProps {
  projectId?: string
  activeSchema: string
  activeTable?: string | null
  databaseType?: DatabaseType
  isFullscreen?: boolean
  onToggleFullscreen?: () => void
  onSelectTable?: (tableName: string) => void
  onOpenTableData?: (tableName: string) => void
}

interface TableNode {
  name: string
  columns: ColumnInfo[]
  rowsCount: number
  hasRls?: boolean
  x: number
  y: number
  width: number
  height: number
  domain?: 'auth' | 'commerce' | 'analytics' | 'core'
}

interface GraphRelationship {
  id: string
  sourceTable: string
  sourceColumn: string
  targetTable: string
  targetColumn: string
  constraintName?: string
}

const CARD_WIDTH = 280
const HEADER_HEIGHT = 44
const COLUMN_HEIGHT = 28
const FOOTER_HEIGHT = 28
const H_SPACING = 110
const V_SPACING = 70

// ── Domain Themes (Color Tokens & Badges) ───────────────────────────────────

export const DOMAIN_THEMES = {
  auth: {
    accent: '#a78bfa',
    border: 'border-violet-500/30',
    bgBadge: 'border-violet-500/30 bg-violet-500/10 text-violet-300',
    strip: 'from-violet-500 via-purple-400 to-indigo-500',
    dot: '#a78bfa',
    label: 'Auth & Identity',
  },
  commerce: {
    accent: '#38bdf8',
    border: 'border-sky-500/30',
    bgBadge: 'border-sky-500/30 bg-sky-500/10 text-sky-300',
    strip: 'from-sky-500 via-cyan-400 to-blue-500',
    dot: '#38bdf8',
    label: 'Commerce & Data',
  },
  analytics: {
    accent: '#34d399',
    border: 'border-emerald-500/30',
    bgBadge: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
    strip: 'from-emerald-500 via-teal-400 to-emerald-600',
    dot: '#34d399',
    label: 'Audit & Logs',
  },
  core: {
    accent: '#f59e0b',
    border: 'border-amber-500/30',
    bgBadge: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
    strip: 'from-amber-500 via-orange-400 to-amber-600',
    dot: '#f59e0b',
    label: 'Core & Config',
  },
} as const



function detectDomain(name: string): TableNode['domain'] {
  const l = name.toLowerCase()
  if (l.includes('user') || l.includes('auth') || l.includes('session') || l.includes('account') || l.includes('profile')) return 'auth'
  if (l.includes('product') || l.includes('order') || l.includes('item') || l.includes('cart') || l.includes('payment') || l.includes('category') || l.includes('invoice')) return 'commerce'
  if (l.includes('log') || l.includes('audit') || l.includes('metric') || l.includes('event') || l.includes('history')) return 'analytics'
  return 'core'
}

/** Compute hierarchical top-down layout (parent tables like users at the top) */
function calculateLayout(
  tables: TableInfo[],
  columnsMap: Map<string, ColumnInfo[]>,
  relationships: GraphRelationship[]
): Map<string, { x: number; y: number; width: number; height: number }> {
  const positions = new Map<string, { x: number; y: number; width: number; height: number }>()
  if (tables.length === 0) return positions

  const tableNames = new Set(tables.map((t) => t.name))

  // Directed edges: parentTable -> children, childTable -> parents
  const childrenMap = new Map<string, Set<string>>()
  const parentsMap = new Map<string, Set<string>>()
  for (const t of tables) {
    childrenMap.set(t.name, new Set())
    parentsMap.set(t.name, new Set())
  }

  for (const rel of relationships) {
    let parent = rel.targetTable
    let child = rel.sourceTable

    // Detect direction using column metadata if available
    const srcCols = columnsMap.get(rel.sourceTable) || []
    const tgtCols = columnsMap.get(rel.targetTable) || []
    const srcIsFk =
      srcCols.find((c) => c.name === rel.sourceColumn)?.foreign ||
      rel.sourceColumn.endsWith('_id') ||
      rel.sourceColumn.includes('Id')
    const tgtIsFk =
      tgtCols.find((c) => c.name === rel.targetColumn)?.foreign ||
      rel.targetColumn.endsWith('_id') ||
      rel.targetColumn.includes('Id')

    if (tgtIsFk && !srcIsFk) {
      parent = rel.sourceTable
      child = rel.targetTable
    }

    if (tableNames.has(parent) && tableNames.has(child) && parent !== child) {
      childrenMap.get(parent)?.add(child)
      parentsMap.get(child)?.add(parent)
    }
  }

  // Kahn's topological sort + max-level assignment
  const inDegree = new Map<string, number>()
  for (const t of tables) {
    inDegree.set(t.name, parentsMap.get(t.name)?.size ?? 0)
  }

  const levels = new Map<string, number>()
  const queue: string[] = []

  // Tables with inDegree 0 (no parents: users, categories, root tables) start at Level 0
  for (const [name, deg] of inDegree) {
    if (deg === 0) {
      queue.push(name)
      levels.set(name, 0)
    }
  }

  while (queue.length > 0) {
    const cur = queue.shift()!
    const curLevel = levels.get(cur) ?? 0
    for (const child of childrenMap.get(cur) ?? []) {
      const childLevel = levels.get(child) ?? -1
      if (curLevel + 1 > childLevel) {
        levels.set(child, curLevel + 1)
      }
      const newDeg = (inDegree.get(child) ?? 1) - 1
      inDegree.set(child, newDeg)
      if (newDeg === 0) {
        queue.push(child)
      }
    }
  }

  // Fallback for cycle / disconnected nodes to Level 0
  for (const t of tables) {
    if (!levels.has(t.name)) {
      levels.set(t.name, 0)
    }
  }

  // Group by hierarchical level row
  const maxLevel = Math.max(...levels.values(), 0)
  const byLevel: string[][] = Array.from({ length: maxLevel + 1 }, () => [])
  for (const [name, level] of levels) {
    byLevel[level].push(name)
  }

  // Sort each level row: in Level 0, ensure 'users' / auth tables come first
  byLevel.forEach((row, lvl) => {
    row.sort((a, b) => {
      if (lvl === 0) {
        const aIsUser = a.toLowerCase().includes('user') || a.toLowerCase().includes('auth')
        const bIsUser = b.toLowerCase().includes('user') || b.toLowerCase().includes('auth')
        if (aIsUser && !bIsUser) return -1
        if (!aIsUser && bIsUser) return 1
      }
      return a.localeCompare(b)
    })
  })

  // Center each level horizontally across the canvas
  const H_GAP = 90
  const V_GAP = 120
  const START_Y = 60

  const rowWidths = byLevel.map(
    (row) => row.length * CARD_WIDTH + Math.max(0, row.length - 1) * H_GAP
  )
  const maxCanvasWidth = Math.max(...rowWidths, CARD_WIDTH)

  let currentY = START_Y

  for (let level = 0; level <= maxLevel; level++) {
    const row = byLevel[level]
    if (row.length === 0) continue

    const rowW = rowWidths[level]
    const startX = Math.max(60, Math.round((maxCanvasWidth - rowW) / 2) + 60)

    let rowMaxHeight = 0

    row.forEach((tableName, i) => {
      const cols = columnsMap.get(tableName) || []
      const cardHeight = HEADER_HEIGHT + Math.max(1, cols.length) * COLUMN_HEIGHT + FOOTER_HEIGHT

      positions.set(tableName, {
        x: Math.round(startX + i * (CARD_WIDTH + H_GAP)),
        y: Math.round(currentY),
        width: CARD_WIDTH,
        height: cardHeight,
      })

      if (cardHeight > rowMaxHeight) {
        rowMaxHeight = cardHeight
      }
    })

    currentY += rowMaxHeight + V_GAP
  }

  return positions
}

// ── Interactive Floating MiniMap Component ──────────────────────────────────

interface SchemaMinimapProps {
  tables: TableInfo[]
  nodePositions: Map<string, { x: number; y: number; width: number; height: number }>
  pan: { x: number; y: number }
  zoom: number
  containerSize: { width: number; height: number }
  setPan: React.Dispatch<React.SetStateAction<{ x: number; y: number }>>
  hoveredTable: string | null
  setHoveredTable: (name: string | null) => void
  activeTable?: string | null
  focusCluster?: {
    root: string
    firstDegree: Set<string>
    secondDegree: Set<string>
    allConnected: Set<string>
  } | null
  filteredTableNames: Set<string> | null
  onClose: () => void
  onSelectTable?: (tableName: string) => void
}

function SchemaMinimap({
  tables,
  nodePositions,
  pan,
  zoom,
  containerSize,
  setPan,
  hoveredTable,
  setHoveredTable,
  activeTable,
  focusCluster,
  filteredTableNames,
  onClose,
  onSelectTable,
}: SchemaMinimapProps) {
  const miniCanvasRef = useRef<HTMLDivElement>(null)
  const isDraggingViewfinder = useRef(false)
  const dragStartRef = useRef<{ clientX: number; clientY: number; startPanX: number; startPanY: number } | null>(null)

  const MINI_WIDTH = 216
  const MINI_HEIGHT = 116
  const MARGIN = 60

  // Bounding box of canvas world
  const bounds = useMemo(() => {
    if (tables.length === 0) return { minX: 0, maxX: 1200, minY: 0, maxY: 800, worldW: 1200, worldH: 800 }
    const xs = tables.map((t) => nodePositions.get(t.name)?.x ?? 0)
    const ys = tables.map((t) => nodePositions.get(t.name)?.y ?? 0)
    const minX = Math.min(...xs, 0) - MARGIN
    const maxX = Math.max(...xs.map((x) => x + CARD_WIDTH), 1000) + MARGIN
    const minY = Math.min(...ys, 0) - MARGIN
    const maxY = Math.max(...ys.map((y) => y + 260), 700) + MARGIN
    return {
      minX,
      maxX,
      minY,
      maxY,
      worldW: Math.max(1, maxX - minX),
      worldH: Math.max(1, maxY - minY),
    }
  }, [tables, nodePositions])

  // Uniform scale to preserve aspect ratio
  const scale = useMemo(() => {
    const scaleX = (MINI_WIDTH - 16) / bounds.worldW
    const scaleY = (MINI_HEIGHT - 16) / bounds.worldH
    return Math.min(scaleX, scaleY)
  }, [bounds, MINI_WIDTH, MINI_HEIGHT])

  const offX = Math.max(0, (MINI_WIDTH - bounds.worldW * scale) / 2)
  const offY = Math.max(0, (MINI_HEIGHT - bounds.worldH * scale) / 2)

  // Visible viewport dimensions in canvas coordinates
  const containerW = containerSize.width || 900
  const containerH = containerSize.height || 650

  const viewX1 = -pan.x / zoom
  const viewY1 = -pan.y / zoom
  const viewW = containerW / zoom
  const viewH = containerH / zoom

  // Viewfinder position in minimap
  const viewMiniX = offX + (viewX1 - bounds.minX) * scale
  const viewMiniY = offY + (viewY1 - bounds.minY) * scale
  const viewMiniW = Math.max(14, Math.min(MINI_WIDTH, viewW * scale))
  const viewMiniH = Math.max(10, Math.min(MINI_HEIGHT, viewH * scale))

  // Dragging viewfinder
  const handleViewfinderPointerDown = (e: React.PointerEvent) => {
    e.stopPropagation()
    isDraggingViewfinder.current = true
    dragStartRef.current = {
      clientX: e.clientX,
      clientY: e.clientY,
      startPanX: pan.x,
      startPanY: pan.y,
    }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }

  const handleViewfinderPointerMove = (e: React.PointerEvent) => {
    if (!isDraggingViewfinder.current || !dragStartRef.current) return
    const dx = e.clientX - dragStartRef.current.clientX
    const dy = e.clientY - dragStartRef.current.clientY

    const deltaCanvasX = dx / scale
    const deltaCanvasY = dy / scale

    setPan({
      x: Math.round(dragStartRef.current.startPanX - deltaCanvasX * zoom),
      y: Math.round(dragStartRef.current.startPanY - deltaCanvasY * zoom),
    })
  }

  const handleViewfinderPointerUp = (e: React.PointerEvent) => {
    if (isDraggingViewfinder.current) {
      isDraggingViewfinder.current = false
      dragStartRef.current = null
      try {
        ;(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
      } catch {
        // safe ignore
      }
    }
  }

  // Click on background to jump camera
  const handleMinimapClick = (e: React.MouseEvent) => {
    if (isDraggingViewfinder.current) return
    const rect = miniCanvasRef.current?.getBoundingClientRect()
    if (!rect) return

    const clickX = e.clientX - rect.left
    const clickY = e.clientY - rect.top

    const targetCanvasX = bounds.minX + (clickX - offX) / scale
    const targetCanvasY = bounds.minY + (clickY - offY) / scale

    setPan({
      x: Math.round(containerW / 2 - targetCanvasX * zoom),
      y: Math.round(containerH / 2 - targetCanvasY * zoom),
    })
  }

  return (
    <div className="w-[236px] rounded-xl border border-white/[0.08] bg-[#0f1012]/92 p-2.5 shadow-2xl backdrop-blur-md transition-[opacity,transform] duration-200 select-none">
      {/* Header */}
      <div className="flex items-center justify-between pb-2 border-b border-white/[0.06] text-zinc-300">
        <div className="flex items-center gap-1.5 font-mono text-[11px] font-semibold text-zinc-200">
          <Compass className="h-3.5 w-3.5 text-violet-400" />
          <span>MiniMap</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="font-mono text-[10px] text-zinc-500 tabular-nums">
            {Math.round(zoom * 100)}%
          </span>
          <kbd
            title="Press 'M' to toggle"
            className="flex h-4 items-center justify-center rounded border border-white/[0.08] bg-white/[0.04] px-1 font-mono text-[9px] text-zinc-400"
          >
            M
          </kbd>
          <button
            type="button"
            onClick={onClose}
            title="Minimize (M)"
            className="flex h-5 w-5 items-center justify-center rounded text-zinc-400 hover:text-white hover:bg-white/[0.08] transition-colors"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      </div>

      {/* Mini Canvas Area */}
      <div
        ref={miniCanvasRef}
        onClick={handleMinimapClick}
        style={{ width: MINI_WIDTH, height: MINI_HEIGHT }}
        className="relative mt-2 rounded-lg border border-white/[0.06] bg-[#0c0d0f]/90 overflow-hidden cursor-crosshair"
      >
        {/* Subtle grid dots */}
        <div
          className="absolute inset-0 pointer-events-none opacity-40"
          style={{
            backgroundImage: `radial-gradient(rgba(255, 255, 255, 0.15) 1px, transparent 1px)`,
            backgroundSize: '12px 12px',
          }}
        />

        {/* Scaled Table Node Rectangles */}
        {tables.map((t) => {
          const p = nodePositions.get(t.name) || { x: 0, y: 0, width: CARD_WIDTH, height: 200 }
          const d = detectDomain(t.name)
          const isSelected = activeTable === t.name
          const isHovered = hoveredTable === t.name
          const isMatched = filteredTableNames != null && filteredTableNames.has(t.name)

          const isFocusRoot = focusCluster?.root === t.name
          const isFocusFirst = focusCluster?.firstDegree.has(t.name)
          const isFocusSecond = focusCluster?.secondDegree.has(t.name)
          const isFocusUnrelated = focusCluster != null && !focusCluster.allConnected.has(t.name)

          const mx = offX + (p.x - bounds.minX) * scale
          const my = offY + (p.y - bounds.minY) * scale
          const mw = Math.max(8, p.width * scale)
          const mh = Math.max(6, p.height * scale)

          let stateStyle = 'opacity-75 hover:opacity-100'
          if (isFocusRoot) {
            stateStyle = 'ring-2 ring-white z-20 opacity-100 shadow-[0_0_8px_rgba(255,255,255,0.6)] scale-110'
          } else if (isFocusFirst) {
            stateStyle = 'ring-1.5 ring-violet-400 z-10 opacity-100 shadow-[0_0_6px_rgba(167,139,250,0.5)]'
          } else if (isFocusSecond) {
            stateStyle = 'opacity-80'
          } else if (isFocusUnrelated) {
            stateStyle = 'opacity-[0.15]'
          } else if (isSelected || isHovered) {
            stateStyle = 'ring-2 ring-white z-20 opacity-100 shadow-[0_0_8px_rgba(255,255,255,0.4)]'
          } else if (isMatched) {
            stateStyle = 'ring-2 ring-violet-400 z-10 opacity-100 shadow-[0_0_8px_rgba(167,139,250,0.5)]'
          }

          return (
            <div
              key={t.name}
              onClick={(e) => {
                e.stopPropagation()
                const centerTableX = p.x + p.width / 2
                const centerTableY = p.y + p.height / 2
                setPan({
                  x: Math.round(containerW / 2 - centerTableX * zoom),
                  y: Math.round(containerH / 2 - centerTableY * zoom),
                })
                setHoveredTable(t.name)
                onSelectTable?.(t.name)
              }}
              title={`${t.name}${isFocusRoot ? ' (Focused)' : isFocusFirst ? ' (1st-degree)' : isFocusSecond ? ' (2nd-degree)' : ''}`}
              style={{
                left: `${mx}px`,
                top: `${my}px`,
                width: `${mw}px`,
                height: `${mh}px`,
                backgroundColor: DOMAIN_THEMES[d].accent,
              }}
              className={`absolute rounded-[2px] cursor-pointer transition-[transform,box-shadow,opacity] hover:scale-110 ${stateStyle}`}
            />
          )
        })}

        {/* Live Interactive Viewfinder (Camera Viewport) */}
        <div
          onPointerDown={handleViewfinderPointerDown}
          onPointerMove={handleViewfinderPointerMove}
          onPointerUp={handleViewfinderPointerUp}
          title="Drag to pan canvas"
          style={{
            left: `${viewMiniX}px`,
            top: `${viewMiniY}px`,
            width: `${viewMiniW}px`,
            height: `${viewMiniH}px`,
          }}
          className="absolute z-30 rounded-[3px] border border-violet-400/80 bg-violet-500/[0.12] shadow-[0_0_12px_rgba(167,139,250,0.25)] cursor-grab active:cursor-grabbing hover:bg-violet-500/[0.18] transition-colors"
        >
          <div className="absolute top-1 right-1 h-1.5 w-1.5 rounded-full bg-violet-400/90" />
        </div>
      </div>

      {/* Mini Helper Footer */}
      <div className="mt-1.5 flex items-center justify-between text-[9.5px] font-mono text-zinc-500">
        <span>Click to jump</span>
        <span>Drag to pan</span>
      </div>
    </div>
  )
}

// ── Main Component ──────────────────────────────────────────────────────────

export function SchemaDiagram({
  projectId,
  activeSchema,
  activeTable,
  databaseType = 'postgresql',
  isFullscreen = false,
  onToggleFullscreen,
  onSelectTable,
  onOpenTableData,
}: SchemaDiagramProps) {
  const containerRef = useRef<HTMLDivElement>(null)

  const [loading, setLoading] = useState(true)
  const [tables, setTables] = useState<TableInfo[]>([])
  const [columnsMap, setColumnsMap] = useState<Map<string, ColumnInfo[]>>(new Map())
  const [relationships, setRelationships] = useState<GraphRelationship[]>([])

  // Layout & positioning
  const [nodePositions, setNodePositions] = useState<Map<string, { x: number; y: number; width: number; height: number }>>(new Map())
  const initialPositionsRef = useRef<Map<string, { x: number; y: number; width: number; height: number }>>(new Map())

  // Viewport transforms (pan & zoom clamped 0.5x to 1.75x)
  const [pan, setPan] = useState({ x: 40, y: 40 })
  const [zoom, setZoom] = useState(1)
  const [isPanning, setIsPanning] = useState(false)
  const panStartRef = useRef({ x: 0, y: 0 })

  // Dragging individual card
  const [draggingNode, setDraggingNode] = useState<string | null>(null)
  const dragStartRef = useRef<{ clientX: number; clientY: number; nodeX: number; nodeY: number } | null>(null)

  // Hover highlights & Relationship Focus Mode
  const [hoveredRelId, setHoveredRelId] = useState<string | null>(null)
  const [hoveredTable, setHoveredTable] = useState<string | null>(null)
  const [focusedTableId, setFocusedTableId] = useState<string | null>(null)
  const [searchTerm, setSearchTerm] = useState('')
  const searchInputRef = useRef<HTMLInputElement>(null)

  // Panels & overlays (remember open state in localStorage)
  const [showMinimap, setShowMinimap] = useState(() => {
    if (typeof window !== 'undefined') {
      try {
        const stored = localStorage.getItem('backenly_schema_minimap_open')
        return stored !== null ? stored === 'true' : true
      } catch {}
    }
    return true
  })
  const [showLegend, setShowLegend] = useState(true)
  const [containerSize, setContainerSize] = useState({ width: 900, height: 650 })

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const updateSize = () => {
      if (el.clientWidth && el.clientHeight) {
        setContainerSize({ width: el.clientWidth, height: el.clientHeight })
      }
    }
    updateSize()
    const ro = new ResizeObserver(updateSize)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const toggleMinimap = useCallback(() => {
    setShowMinimap((prev) => {
      const next = !prev
      try {
        localStorage.setItem('backenly_schema_minimap_open', String(next))
      } catch {}
      return next
    })
  }, [])

  // Keyboard shortcuts: 'Cmd+F'/'Ctrl+F' or '/' for search, 'M' for minimap, 'Escape' to clear focus
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Cmd+F or Ctrl+F anywhere in the schema map triggers table search
      if ((e.metaKey || e.ctrlKey) && (e.key === 'f' || e.key === 'F')) {
        e.preventDefault()
        searchInputRef.current?.focus()
        searchInputRef.current?.select()
        return
      }

      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        (e.target as HTMLElement)?.isContentEditable
      ) {
        if (e.key === 'Escape') {
          searchInputRef.current?.blur()
        }
        return
      }

      // 'F' key (without Cmd/Ctrl/Alt) toggles fullscreen in schema tab
      if (!e.metaKey && !e.ctrlKey && !e.altKey && (e.key === 'f' || e.key === 'F')) {
        e.preventDefault()
        onToggleFullscreen?.()
        return
      }

      if (e.key === 'm' || e.key === 'M') {
        e.preventDefault()
        toggleMinimap()
      } else if (e.key === '/') {
        e.preventDefault()
        searchInputRef.current?.focus()
      } else if (e.key === 'Escape') {
        if (focusedTableId) {
          setFocusedTableId(null)
        } else if (searchTerm) {
          setSearchTerm('')
        } else if (isFullscreen) {
          onToggleFullscreen?.()
        }
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [toggleMinimap, onToggleFullscreen, isFullscreen, focusedTableId, searchTerm])

  // ── Data Fetching ─────────────────────────────────────────────────────────

  const loadData = useCallback(async () => {
    setLoading(true)

    const applyLayout = (
      tbls: TableInfo[],
      cMap: Map<string, ColumnInfo[]>,
      rels: GraphRelationship[]
    ) => {
      const layout = calculateLayout(tbls, cMap, rels)
      initialPositionsRef.current = new Map(layout)
      setNodePositions(layout)
    }

    try {
      const dbType = databaseType || 'postgresql'
      const targetSchema = activeSchema || 'public'

      // Live fetch
      const fetchedTables = await getTables(dbType, targetSchema, { projectId: projectId || undefined })
      if (!fetchedTables || fetchedTables.length === 0) {
        setTables([])
        setColumnsMap(new Map())
        setRelationships([])
        setNodePositions(new Map())
        return
      }

      setTables(fetchedTables)

      // Concurrently fetch columns & relationships
      const cMap = new Map<string, ColumnInfo[]>()
      const allRels: GraphRelationship[] = []

      await Promise.all(
        fetchedTables.map(async (t) => {
          try {
            const cols = await getStructure(dbType, t.name, targetSchema, { projectId: projectId || undefined })
            cMap.set(t.name, cols || [])
          } catch {
            cMap.set(t.name, [])
          }

          try {
            const rels = await getRelationships(targetSchema, t.name, { projectId: projectId || undefined })
            if (Array.isArray(rels)) {
              rels.forEach((r, idx) => {
                if (r?.from?.table && r?.to?.table) {
                  // r.from is referenced PK table (parent), r.to is referencing FK table (child)
                  allRels.push({
                    id: `${r.from.table}_${r.from.column}_to_${r.to.table}_${r.to.column}_${idx}`,
                    sourceTable: r.to.table,
                    sourceColumn: r.to.column,
                    targetTable: r.from.table,
                    targetColumn: r.from.column,
                    constraintName: r.name,
                  })
                }
              })
            }
          } catch {
            // Ignore relationship query errors if schema doesn't have FKs
          }
        })
      )

      setColumnsMap(cMap)
      setRelationships(allRels)
      applyLayout(fetchedTables, cMap, allRels)
    } catch (err) {
      console.error('Failed to load schema diagram data:', err)
      setTables([])
      setColumnsMap(new Map())
      setRelationships([])
      setNodePositions(new Map())
    } finally {
      setLoading(false)
    }
  }, [activeSchema, databaseType, projectId])

  useEffect(() => {
    let unmounted = false
    Promise.resolve().then(() => {
      if (!unmounted) void loadData()
    })
    return () => {
      unmounted = true
    }
  }, [loadData])

  // ── Pan Handlers ──────────────────────────────────────────────────────────

  const handleCanvasPointerDown = (e: React.PointerEvent) => {
    if (e.button === 0 && (e.target as HTMLElement).dataset.canvasSurface) {
      setFocusedTableId(null)
      setIsPanning(true)
      panStartRef.current = { x: e.clientX - pan.x, y: e.clientY - pan.y }
      ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    }
  }

  const handleCanvasPointerMove = (e: React.PointerEvent) => {
    if (isPanning) {
      setPan({
        x: e.clientX - panStartRef.current.x,
        y: e.clientY - panStartRef.current.y,
      })
    } else if (draggingNode && dragStartRef.current) {
      const dx = (e.clientX - dragStartRef.current.clientX) / zoom
      const dy = (e.clientY - dragStartRef.current.clientY) / zoom

      setNodePositions((prev) => {
        const next = new Map(prev)
        const current = next.get(draggingNode)
        if (current && dragStartRef.current) {
          next.set(draggingNode, {
            ...current,
            x: Math.round(dragStartRef.current.nodeX + dx),
            y: Math.round(dragStartRef.current.nodeY + dy),
          })
        }
        return next
      })
    }
  }

  const handleCanvasPointerUp = (e: React.PointerEvent) => {
    if (isPanning) {
      setIsPanning(false)
      try {
        ;(e.target as HTMLElement).releasePointerCapture(e.pointerId)
      } catch {
        // Safe ignore
      }
    }
    if (draggingNode) {
      setDraggingNode(null)
      dragStartRef.current = null
    }
  }

  // ── Wheel Zoom with cursor center ─────────────────────────────────────────

  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault()
    const zoomFactor = e.deltaY < 0 ? 1.08 : 0.92
    setZoom((prev) => Math.min(1.75, Math.max(0.5, prev * zoomFactor)))
  }

  // ── Node Drag Handlers ────────────────────────────────────────────────────

  const startDraggingNode = (e: React.PointerEvent, tableName: string) => {
    e.stopPropagation()
    const current = nodePositions.get(tableName)
    if (!current) return

    setDraggingNode(tableName)
    dragStartRef.current = {
      clientX: e.clientX,
      clientY: e.clientY,
      nodeX: current.x,
      nodeY: current.y,
    }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }

  const stopDraggingNode = (e: React.PointerEvent) => {
    if (draggingNode) {
      setDraggingNode(null)
      dragStartRef.current = null
      try {
        ;(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
      } catch {
        // Safe ignore
      }
    }
  }

  // ── Viewport Controls ─────────────────────────────────────────────────────

  const handleZoomIn = () => setZoom((z) => Math.min(1.75, z + 0.15))
  const handleZoomOut = () => setZoom((z) => Math.max(0.5, z - 0.15))

  const handleReset = () => {
    setDraggingNode(null)
    dragStartRef.current = null
    setIsPanning(false)
    setZoom(1)
    setPan({ x: 40, y: 40 })

    if (initialPositionsRef.current.size > 0) {
      setNodePositions(new Map(initialPositionsRef.current))
    } else {
      const layout = calculateLayout(tables, columnsMap, relationships)
      initialPositionsRef.current = new Map(layout)
      setNodePositions(layout)
    }
  }

  const handleAutoLayout = () => {
    const layout = calculateLayout(tables, columnsMap, relationships)
    initialPositionsRef.current = new Map(layout)
    setNodePositions(layout)
    setDraggingNode(null)
    dragStartRef.current = null
    setIsPanning(false)
    setZoom(1)
    setPan({ x: 40, y: 40 })
  }

  // ── Relationship Focus Mode Graph Traversal ──────────────────────────────
  const adjacencyMap = useMemo(() => {
    const map = new Map<string, Set<string>>()
    for (const t of tables) {
      map.set(t.name, new Set())
    }
    for (const rel of relationships) {
      if (rel.sourceTable && rel.targetTable && rel.sourceTable !== rel.targetTable) {
        map.get(rel.sourceTable)?.add(rel.targetTable)
        map.get(rel.targetTable)?.add(rel.sourceTable)
      }
    }
    return map
  }, [tables, relationships])

  // Relationship Focus Mode root entity (activated ONLY when pinned via table click/selection, NOT on hover)
  const effectiveFocusTable = focusedTableId || null

  const focusCluster = useMemo(() => {
    if (!effectiveFocusTable) return null

    const firstDegree = new Set<string>()
    const secondDegree = new Set<string>()
    const allConnected = new Set<string>([effectiveFocusTable])

    const directNeighbors = adjacencyMap.get(effectiveFocusTable)
    if (directNeighbors) {
      for (const neighbor of directNeighbors) {
        firstDegree.add(neighbor)
        allConnected.add(neighbor)
      }
    }

    for (const neighbor of firstDegree) {
      const secondary = adjacencyMap.get(neighbor)
      if (secondary) {
        for (const n2 of secondary) {
          if (n2 !== effectiveFocusTable && !firstDegree.has(n2)) {
            secondDegree.add(n2)
            allConnected.add(n2)
          }
        }
      }
    }

    return {
      root: effectiveFocusTable,
      firstDegree,
      secondDegree,
      allConnected,
    }
  }, [effectiveFocusTable, adjacencyMap])

  // ── Search & Field Filter Matching ('/' prefix for columns) ───────────────
  const isFieldSearch = searchTerm.trim().startsWith('/')

  const { filteredTableNames, matchedColumnsMap } = useMemo(() => {
    const trimmed = searchTerm.trim()
    if (!trimmed) {
      return { filteredTableNames: null, matchedColumnsMap: new Map<string, Set<string>>() }
    }

    const isField = trimmed.startsWith('/')
    const query = isField ? trimmed.slice(1).trim().toLowerCase() : trimmed.toLowerCase()

    if (!query) {
      return { filteredTableNames: null, matchedColumnsMap: new Map<string, Set<string>>() }
    }

    const matchedTables = new Set<string>()
    const colMatches = new Map<string, Set<string>>()

    if (isField) {
      // Field search mode: search field/column names only
      for (const t of tables) {
        const cols = columnsMap.get(t.name) || []
        const hits = cols.filter((c) => c.name.toLowerCase().includes(query))
        if (hits.length > 0) {
          matchedTables.add(t.name)
          colMatches.set(t.name, new Set(hits.map((c) => c.name)))
        }
      }
    } else {
      // Table search mode: search table names only (do NOT match column names)
      for (const t of tables) {
        if (t.name.toLowerCase().includes(query)) {
          matchedTables.add(t.name)
        }
      }
    }

    return { filteredTableNames: matchedTables, matchedColumnsMap: colMatches }
  }, [searchTerm, tables, columnsMap])

  // ── Calculate SVG Connectors ──────────────────────────────────────────────
  const renderedEdges = useMemo(() => {
    return relationships
      .map((rel) => {
        const srcCols = columnsMap.get(rel.sourceTable) || []
        const tgtCols = columnsMap.get(rel.targetTable) || []

        const srcIsFk =
          srcCols.find((c) => c.name === rel.sourceColumn)?.foreign ||
          rel.sourceColumn.endsWith('_id') ||
          rel.sourceColumn.includes('Id')
        const tgtIsFk =
          tgtCols.find((c) => c.name === rel.targetColumn)?.foreign ||
          rel.targetColumn.endsWith('_id') ||
          rel.targetColumn.includes('Id')

        let childTable = rel.sourceTable
        let childCol = rel.sourceColumn
        let parentTable = rel.targetTable
        let parentCol = rel.targetColumn

        if (tgtIsFk && !srcIsFk) {
          childTable = rel.targetTable
          childCol = rel.targetColumn
          parentTable = rel.sourceTable
          parentCol = rel.sourceColumn
        }

        const parentPos = nodePositions.get(parentTable)
        const childPos = nodePositions.get(childTable)
        if (!parentPos || !childPos) return null

        const parentCols = columnsMap.get(parentTable) || []
        const childCols = columnsMap.get(childTable) || []

        const parentColIdx = Math.max(0, parentCols.findIndex((c) => c.name === parentCol))
        const childColIdx = Math.max(0, childCols.findIndex((c) => c.name === childCol))

        let startX: number
        let startY: number
        let endX: number
        let endY: number
        let pathData: string

        // Check if vertically arranged (parent clearly above or below child)
        const isParentAbove = parentPos.y + parentPos.height + 25 <= childPos.y
        const isChildAbove = childPos.y + childPos.height + 25 <= parentPos.y

        if (isParentAbove) {
          // Parent on top, Child below: route from parent bottom down to child top
          const parentRatio = parentCols.length > 1 ? parentColIdx / (parentCols.length - 1) : 0.5
          const childRatio = childCols.length > 1 ? childColIdx / (childCols.length - 1) : 0.5

          startX = Math.round(parentPos.x + 36 + parentRatio * (CARD_WIDTH - 72))
          startY = parentPos.y + parentPos.height
          endX = Math.round(childPos.x + 36 + childRatio * (CARD_WIDTH - 72))
          endY = childPos.y

          const midY = Math.round((startY + endY) / 2)
          pathData = `M ${startX} ${startY} C ${startX} ${midY}, ${endX} ${midY}, ${endX} ${endY}`
        } else if (isChildAbove) {
          // Child on top, Parent below: route from child bottom down to parent top
          const parentRatio = parentCols.length > 1 ? parentColIdx / (parentCols.length - 1) : 0.5
          const childRatio = childCols.length > 1 ? childColIdx / (childCols.length - 1) : 0.5

          startX = Math.round(childPos.x + 36 + childRatio * (CARD_WIDTH - 72))
          startY = childPos.y + childPos.height
          endX = Math.round(parentPos.x + 40 + parentRatio * (CARD_WIDTH - 80))
          endY = parentPos.y

          const midY = Math.round((startY + endY) / 2)
          pathData = `M ${startX} ${startY} C ${startX} ${midY}, ${endX} ${midY}, ${endX} ${endY}`
        } else {
          // Side-by-side or horizontally displaced
          const pColY = parentPos.y + HEADER_HEIGHT + parentColIdx * COLUMN_HEIGHT + COLUMN_HEIGHT / 2
          const cColY = childPos.y + HEADER_HEIGHT + childColIdx * COLUMN_HEIGHT + COLUMN_HEIGHT / 2

          if (childPos.x >= parentPos.x + CARD_WIDTH * 0.7) {
            // Parent on left, Child on right
            startX = parentPos.x + CARD_WIDTH
            startY = pColY
            endX = childPos.x
            endY = cColY
            const dist = Math.max(35, (endX - startX) * 0.45)
            pathData = `M ${startX} ${startY} C ${startX + dist} ${startY}, ${endX - dist} ${endY}, ${endX} ${endY}`
          } else if (parentPos.x >= childPos.x + CARD_WIDTH * 0.7) {
            // Child on left, Parent on right
            startX = parentPos.x
            startY = pColY
            endX = childPos.x + CARD_WIDTH
            endY = cColY
            const dist = Math.max(35, (startX - endX) * 0.45)
            pathData = `M ${startX} ${startY} C ${startX - dist} ${startY}, ${endX + dist} ${endY}, ${endX} ${endY}`
          } else {
            // Overlapping horizontally: loop around the right
            startX = parentPos.x + CARD_WIDTH
            startY = pColY
            endX = childPos.x + CARD_WIDTH
            endY = cColY
            const loopX = Math.max(startX, endX) + 45
            pathData = `M ${startX} ${startY} C ${loopX} ${startY}, ${loopX} ${endY}, ${endX} ${endY}`
          }
        }

        const isHovered =
          hoveredRelId === rel.id ||
          hoveredTable === rel.sourceTable ||
          hoveredTable === rel.targetTable

        // Focus mode relationship classification
        const isDirectFocusEdge =
          focusCluster != null &&
          (parentTable === focusCluster.root || childTable === focusCluster.root)

        const isSecondaryFocusEdge =
          focusCluster != null &&
          !isDirectFocusEdge &&
          focusCluster.allConnected.has(parentTable) &&
          focusCluster.allConnected.has(childTable)

        const isUnrelatedEdge =
          focusCluster != null && !isDirectFocusEdge && !isSecondaryFocusEdge

        return {
          ...rel,
          parentTable,
          parentCol,
          childTable,
          childCol,
          pathData,
          srcX: startX,
          srcY: startY,
          tgtX: endX,
          tgtY: endY,
          isHovered,
          isDirectFocusEdge,
          isSecondaryFocusEdge,
          isUnrelatedEdge,
        }
      })
      .filter(Boolean)
  }, [relationships, nodePositions, columnsMap, hoveredRelId, hoveredTable, focusCluster])

  if (loading) {
    return (
      <div className="flex h-full min-h-[500px] w-full flex-col items-center justify-center gap-3 bg-[#0c0d0f]">
        <Spinner className="h-5 w-5 text-violet-400" />
        <p className="font-mono text-[12px] text-zinc-500">Mapping relational schema graph…</p>
      </div>
    )
  }

  if (tables.length === 0) {
    return (
      <div className="flex h-full min-h-[500px] w-full items-center justify-center bg-[#0c0d0f] p-6">
        <EmptyState
          icon={Table2}
          title="No tables in schema"
          description={`The workspace schema “${activeSchema}” currently contains no tables.`}
        />
      </div>
    )
  }

  return (
    <div
      ref={containerRef}
      onWheel={handleWheel}
      onPointerDown={handleCanvasPointerDown}
      onPointerMove={handleCanvasPointerMove}
      onPointerUp={handleCanvasPointerUp}
      data-canvas-surface="true"
      className="relative w-full h-full min-h-[500px] overflow-hidden select-none bg-[#0c0d0f] cursor-grab active:cursor-grabbing"
    >
      {/* ── Dot Grid Pattern ────────────────────────────────────────────────── */}
      <div
        data-canvas-surface="true"
        className="absolute inset-0 pointer-events-none"
        style={{
          backgroundImage: `radial-gradient(rgba(255, 255, 255, 0.06) 1px, transparent 1px)`,
          backgroundSize: '24px 24px',
          backgroundPosition: `${pan.x}px ${pan.y}px`,
        }}
      />

      {/* ── Top Bar Controls (Search & Focus Mode Indicator) ── */}
      <div className="absolute top-3 left-3 z-30 flex items-center gap-2 flex-wrap max-w-[calc(100%-24px)]">
        <div className="relative flex items-center">
          <Search
            className={`pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 transition-colors ${
              isFieldSearch ? 'text-sky-400' : 'text-zinc-500'
            }`}
          />
          <input
            ref={searchInputRef}
            type="text"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder={isFieldSearch ? 'Filter columns…' : 'Search tables (⌘F)…'}
            className={`h-[32px] w-64 sm:w-72 rounded-[7px] border bg-[#08090a]/95 pl-8 ${
              searchTerm ? (isFieldSearch ? 'pr-20' : 'pr-8') : 'pr-24'
            } text-[13px] text-zinc-100 placeholder:text-zinc-500 shadow-[inset_0_1px_2px_rgba(0,0,0,0.35),0_8px_24px_rgba(0,0,0,0.4)] backdrop-blur-md transition-[border-color,box-shadow] ${
              isFieldSearch
                ? 'border-sky-500/40 focus:border-sky-400 focus:outline-none focus:ring-2 focus:ring-sky-400/20 shadow-[0_0_16px_rgba(56,189,248,0.12)]'
                : 'border-white/[0.08] hover:border-white/[0.14] focus:border-violet-300/50 focus:outline-none focus:ring-2 focus:ring-violet-400/15'
            }`}
          />
          {searchTerm ? (
            <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1.5">
              {isFieldSearch && (
                <span className="inline-flex items-center rounded-[4px] border border-sky-500/30 bg-sky-500/15 px-1.5 py-0.5 font-mono text-[9px] font-semibold text-sky-300 select-none">
                  field
                </span>
              )}
              <button
                type="button"
                onClick={() => setSearchTerm('')}
                className="flex h-5 w-5 items-center justify-center rounded-[4px] text-zinc-400 hover:text-white hover:bg-white/[0.08] transition-colors"
                title="Clear search"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ) : (
            <div className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 flex items-center gap-1 select-none font-mono text-[10.5px] text-zinc-500">
              <kbd className="inline-flex h-[18px] items-center justify-center rounded-[4px] border border-white/[0.10] bg-white/[0.04] px-1 font-mono text-[10px] text-zinc-400">
                ⌘F
              </kbd>
              <kbd className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-[4px] border border-white/[0.10] bg-white/[0.04] px-1 font-mono text-[10px] text-zinc-400">
                /
              </kbd>
            </div>
          )}
        </div>

        {/* Filter Match Count */}
        {filteredTableNames != null && (
          <span className="inline-flex h-[32px] items-center gap-1 rounded-[7px] border border-white/[0.08] bg-[#0f1012]/95 px-2.5 font-mono text-[11px] text-zinc-300 shadow-2xl backdrop-blur-md">
            <span className="font-semibold text-zinc-100">{filteredTableNames.size}</span>
            <span className="text-zinc-500">table{filteredTableNames.size !== 1 ? 's' : ''} matched</span>
          </span>
        )}

        {/* Pinned Relationship Focus Mode Indicator */}
        {focusedTableId && (
          <div className="inline-flex h-[32px] items-center gap-1.5 rounded-[7px] border border-violet-500/40 bg-violet-500/15 px-2.5 text-[11.5px] font-mono text-violet-200 shadow-2xl backdrop-blur-md">
            <Target className="h-3.5 w-3.5 text-violet-400 animate-pulse" />
            <span>Focus: <strong className="text-white">{focusedTableId}</strong></span>
            {focusCluster && (
              <span className="text-[10px] text-violet-300/80">
                ({focusCluster.firstDegree.size} direct · {focusCluster.secondDegree.size} 2nd-deg)
              </span>
            )}
            <button
              type="button"
              onClick={() => setFocusedTableId(null)}
              title="Clear focus mode (or click empty canvas)"
              className="ml-1 flex h-4 w-4 items-center justify-center rounded text-violet-400 hover:text-white hover:bg-violet-400/20 transition-colors"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        )}


      </div>

      {/* ── Floating Control Bar (Zoom, Fit, Auto-arrange, Mode) ───────────── */}
      <div className="absolute bottom-4 right-4 z-30 flex items-center gap-1 rounded-[8px] border border-white/[0.08] bg-[#0f1012]/95 p-1 shadow-2xl backdrop-blur-md">
        <button
          type="button"
          onClick={handleZoomIn}
          title="Zoom In (+)"
          className="flex h-7 w-7 items-center justify-center rounded text-zinc-400 hover:bg-white/[0.06] hover:text-white transition-colors"
        >
          <ZoomIn className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={handleZoomOut}
          title="Zoom Out (-)"
          className="flex h-7 w-7 items-center justify-center rounded text-zinc-400 hover:bg-white/[0.06] hover:text-white transition-colors"
        >
          <ZoomOut className="h-3.5 w-3.5" />
        </button>
        <span className="px-1 font-mono text-[11px] text-zinc-500 tabular-nums">
          {Math.round(zoom * 100)}%
        </span>
        <div className="h-4 w-px bg-white/[0.08] mx-0.5" />
        <button
          type="button"
          onClick={handleReset}
          title="Reset View & Positions (RotateCcw)"
          className="flex h-7 w-7 items-center justify-center rounded text-zinc-400 hover:bg-white/[0.06] hover:text-white transition-colors"
        >
          <RotateCcw className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={handleAutoLayout}
          title="Auto-arrange Layout"
          className="flex h-7 w-7 items-center justify-center rounded text-zinc-400 hover:bg-white/[0.06] hover:text-white transition-colors"
        >
          <Layers className="h-3.5 w-3.5" />
        </button>
        {onToggleFullscreen && (
          <button
            type="button"
            onClick={onToggleFullscreen}
            title={isFullscreen ? 'Exit full screen (F / Esc)' : 'Full screen (F)'}
            className={`flex h-7 w-7 items-center justify-center rounded transition-colors ${
              isFullscreen
                ? 'bg-violet-500/20 text-violet-300 border border-violet-500/40 hover:bg-violet-500/30'
                : 'text-zinc-400 hover:bg-white/[0.06] hover:text-white'
            }`}
          >
            {isFullscreen ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
          </button>
        )}
      </div>

      {/* ── Transformed Canvas Space ──────────────────────────────────────── */}
      <div
        data-canvas-surface="true"
        className="absolute inset-0 origin-top-left transition-transform duration-75 ease-out"
        style={{
          transform: `translate3d(${pan.x}px, ${pan.y}px, 0px) scale(${zoom})`,
        }}
      >
        {/* SVG Bezier Relationship Connectors */}
        <svg
          className="absolute inset-0 overflow-visible pointer-events-none"
          style={{ width: '100%', height: '100%' }}
        >
          <defs>
            <marker
              id="erd-arrow-default"
              viewBox="0 0 10 10"
              refX="8"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M 0 1.5 L 8 5 L 0 8.5 z" fill="rgba(255, 255, 255, 0.22)" />
            </marker>
            <marker
              id="erd-arrow-active"
              viewBox="0 0 10 10"
              refX="8"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M 0 1.5 L 8 5 L 0 8.5 z" fill="#a78bfa" />
            </marker>
            <filter id="erd-glow" x="-20%" y="-20%" width="140%" height="140%">
              <feDropShadow dx="0" dy="0" stdDeviation="3" floodColor="#a78bfa" floodOpacity="0.6" />
            </filter>
          </defs>

          {renderedEdges.map((edge) => {
            if (!edge) return null

            const isDirectHighlight = edge.isDirectFocusEdge || edge.isHovered
            const isSecondaryHighlight = edge.isSecondaryFocusEdge
            const isUnrelatedDimmed = edge.isUnrelatedEdge

            let strokeColor = 'rgba(255, 255, 255, 0.12)'
            let strokeWidth = 1.5
            let strokeDasharray: string | undefined = '3 3'
            let edgeOpacity = 1
            let markerEnd: string | undefined = 'url(#erd-arrow-default)'
            let filter: string | undefined = undefined

            if (isDirectHighlight) {
              strokeColor = '#a78bfa'
              strokeWidth = 2.5
              strokeDasharray = undefined
              edgeOpacity = 1
              markerEnd = 'url(#erd-arrow-active)'
              filter = 'url(#erd-glow)'
            } else if (isSecondaryHighlight) {
              strokeColor = 'rgba(167, 139, 250, 0.5)'
              strokeWidth = 1.8
              strokeDasharray = undefined
              edgeOpacity = 0.75
              markerEnd = 'url(#erd-arrow-active)'
            } else if (isUnrelatedDimmed) {
              strokeColor = 'rgba(255, 255, 255, 0.06)'
              strokeWidth = 1
              strokeDasharray = '3 3'
              edgeOpacity = 0.08
              markerEnd = undefined
            }

            return (
              <g key={edge.id} className="pointer-events-auto">
                {/* Wide invisible path for effortless hover */}
                <path
                  d={edge.pathData}
                  fill="none"
                  stroke="transparent"
                  strokeWidth={16}
                  onMouseEnter={() => setHoveredRelId(edge.id)}
                  onMouseLeave={() => setHoveredRelId(null)}
                  className="cursor-pointer"
                />

                {/* Visible Bezier Curve Connector */}
                <path
                  d={edge.pathData}
                  fill="none"
                  stroke={strokeColor}
                  strokeWidth={strokeWidth}
                  strokeDasharray={strokeDasharray}
                  markerEnd={markerEnd}
                  filter={filter}
                  opacity={edgeOpacity}
                  className="transition-[stroke,stroke-width,opacity] duration-150"
                />

                {/* Origin Anchor Dot */}
                <circle
                  cx={edge.srcX}
                  cy={edge.srcY}
                  r={isDirectHighlight ? 3.5 : 2.5}
                  fill={isDirectHighlight ? '#a78bfa' : 'rgba(255, 255, 255, 0.4)'}
                  opacity={edgeOpacity}
                />

              </g>
            )
          })}
        </svg>

        {/* ── Draggable Table Entity Cards ─────────────────────────────────── */}
        {tables.map((table) => {
          const pos = nodePositions.get(table.name) || { x: 80, y: 80, width: CARD_WIDTH, height: 200 }
          const columns = columnsMap.get(table.name) || []
          const isSelected = activeTable === table.name
          const isDraggingThis = draggingNode === table.name
          const domain = detectDomain(table.name)

          // Relationship Focus Mode classification
          const isFocusRoot = focusCluster?.root === table.name
          const isFocusFirst = focusCluster?.firstDegree.has(table.name)
          const isFocusSecond = focusCluster?.secondDegree.has(table.name)
          const isUnrelatedInFocus = focusCluster != null && !focusCluster.allConnected.has(table.name)
          const isFilteredOutBySearch = filteredTableNames != null && !filteredTableNames.has(table.name)

          const isDimmed = isUnrelatedInFocus || isFilteredOutBySearch

          let borderClass = 'border-white/[0.08] hover:border-white/[0.18]'
          let zIndexClass = 'z-20'
          let opacityClass = 'opacity-100'

          if (isDraggingThis) {
            zIndexClass = 'z-40'
            borderClass = 'border-violet-400/80 shadow-[0_16px_36px_rgba(0,0,0,0.8)] cursor-grabbing'
          } else if (isFocusRoot) {
            zIndexClass = 'z-30'
            borderClass = 'border-violet-400 ring-2 ring-violet-400/90 shadow-[0_0_28px_rgba(167,139,250,0.3)]'
            opacityClass = 'opacity-100'
          } else if (isFocusFirst) {
            zIndexClass = 'z-25'
            borderClass = 'border-violet-500/60 ring-1.5 ring-violet-400/70 shadow-[0_0_16px_rgba(167,139,250,0.2)]'
            opacityClass = 'opacity-100'
          } else if (isFocusSecond) {
            zIndexClass = 'z-22'
            borderClass = 'border-white/[0.18] ring-1 ring-white/10 shadow-[0_0_12px_rgba(255,255,255,0.06)]'
            opacityClass = 'opacity-90'
          } else if (isDimmed) {
            zIndexClass = 'z-10'
            opacityClass = 'opacity-[0.15] saturate-50'
          } else if (isSelected) {
            borderClass = 'border-violet-400/50 shadow-[0_0_24px_rgba(167,139,250,0.18)]'
          }

          return (
            <div
              key={table.name}
              style={{
                transform: `translate3d(${pos.x}px, ${pos.y}px, 0px)`,
                width: pos.width,
              }}
              onMouseEnter={() => setHoveredTable(table.name)}
              onMouseLeave={() => setHoveredTable(null)}
              className={`absolute top-0 left-0 rounded-[10px] border bg-[#0f1012] shadow-[0_1px_0_rgba(255,255,255,0.05)] transition-[opacity,box-shadow,border-color,transform] duration-200 ${zIndexClass} ${borderClass} ${opacityClass}`}
            >
              {/* Domain Color Accent Stripe (2.5px) */}
              <div
                className={`h-[2.5px] w-full rounded-t-[9px] bg-gradient-to-r ${
                  DOMAIN_THEMES[domain || 'core'].strip
                }`}
              />

              {/* Card Header (Drag Handle & Focus Pinning) */}
              <div
                onPointerDown={(e) => startDraggingNode(e, table.name)}
                onPointerUp={stopDraggingNode}
                onClick={() => {
                  setFocusedTableId((prev) => (prev === table.name ? null : table.name))
                  onSelectTable?.(table.name)
                }}
                className="flex h-[42px] items-center justify-between gap-2 border-b border-white/[0.06] bg-[#14151a] px-3 cursor-grab active:cursor-grabbing hover:bg-[#181920] transition-colors"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span
                    className={`flex h-5 w-5 items-center justify-center rounded-[5px] border ${
                      domain === 'auth'
                        ? 'border-violet-500/30 bg-violet-500/10 text-violet-300'
                        : domain === 'commerce'
                        ? 'border-sky-500/30 bg-sky-500/10 text-sky-300'
                        : domain === 'analytics'
                        ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                        : 'border-amber-500/30 bg-amber-500/10 text-amber-300'
                    }`}
                  >
                    <Table2 className="h-3 w-3" />
                  </span>
                  <span
                    className="truncate text-[13px] font-semibold text-zinc-100 tracking-tight"
                  >
                    {table.name}
                  </span>

                  {/* Relationship Focus Badges */}
                  {isFocusRoot && (
                    <span className="flex-shrink-0 rounded px-1.5 py-0.5 text-[8.5px] font-mono font-bold bg-violet-500/25 text-violet-200 border border-violet-500/40 shadow-sm">
                      FOCUSED
                    </span>
                  )}
                  {isFocusFirst && (
                    <span className="flex-shrink-0 rounded px-1.5 py-0.5 text-[8.5px] font-mono text-violet-300/90 bg-violet-500/15 border border-violet-500/25">
                      1st
                    </span>
                  )}
                  {isFocusSecond && (
                    <span className="flex-shrink-0 rounded px-1.5 py-0.5 text-[8.5px] font-mono text-zinc-400 bg-white/[0.04] border border-white/[0.08]">
                      2nd
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-1.5 flex-shrink-0">
                  <span className="text-[11px] tabular-nums text-zinc-500 bg-white/[0.04] px-1.5 py-0.5 rounded border border-white/[0.06]">
                    {table.rows?.toLocaleString() ?? 0}
                  </span>
                  {onOpenTableData && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation()
                        onOpenTableData(table.name)
                      }}
                      title="Open table data view"
                      className="flex h-5 w-5 items-center justify-center rounded text-zinc-400 hover:text-white hover:bg-white/[0.08] transition-colors"
                    >
                      <Rows className="h-3 w-3" />
                    </button>
                  )}
                </div>
              </div>

              {/* Column List */}
              <div className="divide-y divide-white/[0.04] py-0.5">
                {columns.length === 0 ? (
                  <div className="px-3 py-2 text-[11px] text-zinc-500 italic">No columns found</div>
                ) : (
                  columns.map((col) => {
                    const isPk = !!col.primary
                    const isFk = !!col.foreign
                    const isFieldMatched = matchedColumnsMap.get(table.name)?.has(col.name)
                    const isColHighlighted =
                      isFieldMatched ||
                      (hoveredRelId != null &&
                        relationships.some(
                          (r) =>
                            r.id === hoveredRelId &&
                            ((r.sourceTable === table.name && r.sourceColumn === col.name) ||
                              (r.targetTable === table.name && r.targetColumn === col.name))
                        ))

                    return (
                      <div
                        key={col.name}
                        className={`flex h-[28px] items-center justify-between px-3 font-mono text-[11px] transition-colors group ${
                          isFieldMatched
                            ? 'bg-amber-500/15 text-amber-200 border-l-2 border-amber-400 font-medium'
                            : isColHighlighted
                            ? 'bg-violet-500/15 text-violet-200 border-l-2 border-violet-400'
                            : 'hover:bg-white/[0.03]'
                        }`}
                      >
                        <div className="flex items-center gap-1.5 min-w-0">
                          {isPk && (
                            <span
                              title="Primary Key"
                              className="flex items-center gap-0.5 text-[9px] font-bold text-amber-300 bg-amber-500/15 border border-amber-500/30 px-1 rounded"
                            >
                              <Key className="h-2.5 w-2.5 text-amber-300" />
                              PK
                            </span>
                          )}
                          {isFk && (
                            <span
                              title="Foreign Key"
                              className="flex items-center gap-0.5 text-[9px] font-bold text-violet-300 bg-violet-500/15 border border-violet-500/30 px-1 rounded"
                            >
                              <Link2 className="h-2.5 w-2.5 text-violet-300" />
                              FK
                            </span>
                          )}
                          <span
                            className={`truncate ${
                              isFieldMatched
                                ? 'text-amber-200 font-semibold'
                                : isPk
                                ? 'text-zinc-100 font-medium'
                                : isColHighlighted
                                ? 'text-violet-200 font-medium'
                                : 'text-zinc-200'
                            }`}
                          >
                            {col.name}
                          </span>
                          {isFieldMatched && (
                            <span className="text-[8.5px] font-mono font-bold text-amber-300 bg-amber-500/25 px-1 rounded border border-amber-500/40 shadow-sm">
                              MATCH
                            </span>
                          )}
                        </div>

                        <div className="flex items-center gap-1.5 flex-shrink-0 text-[10.5px]">
                          <span className="text-zinc-500 truncate max-w-[85px]">{col.type}</span>
                          {col.nullable && <span className="text-zinc-600 text-[10px]" title="Nullable">?</span>}
                          {col.indexed && !isPk && (
                            <span
                              title="Indexed"
                              className="text-[9px] text-zinc-400 bg-white/[0.04] px-1 rounded"
                            >
                              IDX
                            </span>
                          )}
                        </div>
                      </div>
                    )
                  })
                )}
              </div>

              {/* Card Footer (Metadata) */}
              <div className="flex h-[28px] items-center justify-between border-t border-white/[0.05] bg-[#111216] px-3 rounded-b-[9px] font-mono text-[10px] text-zinc-500">
                <span className="flex items-center gap-1">
                  <Shield className="h-2.5 w-2.5 text-emerald-400" />
                  <span>RLS active</span>
                </span>
                <span>{table.size || '32 kB'}</span>
              </div>
            </div>
          )
        })}
      </div>

      {/* ── Domain Legend & Hierarchy Stats (Bottom-Left) ─────────────────── */}
      <div className="absolute bottom-4 left-4 z-30 flex flex-col gap-2">
        {/* Toggleable Interactive MiniMap */}
        {showMinimap && (
          <SchemaMinimap
            tables={tables}
            nodePositions={nodePositions}
            pan={pan}
            zoom={zoom}
            containerSize={containerSize}
            setPan={setPan}
            hoveredTable={hoveredTable}
            setHoveredTable={setHoveredTable}
            activeTable={activeTable}
            focusCluster={focusCluster}
            filteredTableNames={filteredTableNames}
            onClose={toggleMinimap}
            onSelectTable={onSelectTable}
          />
        )}

        {/* Legend Bar */}
        <div className="flex items-center gap-2 rounded-[8px] border border-white/[0.08] bg-[#0f1012]/95 px-3 py-1.5 shadow-2xl backdrop-blur-md">
          <div className="flex items-center gap-2.5 pr-2 border-r border-white/[0.08]">
            <span className="flex items-center gap-1 font-mono text-[10.5px] text-zinc-400">
              <span className="h-2 w-2 rounded-full bg-violet-400" />
              <span>Auth</span>
            </span>
            <span className="flex items-center gap-1 font-mono text-[10.5px] text-zinc-400">
              <span className="h-2 w-2 rounded-full bg-sky-400" />
              <span>Commerce</span>
            </span>
            <span className="flex items-center gap-1 font-mono text-[10.5px] text-zinc-400">
              <span className="h-2 w-2 rounded-full bg-emerald-400" />
              <span>Analytics</span>
            </span>
            <span className="flex items-center gap-1 font-mono text-[10.5px] text-zinc-400">
              <span className="h-2 w-2 rounded-full bg-amber-400" />
              <span>Core</span>
            </span>
          </div>

          <span className="font-mono text-[10.5px] text-zinc-500 tabular-nums">
            {tables.length} tables · {relationships.length} rels
          </span>

          <button
            type="button"
            onClick={toggleMinimap}
            title={showMinimap ? 'Hide MiniMap (M)' : 'Show MiniMap (M)'}
            className={`flex h-6 items-center gap-1 px-1.5 rounded font-mono text-[10px] transition-colors ${
              showMinimap
                ? 'bg-violet-500/20 text-violet-300 border border-violet-500/30'
                : 'text-zinc-400 hover:bg-white/[0.06] hover:text-white'
            }`}
          >
            <Compass className="h-3 w-3" />
            <span>Map</span>
            <kbd className="text-[8.5px] px-1 rounded bg-white/[0.06] text-zinc-400 border border-white/[0.06]">M</kbd>
          </button>
        </div>
      </div>
    </div>
  )
}

export default SchemaDiagram
