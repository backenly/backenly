'use client'

import { motion } from 'framer-motion'

export function Testimonials() {
  return (
    <section className="py-20 px-6">
      <div className="max-w-7xl mx-auto">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5 }}
          className="text-center mb-12"
        >
          <p className="text-2xl text-gray-300 italic mb-8">
            "The fastest way to turn ideas into production backends."
          </p>
          <div className="flex items-center justify-center space-x-8 opacity-60">
            <div className="text-gray-500">Indie Hackers</div>
            <div className="w-1 h-1 bg-gray-500 rounded-full"></div>
            <div className="text-gray-500">YC Startups</div>
            <div className="w-1 h-1 bg-gray-500 rounded-full"></div>
            <div className="text-gray-500">Tech Companies</div>
          </div>
        </motion.div>
      </div>
    </section>
  )
}

