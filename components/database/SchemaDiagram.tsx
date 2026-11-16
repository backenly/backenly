'use client'

/**
 * The schema as a graph: each table a card (its name, row count and columns,
 * the key and foreign keys marked), a line between tables a foreign key joins.
 *
 * It draws only what the catalog says. It used to colour tables by "domains"
 * guessed from their names, print "RLS active" on every card whatever the
 * truth, and show "32 kB" where a size was missing; all three are gone.
 *
 * Three reads open it, however many tables there are: the list, every table's
 * columns and every relationship (tests/unit/schema-diagram-loads-in-three-reads).
 *
 * Drag a card to move it, drag the canvas to pan, scroll to zoom. Click a
 * card's name to see its neighbours; ⌘F or / searches tables ("/name" searches
 * columns); F is full screen, M the map, Esc steps back out.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from 'react'
import { Expand, KeyRound, LayoutGrid, Link2, Map as MapIcon, Maximize2, Minimize2, Minus, Plus, Rows, X } from 'lucide-react'
import { getRelationships, getSchemaStructure, getTables, type ColumnInfo, type DatabaseType, type TableInfo } from '@/lib/api/database'
import { ErrorRow } from '@/components/console/states'
import { FOCUS, RULE } from '@/components/console/tokens'
import { INPUT_BASE, Spinner } from '@/components/inspector/kit'

export interface SchemaDiagramProps {
  projectId?: string
  activeSchema: string
  activeTable?: string | null
  databaseType?: DatabaseType
  onSelectTable?: (tableName: string) => void
  onOpenTableData?: (tableName: string) => void
}

interface Edge {
  id: string
  child: string
  childCol: string
  parent: string
  parentCol: string
}

type Box = { x: number; y: number; width: number; height: number }

const CARD_WIDTH = 248
const HEADER = 38
const COL = 26
const PAD = 6
const MIN_ZOOM = 0.4
const MAX_ZOOM = 1.75
/** The smallest zoom the first view uses: below it the column names stop reading. */
const READABLE = 0.8
/** A layer wider than this wraps onto another row. */
const PER_ROW = 4

const cardHeight = (cols: number) => HEADER + Math.max(1, cols) * COL + PAD * 2

/** Top-down layers: tables nothing points at first, each table one layer below the tables it references. */
function layout(tables: readonly TableInfo[], cols: Map<string, ColumnInfo[]>, edges: readonly Edge[]): Map<string, Box> {
  const names = new Set(tables.map((t) => t.name))
  const parents = new Map<string, Set<string>>()
  const children = new Map<string, Set<string>>()
  for (const t of tables) {
    parents.set(t.name, new Set())
    children.set(t.name, new Set())
  }
  for (const e of edges) {
    if (!names.has(e.parent) || !names.has(e.child) || e.parent === e.child) continue
    children.get(e.parent)?.add(e.child)
    parents.get(e.child)?.add(e.parent)
  }
  const level = new Map<string, number>()
  const indeg = new Map<string, number>()
  const queue: string[] = []
  for (const t of tables) {
    const d = parents.get(t.name)?.size ?? 0
    indeg.set(t.name, d)
    if (d === 0) {
      level.set(t.name, 0)
      queue.push(t.name)
    }
  }
  while (queue.length > 0) {
    const cur = queue.shift() as string
    for (const ch of children.get(cur) ?? []) {
      level.set(ch, Math.max(level.get(ch) ?? 0, (level.get(cur) ?? 0) + 1))
      const d = (indeg.get(ch) ?? 1) - 1
      indeg.set(ch, d)
      if (d === 0) queue.push(ch)
    }
  }
  for (const t of tables) if (!level.has(t.name)) level.set(t.name, 0)
  const max = Math.max(0, ...level.values())
  const layers: string[][] = Array.from({ length: max + 1 }, () => [])
  for (const [n, l] of level) layers[l].push(n)
  layers.forEach((r) => r.sort((a, b) => a.localeCompare(b)))
  // A wide layer wraps, so the graph grows down rather than off to the side.
  const rows = layers.flatMap((r) => Array.from({ length: Math.max(1, Math.ceil(r.length / PER_ROW)) }, (_, i) => r.slice(i * PER_ROW, (i + 1) * PER_ROW)))
  const GAP_X = 72
  const GAP_Y = 96
  const widths = rows.map((r) => r.length * CARD_WIDTH + Math.max(0, r.length - 1) * GAP_X)
  const widest = Math.max(CARD_WIDTH, ...widths)
  const out = new Map<string, Box>()
  let y = 0
  rows.forEach((r, i) => {
    if (r.length === 0) return
    const x0 = Math.round((widest - widths[i]) / 2)
    let tallest = 0
    r.forEach((n, j) => {
      const h = cardHeight(cols.get(n)?.length ?? 0)
      out.set(n, { x: x0 + j * (CARD_WIDTH + GAP_X), y, width: CARD_WIDTH, height: h })
      tallest = Math.max(tallest, h)
    })
    y += tallest + GAP_Y
  })
  return out
}

