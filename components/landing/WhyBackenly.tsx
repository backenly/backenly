'use client'

import { motion } from 'framer-motion'
import { Check } from 'lucide-react'

const removed = [
  'Infrastructure',
  'Schema design',
  'API boilerplate',
  'Auth plumbing',
  'DevOps',
]

export function WhyBackenly() {
  return (
    <section className="py-32 px-4 sm:px-6 lg:px-8 bg-[#0A0E1A] relative overflow-hidden">
      {/* Background gradient */}
      <div className="absolute inset-0 bg-gradient-to-b from-transparent via-[#1a0f2e]/10 to-transparent pointer-events-none"></div>
      
      <div className="max-w-7xl mx-auto relative z-10">
        <motion.div
          className="text-center mb-16"
          initial={{ opacity: 0, y: 30 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6 }}
        >
          <h2 className="text-4xl sm:text-5xl lg:text-6xl font-bold text-white mb-6 tracking-tight">
            Stop building backend. Start building products.
          </h2>
          <p className="text-xl text-gray-400 max-w-3xl mx-auto leading-relaxed">
            Developers don't fail because of bad ideas.<br />
            They fail because backend takes too long.
          </p>
        </motion.div>

        <motion.div
          className="max-w-2xl mx-auto"
          initial={{ opacity: 0, y: 30 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6, delay: 0.2 }}
        >
          <p className="text-lg text-gray-300 mb-8 text-center">
            Backenly removes:
          </p>
          <div className="grid gap-4">
            {removed.map((item, index) => (
              <motion.div
                key={index}
                className="flex items-center gap-4 bg-white/5 border border-white/10 rounded-xl p-4 hover:border-white/20 transition-all duration-300"
                initial={{ opacity: 0, x: -20 }}
                whileInView={{ opacity: 1, x: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.3, delay: index * 0.1 }}
                whileHover={{ x: 5 }}
              >
                <div className="w-6 h-6 bg-gradient-to-br from-red-500 to-red-600 rounded-full flex items-center justify-center flex-shrink-0">
                  <span className="text-white text-xs font-bold">✕</span>
                </div>
                <span className="text-white text-lg line-through decoration-red-500/50">{item}</span>
              </motion.div>
            ))}
          </div>
          <motion.p
            className="text-center text-xl text-white mt-12 font-semibold"
            initial={{ opacity: 0, scale: 0.9 }}
            whileInView={{ opacity: 1, scale: 1 }}
            viewport={{ once: true }}
            transition={{ duration: 0.6, delay: 0.6 }}
          >
            So you can ship faster.
          </motion.p>
        </motion.div>
      </div>
    </section>
  )
}
