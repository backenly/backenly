'use client'

/**
 * MISSING PIECE 2: STREAMING THOUGHT VISIBILITY
 * 
 * Progressive reasoning display that increases perceived intelligence
 * Shows: Understanding → Analyzing → Planning → Checking → Ready
 * 
 * CRITICAL CONSTRAINTS:
 * - Pure UI visualization layer
 * - NO changes to execution pipeline
 * - Consumes existing SSE events
 * - Can be disabled without breaking execution
 */

import { useState, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  MagnifyingGlassIcon,
  Cog6ToothIcon,
  ShieldCheckIcon,
  CheckCircleIcon
} from '@heroicons/react/24/outline'

export type ThoughtStage = 
  | 'understanding'
  | 'analyzing'
  | 'planning'
  | 'checking'
  | 'ready'
  | 'executing'

export interface ThoughtProgress {
  stage: ThoughtStage
  message: string
  progress?: number // 0-100
  timestamp: number
}

interface StreamingThoughtDisplayProps {
  isActive: boolean
  currentStage?: ThoughtStage
  onComplete?: () => void
}

const STAGE_CONFIG: Record<ThoughtStage, {
  icon: typeof MagnifyingGlassIcon
  label: string
  color: string
  bgColor: string
  duration: number // ms
}> = {
  understanding: {
    icon: MagnifyingGlassIcon,
    label: 'Understanding your request',
    color: 'text-blue-400',
    bgColor: 'bg-blue-500/10',
    duration: 800,
  },
  analyzing: {
    icon: MagnifyingGlassIcon,
    label: 'Analyzing schema impact',
    color: 'text-purple-400',
    bgColor: 'bg-purple-500/10',
    duration: 1200,
  },
  planning: {
    icon: Cog6ToothIcon,
    label: 'Planning integration',
    color: 'text-yellow-400',
    bgColor: 'bg-yellow-500/10',
    duration: 1000,
  },
  checking: {
    icon: ShieldCheckIcon,
    label: 'Checking safety & impact',
    color: 'text-orange-400',
    bgColor: 'bg-orange-500/10',
    duration: 900,
  },
  ready: {
    icon: CheckCircleIcon,
    label: 'Ready to build',
    color: 'text-green-400',
    bgColor: 'bg-green-500/10',
    duration: 500,
  },
  executing: {
    icon: Cog6ToothIcon,
    label: 'Executing changes',
    color: 'text-purple-400',
    bgColor: 'bg-purple-500/10',
    duration: 0,
  },
}

export function StreamingThoughtDisplay({
  isActive,
  currentStage,
  onComplete,
}: StreamingThoughtDisplayProps) {
  const [visibleStages, setVisibleStages] = useState<ThoughtStage[]>([])
  const [activeStage, setActiveStage] = useState<ThoughtStage | null>(null)

  useEffect(() => {
    if (!isActive) {
      setVisibleStages([])
      setActiveStage(null)
      return
    }

    if (currentStage) {
      setActiveStage(currentStage)
      if (!visibleStages.includes(currentStage)) {
        setVisibleStages(prev => [...prev, currentStage])
      }
    }
  }, [isActive, currentStage])

  useEffect(() => {
    if (activeStage === 'ready' && onComplete) {
      const timer = setTimeout(onComplete, 500)
      return () => clearTimeout(timer)
    }
  }, [activeStage, onComplete])

  if (!isActive || visibleStages.length === 0) return null

  return (
    <div className="bg-slate-900/60 border border-slate-700 rounded-xl p-4">
      <div className="space-y-2">
        <AnimatePresence mode="sync">
          {visibleStages.map((stage) => {
            const config = STAGE_CONFIG[stage]
            const Icon = config.icon
            const isActive = stage === activeStage
            const isComplete = visibleStages.indexOf(stage) < visibleStages.indexOf(activeStage!)

            return (
              <motion.div
                key={stage}
                initial={{ opacity: 0, x: -20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 20 }}
                transition={{ duration: 0.3 }}
                className="flex items-center gap-3"
              >
                {/* Icon */}
                <div className={`
                  w-8 h-8 rounded-lg flex items-center justify-center transition-all
                  ${isActive ? `${config.bgColor} border border-${config.color.replace('text-', '')}/20` : ''}
                  ${isComplete ? 'bg-slate-800 border border-slate-700' : ''}
                  ${!isActive && !isComplete ? 'bg-slate-900 border border-slate-800' : ''}
                `}>
                  <Icon className={`
                    w-4 h-4 transition-all
                    ${isActive ? `${config.color} ${isActive ? 'animate-pulse' : ''}` : ''}
                    ${isComplete ? 'text-green-500' : ''}
                    ${!isActive && !isComplete ? 'text-slate-600' : ''}
                  `} />
                </div>

                {/* Label */}
                <div className="flex-1">
                  <p className={`
                    text-sm font-medium transition-all
                    ${isActive ? 'text-white' : ''}
                    ${isComplete ? 'text-slate-500' : ''}
                    ${!isActive && !isComplete ? 'text-slate-600' : ''}
                  `}>
                    {config.label}
                    {isActive && (
                      <span className="inline-block ml-1">
                        <motion.span
                          initial={{ opacity: 0 }}
                          animate={{ opacity: [0, 1, 0] }}
                          transition={{ duration: 1.5, repeat: Infinity }}
                        >
                          …
                        </motion.span>
                      </span>
                    )}
                  </p>
                </div>

                {/* Status Indicator */}
                <div>
                  {isComplete && (
                    <CheckCircleIcon className="w-4 h-4 text-green-500" />
                  )}
                  {isActive && (
                    <motion.div
                      className="w-4 h-4 border-2 border-purple-500 border-t-transparent rounded-full"
                      animate={{ rotate: 360 }}
                      transition={{ duration: 1, repeat: Infinity, ease: 'linear' }}
                    />
                  )}
                </div>
              </motion.div>
            )
          })}
        </AnimatePresence>
      </div>
    </div>
  )
}

