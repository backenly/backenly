'use client'

import { motion, AnimatePresence } from 'framer-motion'
import { CheckCircle2, X, AlertCircle, Info, Zap } from 'lucide-react'
import { useEffect } from 'react'
import { prefersReducedMotion } from '@/lib/workspace-performance'

interface SuccessToastProps {
  isVisible: boolean
  message: string
  type?: 'success' | 'error' | 'info' | 'warning'
  onClose: () => void
  duration?: number
}

export function SuccessToast({
  isVisible,
  message,
  type = 'success',
  onClose,
  duration = 3000,
}: SuccessToastProps) {
  // PHASE 8: Respect user's motion preferences
  const shouldAnimate = !prefersReducedMotion()
  
  useEffect(() => {
    if (isVisible && duration > 0) {
      const timer = setTimeout(onClose, duration)
      return () => clearTimeout(timer)
    }
  }, [isVisible, duration, onClose])

  const config = {
    success: {
      icon: CheckCircle2,
      color: 'from-green-600 to-emerald-600',
      borderColor: 'border-green-500/50',
      bgColor: 'bg-green-500/10',
    },
    error: {
      icon: AlertCircle,
      color: 'from-red-600 to-rose-600',
      borderColor: 'border-red-500/50',
      bgColor: 'bg-red-500/10',
    },
    info: {
      icon: Info,
      color: 'from-blue-600 to-cyan-600',
      borderColor: 'border-blue-500/50',
      bgColor: 'bg-blue-500/10',
    },
    warning: {
      icon: Zap,
      color: 'from-yellow-600 to-amber-600',
      borderColor: 'border-yellow-500/50',
      bgColor: 'bg-yellow-500/10',
    },
  }

  const { icon: Icon, color, borderColor, bgColor } = config[type]

  return (
    <AnimatePresence>
      {isVisible && (
        <motion.div
          initial={{ opacity: 0, y: -50, scale: 0.9 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -50, scale: 0.9 }}
          transition={
            shouldAnimate
              ? { type: 'spring', stiffness: 200, damping: 20 }
              : { duration: 0.15 }
          }
          className="fixed top-6 left-1/2 -translate-x-1/2 z-50 max-w-md w-full mx-4"
        >
          <div className={`relative ${bgColor} backdrop-blur-xl border ${borderColor} rounded-xl shadow-2xl`}>
            {/* Gradient background */}
            <div className={`absolute inset-0 bg-gradient-to-r ${color} opacity-10 rounded-xl`} />

            {/* Content */}
            <div className="relative p-4 flex items-center space-x-3">
              <div className={`flex-shrink-0 w-10 h-10 rounded-full bg-gradient-to-r ${color} flex items-center justify-center`}>
                <Icon className="w-5 h-5 text-white" />
              </div>

              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-[#E6E8EF]">{message}</p>
              </div>

              <button
                onClick={onClose}
                className="flex-shrink-0 p-1 hover:bg-white/10 rounded-lg transition-colors"
              >
                <X className="w-4 h-4 text-[#9AA3B2]" />
              </button>
            </div>

            {/* Progress bar */}
            {duration > 0 && (
              <motion.div
                initial={{ scaleX: 1 }}
                animate={{ scaleX: 0 }}
                transition={{ duration: duration / 1000, ease: 'linear' }}
                className={`h-1 bg-gradient-to-r ${color} origin-left rounded-b-xl`}
              />
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
