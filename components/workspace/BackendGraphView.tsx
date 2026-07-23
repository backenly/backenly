'use client'

import { motion } from 'framer-motion'
import { useRouter } from 'next/navigation'
import { Database, Shield, Monitor, ArrowRight } from 'lucide-react'

interface Entity {
  name: string
  fieldCount: number
  fields?: Array<{ name: string; type: string }>
}

interface Api {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH'
  path: string
}

interface BackendGraphViewProps {
  projectId: string
  entities: Entity[]
  apis: Api[]
  authEnabled: boolean
  isConnected?: boolean
}

// ─── Edge detection ────────────────────────────────────────────────────────

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

function buildRelationshipRows(edges: Edge[]): string[][] {
  if (edges.length === 0) return []
  const rows: string[][] = []
  edges.forEach(({ parent, child }) => {
    const row = [parent, child]
    let current = child
    for (let i = 0; i < 8; i++) {
      const next = edges.find(e => e.parent === current)
      if (!next) break
      row.push(next.child)
      current = next.child
    }
    rows.push(row)
  })
  // Remove sub-sequences
  return rows.filter((row, i) =>
    !rows.some((other, j) => i !== j && other.length > row.length && row.every((n, idx) => other[idx] === n))
  )
}

// ─── Node components ───────────────────────────────────────────────────────

const METHOD_COLORS: Record<string, string> = {
  GET: 'text-emerald-400 bg-emerald-400/10',
  POST: 'text-blue-400 bg-blue-400/10',
  PUT: 'text-amber-500 bg-amber-400/10',
  PATCH: 'text-orange-400 bg-orange-400/10',
  DELETE: 'text-red-400 bg-red-400/10',
}

function NodeCard({
  icon,
  title,
  subtitle,
  children,
  accent,
  onClick,
  delay = 0,
}: {
  icon: React.ReactNode
  title: string
  subtitle?: string
  children?: React.ReactNode
  accent?: 'purple' | 'emerald' | 'blue' | 'slate'
  onClick?: () => void
  delay?: number
}) {
  const borderColor = {
    purple: 'border-purple-500/25 hover:border-purple-500/50',
    emerald: 'border-emerald-500/25 hover:border-emerald-500/50',
    blue: 'border-blue-500/20 hover:border-blue-500/40',
    slate: 'border-slate-700/60 hover:border-slate-600',
  }[accent || 'slate']

  const glowColor = {
    purple: 'shadow-purple-500/10',
    emerald: 'shadow-emerald-500/10',
    blue: 'shadow-blue-500/10',
    slate: '',
  }[accent || 'slate']

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay }}
      onClick={onClick}
      className={`bg-[#0B1220] border rounded-xl p-4 min-w-[140px] shadow-lg ${borderColor} ${glowColor} ${onClick ? 'cursor-pointer' : ''} transition-all duration-200`}
    >
      <div className="flex items-center gap-2 mb-2">
        <div className={`w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 ${
          accent === 'purple' ? 'bg-purple-500/15' :
          accent === 'emerald' ? 'bg-emerald-500/15' :
          accent === 'blue' ? 'bg-blue-500/15' :
          'bg-slate-800'
        }`}>
          {icon}
        </div>
        <div>
          <p className="text-[12px] font-semibold text-slate-200 leading-tight">{title}</p>
          {subtitle && <p className="text-[10px] text-slate-500 leading-tight">{subtitle}</p>}
        </div>
      </div>
      {children}
    </motion.div>
  )
}

function EdgeArrow({ label }: { label?: string }) {
  return (
    <div className="flex flex-col items-center justify-center px-2 flex-shrink-0 self-center">
      {label && (
        <span className="text-[9px] text-slate-700 font-mono mb-0.5 whitespace-nowrap">{label}</span>
      )}
      <div className="flex items-center">
        <div className="w-5 h-px bg-slate-700" />
        <svg width="5" height="7" viewBox="0 0 5 7" className="text-slate-700">
          <polyline points="0,0 5,3.5 0,7" stroke="currentColor" strokeWidth="1.5"
            fill="none" strokeLinejoin="round" strokeLinecap="round" />
        </svg>
      </div>
    </div>
  )
}

// ─── Main component ─────────────────────────────────────────────────────────

