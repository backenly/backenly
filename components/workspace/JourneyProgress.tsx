'use client'

import { motion } from 'framer-motion'
import { Check, Circle } from 'lucide-react'

interface JourneyProgressProps {
  backendCreated: boolean
  apisTested: boolean
  frontendConnected: boolean
}

export function JourneyProgress({ backendCreated, apisTested, frontendConnected }: JourneyProgressProps) {
  const steps = [
    { label: 'Backend Created', completed: backendCreated },
    { label: 'APIs Tested', completed: apisTested },
    { label: 'Frontend Connected', completed: frontendConnected },
  ]

  // Only show when at least backend is created
  if (!backendCreated) return null

  return (
    <motion.div
      initial={{ opacity: 0, y: -10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className="bg-[#151B2E]/40 border border-white/5 rounded-xl p-4 mb-6"
    >
      <div className="flex items-center justify-between">
        {steps.map((step, index) => (
          <div key={step.label} className="flex items-center space-x-2">
            <div className="flex items-center space-x-2">
              {step.completed ? (
                <motion.div
                  initial={{ scale: 0 }}
                  animate={{ scale: 1 }}
                  transition={{ type: 'spring', stiffness: 200, damping: 15 }}
                  className="w-5 h-5 rounded-full bg-green-500 flex items-center justify-center"
                >
                  <Check className="w-3 h-3 text-white" />
                </motion.div>
              ) : (
                <div className="w-5 h-5 rounded-full border-2 border-[#9AA3B2]/30 flex items-center justify-center">
                  <Circle className="w-2 h-2 text-[#9AA3B2]/30" />
                </div>
              )}
              <span className={`text-sm font-medium ${
                step.completed ? 'text-[#E6E8EF]' : 'text-[#9AA3B2]/50'
              }`}>
                {step.label}
              </span>
            </div>
            {index < steps.length - 1 && (
              <div className="mx-3 w-12 h-0.5 bg-white/5 rounded-full overflow-hidden">
                <motion.div
                  initial={{ width: '0%' }}
                  animate={{ width: step.completed ? '100%' : '0%' }}
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
