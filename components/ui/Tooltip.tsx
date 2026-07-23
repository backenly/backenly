'use client'

import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'

interface TooltipProps {
  content: string
  children: React.ReactNode
}

export function Tooltip({ content, children }: TooltipProps) {
  const [isVisible, setIsVisible] = useState(false)

  return (
    <div
      className="relative inline-block"
      onMouseEnter={() => setIsVisible(true)}
      onMouseLeave={() => setIsVisible(false)}
    >
      {children}
      <AnimatePresence>
        {isVisible && (
          <motion.div
            initial={{ opacity: 0, y: 5 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 5 }}
            className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 z-50"
          >
            <div className="bg-[#181B20] border border-[#23262B] rounded-lg px-3 py-2 text-xs text-white shadow-xl max-w-xs">
              {content}
              <div className="absolute top-full left-1/2 -translate-x-1/2 -mt-1">
                <div className="w-2 h-2 bg-[#181B20] border-r border-b border-[#23262B] rotate-45"></div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

