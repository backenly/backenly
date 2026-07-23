'use client'

import { useState, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { X, Lightbulb } from 'lucide-react'

interface ContextualHintProps {
  type: 'test-api' | 'advanced-view' | null
  onDismiss: () => void
}

export function ContextualHint({ type, onDismiss }: ContextualHintProps) {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    if (type) {
      // Show hint after a short delay
      const timer = setTimeout(() => setVisible(true), 1000)
      return () => clearTimeout(timer)
    } else {
      setVisible(false)
    }
  }, [type])

  const getHintContent = () => {
    switch (type) {
      case 'test-api':
        return {
          title: 'Test your APIs',
          message: 'Click "Test Endpoint" on any API to verify it works',
        }
      case 'advanced-view':
        return {
          title: 'Inspect deeper',
          message: 'Open Advanced View to see full schema, relationships, and configuration',
        }
      default:
        return null
    }
  }

  const content = getHintContent()
  if (!content || !visible) return null

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0, y: -10, scale: 0.95 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: -10, scale: 0.95 }}
        transition={{ duration: 0.2 }}
        className="bg-[#151B2E]/90 backdrop-blur-xl border border-yellow-500/30 rounded-xl p-4 mb-6 relative overflow-hidden"
      >
        {/* Animated pulse effect */}
        <motion.div
          animate={{ opacity: [0.3, 0.6, 0.3] }}
          transition={{ duration: 2, repeat: Infinity }}
          className="absolute inset-0 bg-gradient-to-r from-yellow-500/10 to-yellow-600/5"
        />

        <div className="relative flex items-start space-x-3">
          <div className="flex-shrink-0">
            <div className="w-8 h-8 rounded-lg bg-yellow-500/20 flex items-center justify-center">
              <Lightbulb className="w-4 h-4 text-yellow-400" />
            </div>
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="text-sm font-semibold text-[#E6E8EF] mb-0.5">
              {content.title}
            </h3>
            <p className="text-sm text-[#9AA3B2]">
              {content.message}
            </p>
          </div>
          <button
            onClick={() => {
              setVisible(false)
              setTimeout(onDismiss, 200)
            }}
            className="flex-shrink-0 p-1 hover:bg-white/5 rounded transition-colors"
          >
            <X className="w-4 h-4 text-[#9AA3B2]" />
          </button>
        </div>
      </motion.div>
    </AnimatePresence>
  )
}