/** A line from the referencing column to the referenced one, bending smoothly. */
function path(child: Box, ci: number, parent: Box, pi: number): { d: string; end: [number, number] } {
  const cy = child.y + HEADER + PAD + ci * COL + COL / 2
  const py = parent.y + HEADER + PAD + pi * COL + COL / 2
  if (parent.y + parent.height + 20 <= child.y) {
    const sx = parent.x + parent.width / 2
    const sy = parent.y + parent.height
    const ex = child.x + child.width / 2
    const ey = child.y
    const my = (sy + ey) / 2
    return { d: `M ${sx} ${sy} C ${sx} ${my}, ${ex} ${my}, ${ex} ${ey}`, end: [ex, ey] }
  }
  if (child.x >= parent.x + parent.width * 0.7) {
    const sx = parent.x + parent.width
    const ex = child.x
    const k = Math.max(32, (ex - sx) * 0.45)
    return { d: `M ${sx} ${py} C ${sx + k} ${py}, ${ex - k} ${cy}, ${ex} ${cy}`, end: [ex, cy] }
  }
  if (parent.x >= child.x + child.width * 0.7) {
    const sx = parent.x
    const ex = child.x + child.width
    const k = Math.max(32, (sx - ex) * 0.45)
    return { d: `M ${sx} ${py} C ${sx - k} ${py}, ${ex + k} ${cy}, ${ex} ${cy}`, end: [ex, cy] }
  }
  const sx = parent.x + parent.width
  const ex = child.x + child.width
  const lx = Math.max(sx, ex) + 40
  return { d: `M ${sx} ${py} C ${lx} ${py}, ${lx} ${cy}, ${ex} ${cy}`, end: [ex, cy] }
}

