'use client'

import { useState, useEffect } from 'react'
import { Lightbulb, ChevronDown, ChevronUp, AlertTriangle, Info, CheckCircle, ArrowRight } from 'lucide-react'

interface Suggestion {
  id: string
  type: 'performance' | 'security' | 'schema' | 'architecture' | 'scaling'
  severity: 'low' | 'medium' | 'high'
  message: string
  rationale: string
  suggestedPrompt?: string
}

interface SuggestionCounts {
  high: number
  medium: number
  low: number
}

interface SuggestionPanelProps {
  projectId: string
  onApplySuggestion?: (prompt: string) => void
}

export function SuggestionPanel({ projectId, onApplySuggestion }: SuggestionPanelProps) {
  const [suggestions, setSuggestions] = useState<Suggestion[]>([])
  const [counts, setCounts] = useState<SuggestionCounts>({ high: 0, medium: 0, low: 0 })
  const [isExpanded, setIsExpanded] = useState(false)
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    loadSuggestions()
  }, [projectId])

  const loadSuggestions = async () => {
    try {
      const response = await fetch(`/api/projects/${projectId}/suggestions`)
      if (response.ok) {
        const data = await response.json()
        setSuggestions(data.suggestions)
        setCounts(data.counts)
      }
    } catch (error) {
      console.error('Failed to load suggestions:', error)
    } finally {
      setIsLoading(false)
    }
  }

  const getSeverityIcon = (severity: string) => {
    switch (severity) {
      case 'high':
        return <AlertTriangle className="w-4 h-4 text-red-400" />
      case 'medium':
        return <Info className="w-4 h-4 text-yellow-400" />
      case 'low':
        return <CheckCircle className="w-4 h-4 text-blue-400" />
      default:
        return <Info className="w-4 h-4 text-gray-400" />
    }
  }

  const getSeverityColor = (severity: string) => {
    switch (severity) {
      case 'high':
        return 'border-red-500/30 bg-red-500/5'
      case 'medium':
        return 'border-yellow-500/30 bg-yellow-500/5'
      case 'low':
        return 'border-blue-500/30 bg-blue-500/5'
      default:
        return 'border-gray-500/30 bg-gray-500/5'
    }
  }

  const getTypeLabel = (type: string) => {
    const labels: Record<string, string> = {
      performance: 'Performance',
      security: 'Security',
      schema: 'Schema',
      architecture: 'Architecture',
      scaling: 'Scaling',
    }
    return labels[type] || type
  }

  const totalCount = counts.high + counts.medium + counts.low

  if (isLoading) {
    return (
      <div className="bg-[#1e1e22] border border-[#333] rounded-lg p-4">
        <div className="flex items-center gap-2 text-gray-400">
          <Lightbulb className="w-4 h-4" />
          <span className="text-sm">Loading suggestions...</span>
        </div>
      </div>
    )
  }

  if (totalCount === 0) {
    return (
      <div className="bg-[#1e1e22] border border-[#333] rounded-lg p-4">
        <div className="flex items-center gap-2 text-green-400">
          <CheckCircle className="w-4 h-4" />
          <span className="text-sm">No suggestions — your backend looks good!</span>
        </div>
      </div>
    )
  }

  return (
    <div className="bg-[#1e1e22] border border-[#333] rounded-lg overflow-hidden">
      {/* Header */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full flex items-center justify-between p-4 hover:bg-[#252525] transition-colors"
      >
        <div className="flex items-center gap-3">
          <Lightbulb className="w-5 h-5 text-yellow-400" />
          <div>
            <h3 className="text-sm font-medium text-white">Suggestions</h3>
            <p className="text-xs text-gray-400">
              {counts.high > 0 && (
                <span className="text-red-400">{counts.high} high priority</span>
              )}
              {counts.high > 0 && counts.medium > 0 && <span className="text-gray-500"> · </span>}
              {counts.medium > 0 && (
                <span className="text-yellow-400">{counts.medium} medium</span>
              )}
              {(counts.high > 0 || counts.medium > 0) && counts.low > 0 && (
                <span className="text-gray-500"> · </span>
              )}
              {counts.low > 0 && <span className="text-blue-400">{counts.low} low</span>}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {/* Severity badges */}
          <div className="flex gap-1">
            {counts.high > 0 && (
              <span className="px-2 py-0.5 bg-red-500/20 text-red-400 text-xs rounded-full">
                {counts.high}
              </span>
            )}
            {counts.medium > 0 && (
              <span className="px-2 py-0.5 bg-yellow-500/20 text-yellow-400 text-xs rounded-full">
                {counts.medium}
              </span>
            )}
            {counts.low > 0 && (
              <span className="px-2 py-0.5 bg-blue-500/20 text-blue-400 text-xs rounded-full">
                {counts.low}
              </span>
            )}
          </div>
          {isExpanded ? (
            <ChevronUp className="w-4 h-4 text-gray-400" />
          ) : (
            <ChevronDown className="w-4 h-4 text-gray-400" />
          )}
        </div>
      </button>

      {/* Expanded content */}
      {isExpanded && (
        <div className="border-t border-[#333]">
          <div className="p-4 space-y-3 max-h-96 overflow-y-auto">
            {suggestions.map((suggestion) => (
              <div
                key={suggestion.id}
                className={`p-3 rounded-lg border ${getSeverityColor(suggestion.severity)}`}
              >
                <div className="flex items-start gap-3">
                  {getSeverityIcon(suggestion.severity)}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-xs font-medium text-gray-400 uppercase">
                        {getTypeLabel(suggestion.type)}
                      </span>
                      <span className="text-xs text-gray-500">·</span>
                      <span className={`text-xs capitalize ${
                        suggestion.severity === 'high' ? 'text-red-400' :
                        suggestion.severity === 'medium' ? 'text-yellow-400' :
                        'text-blue-400'
                      }`}>
                        {suggestion.severity}
                      </span>
                    </div>
                    <p className="text-sm text-white mb-1">{suggestion.message}</p>
                    <p className="text-xs text-gray-400 mb-2">{suggestion.rationale}</p>
                    
                    {suggestion.suggestedPrompt && onApplySuggestion && (
                      <button
                        onClick={() => onApplySuggestion(suggestion.suggestedPrompt!)}
                        className="flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300 transition-colors"
                      >
                        <span>Apply suggestion</span>
                        <ArrowRight className="w-3 h-3" />
                      </button>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
          
          <div className="px-4 py-3 border-t border-[#333] bg-[#151515]">
            <p className="text-xs text-gray-500">
              Suggestions are generated from your backend structure and updated after each change.
            </p>
          </div>
        </div>
      )}
    </div>
  )
}
