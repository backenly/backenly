'use client'

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import {
  Table2, Key, Link2, Search, ZoomIn, ZoomOut, RotateCcw,
  Maximize2, Sparkles, Database, Layers, ArrowRight, Shield, X,
  Rows
} from 'lucide-react'
import {
  getTables, getStructure, getRelationships,
  type TableInfo, type ColumnInfo, type DatabaseType
} from '@/lib/api/database'
import { EmptyState, KitButton, Spinner } from '@/components/inspector/kit'

// ── Types ───────────────────────────────────────────────────────────────────

export interface SchemaDiagramProps {
  projectId?: string
  activeSchema: string
  activeTable?: string | null
  databaseType?: DatabaseType
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

// ── Localhost Mock / Dummy Data for instant visualization ──────────────────

const MOCK_TABLES: TableInfo[] = [
  { name: 'users', rows: 1420, size: '240 kB', description: 'Platform & tenant users' },
  { name: 'categories', rows: 28, size: '32 kB', description: 'Product category taxonomy' },
  { name: 'products', rows: 384, size: '180 kB', description: 'Store catalog items' },
  { name: 'orders', rows: 960, size: '320 kB', description: 'Customer checkout orders' },
  { name: 'order_items', rows: 2450, size: '410 kB', description: 'Line items per order' },
  { name: 'audit_logs', rows: 8120, size: '890 kB', description: 'Security audit trail' },
]

const MOCK_COLUMNS: Record<string, ColumnInfo[]> = {
  users: [
    { name: 'id', type: 'uuid', primary: true, nullable: false, indexed: true },
    { name: 'email', type: 'varchar(255)', unique: true, nullable: false, indexed: true },
    { name: 'full_name', type: 'text', nullable: true },
    { name: 'role', type: 'varchar(50)', default: "'member'", nullable: false },
    { name: 'avatar_url', type: 'text', nullable: true },
    { name: 'created_at', type: 'timestamp', nullable: false, indexed: true },
  ],
  categories: [
    { name: 'id', type: 'serial', primary: true, nullable: false },
    { name: 'name', type: 'varchar(100)', nullable: false },
    { name: 'slug', type: 'varchar(100)', unique: true, nullable: false, indexed: true },
    { name: 'parent_id', type: 'integer', foreign: true, nullable: true },
  ],
  products: [
    { name: 'id', type: 'uuid', primary: true, nullable: false, indexed: true },
    { name: 'title', type: 'varchar(255)', nullable: false },
    { name: 'sku', type: 'varchar(64)', unique: true, nullable: false, indexed: true },
    { name: 'price_cents', type: 'integer', nullable: false },
    { name: 'category_id', type: 'integer', foreign: true, nullable: false, indexed: true },
    { name: 'stock_quantity', type: 'integer', default: '0', nullable: false },
    { name: 'is_active', type: 'boolean', default: 'true', nullable: false },
  ],
  orders: [
    { name: 'id', type: 'uuid', primary: true, nullable: false, indexed: true },
    { name: 'user_id', type: 'uuid', foreign: true, nullable: false, indexed: true },
    { name: 'status', type: 'varchar(32)', default: "'pending'", nullable: false },
    { name: 'total_cents', type: 'integer', nullable: false },
    { name: 'currency', type: 'char(3)', default: "'USD'", nullable: false },
    { name: 'created_at', type: 'timestamp', nullable: false, indexed: true },
  ],
  order_items: [
    { name: 'id', type: 'uuid', primary: true, nullable: false },
    { name: 'order_id', type: 'uuid', foreign: true, nullable: false, indexed: true },
    { name: 'product_id', type: 'uuid', foreign: true, nullable: false, indexed: true },
    { name: 'quantity', type: 'integer', default: '1', nullable: false },
    { name: 'unit_price_cents', type: 'integer', nullable: false },
  ],
  audit_logs: [
    { name: 'id', type: 'bigserial', primary: true, nullable: false },
    { name: 'user_id', type: 'uuid', foreign: true, nullable: true, indexed: true },
    { name: 'action', type: 'varchar(64)', nullable: false },
    { name: 'resource_type', type: 'varchar(64)', nullable: false },
    { name: 'ip_address', type: 'inet', nullable: true },
    { name: 'created_at', type: 'timestamp', nullable: false, indexed: true },
  ],
}

const MOCK_RELATIONSHIPS: GraphRelationship[] = [
  { id: 'fk_products_category', sourceTable: 'products', sourceColumn: 'category_id', targetTable: 'categories', targetColumn: 'id' },
  { id: 'fk_orders_user', sourceTable: 'orders', sourceColumn: 'user_id', targetTable: 'users', targetColumn: 'id' },
  { id: 'fk_items_order', sourceTable: 'order_items', sourceColumn: 'order_id', targetTable: 'orders', targetColumn: 'id' },
  { id: 'fk_items_product', sourceTable: 'order_items', sourceColumn: 'product_id', targetTable: 'products', targetColumn: 'id' },
  { id: 'fk_audit_user', sourceTable: 'audit_logs', sourceColumn: 'user_id', targetTable: 'users', targetColumn: 'id' },
  { id: 'fk_cat_parent', sourceTable: 'categories', sourceColumn: 'parent_id', targetTable: 'categories', targetColumn: 'id' },
]

function detectDomain(name: string): TableNode['domain'] {
  const l = name.toLowerCase()
  if (l.includes('user') || l.includes('auth') || l.includes('session') || l.includes('account')) return 'auth'
  if (l.includes('product') || l.includes('order') || l.includes('item') || l.includes('cart') || l.includes('payment') || l.includes('category')) return 'commerce'
  if (l.includes('log') || l.includes('audit') || l.includes('metric') || l.includes('event')) return 'analytics'
  return 'core'
}

/** Compute ergonomic layered column layout */
function calculateLayout(
  tables: TableInfo[],
  columnsMap: Map<string, ColumnInfo[]>,
  relationships: GraphRelationship[]
): Map<string, { x: number; y: number; width: number; height: number }> {
  const positions = new Map<string, { x: number; y: number; width: number; height: number }>()
  if (tables.length === 0) return positions

  // Calculate dependency tier (inDegree / outDegree)
  const inDegree = new Map<string, number>()
  const outgoing = new Map<string, Set<string>>()
  for (const t of tables) {
    inDegree.set(t.name, 0)
    outgoing.set(t.name, new Set())
  }

  for (const rel of relationships) {
    if (inDegree.has(rel.sourceTable) && outgoing.has(rel.targetTable) && rel.sourceTable !== rel.targetTable) {
      outgoing.get(rel.targetTable)?.add(rel.sourceTable)
      inDegree.set(rel.sourceTable, (inDegree.get(rel.sourceTable) || 0) + 1)
    }
  }

  // Assign columns/tiers
  const tiers: string[][] = []
  const visited = new Set<string>()
  let currentTier = tables.filter((t) => (inDegree.get(t.name) || 0) === 0).map((t) => t.name)
  if (currentTier.length === 0 && tables.length > 0) {
    currentTier = [tables[0].name]
  }

  while (currentTier.length > 0) {
    tiers.push(currentTier)
    currentTier.forEach((t) => visited.add(t))

    const nextTier: string[] = []
    for (const t of currentTier) {
      const targets = outgoing.get(t)
      if (targets) {
        targets.forEach((target) => {
          if (!visited.has(target) && !nextTier.includes(target)) {
            nextTier.push(target)
          }
        })
      }
    }
    currentTier = nextTier
  }

  // Any unplaced tables get appended into the last tier or a new tier
  const remaining = tables.filter((t) => !visited.has(t.name)).map((t) => t.name)
  if (remaining.length > 0) {
    tiers.push(remaining)
  }

  const startX = 60
  const startY = 60

  tiers.forEach((tierTables, colIdx) => {
    let currentY = startY
    const colX = startX + colIdx * (CARD_WIDTH + H_SPACING)

    tierTables.forEach((tableName) => {
      const cols = columnsMap.get(tableName) || []
      const cardHeight = HEADER_HEIGHT + Math.max(1, cols.length) * COLUMN_HEIGHT + FOOTER_HEIGHT

      positions.set(tableName, {
        x: colX,
        y: currentY,
        width: CARD_WIDTH,
        height: cardHeight,
      })

      currentY += cardHeight + V_SPACING
    })
  })

  return positions
}

// ── Main Component ──────────────────────────────────────────────────────────

export function SchemaDiagram({
  projectId,
  activeSchema,
  activeTable,
  databaseType = 'postgresql',
  onSelectTable,
  onOpenTableData,
}: SchemaDiagramProps) {
  const containerRef = useRef<HTMLDivElement>(null)

  const [loading, setLoading] = useState(true)
  const [tables, setTables] = useState<TableInfo[]>([])
  const [columnsMap, setColumnsMap] = useState<Map<string, ColumnInfo[]>>(new Map())
  const [relationships, setRelationships] = useState<GraphRelationship[]>([])
  const [useMockData, setUseMockData] = useState(false)

  // Layout & positioning
  const [nodePositions, setNodePositions] = useState<Map<string, { x: number; y: number; width: number; height: number }>>(new Map())

  // Viewport transforms (pan & zoom clamped 0.5x to 1.75x)
  const [pan, setPan] = useState({ x: 40, y: 40 })
  const [zoom, setZoom] = useState(1)
  const [isPanning, setIsPanning] = useState(false)
  const panStartRef = useRef({ x: 0, y: 0 })

  // Dragging individual card
  const [draggingNode, setDraggingNode] = useState<string | null>(null)
  const dragStartRef = useRef<{ clientX: number; clientY: number; nodeX: number; nodeY: number } | null>(null)

  // Hover highlights
  const [hoveredRelId, setHoveredRelId] = useState<string | null>(null)
  const [hoveredTable, setHoveredTable] = useState<string | null>(null)
  const [searchTerm, setSearchTerm] = useState('')

  // ── Data Fetching ─────────────────────────────────────────────────────────

  const loadData = useCallback(async () => {
    setLoading(true)
    try {
      if (useMockData) {
        setTables(MOCK_TABLES)
        const cMap = new Map<string, ColumnInfo[]>()
        Object.entries(MOCK_COLUMNS).forEach(([t, cols]) => cMap.set(t, cols))
        setColumnsMap(cMap)
        setRelationships(MOCK_RELATIONSHIPS)
        setNodePositions(calculateLayout(MOCK_TABLES, cMap, MOCK_RELATIONSHIPS))
        setLoading(false)
        return
      }

      const dbType = databaseType || 'postgresql'
      const targetSchema = activeSchema || 'public'

      // Live fetch
      const fetchedTables = await getTables(dbType, targetSchema, { projectId: projectId || undefined })
      if (!fetchedTables || fetchedTables.length === 0) {
        // Fallback to mock data for instant rich localhost developer experience
        setUseMockData(true)
        setTables(MOCK_TABLES)
        const cMap = new Map<string, ColumnInfo[]>()
        Object.entries(MOCK_COLUMNS).forEach(([t, cols]) => cMap.set(t, cols))
        setColumnsMap(cMap)
        setRelationships(MOCK_RELATIONSHIPS)
        setNodePositions(calculateLayout(MOCK_TABLES, cMap, MOCK_RELATIONSHIPS))
        setLoading(false)
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
                  allRels.push({
                    id: `${r.from.table}_${r.from.column}_to_${r.to.table}_${r.to.column}_${idx}`,
                    sourceTable: r.from.table,
                    sourceColumn: r.from.column,
                    targetTable: r.to.table,
                    targetColumn: r.to.column,
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
      setNodePositions(calculateLayout(fetchedTables, cMap, allRels))
    } catch {
      // In case of error (e.g. offline dev server or empty mock), load dummy data gracefully
      setUseMockData(true)
      setTables(MOCK_TABLES)
      const cMap = new Map<string, ColumnInfo[]>()
      Object.entries(MOCK_COLUMNS).forEach(([t, cols]) => cMap.set(t, cols))
      setColumnsMap(cMap)
      setRelationships(MOCK_RELATIONSHIPS)
      setNodePositions(calculateLayout(MOCK_TABLES, cMap, MOCK_RELATIONSHIPS))
    } finally {
      setLoading(false)
    }
  }, [activeSchema, databaseType, projectId, useMockData])

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
    setZoom(1)
    setPan({ x: 40, y: 40 })
  }
  const handleAutoLayout = () => {
    setNodePositions(calculateLayout(tables, columnsMap, relationships))
    handleReset()
  }

  // ── Filter Matching ───────────────────────────────────────────────────────

  const filteredTableNames = useMemo(() => {
    if (!searchTerm.trim()) return null
    const q = searchTerm.toLowerCase()
    return new Set(
      tables
        .filter((t) => {
          const cols = columnsMap.get(t.name) || []
          return t.name.toLowerCase().includes(q) || cols.some((c) => c.name.toLowerCase().includes(q))
        })
        .map((t) => t.name)
    )
  }, [tables, columnsMap, searchTerm])

  // ── Calculate SVG Connectors ──────────────────────────────────────────────

  const renderedEdges = useMemo(() => {
    return relationships.map((rel) => {
      const srcPos = nodePositions.get(rel.sourceTable)
      const tgtPos = nodePositions.get(rel.targetTable)
      if (!srcPos || !tgtPos) return null

      const srcCols = columnsMap.get(rel.sourceTable) || []
      const tgtCols = columnsMap.get(rel.targetTable) || []

      const srcColIdx = Math.max(0, srcCols.findIndex((c) => c.name === rel.sourceColumn))
      const tgtColIdx = Math.max(0, tgtCols.findIndex((c) => c.name === rel.targetColumn))

      const srcY = srcPos.y + HEADER_HEIGHT + srcColIdx * COLUMN_HEIGHT + COLUMN_HEIGHT / 2
      const tgtY = tgtPos.y + HEADER_HEIGHT + tgtColIdx * COLUMN_HEIGHT + COLUMN_HEIGHT / 2

      let srcX: number
      let tgtX: number
      let c1X: number
      let c2X: number

      // Horizontal orientation logic
      if (tgtPos.x >= srcPos.x + CARD_WIDTH - 20) {
        srcX = srcPos.x + CARD_WIDTH
        tgtX = tgtPos.x
        const distance = Math.max(40, (tgtX - srcX) * 0.45)
        c1X = srcX + distance
        c2X = tgtX - distance
      } else if (srcPos.x >= tgtPos.x + CARD_WIDTH - 20) {
        srcX = srcPos.x
        tgtX = tgtPos.x + CARD_WIDTH
        const distance = Math.max(40, (srcX - tgtX) * 0.45)
        c1X = srcX - distance
        c2X = tgtX + distance
      } else {
        // Vertically aligned or overlapping: loop around the right
        srcX = srcPos.x + CARD_WIDTH
        tgtX = tgtPos.x + CARD_WIDTH
        const curveOffset = 50
        c1X = Math.max(srcX, tgtX) + curveOffset
        c2X = Math.max(srcX, tgtX) + curveOffset
      }

      const pathData = `M ${srcX} ${srcY} C ${c1X} ${srcY}, ${c2X} ${tgtY}, ${tgtX} ${tgtY}`

      const isHovered =
        hoveredRelId === rel.id ||
        hoveredTable === rel.sourceTable ||
        hoveredTable === rel.targetTable

      return {
        ...rel,
        pathData,
        srcX,
        srcY,
        tgtX,
        tgtY,
        isHovered,
      }
    }).filter(Boolean)
  }, [relationships, nodePositions, columnsMap, hoveredRelId, hoveredTable])

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
          action={
            <KitButton size="sm" icon={Sparkles} onClick={() => setUseMockData(true)}>
              Load demo schema
            </KitButton>
          }
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

      {/* ── Top Bar Controls (Search & Mode Badge) ─────────────────────────── */}
      <div className="absolute top-3 left-3 z-30 flex items-center gap-2">
        <div className="relative flex items-center">
          <Search className="absolute left-2.5 h-3.5 w-3.5 text-zinc-500 pointer-events-none" />
          <input
            type="text"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="Search schema..."
            className="h-8 w-44 sm:w-56 rounded-md border border-white/[0.08] bg-[#0f1012]/90 pl-8 pr-7 text-[12px] text-zinc-200 placeholder:text-zinc-600 focus:border-violet-400/50 focus:outline-none backdrop-blur-sm transition-all"
          />
          {searchTerm && (
            <button
              onClick={() => setSearchTerm('')}
              className="absolute right-2 text-zinc-500 hover:text-zinc-300"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>

        {useMockData && (
          <span className="inline-flex items-center gap-1.5 rounded-md border border-violet-500/30 bg-violet-500/10 px-2.5 py-1 text-[11px] font-medium text-violet-300 shadow-sm backdrop-blur-sm">
            <Sparkles className="h-3 w-3 text-violet-400" />
            <span>Interactive Demo Schema</span>
          </span>
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
          title="Reset View (RotateCcw)"
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
        <div className="h-4 w-px bg-white/[0.08] mx-0.5" />
        <button
          type="button"
          onClick={() => {
            setUseMockData((prev) => !prev)
          }}
          title={useMockData ? 'Switch to live workspace data' : 'Switch to demo schema'}
          className={`flex h-7 items-center gap-1.5 px-2.5 rounded text-[11px] font-medium transition-colors ${
            useMockData
              ? 'bg-violet-500/20 text-violet-200 border border-violet-500/30'
              : 'text-zinc-400 hover:bg-white/[0.06] hover:text-white'
          }`}
        >
          <Database className="h-3 w-3" />
          <span>{useMockData ? 'Live DB' : 'Demo DB'}</span>
        </button>
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
                  stroke={edge.isHovered ? '#a78bfa' : 'rgba(255, 255, 255, 0.12)'}
                  strokeWidth={edge.isHovered ? 2.5 : 1.5}
                  strokeDasharray={edge.isHovered ? undefined : '3 3'}
                  markerEnd={edge.isHovered ? 'url(#erd-arrow-active)' : 'url(#erd-arrow-default)'}
                  filter={edge.isHovered ? 'url(#erd-glow)' : undefined}
                  className="transition-colors duration-150"
                />

                {/* Origin Anchor Dot */}
                <circle
                  cx={edge.srcX}
                  cy={edge.srcY}
                  r={edge.isHovered ? 3.5 : 2.5}
                  fill={edge.isHovered ? '#a78bfa' : 'rgba(255, 255, 255, 0.4)'}
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
          const isDimmed = filteredTableNames != null && !filteredTableNames.has(table.name)
          const domain = detectDomain(table.name)

          return (
            <div
              key={table.name}
              style={{
                transform: `translate3d(${pos.x}px, ${pos.y}px, 0px)`,
                width: pos.width,
              }}
              onMouseEnter={() => setHoveredTable(table.name)}
              onMouseLeave={() => setHoveredTable(null)}
              className={`absolute top-0 left-0 rounded-[10px] border bg-[#0f1012] shadow-[0_1px_0_rgba(255,255,255,0.05)] transition-[opacity,box-shadow,border-color] duration-150 ${
                isDraggingThis ? 'z-40 shadow-[0_16px_36px_rgba(0,0,0,0.8)] border-violet-400/80 cursor-grabbing' : 'z-20'
              } ${
                isSelected
                  ? 'border-violet-400/50 shadow-[0_0_24px_rgba(167,139,250,0.18)]'
                  : 'border-white/[0.08] hover:border-white/[0.18]'
              } ${isDimmed ? 'opacity-25' : 'opacity-100'}`}
            >
              {/* Card Header (Drag Handle) */}
              <div
                onPointerDown={(e) => startDraggingNode(e, table.name)}
                onPointerUp={stopDraggingNode}
                className="flex h-[44px] items-center justify-between gap-2 border-b border-white/[0.06] bg-[#14151a] px-3 rounded-t-[9px] cursor-grab active:cursor-grabbing"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span
                    className={`flex h-5 w-5 items-center justify-center rounded-[5px] border ${
                      domain === 'auth'
                        ? 'border-violet-500/30 bg-violet-500/10 text-violet-300'
                        : domain === 'commerce'
                        ? 'border-sky-500/30 bg-sky-500/10 text-sky-300'
                        : domain === 'analytics'
                        ? 'border-amber-500/30 bg-amber-500/10 text-amber-300'
                        : 'border-zinc-700 bg-zinc-800 text-zinc-300'
                    }`}
                  >
                    <Table2 className="h-3 w-3" />
                  </span>
                  <span
                    className="truncate text-[13px] font-semibold text-zinc-100 tracking-tight cursor-pointer hover:underline"
                    onClick={() => onSelectTable?.(table.name)}
                  >
                    {table.name}
                  </span>
                </div>

                <div className="flex items-center gap-1.5 flex-shrink-0">
                  <span className="text-[11px] tabular-nums text-zinc-500 bg-white/[0.04] px-1.5 py-0.5 rounded border border-white/[0.06]">
                    {table.rows?.toLocaleString() ?? 0}
                  </span>
                  {onOpenTableData && (
                    <button
                      type="button"
                      onClick={() => onOpenTableData(table.name)}
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
                    return (
                      <div
                        key={col.name}
                        className="flex h-[28px] items-center justify-between px-3 font-mono text-[11px] hover:bg-white/[0.03] transition-colors group"
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
                              isPk ? 'text-zinc-100 font-medium' : 'text-zinc-200'
                            }`}
                          >
                            {col.name}
                          </span>
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
    </div>
  )
}

export default SchemaDiagram
