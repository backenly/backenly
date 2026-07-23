'use client'

import { motion } from 'framer-motion'
import { Check } from 'lucide-react'

interface BuildStage {
  label: string
  completed: boolean
}

interface BuildProgressIndicatorProps {
  stages: BuildStage[]
  show: boolean
}

export function BuildProgressIndicator({ stages, show }: BuildProgressIndicatorProps) {
  if (!show) return null

  return (
    <motion.div
      initial={{ opacity: 0, y: -20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -20 }}
      className="mb-6 bg-[#151B2E]/60 backdrop-blur-xl border border-white/5 rounded-xl p-4"
    >
      <div className="flex items-center justify-between space-x-4">
        {stages.map((stage, index) => (
          <div key={index} className="flex-1">
            <div className="flex items-center space-x-2">
              <motion.div
                initial={{ scale: 0 }}
                animate={{ scale: stage.completed ? 1 : 0 }}
                transition={{ type: 'spring', stiffness: 200, damping: 15 }}
                className="w-5 h-5 rounded-full bg-green-500 flex items-center justify-center flex-shrink-0"
              >
                <Check className="w-3 h-3 text-white" />
              </motion.div>
              <div className="flex-1 min-w-0">
                <p className={`text-xs font-medium transition-colors ${
                  stage.completed ? 'text-[#E6E8EF]' : 'text-[#9AA3B2]'
                }`}>
                  {stage.label}
                </p>
              </div>
            </div>
            {index < stages.length - 1 && (
              <div className="mt-2 h-0.5 bg-white/5 rounded-full overflow-hidden">
                <motion.div
                  initial={{ width: '0%' }}
                  animate={{ width: stage.completed ? '100%' : '0%' }}
                  transition={{ duration: 0.3 }}
                  className="h-full bg-green-500"
                />
              </div>
            )}
          </div>
        ))}
      </div>
    </motion.div>
  )
}