export function SchemaDiagram({ projectId, activeSchema, activeTable, databaseType = 'postgresql', onSelectTable, onOpenTableData }: SchemaDiagramProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [tables, setTables] = useState<TableInfo[]>([])
  const [cols, setCols] = useState<Map<string, ColumnInfo[]>>(new Map())
  const [edges, setEdges] = useState<Edge[]>([])
  const [boxes, setBoxes] = useState<Map<string, Box>>(new Map())
  const [pan, setPan] = useState({ x: 32, y: 72 })
  const [zoom, setZoom] = useState(1)
  const [size, setSize] = useState({ width: 900, height: 600 })
  const [focused, setFocused] = useState<string | null>(null)
  const [hovered, setHovered] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [fullscreen, setFullscreen] = useState(false)
  const [showMap, setShowMap] = useState(() => {
    try {
      return typeof window !== 'undefined' && window.localStorage.getItem('backenly_schema_minimap_open') === 'true'
    } catch {
      return false
    }
  })
  const drag = useRef<{ kind: 'pan' | 'card'; name?: string; x: number; y: number; ox: number; oy: number } | null>(null)
  const fitted = useRef(false)

  // ── Three reads ────────────────────────────────────────────────────────────
  const load = useCallback(async () => {
    setState('loading')
    try {
      const scope = { projectId: projectId || undefined }
      const [list, structure, rels] = await Promise.all([
        getTables(databaseType, activeSchema || 'public', scope),
        getSchemaStructure(databaseType, scope),
        getRelationships(activeSchema || 'public', undefined, scope).catch(() => []),
      ])
      const map = new Map<string, ColumnInfo[]>()
      for (const t of list) map.set(t.name, structure[t.name] ?? [])
      // r.from is the referenced table (the parent), r.to the referencing one (the child).
      const es: Edge[] = (Array.isArray(rels) ? rels : [])
        .filter((r) => r?.from?.table && r?.to?.table)
        .map((r, i) => ({ id: `${r.to.table}.${r.to.column}->${r.from.table}.${r.from.column}#${i}`, child: r.to.table, childCol: r.to.column, parent: r.from.table, parentCol: r.from.column }))
      setTables(list)
      setCols(map)
      setEdges(es)
      setBoxes(layout(list, map, es))
      fitted.current = false
      setState('ready')
    } catch {
      setState('failed')
    }
  }, [activeSchema, databaseType, projectId])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const update = () => el.clientWidth && el.clientHeight && setSize({ width: el.clientWidth, height: el.clientHeight })
    update()
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : null
    ro?.observe(el)
    return () => ro?.disconnect()
  }, [state, fullscreen])

  const fit = useCallback((readable = false) => {
    if (boxes.size === 0) return
    const all = [...boxes.values()]
    const minX = Math.min(...all.map((b) => b.x))
    const minY = Math.min(...all.map((b) => b.y))
    const maxX = Math.max(...all.map((b) => b.x + b.width))
    const maxY = Math.max(...all.map((b) => b.y + b.height))
    const top = 64
    const fits = Math.min((size.width - 48) / (maxX - minX), (size.height - top - 64) / (maxY - minY), 1.1)
    if (!readable || fits >= READABLE) {
      const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, fits))
      setZoom(z)
      setPan({ x: Math.round((size.width - (maxX - minX) * z) / 2 - minX * z), y: Math.round(top + Math.max(0, (size.height - top - 64 - (maxY - minY) * z) / 2) - minY * z) })
      return
    }
    // Too many tables to read at once: start where the graph starts, at a size that reads; Fit shows all.
    setZoom(READABLE)
    setPan({ x: Math.round(24 - minX * READABLE), y: Math.round(top - minY * READABLE) })
  }, [boxes, size])

  // The first view shows every table.
  useEffect(() => {
    if (state === 'ready' && !fitted.current && boxes.size > 0 && size.width > 0) {
      fitted.current = true
      fit(true)
    }
  }, [state, boxes, size, fit])

  const toggleMap = useCallback(() => {
    setShowMap((v) => {
      try {
        window.localStorage.setItem('backenly_schema_minimap_open', String(!v))
      } catch {
        /* a remembered choice, nothing more */
      }
      return !v
    })
  }, [])

  // ── Keys ───────────────────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'f' || e.key === 'F')) {
        e.preventDefault()
        searchRef.current?.focus()
        searchRef.current?.select()
        return
      }
      const t = e.target as HTMLElement | null
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) {
        if (e.key === 'Escape' && t === searchRef.current) searchRef.current?.blur()
        return
      }
      if (t?.closest('[role="dialog"],[role="menu"]')) return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === 'f' || e.key === 'F') {
        e.preventDefault()
        setFullscreen((v) => !v)
      } else if (e.key === 'm' || e.key === 'M') {
        e.preventDefault()
        toggleMap()
      } else if (e.key === '/') {
        e.preventDefault()
        searchRef.current?.focus()
      } else if (e.key === 'Escape') {
        if (focused) setFocused(null)
        else if (search) setSearch('')
        else if (fullscreen) setFullscreen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [focused, search, fullscreen, toggleMap])

  // ── Neighbours and search ──────────────────────────────────────────────────
  const neighbours = useMemo(() => {
    if (!focused) return null
    const near = new Set<string>([focused])
    for (const e of edges) {
      if (e.child === focused) near.add(e.parent)
      if (e.parent === focused) near.add(e.child)
    }
    return near
  }, [focused, edges])

  const columnSearch = search.trim().startsWith('/')
  const query = (columnSearch ? search.trim().slice(1) : search.trim()).toLowerCase()
  const { matchedTables, matchedCols } = useMemo(() => {
    if (!query) return { matchedTables: null as Set<string> | null, matchedCols: new Map<string, Set<string>>() }
    const ts = new Set<string>()
    const cs = new Map<string, Set<string>>()
    for (const t of tables) {
      if (columnSearch) {
        const hits = (cols.get(t.name) ?? []).filter((c) => c.name.toLowerCase().includes(query)).map((c) => c.name)
        if (hits.length) {
          ts.add(t.name)
          cs.set(t.name, new Set(hits))
        }
      } else if (t.name.toLowerCase().includes(query)) ts.add(t.name)
    }
    return { matchedTables: ts, matchedCols: cs }
  }, [query, columnSearch, tables, cols])

  // ── Pointer: pan the canvas, move a card ───────────────────────────────────
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !(e.target as HTMLElement).dataset.canvas) return
    setFocused(null)
    drag.current = { kind: 'pan', x: e.clientX, y: e.clientY, ox: pan.x, oy: pan.y }
    ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
  }
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d) return
    if (d.kind === 'pan') setPan({ x: d.ox + e.clientX - d.x, y: d.oy + e.clientY - d.y })
    else if (d.name) {
      const name = d.name
      setBoxes((prev) => {
        const next = new Map(prev)
        const b = next.get(name)
        if (b) next.set(name, { ...b, x: Math.round(d.ox + (e.clientX - d.x) / zoom), y: Math.round(d.oy + (e.clientY - d.y) / zoom) })
        return next
      })
    }
  }
  const onPointerUp = () => {
    drag.current = null
  }
  const startCardDrag = (e: ReactPointerEvent, name: string) => {
    if (e.button !== 0) return
    const b = boxes.get(name)
    if (!b) return
    e.stopPropagation()
    drag.current = { kind: 'card', name, x: e.clientX, y: e.clientY, ox: b.x, oy: b.y }
  }
  const onWheel = (e: ReactWheelEvent<HTMLDivElement>) => {
    const rect = containerRef.current?.getBoundingClientRect()
    if (!rect) return
    const factor = e.deltaY < 0 ? 1.08 : 0.92
    const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom * factor))
    // Zoom about the pointer, so what is under it stays under it.
    const px = e.clientX - rect.left
    const py = e.clientY - rect.top
    setPan({ x: px - ((px - pan.x) * next) / zoom, y: py - ((py - pan.y) * next) / zoom })
    setZoom(next)
  }
  const zoomBy = (f: number) => {
    const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom * f))
    const cx = size.width / 2
    const cy = size.height / 2
    setPan({ x: cx - ((cx - pan.x) * next) / zoom, y: cy - ((cy - pan.y) * next) / zoom })
    setZoom(next)
  }
  const arrange = () => {
    setBoxes(layout(tables, cols, edges))
    fitted.current = false
  }

  const shell = fullscreen ? 'fixed inset-0 z-[100] bg-[#0c0d0f]' : 'relative min-h-0 min-w-0 flex-1'

  if (state !== 'ready' || tables.length === 0) {
    return (
      <div className={`${shell} overflow-y-auto`}>
        {state === 'failed' ? (
          <ErrorRow things="the schema" stillWorks="The Tables and SQL tabs still work." onRetry={() => void load()} />
        ) : state === 'loading' ? (
          <p className="flex items-center gap-[8px] px-[20px] py-[16px] text-[12.5px] text-faint">
            <Spinner className="h-3.5 w-3.5" /> Reading the schema
          </p>
        ) : (
          <p className="px-[20px] py-[16px] text-[13px] leading-[20px] text-zinc-400">No tables yet. The graph draws itself as tables are added.</p>
        )}
      </div>
    )
  }

  const dimmed = (name: string) => (neighbours ? !neighbours.has(name) : matchedTables ? !matchedTables.has(name) : false)
  const edgeTone = (e: Edge) => {
    const touches = (n: string | null) => !!n && (e.child === n || e.parent === n)
    if (touches(focused) || touches(hovered)) return 'strong'
    if (neighbours && (!neighbours.has(e.child) || !neighbours.has(e.parent))) return 'faint'
    if (matchedTables && !matchedTables.has(e.child) && !matchedTables.has(e.parent)) return 'faint'
    return 'normal'
  }

  return (
    <div
      ref={containerRef}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={onPointerUp}
      onWheel={onWheel}
      data-canvas="true"
      aria-label="Schema graph"
      className={`${shell} cursor-grab touch-none select-none overflow-hidden active:cursor-grabbing`}
      style={{ backgroundImage: 'radial-gradient(rgba(255,255,255,0.05) 1px, transparent 1px)', backgroundSize: '24px 24px', backgroundPosition: `${pan.x}px ${pan.y}px` }}
    >
      {/* Search and facts, top left. */}
      <div className="absolute left-[16px] right-[16px] top-[12px] z-30 flex flex-wrap items-center gap-x-[14px] gap-y-[8px]">
        <span className="w-[240px] max-w-full">
        <input
          ref={searchRef}
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Find a table, or /column"
          aria-label="Find a table, or a column after a slash"
          className={`${INPUT_BASE} h-[32px] px-[10px]`}
        />
        </span>
        <span className="text-[12.5px] tabular-nums text-faint">{tables.length.toLocaleString('en-US')} {tables.length === 1 ? 'table' : 'tables'}</span>
        <span className="text-[12.5px] tabular-nums text-faint">{edges.length.toLocaleString('en-US')} {edges.length === 1 ? 'relationship' : 'relationships'}</span>
        {matchedTables && <span className="text-[12.5px] tabular-nums text-zinc-300">{matchedTables.size} found</span>}
        {focused && (
          <span className="inline-flex h-[28px] items-center gap-[4px] rounded-[7px] border border-white/[0.12] bg-[#141518] pl-[10px] pr-[2px] text-[12.5px] text-zinc-200">
            Neighbours of <span className="font-mono">{focused}</span>
            <button type="button" onClick={() => setFocused(null)} aria-label="Show every table" className={`flex h-[24px] w-[24px] items-center justify-center rounded-[5px] text-zinc-400 hover:text-zinc-100 ${FOCUS}`}>
              <X className="h-[12px] w-[12px]" />
            </button>
          </span>
        )}
      </div>

      {/* The canvas. */}
      <div data-canvas="true" className="absolute inset-0 origin-top-left" style={{ transform: `translate3d(${pan.x}px, ${pan.y}px, 0) scale(${zoom})` }}>
        <svg className="pointer-events-none absolute left-0 top-0 overflow-visible" width="1" height="1" aria-hidden>
          {edges.map((e) => {
            const c = boxes.get(e.child)
            const p = boxes.get(e.parent)
            if (!c || !p) return null
            const ci = Math.max(0, (cols.get(e.child) ?? []).findIndex((x) => x.name === e.childCol))
            const pi = Math.max(0, (cols.get(e.parent) ?? []).findIndex((x) => x.name === e.parentCol))
            const { d, end } = path(c, ci, p, pi)
            const tone = edgeTone(e)
            const stroke = tone === 'strong' ? 'rgba(255,255,255,0.72)' : tone === 'faint' ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.2)'
            return (
              <g key={e.id}>
                <path d={d} fill="none" stroke={stroke} strokeWidth={tone === 'strong' ? 1.5 : 1} />
                <circle cx={end[0]} cy={end[1]} r={2.5} fill={stroke} />
              </g>
            )
          })}
        </svg>

        {tables.map((t) => {
          const b = boxes.get(t.name)
          if (!b) return null
          const list = cols.get(t.name) ?? []
          const isFocus = focused === t.name
          const isActive = activeTable === t.name
          const dim = dimmed(t.name)
          return (
            <div
              key={t.name}
              onMouseEnter={() => setHovered(t.name)}
              onMouseLeave={() => setHovered(null)}
              style={{ transform: `translate3d(${b.x}px, ${b.y}px, 0)`, width: b.width }}
              className={`absolute left-0 top-0 rounded-[10px] border bg-[#111215] transition-[opacity,border-color] duration-150 ${
                isFocus ? 'z-20 border-white/70' : neighbours?.has(t.name) ? 'z-10 border-white/25' : isActive ? 'border-white/30' : 'border-white/[0.09]'
              } ${dim ? 'opacity-25' : ''}`}
            >
              <div onPointerDown={(e) => startCardDrag(e, t.name)} className={`flex h-[38px] cursor-grab items-center gap-[8px] border-b ${RULE} pl-[12px] pr-[6px] active:cursor-grabbing`}>
                <button
                  type="button"
                  onClick={() => {
                    setFocused((f) => (f === t.name ? null : t.name))
                    onSelectTable?.(t.name)
                  }}
                  aria-pressed={isFocus}
                  title={isFocus ? 'Show every table' : 'Show its neighbours'}
                  className={`min-w-0 flex-1 truncate rounded-[4px] text-left font-mono text-[12.5px] font-medium text-white ${FOCUS}`}
                >
                  {t.name}
                </button>
                <span className="flex-shrink-0 text-[12px] tabular-nums text-faint">{(t.rows ?? 0).toLocaleString('en-US')}</span>
                {onOpenTableData && (
                  <button
                    type="button"
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={() => onOpenTableData(t.name)}
                    aria-label={`Open the rows of ${t.name}`}
                    title="Open its rows"
                    className={`flex h-[24px] w-[24px] flex-shrink-0 items-center justify-center rounded-[6px] text-zinc-500 transition-colors duration-150 hover:bg-white/[0.06] hover:text-zinc-100 ${FOCUS}`}
                  >
                    <Rows className="h-[13px] w-[13px]" strokeWidth={1.75} />
                  </button>
                )}
              </div>
              <ul className="py-[6px]">
                {list.length === 0 ? (
                  <li className="flex h-[26px] items-center px-[12px] text-[12px] text-faint">Columns not read</li>
                ) : (
                  list.map((c) => {
                    const hit = matchedCols.get(t.name)?.has(c.name)
                    return (
                      <li key={c.name} className={`flex h-[26px] items-center gap-[6px] px-[12px] ${hit ? 'bg-white/[0.08]' : ''}`}>
                        <span className="flex h-[12px] w-[12px] flex-shrink-0 items-center justify-center">
                          {c.primary ? (
                            <KeyRound aria-label="Primary key" className="h-[11px] w-[11px] text-zinc-400" strokeWidth={2} />
                          ) : c.foreign ? (
                            <Link2 aria-label="Foreign key" className="h-[11px] w-[11px] text-zinc-400" strokeWidth={2} />
                          ) : null}
                        </span>
                        <span className={`min-w-0 flex-1 truncate font-mono text-[12px] ${hit ? 'text-white' : 'text-zinc-300'}`}>{c.name}</span>
                        <span className="max-w-[88px] flex-shrink-0 truncate font-mono text-[11px] text-faint">{c.type}</span>
                      </li>
                    )
                  })
                )}
              </ul>
            </div>
          )
        })}
      </div>

      {showMap && <Minimap boxes={boxes} pan={pan} zoom={zoom} size={size} focused={focused} onJump={setPan} />}

      {/* One control group, bottom right. */}
      <div className="absolute bottom-[16px] right-[16px] z-30 flex items-center gap-[2px] rounded-[9px] border border-white/[0.09] bg-[#141518] p-[3px]">
        <Control label="Zoom out" onClick={() => zoomBy(0.85)} icon={Minus} />
        <span className="w-[42px] text-center text-[12px] tabular-nums text-faint">{Math.round(zoom * 100)}%</span>
        <Control label="Zoom in" onClick={() => zoomBy(1.18)} icon={Plus} />
        <span aria-hidden className="mx-[3px] h-[16px] w-px bg-white/[0.09]" />
        <Control label="Fit every table" onClick={() => fit()} icon={Expand} />
        <Control label="Arrange" onClick={arrange} icon={LayoutGrid} />
        <Control label={fullscreen ? 'Leave full screen (F)' : 'Full screen (F)'} onClick={() => setFullscreen((v) => !v)} icon={fullscreen ? Minimize2 : Maximize2} />
        <Control label={showMap ? 'Hide the map (M)' : 'Show the map (M)'} onClick={toggleMap} icon={MapIcon} pressed={showMap} />
      </div>
    </div>
  )
}

