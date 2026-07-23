'use client'

import { useMemo, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import ReactFlow, {
  Background,
  Handle,
  Position,
  BackgroundVariant,
  BaseEdge,
  EdgeLabelRenderer,
  getSmoothStepPath,
  type NodeTypes,
  type EdgeTypes,
  type Node,
  type Edge,
  type EdgeProps,
} from 'reactflow'
import 'reactflow/dist/style.css'
import { Database, Shield } from 'lucide-react'
import dagre from '@dagrejs/dagre'

// ─── Types ──────────────────────────────────────────────────────────────────

interface Entity {
  name: string
  fieldCount: number
  fields?: Array<{ name: string; type: string }>
}

interface Api {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH'
  path: string
}

export interface ArchitectureCanvasProps {
  projectId: string
  entities: Entity[]
  apis: Api[]
  authEnabled: boolean
  isConnected?: boolean
}

// ─── Human-readable action labels ────────────────────────────────────────────

// Per-resource action vocabulary — reads like a product, not an API reference
const RESOURCE_ACTIONS: Record<string, Record<string, string>> = {
  // Auth actions (fixed, shown inside auth node — not derived from APIs)
  // Table-level actions by resource name
  users:    { GET: 'View profile',    POST: 'Create account', PUT: 'Update profile',  PATCH: 'Update profile',  DELETE: 'Delete account' },
  posts:    { GET: 'View posts',      POST: 'Create post',    PUT: 'Edit post',       PATCH: 'Edit post',       DELETE: 'Delete post'    },
  comments: { GET: 'View comments',   POST: 'Add comment',    PUT: 'Edit comment',    PATCH: 'Edit comment',    DELETE: 'Delete comment' },
  reviews:  { GET: 'View reviews',    POST: 'Write review',   PUT: 'Edit review',     PATCH: 'Edit review',     DELETE: 'Delete review'  },
  articles: { GET: 'View articles',   POST: 'Write article',  PUT: 'Edit article',    PATCH: 'Edit article',    DELETE: 'Delete article' },
  messages: { GET: 'View messages',   POST: 'Send message',   PUT: 'Edit message',    PATCH: 'Edit message',    DELETE: 'Delete message' },
  orders:   { GET: 'View orders',     POST: 'Place order',    PUT: 'Update order',    PATCH: 'Update order',    DELETE: 'Cancel order'   },
  products: { GET: 'View products',   POST: 'Add product',    PUT: 'Update product',  PATCH: 'Update product',  DELETE: 'Remove product' },
  profiles: { GET: 'View profile',    POST: 'Create profile', PUT: 'Update profile',  PATCH: 'Update profile',  DELETE: 'Delete profile' },
  tags:     { GET: 'View tags',       POST: 'Add tag',        PUT: 'Update tag',      PATCH: 'Update tag',      DELETE: 'Remove tag'     },
  likes:    { GET: 'View likes',      POST: 'Like',           PUT: 'Update like',     PATCH: 'Update like',     DELETE: 'Unlike'         },
  files:    { GET: 'View files',      POST: 'Upload file',    PUT: 'Update file',     PATCH: 'Update file',     DELETE: 'Delete file'    },
}

// Edge actions between two models — tells the story of their relationship
const EDGE_ACTIONS: Record<string, Record<string, string>> = {
  users:    { posts: 'Create post', comments: 'Add comment', reviews: 'Write review', messages: 'Send message', orders: 'Place order', likes: 'Like content' },
  posts:    { comments: 'Add comment', reviews: 'Write review', tags: 'Add tag', likes: 'Get liked' },
  articles: { comments: 'Add comment', tags: 'Add tag' },
  orders:   { products: 'Contains product' },
}

function getResourceActions(resourceName: string, apis: Api[]): string[] {
  const key = resourceName.toLowerCase()
  const vocab = RESOURCE_ACTIONS[key]
  const seen = new Set<string>()
  const actions: string[] = []

  apis.forEach(api => {
    const action = vocab?.[api.method] ?? fallbackAction(api.method, resourceName)
    if (!seen.has(action)) { seen.add(action); actions.push(action) }
  })

  return actions.slice(0, 4)
}

function fallbackAction(method: string, resource: string): string {
  const name = resource.toLowerCase()
  const singular = name.endsWith('s') ? name.slice(0, -1) : name
  switch (method) {
    case 'GET':    return `View ${name}`
    case 'POST':   return `Create ${singular}`
    case 'PUT':
    case 'PATCH':  return `Edit ${singular}`
    case 'DELETE': return `Delete ${singular}`
    default:       return `Manage ${name}`
  }
}

function getEdgeAction(from: string, to: string): string {
  const f = from.toLowerCase(), t = to.toLowerCase()
  return EDGE_ACTIONS[f]?.[t] ?? EDGE_ACTIONS[f]?.[t + 's'] ?? `Manage ${t}`
}

// ─── Node dimensions ─────────────────────────────────────────────────────────

const DIMS = {
  auth:  { w: 200, h: 130 },
  table: { w: 185, h: 115 },
}

// ─── Auth Node ────────────────────────────────────────────────────────────────

function AuthNode({ data }: { data: any }) {
  return (
    <div
      onClick={data.onClick}
      className="flex flex-col gap-2 bg-[#071510] border-2 border-emerald-500/50 hover:border-emerald-400/80 rounded-2xl p-4 cursor-pointer transition-all shadow-lg shadow-emerald-950/30"
      style={{ width: DIMS.auth.w }}
    >
      <Handle type="target" position={Position.Left}   style={{ background: '#10b981', border: 'none', width: 8, height: 8 }} />
      <Handle type="source" position={Position.Right}  style={{ background: '#10b981', border: 'none', width: 8, height: 8 }} />
      <Handle type="source" position={Position.Bottom} style={{ background: '#10b981', border: 'none', width: 8, height: 8 }} />
      <Handle type="target" position={Position.Top}    style={{ background: '#10b981', border: 'none', width: 8, height: 8 }} />

      <div className="flex items-center gap-2.5">
        <div className="w-7 h-7 rounded-lg bg-emerald-500/15 flex items-center justify-center flex-shrink-0">
          <Shield className="w-4 h-4 text-emerald-400" />
        </div>
        <div>
          <p className="text-[12px] font-bold text-emerald-200">Authentication</p>
          <p className="text-[10px] text-emerald-500/70">JWT · Email + Password</p>
        </div>
      </div>

      <div className="border-t border-emerald-900/40 pt-1.5 space-y-1">
        {['Signup', 'Login', 'Get current user'].map(a => (
          <div key={a} className="text-[10px] text-slate-400 flex items-center gap-1.5">
            <span className="w-1 h-1 rounded-full bg-emerald-500/60 flex-shrink-0" />
            {a}
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── Table / Data Model Node ──────────────────────────────────────────────────

function TableNode({ data }: { data: any }) {
  const actions: string[] = data.actions ?? []
  return (
    <div
      onClick={data.onClick}
      className="flex flex-col gap-2 bg-[#0e0918] border-2 border-purple-500/40 hover:border-purple-400/70 rounded-xl px-4 py-3 cursor-pointer transition-all shadow-lg shadow-purple-950/30"
      style={{ width: DIMS.table.w }}
    >
      <Handle type="target" position={Position.Top}    style={{ background: '#a855f7', border: 'none', width: 8, height: 8 }} />
      <Handle type="source" position={Position.Bottom} style={{ background: '#a855f7', border: 'none', width: 8, height: 8 }} />
      <Handle type="target" position={Position.Left}   style={{ background: '#a855f7', border: 'none', width: 8, height: 8 }} />
      <Handle type="source" position={Position.Right}  style={{ background: '#a855f7', border: 'none', width: 8, height: 8 }} />

      <div className="flex items-center gap-2.5">
        <div className="w-7 h-7 rounded-lg bg-purple-500/15 flex items-center justify-center flex-shrink-0">
          <Database className="w-3.5 h-3.5 text-purple-400" />
        </div>
        <div>
          <p className="text-[13px] font-bold text-purple-100 capitalize">{data.label}</p>
          <p className="text-[10px] text-purple-500/60">{data.fieldCount} fields</p>
        </div>
      </div>

      {actions.length > 0 && (
        <div className="border-t border-purple-900/30 pt-1.5 space-y-1">
          {actions.map(a => (
            <div key={a} className="text-[10px] text-slate-400 flex items-center gap-1.5">
              <span className="w-1 h-1 rounded-full bg-purple-500/60 flex-shrink-0" />
              {a}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Custom Edge with action pill labels ──────────────────────────────────────

function ActionLabelEdge({
  id, sourceX, sourceY, targetX, targetY,
  sourcePosition, targetPosition, data,
}: EdgeProps) {
  const [edgePath, labelX, labelY] = getSmoothStepPath({
    sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition,
  })
  const pills: string[] = data?.pills ?? []

  return (
    <>
      <BaseEdge id={id} path={edgePath} style={{ stroke: '#374151', strokeWidth: 1.5, opacity: 0.7 }} />
      <EdgeLabelRenderer>
        <div
          style={{ transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)` }}
          className="absolute pointer-events-none flex flex-col gap-0.5 items-center nodrag nopan"
        >
          {pills.map((pill, i) => (
            <span key={i} className="px-2 py-0.5 rounded-full text-[9px] font-medium text-slate-300 bg-slate-800/80 border border-slate-700/50 whitespace-nowrap">
              {pill}
            </span>
          ))}
        </div>
      </EdgeLabelRenderer>
    </>
  )
}

const nodeTypes: NodeTypes = { auth: AuthNode, table: TableNode }
const edgeTypes: EdgeTypes = { apiLabel: ActionLabelEdge }

// ─── Relationship / chain detection ──────────────────────────────────────────

function detectTableEdges(entities: Entity[]): Array<{ parent: string; child: string }> {
  const names = new Set(entities.map(e => e.name))
  const edges: Array<{ parent: string; child: string }> = []
  entities.forEach(child => {
    ;(child.fields ?? []).forEach(f => {
      const raw = f.name.match(/^(.+?)Id$/)?.[1] ?? f.name.match(/^(.+?)_id$/)?.[1]
      if (!raw) return
      for (const cand of [raw, raw + 's', raw.replace(/s$/, '')]) {
        if (names.has(cand) && cand !== child.name) {
          if (!edges.some(e => e.parent === cand && e.child === child.name))
            edges.push({ parent: cand, child: child.name })
          break
        }
      }
    })
  })
  return edges
}

// Guess which table an API path targets
function guessTable(api: Api, entityNames: string[]): string | null {
  const segment = api.path.toLowerCase().replace(/^\/api\/v\d+/, '').split('/').filter(s => s && !s.startsWith(':'))[0] ?? ''
  for (const name of entityNames) {
    const n = name.toLowerCase()
    if (segment === n || segment === n + 's' || segment.startsWith(n)) return name
  }
  return null
}

// ─── Dagre TB layout ──────────────────────────────────────────────────────────

function applyDagre(nodes: Node[], edges: Edge[]): Node[] {
  const g = new dagre.graphlib.Graph()
  g.setDefaultEdgeLabel(() => ({}))
  g.setGraph({ rankdir: 'LR', ranksep: 90, nodesep: 50, marginx: 60, marginy: 50 })
  nodes.forEach(n => {
    const d = DIMS[n.type as keyof typeof DIMS] ?? { w: 185, h: 115 }
    g.setNode(n.id, { width: d.w, height: d.h })
  })
  edges.forEach(e => g.setEdge(e.source, e.target))
  dagre.layout(g)
  return nodes.map(n => {
    const pos = g.node(n.id)
    const d = DIMS[n.type as keyof typeof DIMS] ?? { w: 185, h: 115 }
    return { ...n, position: { x: pos.x - d.w / 2, y: pos.y - d.h / 2 } }
  })
}

// ─── Graph builder ────────────────────────────────────────────────────────────

function buildGraph(
  projectId: string,
  entities: Entity[],
  apis: Api[],
  authEnabled: boolean,
  navigate: (p: string) => void,
): { nodes: Node[]; edges: Edge[] } {
  const go = (path: string) => navigate(`/app/projects/${projectId}/inspector${path}`)
  const nodes: Node[] = []
  const edges: Edge[] = []
  const entityNames = entities.map(e => e.name)

  // Real FK-derived relationships (e.g. posts.user_id → users, comments.post_id → posts)
  const fkEdges = detectTableEdges(entities)

  // Collect APIs per table
  const apisByTable: Record<string, Api[]> = {}
  apis.forEach(api => {
    const table = guessTable(api, entityNames)
    if (!table) return
    if (!apisByTable[table]) apisByTable[table] = []
    if (!apisByTable[table].some(a => a.method === api.method && a.path === api.path))
      apisByTable[table].push(api)
  })

  // Auth node
  if (authEnabled) {
    nodes.push({
      id: 'auth', type: 'auth', position: { x: 0, y: 0 },
      data: { onClick: () => go('/auth') },
    })
  }

  // Table nodes
  entities.forEach(ent => {
    nodes.push({
      id: `table-${ent.name}`, type: 'table', position: { x: 0, y: 0 },
      data: {
        label: ent.name,
        fieldCount: ent.fieldCount,
        actions: getResourceActions(ent.name, apisByTable[ent.name] ?? []),
        onClick: () => go('/tables'),
      },
    })
  })

  // Auth → root tables (tables that are NOT a child of any other table)
  const childTables = new Set(fkEdges.map(e => e.child))
  const rootTables = entities.filter(e => !childTables.has(e.name))

  if (authEnabled) {
    rootTables.forEach(rt => {
      edges.push({
        id: `e-auth-${rt.name}`,
        source: 'auth', target: `table-${rt.name}`,
        type: 'apiLabel', data: { pills: [] },
      })
    })
  }

  // FK-derived table→table edges with real story labels
  fkEdges.forEach(({ parent, child }) => {
    edges.push({
      id: `e-${parent}-${child}`,
      source: `table-${parent}`, target: `table-${child}`,
      type: 'apiLabel',
      data: { pills: [getEdgeAction(parent, child)] },
    })
  })

  return { nodes: applyDagre(nodes, edges), edges }
}

// ─── Component ────────────────────────────────────────────────────────────────

export function ArchitectureCanvas({
  projectId, entities, apis, authEnabled,
}: ArchitectureCanvasProps) {
  const router = useRouter()
  const navigate = useCallback((p: string) => router.push(p), [router])

  const { nodes, edges } = useMemo(
    () => buildGraph(projectId, entities, apis, authEnabled, navigate),
    [projectId, entities, apis, authEnabled, navigate],
  )

  if (entities.length === 0 && apis.length === 0) return null

  return (
    <div className="rounded-xl border border-slate-800/60 bg-[#070c18] overflow-hidden">
      <div className="px-5 py-3.5 border-b border-slate-800/50 flex items-center justify-between">
        <div>
          <p className="text-[11px] text-slate-400 uppercase tracking-widest font-semibold">
            Backend System Flow
          </p>
          <p className="text-[10px] text-slate-600 mt-0.5">
            How your backend processes requests
          </p>
        </div>
        <p className="text-[10px] text-slate-600">Click any node to inspect</p>
      </div>

      <div style={{ height: 520 }}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          fitView
          fitViewOptions={{ padding: 0.2, minZoom: 0.3 }}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          panOnDrag
          zoomOnScroll
          minZoom={0.15}
          maxZoom={1.8}
          proOptions={{ hideAttribution: true }}
        >
          <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="#161f35" />
        </ReactFlow>
      </div>
    </div>
  )
}
