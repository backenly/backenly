'use client'

import { motion } from 'framer-motion'
import { Users, TrendingUp, CheckCircle2, Clock, Loader2 } from 'lucide-react'

interface CognitiveWorkspaceHeaderProps {
  projectName?: string
  semanticUnderstanding?: {
    intentSummary?: string
    probableEntities?: string[]
    domain?: string
  }
  interactionGraph?: {
    actors?: Array<{ name: string }>
  }
  impactReport?: {
    overallSeverity?: 'LOW' | 'MEDIUM' | 'HIGH'
    estimatedComplexity?: { score: number }
  }
  buildState?: 'idle' | 'building' | 'complete'
  onReviewPlan?: () => void
  onModify?: () => void
  onBuild?: () => void
}

function getSeverityColor(severity?: string) {
  switch (severity) {
    case 'HIGH': return 'text-orange-400 bg-orange-500/10 border-orange-500/20'
    case 'MEDIUM': return 'text-yellow-400 bg-yellow-500/10 border-yellow-500/20'
    case 'LOW': return 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20'
    default: return 'text-gray-400 bg-gray-500/10 border-gray-500/20'
  }
}

function getComplexityLabel(score?: number) {
  if (!score) return 'Unknown'
  if (score <= 3) return 'Simple'
  if (score <= 6) return 'Medium'
  return 'Complex'
}

function getProjectTitle(semanticUnderstanding?: any): string {
  const domain = semanticUnderstanding?.domain || semanticUnderstanding?.intentSummary || ''
  
  // Extract meaningful title from intent
  if (domain.toLowerCase().includes('chat') || domain.toLowerCase().includes('messaging')) {
    return 'Building Messaging Backend'
  }
  if (domain.toLowerCase().includes('ecommerce') || domain.toLowerCase().includes('shop')) {
    return 'Building E-commerce Backend'
  }
  if (domain.toLowerCase().includes('collaboration') || domain.toLowerCase().includes('team')) {
    return 'Building Collaboration Backend'
  }
  if (domain.toLowerCase().includes('social')) {
    return 'Building Social Backend'
  }
  if (domain.toLowerCase().includes('blog') || domain.toLowerCase().includes('content')) {
    return 'Building Content Backend'
  }
  
  return 'Building Backend System'
}

function getBuildStateInfo(state?: string) {
  switch (state) {
    case 'building':
      return {
        label: 'Executing',
        color: 'text-purple-400 bg-purple-500/10 border-purple-500/20',
        icon: Loader2,
        animate: true
      }
    case 'complete':
      return {
        label: 'Complete',
        color: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20',
        icon: CheckCircle2,
        animate: false
      }
    default:
      return {
        label: 'Preview',
        color: 'text-blue-400 bg-blue-500/10 border-blue-500/20',
        icon: Clock,
        animate: false
      }
  }
}

export function CognitiveWorkspaceHeader({
  projectName,
  semanticUnderstanding,
  interactionGraph,
  impactReport,
  buildState = 'idle',
  onReviewPlan,
  onModify,
  onBuild,
}: CognitiveWorkspaceHeaderProps) {
  const actors = interactionGraph?.actors?.map(a => a.name).slice(0, 3) || []
  const severity = impactReport?.overallSeverity
  const complexity = impactReport?.estimatedComplexity?.score
  const stateInfo = getBuildStateInfo(buildState)
  const StateIcon = stateInfo.icon

  return (
    <div className="border-b border-white/5 bg-[#0B0F1A]">
      <div className="px-8 pt-6 pb-4">
        {/* Header */}
        <div className="mb-3">
          <h2 className="text-xl font-bold text-gray-100 mb-1">
            {projectName || 'Untitled Project'}
          </h2>
          <div className="flex items-center gap-2">
            <div className="w-1.5 h-1.5 rounded-full bg-purple-400 animate-pulse" />
            <h3 className="text-sm font-medium text-purple-400 uppercase tracking-wider">
              Workspace Engine
            </h3>
          </div>
        </div>

        {/* Context Cards Row */}
        {semanticUnderstanding && (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3 mb-3">
            {/* Card 1 - Intent */}
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0 }}
              className="bg-gray-800/30 border border-gray-700/30 rounded-lg p-3"
            >
              <div className="flex items-center gap-2 mb-1">
                <TrendingUp className="w-4 h-4 text-gray-400" />
                <span className="text-xs font-medium text-gray-400 uppercase tracking-wider">
                  Intent Detected
                </span>
              </div>
              <p className="text-sm text-gray-200 line-clamp-2">
                {semanticUnderstanding.intentSummary || 'Building backend system'}
              </p>
            </motion.div>

            {/* Card 2 - Actors */}
            {actors.length > 0 && (
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.1 }}
                className="bg-gray-800/30 border border-gray-700/30 rounded-lg p-3"
              >
                <div className="flex items-center gap-2 mb-1">
                  <Users className="w-4 h-4 text-gray-400" />
                  <span className="text-xs font-medium text-gray-400 uppercase tracking-wider">
                    Actors
                  </span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {actors.map((actor, idx) => (
                    <span
                      key={idx}
                      className="inline-block px-2 py-0.5 bg-gray-700/50 text-xs text-gray-300 rounded"
                    >
                      {actor}
                    </span>
                  ))}
                </div>
              </motion.div>
            )}

            {/* Card 3 - Impact */}
            {(severity || complexity !== undefined) && (
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.2 }}
                className="bg-gray-800/30 border border-gray-700/30 rounded-lg p-3"
              >
                <div className="flex items-center gap-2 mb-1">
                  <TrendingUp className="w-4 h-4 text-gray-400" />
                  <span className="text-xs font-medium text-gray-400 uppercase tracking-wider">
                    Impact
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  {severity && (
                    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border ${getSeverityColor(severity)}`}>
                      {severity}
                    </span>
                  )}
                  {complexity !== undefined && (
                    <span className="text-xs text-gray-400">
                      Complexity: <span className="text-gray-300 font-medium">{getComplexityLabel(complexity)}</span>
                    </span>
                  )}
                </div>
              </motion.div>
            )}

            {/* Card 4 - Status */}
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.3 }}
              className="bg-gray-800/30 border border-gray-700/30 rounded-lg p-3"
            >
              <div className="flex items-center gap-2 mb-1">
                <StateIcon className={`w-4 h-4 text-gray-400 ${stateInfo.animate ? 'animate-spin' : ''}`} />
                <span className="text-xs font-medium text-gray-400 uppercase tracking-wider">
                  Status
                </span>
              </div>
              <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border ${stateInfo.color}`}>
                {stateInfo.label}
              </span>
            </motion.div>
          </div>
        )}

        {/* Action Bar */}
        {(onReviewPlan || onModify || onBuild) && buildState === 'idle' && (
          <div className="flex items-center gap-3">
            {onReviewPlan && (
              <button
                onClick={onReviewPlan}
                className="px-4 py-2 bg-gray-800/50 hover:bg-gray-800/70 border border-gray-700/50 text-gray-300 text-sm font-medium rounded-lg transition-colors"
              >
                Review Plan
              </button>
            )}
            {onModify && (
              <button
                onClick={onModify}
                className="px-4 py-2 bg-gray-800/50 hover:bg-gray-800/70 border border-gray-700/50 text-gray-300 text-sm font-medium rounded-lg transition-colors"
              >
                Modify Request
              </button>
            )}
            {onBuild && (
              <button
                onClick={onBuild}
                className="px-6 py-2 bg-purple-600 hover:bg-purple-700 text-white text-sm font-semibold rounded-lg transition-colors shadow-lg shadow-purple-500/20"
              >
                Build Now
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