function Control({ label, onClick, icon: Icon, pressed }: { label: string; onClick: () => void; icon: typeof Plus; pressed?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-pressed={pressed}
      title={label}
      className={`flex h-[28px] w-[28px] items-center justify-center rounded-[6px] transition-colors duration-150 ${FOCUS} ${pressed ? 'bg-white/[0.09] text-zinc-100' : 'text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-100'}`}
    >
      <Icon className="h-[14px] w-[14px]" strokeWidth={1.75} />
    </button>
  )
}

/** The whole graph small, with the visible part outlined; click to look elsewhere. */
function Minimap({
  boxes,
  pan,
  zoom,
  size,
  focused,
  onJump,
}: {
  boxes: Map<string, Box>
  pan: { x: number; y: number }
  zoom: number
  size: { width: number; height: number }
  focused: string | null
  onJump: (p: { x: number; y: number }) => void
}) {
  const W = 192
  const H = 112
  const all = [...boxes.values()]
  const minX = Math.min(0, ...all.map((b) => b.x)) - 40
  const minY = Math.min(0, ...all.map((b) => b.y)) - 40
  const maxX = Math.max(...all.map((b) => b.x + b.width)) + 40
  const maxY = Math.max(...all.map((b) => b.y + b.height)) + 40
  const s = Math.min((W - 12) / (maxX - minX), (H - 12) / (maxY - minY))
  const ox = (W - (maxX - minX) * s) / 2
  const oy = (H - (maxY - minY) * s) / 2
  const vx = ox + (-pan.x / zoom - minX) * s
  const vy = oy + (-pan.y / zoom - minY) * s
  return (
    <div
      // A pointer convenience: Fit and the zoom buttons do the same from the keyboard.
      aria-hidden
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        const r = e.currentTarget.getBoundingClientRect()
        const wx = minX + (e.clientX - r.left - ox) / s
        const wy = minY + (e.clientY - r.top - oy) / s
        onJump({ x: Math.round(size.width / 2 - wx * zoom), y: Math.round(size.height / 2 - wy * zoom) })
      }}
      style={{ width: W, height: H }}
      className="absolute bottom-[16px] left-[16px] z-30 cursor-crosshair overflow-hidden rounded-[9px] border border-white/[0.09] bg-[#141518]"
    >
      {[...boxes.entries()].map(([name, b]) => (
        <span
          key={name}
          className={`absolute rounded-[1.5px] ${name === focused ? 'bg-white' : 'bg-zinc-500'}`}
          style={{ left: ox + (b.x - minX) * s, top: oy + (b.y - minY) * s, width: Math.max(4, b.width * s), height: Math.max(3, b.height * s) }}
        />
      ))}
      <span
        aria-hidden
        className="absolute rounded-[2px] border border-white/60"
        style={{ left: vx, top: vy, width: Math.min(W, (size.width / zoom) * s), height: Math.min(H, (size.height / zoom) * s) }}
      />
    </div>
  )
}

export default SchemaDiagram
