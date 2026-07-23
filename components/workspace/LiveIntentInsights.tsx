'use client'

import { motion } from 'framer-motion'
import { Database, Waypoints, Target, TrendingUp, AlertCircle } from 'lucide-react'

/**
 * PHASE 4: Live Intent Insights Panel
 * 
 * Replaces dead space below textarea with real-time insights
 * about the user's intent before execution.
 */

interface LiveIntentInsightsProps {
  semanticUnderstanding?: {
    intent?: string
    entities?: string[]
    relationships?: string[]
    complexity?: 'simple' | 'moderate' | 'complex'
  }
  confidence?: number
  impactedTables?: string[]
}

export function LiveIntentInsights({
  semanticUnderstanding,
  confidence,
  impactedTables = [],
}: LiveIntentInsightsProps) {
  // Don't show if no data
  if (!semanticUnderstanding && !confidence && impactedTables.length === 0) {
    return null
  }

  const entities = semanticUnderstanding?.entities || []
  const complexity = semanticUnderstanding?.complexity || 'simple'
  const confidenceScore = confidence || 0

  // Get color for complexity
  const getComplexityColor = (level: string) => {
    switch (level) {
      case 'simple':
        return 'text-emerald-400 bg-emerald-500/10 border-emerald-500/30'
      case 'moderate':
        return 'text-yellow-400 bg-yellow-500/10 border-yellow-500/30'
      case 'complex':
        return 'text-orange-400 bg-orange-500/10 border-orange-500/30'
      default:
        return 'text-gray-400 bg-gray-500/10 border-gray-500/30'
    }
  }

  // Get color for confidence
  const getConfidenceColor = (score: number) => {
    if (score >= 90) return 'text-emerald-400 bg-emerald-500/10 border-emerald-500/30'
    if (score >= 70) return 'text-blue-400 bg-blue-500/10 border-blue-500/30'
    if (score >= 50) return 'text-yellow-400 bg-yellow-500/10 border-yellow-500/30'
    return 'text-orange-400 bg-orange-500/10 border-orange-500/30'
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: -10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2 }}
      className="bg-gradient-to-br from-indigo-900/20 to-purple-900/20 border border-indigo-500/30 rounded-lg p-4"
    >
      {/* Header */}
      <div className="flex items-center gap-2 mb-3">
        <Target className="w-4 h-4 text-indigo-400" />
        <h4 className="text-sm font-semibold text-white">Intent Analysis</h4>
      </div>

      {/* Insights Grid */}
      <div className="grid grid-cols-2 gap-3">
        {/* Detected Entities */}
        {entities.length > 0 && (
          <div className="bg-slate-800/40 border border-slate-700/50 rounded-lg p-3">
            <div className="flex items-center gap-2 mb-2">
              <Database className="w-3.5 h-3.5 text-blue-400" />
              <span className="text-xs font-medium text-gray-300">Detected Entities</span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {entities.slice(0, 3).map((entity, idx) => (
                <span
                  key={idx}
                  className="px-2 py-0.5 text-xs font-medium bg-blue-500/10 text-blue-300 border border-blue-500/30 rounded"
                >
                  {entity}
                </span>
              ))}
              {entities.length > 3 && (
                <span className="px-2 py-0.5 text-xs text-gray-400">
                  +{entities.length - 3} more
                </span>
              )}
            </div>
          </div>
        )}

        {/* Impacted Tables */}
        {impactedTables.length > 0 && (
          <div className="bg-slate-800/40 border border-slate-700/50 rounded-lg p-3">
            <div className="flex items-center gap-2 mb-2">
              <Waypoints className="w-3.5 h-3.5 text-purple-400" />
              <span className="text-xs font-medium text-gray-300">Impacted Tables</span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {impactedTables.slice(0, 3).map((table, idx) => (
                <span
                  key={idx}
                  className="px-2 py-0.5 text-xs font-medium bg-purple-500/10 text-purple-300 border border-purple-500/30 rounded"
                >
                  {table}
                </span>
              ))}
              {impactedTables.length > 3 && (
                <span className="px-2 py-0.5 text-xs text-gray-400">
                  +{impactedTables.length - 3} more
                </span>
              )}
            </div>
          </div>
        )}

        {/* Complexity Score */}
        <div className="bg-slate-800/40 border border-slate-700/50 rounded-lg p-3">
          <div className="flex items-center gap-2 mb-2">
            <TrendingUp className="w-3.5 h-3.5 text-gray-400" />
            <span className="text-xs font-medium text-gray-300">Complexity</span>
          </div>
          <div>
            <span className={`inline-flex px-2 py-1 text-xs font-semibold border rounded ${getComplexityColor(complexity)}`}>
              {complexity.charAt(0).toUpperCase() + complexity.slice(1)}
            </span>
          </div>
        </div>

        {/* Confidence Score */}
        {confidenceScore > 0 && (
          <div className="bg-slate-800/40 border border-slate-700/50 rounded-lg p-3">
            <div className="flex items-center gap-2 mb-2">
              <AlertCircle className="w-3.5 h-3.5 text-gray-400" />
              <span className="text-xs font-medium text-gray-300">Confidence</span>
            </div>
            <div>
              <span className={`inline-flex px-2 py-1 text-xs font-semibold border rounded ${getConfidenceColor(confidenceScore)}`}>
                {Math.round(confidenceScore)}%
              </span>
            </div>
          </div>
        )}
      </div>

      {/* Intent Description */}
      {semanticUnderstanding?.intent && (
        <div className="mt-3 pt-3 border-t border-slate-700/50">
          <p className="text-xs text-gray-400 leading-relaxed">
            <span className="font-semibold text-indigo-300">Intent:</span>{' '}
            {semanticUnderstanding.intent}
          </p>
        </div>
      )}
    </motion.div>
  )
}
