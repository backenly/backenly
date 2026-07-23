'use client'

import { motion } from 'framer-motion'
import Link from 'next/link'
import { MessageCircle } from 'lucide-react'

export function CommunityCTA() {
  return (
    <section className="py-32 px-4 sm:px-6 lg:px-8 bg-gradient-to-br from-[#8b5cf6] via-[#7c3aed] to-[#3b82f6] relative overflow-hidden">
      {/* Animated gradient overlay */}
      <motion.div
        className="absolute inset-0 bg-gradient-to-br from-[#8b5cf6] via-[#7c3aed] to-[#3b82f6]"
        animate={{
          background: [
            'linear-gradient(135deg, #8b5cf6, #7c3aed, #3b82f6)',
            'linear-gradient(135deg, #7c3aed, #3b82f6, #8b5cf6)',
            'linear-gradient(135deg, #3b82f6, #8b5cf6, #7c3aed)',
            'linear-gradient(135deg, #8b5cf6, #7c3aed, #3b82f6)',
          ],
        }}
        transition={{
          duration: 10,
          repeat: Infinity,
          ease: 'linear',
        }}
      />
      
      {/* Floating orbs */}
      <motion.div
        className="absolute top-1/4 left-1/4 w-64 h-64 bg-white/10 rounded-full blur-3xl"
        animate={{
          x: [0, 50, 0],
          y: [0, 30, 0],
          scale: [1, 1.2, 1],
        }}
        transition={{
          duration: 15,
          repeat: Infinity,
          ease: 'easeInOut',
        }}
      />
      <motion.div
        className="absolute bottom-1/4 right-1/4 w-64 h-64 bg-white/10 rounded-full blur-3xl"
        animate={{
          x: [0, -50, 0],
          y: [0, -30, 0],
          scale: [1, 1.2, 1],
        }}
        transition={{
          duration: 20,
          repeat: Infinity,
          ease: 'easeInOut',
        }}
      />
      
      <div className="max-w-4xl mx-auto text-center relative z-10">
        <motion.div
          initial={{ opacity: 0, y: 30 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6 }}
        >
          <div className="flex flex-col sm:flex-row items-center justify-center gap-6 mb-8">
            <h2 className="text-3xl sm:text-4xl font-bold text-white">JOIN COMMUNITY</h2>
            <motion.div
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
              transition={{ duration: 0.2 }}
            >
              <Link
                href="https://discord.gg/backenly"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 px-6 py-3 bg-white/20 hover:bg-white/30 backdrop-blur-sm text-white font-medium rounded-lg transition-all duration-300 shadow-lg hover:shadow-xl"
              >
                <MessageCircle className="w-5 h-5" />
                Join Discord
              </Link>
            </motion.div>
          </div>
          <p className="text-white/90 text-lg">
            Connect with founders, builders, and devs shaping the future of AI workflows.
          </p>
        </motion.div>
      </div>
    </section>
  )
}
