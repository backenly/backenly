'use client'

import { motion } from 'framer-motion'

export function BenefitsStrip() {
  const benefits = [
    { text: 'AI-generated APIs in minutes', dot: true },
    { text: 'Postgres & MongoDB support', dot: true },
    { text: 'No vendor lock-in', dot: true },
    { text: 'Exportable backend code', dot: false },
  ]

  return (
    <section className="py-8 px-4 sm:px-6 lg:px-8 border-b border-[#1A1F2E]/50 bg-[#0A0E1A]/50 backdrop-blur-sm">
      <div className="max-w-[1280px] mx-auto">
        <div className="flex flex-wrap items-center justify-center gap-6 text-sm text-gray-400">
          {benefits.map((benefit, index) => (
            <motion.div
              key={index}
              className="flex items-center space-x-2"
              initial={{ opacity: 0, y: -10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5, delay: index * 0.1 }}
            >
              {index === 0 && (
                <motion.div
                  className="w-2 h-2 rounded-full bg-[#3B82F6]"
                  animate={{ scale: [1, 1.3, 1], opacity: [1, 0.7, 1] }}
                  transition={{ duration: 2, repeat: Infinity }}
                />
              )}
              <span className="font-medium">{benefit.text}</span>
              {benefit.dot && index < benefits.length - 1 && (
                <span className="text-gray-600 mx-2">·</span>
              )}
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  )
}
