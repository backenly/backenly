'use client'

import { motion, AnimatePresence } from 'framer-motion'
import { ArrowRight, Plug } from 'lucide-react'
import { prefersReducedMotion } from '@/lib/workspace-performance'

interface ActionHighlightProps {
  isActive: boolean
  message: string
  position?: 'top' | 'bottom' | 'left' | 'right'
}

export function ActionHighlight({ isActive, message, position = 'top' }: ActionHighlightProps) {
  if (!isActive) return null
  
  // PHASE 8: Respect user's motion preferences
  const shouldAnimate = !prefersReducedMotion()

  const positionClasses = {
    top: 'bottom-full mb-2 left-1/2 -translate-x-1/2',
    bottom: 'top-full mt-2 left-1/2 -translate-x-1/2',
    left: 'right-full mr-2 top-1/2 -translate-y-1/2',
    right: 'left-full ml-2 top-1/2 -translate-y-1/2',
  }

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0, scale: 0.9, y: position === 'top' ? 10 : position === 'bottom' ? -10 : 0 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.9 }}
        transition={shouldAnimate ? { type: 'spring', stiffness: 200, damping: 20 } : { duration: 0 }}
        className={`absolute ${positionClasses[position]} z-20 pointer-events-none`}
      >
        <div className="relative">
          {/* Glowing background */}
          <div className="absolute inset-0 bg-gradient-to-r from-purple-500/20 to-blue-500/20 rounded-lg blur-xl" />
          
          {/* Content */}
          <div className="relative bg-gradient-to-r from-purple-600 to-blue-600 text-white px-4 py-2 rounded-lg shadow-2xl border border-white/20">
            <div className="flex items-center space-x-2">
              <motion.div
                animate={shouldAnimate ? { rotate: [0, 10, -10, 0] } : {}}
                transition={{ duration: 2, repeat: shouldAnimate ? Infinity : 0 }}
              >
                <Plug className="w-4 h-4" />
              </motion.div>
              <span className="text-sm font-semibold whitespace-nowrap">{message}</span>
              <motion.div
                animate={shouldAnimate ? { x: [0, 5, 0] } : {}}
                transition={{ duration: 1.5, repeat: shouldAnimate ? Infinity : 0 }}
              >
                <ArrowRight className="w-4 h-4" />
              </motion.div>
            </div>
          </div>

          {/* Arrow pointer */}
          <div
            className={`absolute ${
              position === 'top'
                ? 'top-full left-1/2 -translate-x-1/2 -mt-1 border-l-8 border-r-8 border-t-8 border-l-transparent border-r-transparent border-t-purple-600'
                : position === 'bottom'
                ? 'bottom-full left-1/2 -translate-x-1/2 -mb-1 border-l-8 border-r-8 border-b-8 border-l-transparent border-r-transparent border-b-purple-600'
                : position === 'left'
                ? 'left-full top-1/2 -translate-y-1/2 -ml-1 border-t-8 border-b-8 border-l-8 border-t-transparent border-b-transparent border-l-purple-600'
                : 'right-full top-1/2 -translate-y-1/2 -mr-1 border-t-8 border-b-8 border-r-8 border-t-transparent border-b-transparent border-r-purple-600'
            }`}
          />
        </div>
      </motion.div>
    </AnimatePresence>
  )
}
