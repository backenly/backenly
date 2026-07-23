/**
 * Impact Report Panel
 * 
 * Shows infrastructure impact prediction before execution
 */

'use client'

import { useState } from 'react'
import { 
  AlertTriangle, 
  Server, 
  Database, 
  Zap, 
  Shield, 
  Cloud,
  TrendingUp,
  ChevronDown,
  ChevronUp,
  CheckCircle2,
  AlertCircle
} from 'lucide-react'
import type { ImpactAnalysis } from '@/lib/impact-analysis'

interface ImpactReportPanelProps {
  analysis: ImpactAnalysis | null
  show?: boolean
}

export function ImpactReportPanel({ analysis, show = false }: ImpactReportPanelProps) {
  const [expandedCategory, setExpandedCategory] = useState<string | null>(null)
  
  if (!show || !analysis) {
    return null
  }

  const getSeverityColor = (severity: string) => {
    switch (severity) {
      case 'critical': return 'text-red-400'
      case 'high': return 'text-orange-400'
      case 'medium': return 'text-yellow-400'
      case 'low': return 'text-blue-400'
      default: return 'text-gray-400'
    }
  }

  const getSeverityBg = (severity: string) => {
    switch (severity) {
      case 'critical': return 'bg-red-500/10 border-red-500/30'
      case 'high': return 'bg-orange-500/10 border-orange-500/30'
      case 'medium': return 'bg-yellow-500/10 border-yellow-500/30'
      case 'low': return 'bg-blue-500/10 border-blue-500/30'
      default: return 'bg-gray-500/10 border-gray-500/30'
    }
  }

  const getCategoryIcon = (category: string) => {
    switch (category) {
      case 'auth': return Shield
      case 'realtime': return Zap
      case 'storage': return Cloud
      case 'api': return Server
      case 'database': return Database
      case 'performance': return TrendingUp
      default: return Server
    }
  }

  const getCostBadge = (cost: string) => {
    const colors = {
      free: 'bg-green-500/10 text-green-400 border-green-500/30',
      low: 'bg-blue-500/10 text-blue-400 border-blue-500/30',
      medium: 'bg-yellow-500/10 text-yellow-400 border-yellow-500/30',
      high: 'bg-red-500/10 text-red-400 border-red-500/30',
    }
    return colors[cost as keyof typeof colors] || colors.free
  }

  return (
    <div className="bg-[#1A1F2E] rounded-lg border border-gray-700/50 p-6 mb-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-5">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-orange-500/10 rounded-lg">
            <AlertTriangle className="w-5 h-5 text-orange-400" />
          </div>
          <div>
            <h3 className="text-base font-semibold text-white">Infrastructure Impact</h3>
            <p className="text-sm text-gray-400">Predicted changes and requirements</p>
          </div>
        </div>

        {/* Overall Severity Badge */}
        <div className={`px-3 py-1.5 rounded-lg border ${getSeverityBg(analysis.overallSeverity)}`}>
          <span className={`text-sm font-medium ${getSeverityColor(analysis.overallSeverity)} uppercase`}>
            {analysis.overallSeverity}
          </span>
        </div>
      </div>

      {/* Summary */}
      <div className="mb-6 p-4 bg-gray-800/30 rounded-lg border border-gray-700/30">
        <p className="text-sm text-gray-300">{analysis.summary}</p>
        
        {/* Complexity Score */}
        <div className="mt-3 flex items-center gap-2">
          <span className="text-xs text-gray-400">Complexity:</span>
          <div className="flex-1 h-2 bg-gray-700 rounded-full overflow-hidden">
            <div 
              className="h-full bg-gradient-to-r from-blue-500 to-purple-500"
              style={{ width: `${analysis.estimatedComplexity.score * 10}%` }}
            />
          </div>
          <span className="text-xs font-medium text-gray-300">
            {analysis.estimatedComplexity.score}/10
          </span>
        </div>
      </div>

      {/* Warnings */}
      {analysis.warnings.length > 0 && (
        <div className="mb-6 p-4 bg-orange-500/10 border border-orange-500/20 rounded-lg">
          <div className="flex items-start gap-2">
            <AlertCircle className="w-4 h-4 text-orange-400 mt-0.5 flex-shrink-0" />
            <div className="flex-1">
              <h4 className="text-sm font-semibold text-orange-300 mb-2">Warnings</h4>
              <ul className="space-y-1">
                {analysis.warnings.map((warning, idx) => (
                  <li key={idx} className="text-xs text-orange-200/80">
                    • {warning}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      )}

      {/* Impact Categories */}
      {analysis.impacts.length > 0 && (
        <div className="mb-6">
          <h4 className="text-xs font-semibold text-gray-400 uppercase mb-3">Impact Areas</h4>
          <div className="space-y-2">
            {analysis.impacts.map((impact) => {
              const Icon = getCategoryIcon(impact.category)
              const isExpanded = expandedCategory === impact.category
              
              return (
                <div
                  key={impact.category}
                  className="bg-gray-800/30 border border-gray-700/30 rounded-lg overflow-hidden"
                >
                  {/* Category Header */}
                  <div
                    className="p-3 cursor-pointer hover:bg-gray-800/50 transition-colors"
                    onClick={() => setExpandedCategory(isExpanded ? null : impact.category)}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3 flex-1">
                        <Icon className="w-4 h-4 text-blue-400" />
                        <div className="flex-1">
                          <div className="flex items-center gap-2 mb-1">
                            <span className="text-sm font-medium text-white capitalize">
                              {impact.category}
                            </span>
                            <span className={`px-2 py-0.5 text-xs rounded ${getSeverityBg(impact.severity)}`}>
                              <span className={getSeverityColor(impact.severity)}>
                                {impact.severity}
                              </span>
                            </span>
                            <span className={`px-2 py-0.5 text-xs rounded border ${getCostBadge(impact.cost)}`}>
                              {impact.cost} cost
                            </span>
                          </div>
                          <p className="text-xs text-gray-400">{impact.description}</p>
                        </div>
                      </div>
                      <button className="text-gray-400 hover:text-white">
                        {isExpanded ? (
                          <ChevronUp className="w-4 h-4" />
                        ) : (
                          <ChevronDown className="w-4 h-4" />
                        )}
                      </button>
                    </div>
                  </div>

                  {/* Expanded Details */}
                  {isExpanded && (
                    <div className="px-4 pb-4 space-y-3 border-t border-gray-700/30">
                      {/* Requirements */}
                      {impact.requirements.length > 0 && (
                        <div>
                          <h5 className="text-xs font-semibold text-green-400 mb-2 mt-3">
                            Requirements
                          </h5>
                          <ul className="space-y-1">
                            {impact.requirements.map((req, idx) => (
                              <li key={idx} className="text-xs text-gray-400 flex items-start gap-2">
                                <CheckCircle2 className="w-3 h-3 text-green-400 mt-0.5" />
                                <span>{req}</span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}

                      {/* Risks */}
                      {impact.risks.length > 0 && (
                        <div>
                          <h5 className="text-xs font-semibold text-orange-400 mb-2">Risks</h5>
                          <ul className="space-y-1">
                            {impact.risks.map((risk, idx) => (
                              <li key={idx} className="text-xs text-gray-400 flex items-start gap-2">
                                <AlertCircle className="w-3 h-3 text-orange-400 mt-0.5" />
                                <span>{risk}</span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}

                      {/* Scaling Concerns */}
                      {impact.scalingConcerns.length > 0 && (
                        <div>
                          <h5 className="text-xs font-semibold text-blue-400 mb-2">
                            Scaling Considerations
                          </h5>
                          <ul className="space-y-1">
                            {impact.scalingConcerns.map((concern, idx) => (
                              <li key={idx} className="text-xs text-gray-400 flex items-start gap-2">
                                <TrendingUp className="w-3 h-3 text-blue-400 mt-0.5" />
                                <span>{concern}</span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Capabilities Forecast */}
      {analysis.capabilities.length > 0 && (
        <div className="mb-6">
          <h4 className="text-xs font-semibold text-gray-400 uppercase mb-3">
            Capabilities Enabled
          </h4>
          <div className="space-y-2">
            {analysis.capabilities.map((cap, idx) => (
              <div
                key={idx}
                className="p-3 bg-green-500/5 border border-green-500/20 rounded-lg"
              >
                <div className="flex items-start gap-2 mb-2">
                  <CheckCircle2 className="w-4 h-4 text-green-400 mt-0.5" />
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-sm font-medium text-green-300">{cap.capability}</span>
                      <span className="px-2 py-0.5 text-xs bg-gray-700/50 text-gray-400 rounded capitalize">
                        {cap.complexity}
                      </span>
                    </div>
                    
                    {cap.dependencies.length > 0 && (
                      <div className="text-xs text-gray-400 mb-1">
                        Depends on: {cap.dependencies.join(', ')}
                      </div>
                    )}
                    
                    {cap.configuration.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-2">
                        {cap.configuration.map(config => (
                          <span
                            key={config}
                            className="px-2 py-0.5 text-xs bg-gray-700/30 text-gray-500 rounded font-mono"
                          >
                            {config}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Recommendations */}
      {analysis.recommendations.length > 0 && (
        <div>
          <h4 className="text-xs font-semibold text-gray-400 uppercase mb-3">
            Recommendations
          </h4>
          <div className="space-y-2">
            {analysis.recommendations.map((rec, idx) => (
              <div
                key={idx}
                className="flex items-start gap-2 p-3 bg-blue-500/5 border border-blue-500/20 rounded-lg"
              >
                <div className="p-1 bg-blue-500/20 rounded">
                  <CheckCircle2 className="w-3 h-3 text-blue-400" />
                </div>
                <p className="text-xs text-gray-300 flex-1">{rec}</p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
