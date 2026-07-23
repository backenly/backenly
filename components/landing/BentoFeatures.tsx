'use client'

import { motion } from 'framer-motion'
import { Shield, Undo2, Eye, Users } from 'lucide-react'

const features = [
  {
    icon: Shield,
    title: 'Built to be safe by default',
    description: 'Every change is validated before execution. No broken states. No silent failures.',
  },
  {
    icon: Undo2,
    title: 'Undo is real',
    description: 'Undo rolls back real infrastructure — not just UI state or configs.',
  },
  {
    icon: Eye,
    title: 'No hidden state',
    description: 'What you see is what exists. Nothing accumulates silently over time.',
  },
  {
    icon: Users,
    title: 'You never touch the backend',
    description: 'No schemas, APIs, auth flows, or deployments. Just describe behavior.',
  },
]

export function BentoFeatures() {
  return (
    <section className="relative py-24 px-4 sm:px-6 lg:px-8 bg-white">
      <div className="relative max-w-5xl mx-auto">
        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6 }}
          className="text-center mb-16"
        >
          <h2 className="text-4xl sm:text-5xl font-bold mb-4 text-gray-900">
            Why Backenly feels different
          </h2>
        </motion.div>

        {/* Simple grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
          {features.map((feature, index) => {
            const Icon = feature.icon
            
            return (
              <motion.div
                key={feature.title}
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.5, delay: index * 0.1 }}
                className="p-8 bg-gray-50 rounded-lg"
              >
                <Icon className="w-6 h-6 text-gray-900 mb-4" />
                <h3 className="text-xl font-bold text-gray-900 mb-3">
                  {feature.title}
                </h3>
                <p className="text-gray-600 leading-relaxed">
                  {feature.description}
                </p>
              </motion.div>
            )
          })}
        </div>
      </div>
    </section>
  )
}
