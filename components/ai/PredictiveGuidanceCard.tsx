'use client'

/**
 * PREDICTIVE GUIDANCE UI COMPONENT
 * 
 * Displays proactive suggestions: "You added X. Want Y too?"
 * This is the "Oh. This is different." investor moment.
 */

import { useState } from 'react'
import {
  XMarkIcon,
  LightBulbIcon,
  ShieldCheckIcon,
  BoltIcon,
  ChartBarIcon
} from '@heroicons/react/24/outline'
import { GuidanceSuggestion } from '@/lib/conversation/PredictiveGuidance'

interface PredictiveGuidanceCardProps {
  suggestion: GuidanceSuggestion
  onAccept: (prompt: string) => void
  onDismiss: () => void
}

const TYPE_CONFIG: Record<GuidanceSuggestion['type'], {
  icon: typeof BoltIcon
  color: string
  label: string
}> = {
  capability: {
    icon: BoltIcon,
    color: 'purple',
    label: 'Capability',
  },
  integration: {
    icon: BoltIcon,
    color: 'blue',
    label: 'Integration',
  },
  optimization: {
    icon: ChartBarIcon,
    color: 'green',
    label: 'Optimization',
  },
  security: {
    icon: ShieldCheckIcon,
    color: 'orange',
    label: 'Security',
  },
}

const PRIORITY_CONFIG: Record<GuidanceSuggestion['priority'], {
  badge: string
  text: string
}> = {
  high: {
    badge: 'bg-red-500/20 border-red-500/30 text-red-400',
    text: 'Recommended',
  },
  medium: {
    badge: 'bg-yellow-500/20 border-yellow-500/30 text-yellow-400',
    text: 'Suggested',
  },
  low: {
    badge: 'bg-slate-500/20 border-slate-500/30 text-slate-400',
    text: 'Optional',
  },
}

export function PredictiveGuidanceCard({
  suggestion,
  onAccept,
  onDismiss,
}: PredictiveGuidanceCardProps) {
  const [isExpanded, setIsExpanded] = useState(false)
  
  const typeConfig = TYPE_CONFIG[suggestion.type]
  const priorityConfig = PRIORITY_CONFIG[suggestion.priority]
  const Icon = typeConfig.icon

  return (
    <div className="bg-slate-900/60 border border-purple-500/30 rounded-xl overflow-hidden shadow-lg shadow-purple-500/10">
      {/* Header */}
      <div className="px-4 py-3 bg-slate-800/40 border-b border-slate-700">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3 flex-1">
            {/* Icon */}
            <div className={`w-8 h-8 rounded-lg bg-${typeConfig.color}-500/20 border border-${typeConfig.color}-500/30 flex items-center justify-center`}>
              <Icon className={`w-4 h-4 text-${typeConfig.color}-400`} />
            </div>
            
            {/* Title & Type */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-semibold text-white truncate">
                  {suggestion.title}
                </h3>
                <span className={`px-2 py-0.5 rounded text-[10px] font-medium border ${priorityConfig.badge}`}>
                  {priorityConfig.text}
                </span>
              </div>
              <p className="text-xs text-slate-400 mt-0.5">
                {typeConfig.label}
              </p>
            </div>
          </div>

          {/* Dismiss */}
          <button
            onClick={onDismiss}
            className="w-6 h-6 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 flex items-center justify-center transition-colors"
            aria-label="Dismiss"
          >
            <XMarkIcon className="w-3.5 h-3.5 text-slate-400" />
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="px-4 py-3">
        {/* Description */}
        <p className="text-sm text-slate-300 leading-relaxed">
          {suggestion.description}
        </p>

        {/* Reasoning (expandable) */}
        {suggestion.reasoning && (
          <div className="mt-3">
            <button
              onClick={() => setIsExpanded(!isExpanded)}
              className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-300 transition-colors"
            >
              <LightBulbIcon className="w-3.5 h-3.5" />
              <span>{isExpanded ? 'Hide reasoning' : 'Why suggest this?'}</span>
            </button>
            
            {isExpanded && (
              <div className="mt-2 pl-5 border-l-2 border-slate-700">
                <p className="text-xs text-slate-400 leading-relaxed">
                  {suggestion.reasoning}
                </p>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="px-4 py-3 bg-slate-800/20 border-t border-slate-800 flex items-center justify-end gap-2">
        <button
          onClick={onDismiss}
          className="px-3 py-1.5 text-xs font-medium text-slate-400 hover:text-white transition-colors"
        >
          Not now
        </button>
        <button
          onClick={() => onAccept(suggestion.action.prompt)}
          className="px-3 py-1.5 rounded-lg bg-purple-600 hover:bg-purple-500 text-xs font-semibold text-white border border-purple-500 transition-colors shadow-sm"
        >
          Add this
        </button>
      </div>
    </div>
  )
}

/**
 * Compact inline guidance indicator (for sticky input bar area)
 */
export function CompactGuidanceIndicator({
  suggestion,
  onClick,
}: {
  suggestion: GuidanceSuggestion
  onClick: () => void
}) {
  const typeConfig = TYPE_CONFIG[suggestion.type]
  const Icon = typeConfig.icon

  return (
    <button
      onClick={onClick}
      className="flex items-center gap-2 px-3 py-1.5 bg-purple-600/20 hover:bg-purple-600/30 border border-purple-500/30 rounded-lg transition-colors"
    >
      <Icon className={`w-3.5 h-3.5 text-${typeConfig.color}-400`} />
      <span className="text-xs text-white font-medium">
        {suggestion.title}
      </span>
    </button>
  )
}

/**
 * Guidance list (for displaying multiple suggestions)
 */
export function PredictiveGuidanceList({
  suggestions,
  onAccept,
  onDismiss,
  maxVisible = 2,
}: {
  suggestions: GuidanceSuggestion[]
  onAccept: (prompt: string) => void
  onDismiss: (id: string) => void
  maxVisible?: number
}) {
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(new Set())

  const visibleSuggestions = suggestions
    .filter(s => !dismissedIds.has(s.id))
    .slice(0, maxVisible)

  if (visibleSuggestions.length === 0) return null

  const handleDismiss = (id: string) => {
    const newSet = new Set(dismissedIds)
    newSet.add(id)
    setDismissedIds(newSet)
    onDismiss(id)
  }

  return (
    <div className="space-y-3">
      {visibleSuggestions.map(suggestion => (
        <PredictiveGuidanceCard
          key={suggestion.id}
          suggestion={suggestion}
          onAccept={onAccept}
          onDismiss={() => handleDismiss(suggestion.id)}
        />
      ))}
      
      {suggestions.length > maxVisible && (
        <div className="text-center">
          <button className="text-xs text-slate-400 hover:text-slate-300 transition-colors">
            {suggestions.length - maxVisible} more suggestions
          </button>
        </div>
      )}
    </div>
  )
}
