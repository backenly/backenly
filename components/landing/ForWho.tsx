'use client'

import { motion } from 'framer-motion'
import { Rocket, Code, Bot, Building2 } from 'lucide-react'

const audiences = [
  {
    icon: Rocket,
    title: 'Founders shipping real products',
    description: 'Build without worrying about backend mistakes.',
    example: 'Launch MVP in hours, not weeks',
  },
  {
    icon: Code,
    title: 'Teams that value safety over hacks',
    description: 'Move fast without creating tech debt.',
    example: 'No more waiting on backend team',
  },
  {
    icon: Bot,
    title: 'Builders tired of backend anxiety',
    description: 'Focus on your product, not infrastructure.',
    example: 'Focus on prompts, not Prisma',
  },
]

export function ForWho() {
  return (
    <section className="py-32 px-4 sm:px-6 lg:px-8 bg-[#0A0E1A]">
      <div className="max-w-7xl mx-auto">
        {/* Section Header */}
        <motion.div
          className="text-center mb-16"
          initial={{ opacity: 0, y: 30 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6 }}
        >
          <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full border border-white/20 bg-white/5 mb-6">
            <span className="text-sm text-gray-400 uppercase tracking-wider font-medium">Who It's For</span>
          </div>
          <h2 className="text-4xl sm:text-5xl lg:text-6xl font-bold text-white mb-6 tracking-tight">
            Who Backenly is for
          </h2>
          <p className="text-xl text-gray-400 max-w-3xl mx-auto">
            Whether you're launching a startup or shipping for clients, Backenly gives you production-ready backends in minutes
          </p>
        </motion.div>

        {/* Audience Cards */}
        <div className="grid md:grid-cols-3 gap-8">
          {audiences.map((audience, index) => {
            const Icon = audience.icon
            return (
              <motion.div
                key={index}
                className="bg-white/5 border border-white/10 rounded-2xl p-6 hover:border-white/20 hover:bg-white/10 transition-all duration-300 group"
                initial={{ opacity: 0, y: 30 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.5, delay: index * 0.1 }}
                whileHover={{ y: -5 }}
              >
                <div className="w-12 h-12 bg-gradient-to-br from-[#8b5cf6] to-[#3b82f6] rounded-xl flex items-center justify-center mb-4">
                  <Icon className="w-6 h-6 text-white" />
                </div>
                <h3 className="text-xl font-semibold text-white mb-2 group-hover:text-transparent group-hover:bg-clip-text group-hover:bg-gradient-to-r group-hover:from-[#8b5cf6] group-hover:to-[#3b82f6] transition-all duration-300">
                  {audience.title}
                </h3>
                <p className="text-gray-400 group-hover:text-gray-300 transition-colors duration-300 mb-3">
                  {audience.description}
                </p>
                <div className="flex items-center gap-2 text-sm font-medium text-purple-400 bg-purple-500/10 px-3 py-1.5 rounded-lg">
                  <span>✨</span>
                  <span>{audience.example}</span>
                </div>
              </motion.div>
            )
          })}
        </div>
      </div>
    </section>
  )
}
