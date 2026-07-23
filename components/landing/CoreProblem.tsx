'use client'

import { motion } from 'framer-motion'
import { AlertTriangle, Database, Lock, Cloud, Settings } from 'lucide-react'

const problems = [
  { text: 'One wrong migration can break production', icon: Database },
  { text: 'One auth change can lock out users', icon: Lock },
  { text: "One deploy can't be undone cleanly", icon: Cloud },
  { text: 'Hidden state accumulates over time', icon: Settings },
]

export function CoreProblem() {
  return (
    <section className="relative py-32 px-6 bg-[#0a0a0a]">
      <div className="max-w-5xl mx-auto">
        {/* Section Title */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6 }}
          className="text-center mb-20"
        >
          <h2 className="text-4xl sm:text-5xl font-bold text-white mb-4">
            Why backend tools feel stressful
          </h2>
          <p className="text-xl text-gray-400 max-w-3xl mx-auto">
            Modern backend platforms are powerful — but fragile.
          </p>
        </motion.div>

        {/* Problems Grid */}
        <div className="grid md:grid-cols-2 gap-6 mb-16">
          {problems.map((problem, index) => {
            const Icon = problem.icon
            return (
              <motion.div
                key={index}
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.5, delay: index * 0.1 }}
                className="flex items-start gap-4 p-8 rounded-2xl bg-[#111111] border border-gray-800 hover:border-gray-700 transition-all group"
              >
                <div className="flex-shrink-0 w-12 h-12 rounded-xl bg-red-50 border border-red-200 flex items-center justify-center group-hover:scale-110 transition-transform">
                  <Icon className="w-6 h-6 text-red-600" />
                </div>
                <p className="text-gray-300 font-medium pt-2 text-base">{problem.text}</p>
              </motion.div>
            )
          })}
        </div>

        {/* Key Insight */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6, delay: 0.4 }}
          className="text-center space-y-8 max-w-3xl mx-auto"
        >
          <p className="text-xl text-gray-400 leading-relaxed">
            Over time, hidden state builds up.<br />
            Confidence disappears.<br />
            Fear replaces speed.
          </p>
          <div className="h-px bg-gradient-to-r from-transparent via-gray-800 to-transparent w-full" />
          <p className="text-2xl text-white font-semibold leading-relaxed">
            Most tools optimize for <span className="text-gray-100">flexibility</span>.<br />
            Very few optimize for <span className="text-white">safety</span>.
          </p>
        </motion.div>
      </div>
    </section>
  )
}
