'use client'

import { useState } from 'react'
import { ChevronDown, ChevronRight, CheckCircle2, AlertCircle, Clock, Lightbulb, Settings, Code, Eye } from 'lucide-react'

type FeatureStatus = 'active' | 'draft' | 'disabled' | 'suggested'

interface Endpoint {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH'
  path: string
}

interface Feature {
  id: string
  icon: React.ReactNode
  title: string
  status: FeatureStatus
  endpoints: Endpoint[]
}

interface FeatureListProps {
  features: Feature[]
  onEndpointClick?: (featureId: string, endpoint: Endpoint) => void
  onViewCode?: (featureId: string) => void
}

const statusConfig = {
  active: {
    icon: CheckCircle2,
    color: 'text-green-400',
  },
  draft: {
    icon: AlertCircle,
    color: 'text-yellow-400',
  },
  disabled: {
    icon: Clock,
    color: 'text-gray-500',
  },
  suggested: {
    icon: Lightbulb,
    color: 'text-purple-400',
  },
}

const methodColors = {
  GET: 'text-blue-400 border-blue-500/50 border-l-2 pl-2',
  POST: 'text-emerald-400 border-emerald-500/50 border-l-2 pl-2',
  PUT: 'text-amber-500 border-amber-500/50 border-l-2 pl-2',
  DELETE: 'text-red-400 border-red-500/50 border-l-2 pl-2',
  PATCH: 'text-orange-400 border-orange-500/50 border-l-2 pl-2',
}

export function FeatureList({ features, onEndpointClick, onViewCode }: FeatureListProps) {
  const [expandedFeatures, setExpandedFeatures] = useState<Set<string>>(
    new Set(features.filter(f => f.status === 'active').map(f => f.id))
  )

  const toggleFeature = (featureId: string) => {
    const newExpanded = new Set(expandedFeatures)
    if (newExpanded.has(featureId)) {
      newExpanded.delete(featureId)
    } else {
      newExpanded.add(featureId)
    }
    setExpandedFeatures(newExpanded)
  }

  return (
    <div className="bg-[#0F1116] border border-gray-800 rounded-xl overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b border-gray-800">
        <div className="flex items-center gap-2">
          <Code className="w-5 h-5 text-purple-400" />
          <h2 className="text-lg font-semibold text-white">APIs</h2>
        </div>
        <div className="text-sm text-gray-500">
          {features.reduce((sum, f) => sum + f.endpoints.length, 0)} APIs
        </div>
      </div>

      {/* Feature List */}
      <div className="divide-y divide-gray-800">
        {features.map((feature) => {
          const isExpanded = expandedFeatures.has(feature.id)
          const StatusIcon = statusConfig[feature.status].icon

          return (
            <div key={feature.id}>
              {/* Feature Header */}
              <div
                onClick={() => toggleFeature(feature.id)}
                className="flex items-center justify-between p-4 hover:bg-white/5 cursor-pointer transition-all group rounded-lg"
              >
                <div className="flex items-center gap-3 flex-1 min-w-0">
                  <ChevronRight
                    className={`w-4 h-4 text-gray-500 transition-transform flex-shrink-0 duration-200 ${
                      isExpanded ? 'rotate-90' : ''
                    }`}
                  />
                  <div className="flex-shrink-0">{feature.icon}</div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-white truncate">{feature.title}</div>
                    <div className="flex items-center gap-2 mt-0.5">
                      <StatusIcon className={`w-3 h-3 ${statusConfig[feature.status].color}`} />
                      <span className="text-xs text-gray-500">
                        {feature.endpoints.length} API{feature.endpoints.length !== 1 ? 's' : ''}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Actions (show on hover) */}
                <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      onViewCode?.(feature.id)
                    }}
                    className="p-2 hover:bg-[#23262B] rounded-lg transition-colors"
                    title="View Code"
                  >
                    <Eye className="w-4 h-4 text-gray-400" />
                  </button>
                </div>
              </div>

              {/* Endpoints (when expanded) */}
              {isExpanded && (
                <div className="bg-[#0B0D10]/50 border-t border-gray-800/50">
                  {feature.endpoints.map((endpoint, idx) => (
                    <div
                      key={idx}
                      onClick={() => onEndpointClick?.(feature.id, endpoint)}
                      className="flex items-center gap-3 px-4 py-2.5 pl-14 hover:bg-white/5 cursor-pointer transition-all group border-b border-gray-800/30 last:border-0 rounded-lg"
                    >
                      <span
                        className={`text-xs font-mono font-semibold lowercase flex-shrink-0 ${
                          methodColors[endpoint.method]
                        }`}
                      >
                        {endpoint.method.toLowerCase()}
                      </span>
                      <span className="text-sm text-gray-300 font-mono flex-1 truncate">
                        {endpoint.path}
                      </span>
                      <Code className="w-4 h-4 text-gray-600 opacity-0 group-hover:opacity-100 transition-opacity" />
                    </div>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* Empty State */}
      {features.length === 0 && (
        <div className="p-12 text-center">
          <Code className="w-12 h-12 text-gray-700 mx-auto mb-3" />
          <p className="text-sm text-gray-500">No APIs yet</p>
          <p className="text-xs text-gray-600 mt-1">Use the AI Assistant above to create your first feature</p>
        </div>
      )}
    </div>
  )
}
