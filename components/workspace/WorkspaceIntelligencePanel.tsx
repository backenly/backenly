'use client'

import { useState } from 'react'
import { ChevronDown, ChevronUp, Brain, Database, Shield, Box } from 'lucide-react'

interface SemanticUnderstanding {
  intentSummary: string
  domain: string
  probableEntities: string[]
  probableRelations: Array<{ from: string; to: string; type: string }>
  probableCapabilities: string[]
  authIntent: boolean
  storageIntent: boolean
  ambiguityScore: number
}

interface ConfidenceEvaluation {
  level: 'HIGH' | 'MEDIUM' | 'LOW'
  score: number
  reasoning: string
}

interface IntelligencePanelProps {
  semanticUnderstanding?: SemanticUnderstanding
  confidence?: ConfidenceEvaluation | string
  entities?: string[]
  show?: boolean
}

export function WorkspaceIntelligencePanel({
  semanticUnderstanding,
  confidence,
  entities,
  show = false
}: IntelligencePanelProps) {
  const [isExpanded, setIsExpanded] = useState(false)
  
  // Don't show if no intelligence data
  if (!show || !semanticUnderstanding) {
    return null
  }
  
  const confidenceLevel = typeof confidence === 'string' ? confidence : confidence?.level
  const confidenceScore = typeof confidence === 'object' ? confidence?.score : 0
  
  const getConfidenceColor = (level?: string) => {
    switch (level) {
      case 'HIGH': return 'text-green-400'
      case 'MEDIUM': return 'text-yellow-400'
      case 'LOW': return 'text-orange-400'
      default: return 'text-gray-400'
    }
  }
  
  const getConfidenceBg = (level?: string) => {
    switch (level) {
      case 'HIGH': return 'bg-green-500/10 border-green-500/30'
      case 'MEDIUM': return 'bg-yellow-500/10 border-yellow-500/30'
      case 'LOW': return 'bg-orange-500/10 border-orange-500/30'
      default: return 'bg-gray-500/10 border-gray-500/30'
    }
  }
  
  return (
    <div className="mb-4 border border-gray-800 rounded-lg bg-gray-900/50 backdrop-blur-sm">
      {/* Header */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full flex items-center justify-between p-4 hover:bg-gray-800/50 transition-colors"
      >
        <div className="flex items-center gap-3">
          <Brain className="w-5 h-5 text-purple-400" />
          <div className="flex flex-col items-start">
            <span className="text-sm font-medium text-gray-200">
              AI Understanding
            </span>
            <span className="text-xs text-gray-500">
              {semanticUnderstanding.intentSummary}
            </span>
          </div>
        </div>
        
        <div className="flex items-center gap-3">
          {/* Confidence Badge */}
          <div className={`px-3 py-1 rounded-full border text-xs font-medium ${getConfidenceBg(confidenceLevel)}`}>
            <span className={getConfidenceColor(confidenceLevel)}>
              {confidenceLevel}
              {confidenceScore > 0 && ` (${(confidenceScore * 100).toFixed(0)}%)`}
            </span>
          </div>
          
          {isExpanded ? (
            <ChevronUp className="w-4 h-4 text-gray-400" />
          ) : (
            <ChevronDown className="w-4 h-4 text-gray-400" />
          )}
        </div>
      </button>
      
      {/* Expanded Content */}
      {isExpanded && (
        <div className="border-t border-gray-800 p-4 space-y-4">
          {/* Domain */}
          {semanticUnderstanding.domain && (
            <div>
              <div className="flex items-center gap-2 mb-2">
                <Box className="w-4 h-4 text-blue-400" />
                <span className="text-xs font-medium text-gray-400 uppercase tracking-wide">
                  Detected Domain
                </span>
              </div>
              <div className="text-sm text-gray-300 ml-6">
                {semanticUnderstanding.domain}
              </div>
            </div>
          )}
          
          {/* Entities */}
          {(semanticUnderstanding.probableEntities?.length > 0 || entities?.length > 0) && (
            <div>
              <div className="flex items-center gap-2 mb-2">
                <Database className="w-4 h-4 text-green-400" />
                <span className="text-xs font-medium text-gray-400 uppercase tracking-wide">
                  Entities
                </span>
              </div>
              <div className="ml-6 flex flex-wrap gap-2">
                {(entities || semanticUnderstanding.probableEntities).map((entity, idx) => (
                  <span
                    key={idx}
                    className="px-2 py-1 text-xs rounded bg-gray-800 text-gray-300 border border-gray-700"
                  >
                    {entity}
                  </span>
                ))}
              </div>
            </div>
          )}
          
          {/* Relationships */}
          {semanticUnderstanding.probableRelations?.length > 0 && (
            <div>
              <div className="flex items-center gap-2 mb-2">
                <Shield className="w-4 h-4 text-yellow-400" />
                <span className="text-xs font-medium text-gray-400 uppercase tracking-wide">
                  Relationships
                </span>
              </div>
              <div className="ml-6 space-y-1">
                {semanticUnderstanding.probableRelations.map((rel, idx) => (
                  <div key={idx} className="text-sm text-gray-300">
                    <span className="text-green-400">{rel.from}</span>
                    {' → '}
                    <span className="text-blue-400">{rel.to}</span>
                    <span className="text-gray-500 text-xs ml-2">({rel.type})</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          
          {/* Capabilities */}
          {(semanticUnderstanding.authIntent || 
            semanticUnderstanding.storageIntent || 
            semanticUnderstanding.probableCapabilities?.length > 0) && (
            <div>
              <div className="flex items-center gap-2 mb-2">
                <Shield className="w-4 h-4 text-purple-400" />
                <span className="text-xs font-medium text-gray-400 uppercase tracking-wide">
                  Capabilities
                </span>
              </div>
              <div className="ml-6 space-y-1">
                {semanticUnderstanding.authIntent && (
                  <div className="flex items-center gap-2 text-sm text-gray-300">
                    <div className="w-1.5 h-1.5 rounded-full bg-green-400" />
                    Authentication
                  </div>
                )}
                {semanticUnderstanding.storageIntent && (
                  <div className="flex items-center gap-2 text-sm text-gray-300">
                    <div className="w-1.5 h-1.5 rounded-full bg-green-400" />
                    Storage
                  </div>
                )}
                {semanticUnderstanding.probableCapabilities?.map((cap, idx) => (
                  <div key={idx} className="flex items-center gap-2 text-sm text-gray-300">
                    <div className="w-1.5 h-1.5 rounded-full bg-green-400" />
                    {cap}
                  </div>
                ))}
              </div>
            </div>
          )}
          
          {/* Confidence Reasoning */}
          {typeof confidence === 'object' && confidence.reasoning && (
            <div>
              <div className="flex items-center gap-2 mb-2">
                <Brain className="w-4 h-4 text-gray-400" />
                <span className="text-xs font-medium text-gray-400 uppercase tracking-wide">
                  Analysis
                </span>
              </div>
              <div className="ml-6 text-xs text-gray-400 leading-relaxed">
                {confidence.reasoning}
              </div>
            </div>
          )}
          
          {/* Ambiguity Score */}
          {semanticUnderstanding.ambiguityScore !== undefined && (
            <div className="pt-2 border-t border-gray-800">
              <div className="flex items-center justify-between text-xs">
                <span className="text-gray-500">Ambiguity Score</span>
                <span className={`font-medium ${
                  semanticUnderstanding.ambiguityScore < 0.3 ? 'text-green-400' :
                  semanticUnderstanding.ambiguityScore < 0.6 ? 'text-yellow-400' :
                  'text-orange-400'
                }`}>
                  {(semanticUnderstanding.ambiguityScore * 100).toFixed(0)}%
                </span>
              </div>
              <div className="mt-1 h-1.5 bg-gray-800 rounded-full overflow-hidden">
                <div
                  className={`h-full transition-all ${
                    semanticUnderstanding.ambiguityScore < 0.3 ? 'bg-green-500' :
                    semanticUnderstanding.ambiguityScore < 0.6 ? 'bg-yellow-500' :
                    'bg-orange-500'
                  }`}
                  style={{ width: `${semanticUnderstanding.ambiguityScore * 100}%` }}
                />
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
