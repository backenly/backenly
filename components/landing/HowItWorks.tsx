'use client'

import { motion } from 'framer-motion'

export function HowItWorks() {
  return (
    <section className="relative py-24 px-6 bg-[#141414]">
      <div className="max-w-4xl mx-auto">
        <motion.h2
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6 }}
          className="text-4xl sm:text-5xl font-bold text-center mb-20 text-white"
        >
          How it works
        </motion.h2>

        <div className="space-y-12">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.5 }}
          >
            <h3 className="text-xl font-bold text-white mb-3">Describe behavior</h3>
            <p className="text-gray-400 leading-relaxed">Say what your app should do — not how to build it.</p>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.5, delay: 0.1 }}
          >
            <h3 className="text-xl font-bold text-white mb-3">Backenly executes safely</h3>
            <p className="text-gray-400 leading-relaxed">Databases, APIs, auth, and storage are created with guarantees.</p>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.5, delay: 0.2 }}
          >
            <h3 className="text-xl font-bold text-white mb-3">Undo if needed</h3>
            <p className="text-gray-400 leading-relaxed">Every change can be reversed without data loss.</p>
          </motion.div>
        </div>
      </div>
    </section>
  )
}
