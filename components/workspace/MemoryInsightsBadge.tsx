/**
 * Memory Insights Badge
 * 
 * Displays a subtle indicator that the system is using learned
 * architectural preferences from previous interactions.
 */

'use client'

import { Brain } from 'lucide-react'
import { motion } from 'framer-motion'

interface MemoryInsightsBadgeProps {
  show?: boolean
  integrationPatterns?: number
  corrections?: number
}

export function MemoryInsightsBadge({
  show = false,
  integrationPatterns = 0,
  corrections = 0,
}: MemoryInsightsBadgeProps) {
  if (!show || (integrationPatterns === 0 && corrections === 0)) {
    return null
  }

  const totalLearnings = integrationPatterns + corrections

  return (
    <motion.div
      initial={{ opacity: 0, y: -10 }}
      animate={{ opacity: 1, y: 0 }}
      className="inline-flex items-center gap-2 px-3 py-1.5 bg-purple-500/10 border border-purple-500/20 rounded-full"
    >
      <Brain className="w-3.5 h-3.5 text-purple-400" />
      <span className="text-xs text-purple-300 font-medium">
        Using your architecture preferences
      </span>
      <span className="text-[10px] text-purple-400/60">
        ({totalLearnings} learned)
      </span>
    </motion.div>
  )
}