/**
 * Compact inline thought indicator (for sticky input bar)
 */
export function CompactThoughtIndicator({
  stage,
  isActive,
}: {
  stage: ThoughtStage
  isActive: boolean
}) {
  if (!isActive) return null

  const config = STAGE_CONFIG[stage]
  const Icon = config.icon

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.8 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.8 }}
      className="flex items-center gap-2 px-3 py-1.5 bg-slate-900/60 border border-slate-700 rounded-lg"
    >
      <Icon className={`w-3.5 h-3.5 ${config.color} animate-pulse`} />
      <span className="text-xs text-slate-400">{config.label}</span>
    </motion.div>
  )
}

/**
 * Hook for managing thought progression
 * 
 * Usage in page.tsx:
 * const thought = useThoughtProgression()
 * 
 * // On SSE events:
 * thought.advance('understanding')
 * thought.advance('analyzing')
 * thought.complete()
 */
export function useThoughtProgression() {
  const [currentStage, setCurrentStage] = useState<ThoughtStage | null>(null)
  const [isActive, setIsActive] = useState(false)
  const [history, setHistory] = useState<ThoughtProgress[]>([])

  const start = () => {
    setIsActive(true)
    setCurrentStage('understanding')
    setHistory([{
      stage: 'understanding',
      message: 'Starting...',
      timestamp: Date.now(),
    }])
  }

  const advance = (stage: ThoughtStage, message?: string) => {
    setCurrentStage(stage)
    setHistory(prev => [...prev, {
      stage,
      message: message || STAGE_CONFIG[stage].label,
      timestamp: Date.now(),
    }])
  }

  const complete = () => {
    setCurrentStage('ready')
    setTimeout(() => {
      setIsActive(false)
      setCurrentStage(null)
    }, 1000)
  }

  const reset = () => {
    setIsActive(false)
    setCurrentStage(null)
    setHistory([])
  }

  return {
    currentStage,
    isActive,
    history,
    start,
    advance,
    complete,
    reset,
  }
}

/**
 * Map SSE events to thought stages (adapter)
 */
export function mapSSEEventToThoughtStage(eventType: string): ThoughtStage | null {
  const eventStageMap: Record<string, ThoughtStage> = {
    'semantic_understanding': 'understanding',
    'entity_inference': 'analyzing',
    'batch_plan': 'planning',
    'safety_check': 'checking',
    'dry_run': 'checking',
    'requires_commitment': 'ready',
    'execution_start': 'executing',
  }

  return eventStageMap[eventType] || null
}
