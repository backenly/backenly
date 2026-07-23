/**
 * AI Suggestions Dock
 * 
 * Floating panel showing proactive AI suggestions for backend improvements
 */

'use client'

import { useState, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  X,
  ChevronDown,
  ChevronUp,
  Check,
  AlertTriangle,
  Database,
  BarChart3,
  Bell,
  Shield,
  TrendingUp,
  Activity,
  MinusCircle,
} from 'lucide-react'
import type { AISuggestion, SuggestionsAnalysis } from '@/lib/autonomous-guidance'

interface AISuggestionsDockProps {
  projectId: string
  analysis: SuggestionsAnalysis | null
  onApply?: (suggestionId: string) => void
  onDismiss?: (suggestionId: string, reason?: string) => void
  onRefresh?: () => void
}

export function AISuggestionsDock({
  projectId,
  analysis,
  onApply,
  onDismiss,
  onRefresh,
}: AISuggestionsDockProps) {
  const [isOpen, setIsOpen] = useState(true)
  const [isMinimized, setIsMinimized] = useState(false)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(new Set())

  const suggestions = analysis?.suggestions.filter(s => !dismissedIds.has(s.id)) || []

  const getCategoryIcon = (category: string) => {
    switch (category) {
      case 'caching': return TrendingUp
      case 'indexing': return Database
      case 'analytics': return BarChart3
      case 'notifications': return Bell
      case 'security': return Shield
      case 'performance': return TrendingUp
      case 'monitoring': return Activity
      default: return Activity
    }
  }

  const getImpactColor = (impact: string) => {
    switch (impact) {
      case 'high': return 'text-green-400'
      case 'medium': return 'text-yellow-400'
      case 'low': return 'text-blue-400'
      default: return 'text-gray-400'
    }
  }

  const getImpactBg = (impact: string) => {
    switch (impact) {
      case 'high': return 'bg-green-500/10 border-green-500/30'
      case 'medium': return 'bg-yellow-500/10 border-yellow-500/30'
      case 'low': return 'bg-blue-500/10 border-blue-500/30'
      default: return 'bg-gray-500/10 border-gray-500/30'
    }
  }

  const handleDismiss = (suggestionId: string) => {
    setDismissedIds(prev => {
      const newSet = new Set(prev)
      newSet.add(suggestionId)
      return newSet
    })
    onDismiss?.(suggestionId, 'user_dismissed')
  }

  const handleApply = (suggestionId: string) => {
    onApply?.(suggestionId)
    setDismissedIds(prev => {
      const newSet = new Set(prev)
      newSet.add(suggestionId)
      return newSet
    })
  }

  if (!isOpen || suggestions.length === 0) {
    return null
  }

  return (
    <motion.div
      initial={{ opacity: 0, x: 400 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 400 }}
      className="fixed right-6 bottom-6 z-40 w-96"
    >
      <div className="bg-[#1A1F2E] border border-purple-500/30 rounded-lg shadow-2xl shadow-purple-500/10 overflow-hidden">
        {/* Header */}
        <div className="bg-gradient-to-r from-purple-600/20 to-blue-600/20 border-b border-purple-500/30 p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="p-1.5 bg-purple-500/20 rounded">
                <Bell className="w-4 h-4 text-purple-400" />
              </div>
              <div>
                <h3 className="text-sm font-semibold text-white">AI Suggestions</h3>
                <p className="text-xs text-gray-400">{suggestions.length} optimization{suggestions.length !== 1 ? 's' : ''} available</p>
              </div>
            </div>
            
            <div className="flex items-center gap-2">
              <button
                onClick={() => setIsMinimized(!isMinimized)}
                className="p-1.5 hover:bg-white/5 rounded transition-colors"
              >
                {isMinimized ? (
                  <ChevronUp className="w-4 h-4 text-gray-400" />
                ) : (
                  <ChevronDown className="w-4 h-4 text-gray-400" />
                )}
              </button>
              <button
                onClick={() => setIsOpen(false)}
                className="p-1.5 hover:bg-white/5 rounded transition-colors"
              >
                <X className="w-4 h-4 text-gray-400" />
              </button>
            </div>
          </div>
        </div>

        {/* Content */}
        <AnimatePresence>
          {!isMinimized && (
            <motion.div
              initial={{ height: 0 }}
              animate={{ height: 'auto' }}
              exit={{ height: 0 }}
              className="overflow-hidden"
            >
              <div className="max-h-[500px] overflow-y-auto">
                {suggestions.map((suggestion, idx) => {
                  const Icon = getCategoryIcon(suggestion.category)
                  const isExpanded = expandedId === suggestion.id
                  
                  return (
                    <motion.div
                      key={suggestion.id}
                      initial={{ opacity: 0, y: 20 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: idx * 0.1 }}
                      className="border-b border-gray-700/30 last:border-b-0"
                    >
                      {/* Suggestion Header */}
                      <div
                        className="p-4 cursor-pointer hover:bg-white/5 transition-colors"
                        onClick={() => setExpandedId(isExpanded ? null : suggestion.id)}
                      >
                        <div className="flex items-start gap-3">
                          <div className="p-2 bg-purple-500/10 rounded flex-shrink-0">
                            <Icon className="w-4 h-4 text-purple-400" />
                          </div>
                          
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 mb-1">
                              <h4 className="text-sm font-medium text-white truncate">
                                {suggestion.title}
                              </h4>
                            </div>
                            
                            <p className="text-xs text-gray-400 mb-2">
                              {suggestion.description}
                            </p>
                            
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className={`px-2 py-0.5 text-xs rounded border ${getImpactBg(suggestion.impact)}`}>
                                <span className={getImpactColor(suggestion.impact)}>
                                  {suggestion.impact} impact
                                </span>
                              </span>
                              <span className="px-2 py-0.5 text-xs bg-gray-700/30 text-gray-400 rounded">
                                {suggestion.effort} effort
                              </span>
                              <span className="px-2 py-0.5 text-xs bg-blue-500/10 text-blue-400 rounded">
                                Priority: {suggestion.priority}/10
                              </span>
                            </div>
                          </div>

                          <button className="text-gray-400 hover:text-white flex-shrink-0">
                            {isExpanded ? (
                              <ChevronUp className="w-4 h-4" />
                            ) : (
                              <ChevronDown className="w-4 h-4" />
                            )}
                          </button>
                        </div>
                      </div>

                      {/* Expanded Details */}
                      <AnimatePresence>
                        {isExpanded && (
                          <motion.div
                            initial={{ height: 0, opacity: 0 }}
                            animate={{ height: 'auto', opacity: 1 }}
                            exit={{ height: 0, opacity: 0 }}
                            className="px-4 pb-4 space-y-3 overflow-hidden"
                          >
                            {/* Rationale */}
                            <div>
                              <h5 className="text-xs font-semibold text-gray-400 mb-1">Why this matters</h5>
                              <p className="text-xs text-gray-300">{suggestion.rationale}</p>
                            </div>

                            {/* Benefits */}
                            <div>
                              <h5 className="text-xs font-semibold text-green-400 mb-2">Benefits</h5>
                              <ul className="space-y-1">
                                {suggestion.benefits.map((benefit, idx) => (
                                  <li key={idx} className="text-xs text-gray-300 flex items-start gap-2">
                                    <Check className="w-3 h-3 text-green-400 mt-0.5 flex-shrink-0" />
                                    <span>{benefit}</span>
                                  </li>
                                ))}
                              </ul>
                            </div>

                            {/* Implementation */}
                            <div>
                              <h5 className="text-xs font-semibold text-blue-400 mb-2">Implementation</h5>
                              <ul className="space-y-1">
                                {suggestion.implementation.changes.map((change, idx) => (
                                  <li key={idx} className="text-xs text-gray-400">
                                    {idx + 1}. {change}
                                  </li>
                                ))}
                              </ul>
                            </div>

                            {/* Dependencies */}
                            {suggestion.implementation.dependencies && suggestion.implementation.dependencies.length > 0 && (
                              <div>
                                <h5 className="text-xs font-semibold text-orange-400 mb-2">Dependencies</h5>
                                <div className="flex flex-wrap gap-1">
                                  {suggestion.implementation.dependencies.map(dep => (
                                    <span key={dep} className="px-2 py-0.5 text-xs bg-gray-700/50 text-gray-400 rounded font-mono">
                                      {dep}
                                    </span>
                                  ))}
                                </div>
                              </div>
                            )}

                            {/* Tradeoffs */}
                            {suggestion.tradeoffs && suggestion.tradeoffs.length > 0 && (
                              <div>
                                <h5 className="text-xs font-semibold text-orange-400 mb-2">Tradeoffs</h5>
                                <ul className="space-y-1">
                                  {suggestion.tradeoffs.map((tradeoff, idx) => (
                                    <li key={idx} className="text-xs text-gray-400 flex items-start gap-2">
                                      <AlertTriangle className="w-3 h-3 text-orange-400 mt-0.5 flex-shrink-0" />
                                      <span>{tradeoff}</span>
                                    </li>
                                  ))}
                                </ul>
                              </div>
                            )}

                            {/* Actions */}
                            <div className="flex items-center gap-2 pt-2 border-t border-gray-700/30">
                              <button
                                onClick={(e) => {
                                  e.stopPropagation()
                                  handleApply(suggestion.id)
                                }}
                                className="flex-1 px-3 py-2 text-xs font-medium bg-purple-600 hover:bg-purple-700 text-white rounded transition-colors flex items-center justify-center gap-2"
                              >
                                <Check className="w-3 h-3" />
                                Apply Suggestion
                              </button>
                              <button
                                onClick={(e) => {
                                  e.stopPropagation()
                                  handleDismiss(suggestion.id)
                                }}
                                className="px-3 py-2 text-xs font-medium bg-gray-700/50 hover:bg-gray-700 text-gray-300 rounded transition-colors flex items-center gap-2"
                              >
                                <MinusCircle className="w-3 h-3" />
                                Dismiss
                              </button>
                            </div>
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </motion.div>
                  )
                })}
              </div>

              {/* Footer */}
              {analysis && (
                <div className="p-3 bg-gray-800/30 border-t border-gray-700/30">
                  <div className="flex items-center justify-between text-xs text-gray-500">
                    <span>
                      Last analyzed: {new Date(analysis.timestamp).toLocaleTimeString()}
                    </span>
                    {onRefresh && (
                      <button
                        onClick={onRefresh}
                        className="text-purple-400 hover:text-purple-300 transition-colors"
                      >
                        Refresh
                      </button>
                    )}
                  </div>
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Floating Trigger (when minimized) */}
      <AnimatePresence>
        {isMinimized && (
          <motion.button
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            exit={{ scale: 0 }}
            onClick={() => setIsMinimized(false)}
            className="absolute -top-14 right-0 p-3 bg-purple-600 hover:bg-purple-700 rounded-full shadow-lg transition-colors"
          >
            <Bell className="w-5 h-5 text-white" />
          </motion.button>
        )}
      </AnimatePresence>
    </motion.div>
  )
}
