/**
 * Schema Evolution Panel
 * 
 * Displays schema health metrics and refactoring suggestions
 */

'use client'

import { useState } from 'react'
import { AlertTriangle, CheckCircle, TrendingUp, ChevronDown, ChevronUp } from 'lucide-react'
import type { EvolutionAnalysis } from '@/lib/schema-evolution'

interface SchemaEvolutionPanelProps {
  analysis: EvolutionAnalysis | null
  show?: boolean
  onApplyRefactor?: (suggestionId: string) => void
}

export function SchemaEvolutionPanel({ 
  analysis, 
  show = false,
  onApplyRefactor 
}: SchemaEvolutionPanelProps) {
  const [expandedSuggestion, setExpandedSuggestion] = useState<string | null>(null)
  
  if (!show || !analysis) {
    return null
  }

  const getGradeColor = (grade: string) => {
    switch (grade) {
      case 'A': return 'text-green-400'
      case 'B': return 'text-blue-400'
      case 'C': return 'text-yellow-400'
      case 'D': return 'text-orange-400'
      case 'F': return 'text-red-400'
      default: return 'text-gray-400'
    }
  }

  const getGradeBg = (grade: string) => {
    switch (grade) {
      case 'A': return 'bg-green-500/10 border-green-500/30'
      case 'B': return 'bg-blue-500/10 border-blue-500/30'
      case 'C': return 'bg-yellow-500/10 border-yellow-500/30'
      case 'D': return 'bg-orange-500/10 border-orange-500/30'
      case 'F': return 'bg-red-500/10 border-red-500/30'
      default: return 'bg-gray-500/10 border-gray-500/30'
    }
  }

  const getSeverityColor = (severity: string) => {
    switch (severity) {
      case 'high': return 'text-red-400'
      case 'medium': return 'text-yellow-400'
      case 'low': return 'text-blue-400'
      default: return 'text-gray-400'
    }
  }

  return (
    <div className="bg-[#1A1F2E] rounded-lg border border-gray-700/50 p-6 mb-6">
      {/* Header with Health Score */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-purple-500/10 rounded-lg">
            <TrendingUp className="w-5 h-5 text-purple-400" />
          </div>
          <div>
            <h3 className="text-base font-semibold text-white">Schema Health</h3>
            <p className="text-sm text-gray-400">Evolution analysis and refactoring suggestions</p>
          </div>
        </div>

        {/* Health Score Badge */}
        <div className={`px-4 py-2 rounded-lg border ${getGradeBg(analysis.health.grade)}`}>
          <div className="text-center">
            <div className={`text-2xl font-bold ${getGradeColor(analysis.health.grade)}`}>
              {analysis.health.grade}
            </div>
            <div className="text-xs text-gray-400">{analysis.health.score}/100</div>
          </div>
        </div>
      </div>

      {/* Metrics */}
      <div className="grid grid-cols-4 gap-4 mb-6">
        <div className="p-3 bg-gray-800/30 rounded-lg border border-gray-700/30">
          <div className="text-xs text-gray-400 mb-1">Entities</div>
          <div className="text-lg font-semibold text-white">{analysis.metrics.entityCount}</div>
        </div>
        <div className="p-3 bg-gray-800/30 rounded-lg border border-gray-700/30">
          <div className="text-xs text-gray-400 mb-1">Relations</div>
          <div className="text-lg font-semibold text-white">{analysis.metrics.relationCount}</div>
        </div>
        <div className="p-3 bg-gray-800/30 rounded-lg border border-gray-700/30">
          <div className="text-xs text-gray-400 mb-1">Avg Fields</div>
          <div className="text-lg font-semibold text-white">{analysis.metrics.avgFieldsPerEntity}</div>
        </div>
        <div className="p-3 bg-gray-800/30 rounded-lg border border-gray-700/30">
          <div className="text-xs text-gray-400 mb-1">Naming</div>
          <div className="text-lg font-semibold text-white">{analysis.metrics.namingConsistency}%</div>
        </div>
      </div>

      {/* Issues */}
      {analysis.issues.length > 0 && (
        <div className="mb-6">
          <h4 className="text-xs font-semibold text-gray-400 uppercase mb-3 flex items-center gap-2">
            <AlertTriangle className="w-4 h-4" />
            Issues Found ({analysis.issues.length})
          </h4>
          <div className="space-y-2">
            {analysis.issues.slice(0, 5).map((issue, idx) => (
              <div
                key={idx}
                className="p-3 bg-gray-800/20 rounded-lg border border-gray-700/30"
              >
                <div className="flex items-start gap-2">
                  <span className={`text-xs font-medium ${getSeverityColor(issue.severity)} uppercase`}>
                    {issue.severity}
                  </span>
                  <div className="flex-1">
                    <p className="text-sm text-white mb-1">{issue.description}</p>
                    <p className="text-xs text-gray-500">Impact: {issue.impact}</p>
                    {issue.entities.length > 0 && (
                      <div className="flex gap-1 mt-2">
                        {issue.entities.map(entity => (
                          <span key={entity} className="px-2 py-0.5 text-xs bg-gray-700/40 text-gray-400 rounded">
                            {entity}
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

      {/* Refactoring Suggestions */}
      {analysis.suggestions.length > 0 && (
        <div>
          <h4 className="text-xs font-semibold text-gray-400 uppercase mb-3 flex items-center gap-2">
            <CheckCircle className="w-4 h-4" />
            Refactoring Suggestions ({analysis.suggestions.length})
          </h4>
          <div className="space-y-3">
            {analysis.suggestions.map((suggestion) => {
              const isExpanded = expandedSuggestion === suggestion.id
              
              return (
                <div
                  key={suggestion.id}
                  className="bg-blue-500/5 border border-blue-500/20 rounded-lg overflow-hidden"
                >
                  {/* Suggestion Header */}
                  <div
                    className="p-4 cursor-pointer hover:bg-blue-500/10 transition-colors"
                    onClick={() => setExpandedSuggestion(isExpanded ? null : suggestion.id)}
                  >
                    <div className="flex items-start justify-between">
                      <div className="flex-1">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="px-2 py-0.5 text-xs font-medium bg-blue-500/20 text-blue-300 rounded">
                            {suggestion.type}
                          </span>
                          <span className="text-sm font-medium text-white">{suggestion.title}</span>
                        </div>
                        <p className="text-xs text-gray-400">{suggestion.description}</p>
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
                    <div className="px-4 pb-4 space-y-3">
                      {/* Before/After */}
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <div className="text-xs font-semibold text-gray-400 mb-2">BEFORE</div>
                          <div className="p-2 bg-gray-800/50 rounded text-xs text-gray-300">
                            {suggestion.before.structure}
                          </div>
                        </div>
                        <div>
                          <div className="text-xs font-semibold text-green-400 mb-2">AFTER</div>
                          <div className="p-2 bg-green-500/10 rounded text-xs text-gray-300">
                            {suggestion.after.structure}
                          </div>
                        </div>
                      </div>

                      {/* Benefits & Risks */}
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <div className="text-xs font-semibold text-green-400 mb-2">BENEFITS</div>
                          <ul className="space-y-1">
                            {suggestion.benefits.map((benefit, idx) => (
                              <li key={idx} className="text-xs text-gray-400 flex items-start gap-1">
                                <span className="text-green-400">✓</span>
                                <span>{benefit}</span>
                              </li>
                            ))}
                          </ul>
                        </div>
                        <div>
                          <div className="text-xs font-semibold text-orange-400 mb-2">RISKS</div>
                          <ul className="space-y-1">
                            {suggestion.risks.map((risk, idx) => (
                              <li key={idx} className="text-xs text-gray-400 flex items-start gap-1">
                                <span className="text-orange-400">!</span>
                                <span>{risk}</span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      </div>

                      {/* Effort Badge */}
                      <div className="flex items-center justify-between pt-2 border-t border-gray-700/30">
                        <span className="text-xs text-gray-500">
                          Effort: <span className="text-gray-300 capitalize">{suggestion.effort}</span>
                        </span>
                        
                        {onApplyRefactor && (
                          <button
                            onClick={() => onApplyRefactor(suggestion.id)}
                            className="px-3 py-1.5 text-xs font-medium bg-blue-600 hover:bg-blue-700 text-white rounded transition-colors"
                          >
                            Apply Refactor
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* No Issues */}
      {analysis.issues.length === 0 && analysis.suggestions.length === 0 && (
        <div className="text-center py-8">
          <CheckCircle className="w-12 h-12 text-green-400 mx-auto mb-3" />
          <p className="text-sm text-gray-400">Schema is healthy! No issues detected.</p>
        </div>
      )}
    </div>
  )
}
