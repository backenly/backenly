'use client'

import { motion } from 'framer-motion'

export function TrustBanner() {
  return (
    <section className="py-12 px-4 sm:px-6 lg:px-8 bg-[#0A0E1A] border-y border-white/5">
      <div className="max-w-7xl mx-auto text-center">
        <motion.p
          className="text-sm sm:text-base text-gray-400"
          initial={{ opacity: 0 }}
          whileInView={{ opacity: 1 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5 }}
        >
          Trusted by founders, indie hackers, and teams building production apps
        </motion.p>
      </div>
    </section>
  )
}