export function BackendGraphView({
  projectId,
  entities,
  apis,
  authEnabled,
  isConnected,
}: BackendGraphViewProps) {
  const router = useRouter()
  const goTo = (path: string) => router.push(`/app/projects/${projectId}/inspector${path}`)

  const edges = detectEdges(entities)
  const rows = buildRelationshipRows(edges)
  const entityMap = new Map(entities.map(e => [e.name, e]))

  // Tables with no edges
  const involved = new Set(edges.flatMap(e => [e.parent, e.child]))
  const standalone = entities.filter(e => !involved.has(e.name))

  // Show top 3 APIs
  const topApis = apis.slice(0, 3)
  const moreApis = apis.length - 3

  return (
    <div className="rounded-xl border border-slate-800/60 bg-[#080e1a] overflow-hidden">
      {/* Header */}
      <div className="px-5 pt-5 pb-4 border-b border-slate-800/50">
        <p className="text-[11px] text-slate-500 uppercase tracking-widest font-semibold mb-0.5">
          Backend Architecture
        </p>
        <p className="text-[11px] text-slate-600">
          Visual overview of your backend system
        </p>
      </div>

      <div className="p-5 space-y-6">

        {/* ── Row 1: Frontend → Auth → Data layer ── */}
        <div className="flex items-start gap-3 flex-wrap">

          {/* Frontend node */}
          <NodeCard
            icon={<Monitor className="w-4 h-4 text-slate-400" />}
            title="Frontend"
            subtitle={isConnected ? 'Connected' : 'Not connected'}
            accent="slate"
            onClick={() => goTo('/sdk')}
            delay={0}
          />

          <EdgeArrow />

          {/* Auth node */}
          {authEnabled && (
            <>
              <NodeCard
                icon={<Shield className="w-4 h-4 text-emerald-400" />}
                title="Auth"
                subtitle="JWT · Email"
                accent="emerald"
                onClick={() => goTo('/auth')}
                delay={0.06}
              />
              <EdgeArrow />
            </>
          )}

          {/* Tables node — shows count + names */}
          <NodeCard
            icon={<Database className="w-4 h-4 text-purple-400" />}
            title={`${entities.length} Tables`}
            subtitle="Data layer"
            accent="purple"
            onClick={() => goTo('/tables')}
            delay={0.1}
          >
            <div className="mt-1 space-y-0.5">
              {entities.slice(0, 4).map(e => (
                <div key={e.name} className="flex items-center justify-between text-[10px]">
                  <span className="text-slate-400">{e.name}</span>
                  <span className="text-slate-600">{e.fieldCount}f</span>
                </div>
              ))}
              {entities.length > 4 && (
                <p className="text-[10px] text-slate-600">+{entities.length - 4} more</p>
              )}
            </div>
          </NodeCard>

          <EdgeArrow />

          {/* API node */}
          <NodeCard
            icon={<ArrowRight className="w-4 h-4 text-blue-400" />}
            title={`${apis.length} APIs`}
            subtitle="REST endpoints"
            accent="blue"
            onClick={() => goTo('/database')}
            delay={0.14}
          >
            <div className="mt-1 space-y-0.5">
              {topApis.map((api, i) => (
                <div key={i} className="flex items-center gap-1.5 text-[10px]">
                  <span className={`px-1 rounded font-mono font-bold ${METHOD_COLORS[api.method] || 'text-slate-400'}`}>
                    {api.method}
                  </span>
                  <span className="text-slate-400 truncate max-w-[80px]">{api.path}</span>
                </div>
              ))}
              {moreApis > 0 && (
                <p className="text-[10px] text-slate-600">+{moreApis} more</p>
              )}
            </div>
          </NodeCard>
        </div>

        {/* ── Row 2: Table relationships ── */}
        {(rows.length > 0 || standalone.length > 0) && (
          <div>
            <p className="text-[10px] text-slate-600 uppercase tracking-wider font-semibold mb-3">
              Data Relationships
            </p>
            <div className="space-y-2">
              {rows.map((row, ri) => (
                <motion.div
                  key={row.join('>')}
                  initial={{ opacity: 0, x: -4 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: 0.18 + ri * 0.05 }}
                  className="flex items-center flex-wrap gap-0"
                >
                  {row.map((name, idx) => {
                    const entity = entityMap.get(name)
                    return (
                      <div key={`${ri}-${name}-${idx}`} className="flex items-center">
                        <div
                          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-slate-700/60 bg-[#0d1525] cursor-pointer hover:border-purple-500/30 transition-colors"
                          onClick={() => goTo('/tables')}
                        >
                          <Database className="w-3 h-3 text-slate-600 flex-shrink-0" />
                          <span className="text-[11px] font-medium text-slate-300">{name}</span>
                          {entity && <span className="text-[10px] text-slate-600">{entity.fieldCount}</span>}
                        </div>
                        {idx < row.length - 1 && (
                          <div className="flex items-center px-1.5">
                            <div className="w-4 h-px bg-slate-700" />
                            <svg width="5" height="7" viewBox="0 0 5 7" className="text-slate-700">
                              <polyline points="0,0 5,3.5 0,7" stroke="currentColor" strokeWidth="1.5"
                                fill="none" strokeLinejoin="round" strokeLinecap="round" />
                            </svg>
                          </div>
                        )}
                      </div>
                    )
                  })}
                </motion.div>
              ))}

              {/* Standalone tables */}
              {standalone.length > 0 && (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ delay: 0.18 + rows.length * 0.05 }}
                  className="flex flex-wrap gap-1.5"
                >
                  {standalone.map(e => (
                    <div
                      key={e.name}
                      className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-slate-800 bg-[#0d1525] cursor-pointer hover:border-slate-700 transition-colors"
                      onClick={() => goTo('/tables')}
                    >
                      <Database className="w-3 h-3 text-slate-600 flex-shrink-0" />
                      <span className="text-[11px] font-medium text-slate-400">{e.name}</span>
                      <span className="text-[10px] text-slate-600">{e.fieldCount}</span>
                    </div>
                  ))}
                </motion.div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
