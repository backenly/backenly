'use client'

import { motion, useInView } from 'framer-motion'
import Link from 'next/link'
import { ArrowRight } from 'lucide-react'
import { useRef } from 'react'

export function FinalCTA() {
  const ref = useRef(null)
  const isInView = useInView(ref, { once: true, margin: '-100px' })

  return (
    <section className="py-32 px-4 sm:px-6 lg:px-8 bg-[#0A0E1A] relative overflow-hidden">
      {/* Animated background */}
      <motion.div
        className="absolute inset-0 opacity-30"
        animate={{
          background: [
            'radial-gradient(circle at 50% 50%, #8b5cf6 0%, transparent 50%)',
            'radial-gradient(circle at 50% 50%, #3b82f6 0%, transparent 50%)',
            'radial-gradient(circle at 50% 50%, #8b5cf6 0%, transparent 50%)',
          ],
        }}
        transition={{ duration: 10, repeat: Infinity }}
      />

      {/* Grid */}
      <div 
        className="absolute inset-0 opacity-10"
        style={{
          backgroundImage: `linear-gradient(rgba(139, 92, 246, 0.1) 1px, transparent 1px),
                           linear-gradient(90deg, rgba(139, 92, 246, 0.1) 1px, transparent 1px)`,
          backgroundSize: '60px 60px',
        }}
      />

      {/* Noise texture */}
      <div 
        className="absolute inset-0 opacity-20 mix-blend-soft-light"
        style={{
          backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 400 400' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noiseFilter'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='2' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noiseFilter)'/%3E%3C/svg%3E")`,
        }}
      />

      <div className="max-w-5xl mx-auto text-center relative z-10" ref={ref}>
        <motion.div
          initial={{ opacity: 0, scale: 0.9 }}
          animate={isInView ? { opacity: 1, scale: 1 } : {}}
          transition={{ duration: 0.8 }}
        >
          {/* Badge */}
          <motion.div
            className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-purple-500/10 border border-purple-500/20 mb-8"
            whileHover={{ scale: 1.05 }}
            animate={{
              boxShadow: [
                '0 0 20px rgba(139, 92, 246, 0.2)',
                '0 0 40px rgba(139, 92, 246, 0.4)',
                '0 0 20px rgba(139, 92, 246, 0.2)',
              ],
            }}
            transition={{ duration: 3, repeat: Infinity }}
          >
            <span className="text-sm font-semibold text-purple-400">Start Building Today</span>
          </motion.div>

          {/* Headline */}
          <motion.h2
            className="text-5xl sm:text-6xl lg:text-7xl font-bold mb-6"
            initial={{ opacity: 0, y: 20 }}
            animate={isInView ? { opacity: 1, y: 0 } : {}}
            transition={{ duration: 0.8, delay: 0.2 }}
          >
            <span className="text-white">Ready to ship </span>
            <br />
            <motion.span 
              className="bg-gradient-to-r from-purple-400 via-violet-400 to-blue-400 bg-clip-text text-transparent"
              animate={{ 
                backgroundPosition: ['0% 50%', '100% 50%', '0% 50%'],
              }}
              transition={{ duration: 5, repeat: Infinity, ease: 'linear' }}
              style={{ backgroundSize: '200% 200%' }}
            >
              10x faster?
            </motion.span>
          </motion.h2>

          <motion.p
            className="text-xl text-gray-400 mb-12 max-w-2xl mx-auto"
            initial={{ opacity: 0 }}
            animate={isInView ? { opacity: 1 } : {}}
            transition={{ duration: 0.8, delay: 0.4 }}
          >
            Join developers building production backends in minutes, not months.
            <br />
            No credit card. No setup. Just your idea.
          </motion.p>

          {/* CTAs */}
          <motion.div
            className="flex flex-col sm:flex-row gap-4 justify-center items-center"
            initial={{ opacity: 0, y: 20 }}
            animate={isInView ? { opacity: 1, y: 0 } : {}}
            transition={{ duration: 0.8, delay: 0.6 }}
          >
            <motion.div
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
            >
              <Link
                href="/auth/signup"
                className="group inline-flex items-center gap-2 px-10 py-5 text-lg font-bold text-black bg-white hover:bg-gray-100 rounded-xl transition-all"
              >
                <span>Start Free</span>
                <ArrowRight className="w-5 h-5 transition-transform group-hover:translate-x-1" />
              </Link>
            </motion.div>

            <motion.div
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
            >
              <Link
                href="#demo"
                className="inline-flex items-center gap-2 px-10 py-5 text-lg font-bold text-white border-2 border-white/20 hover:border-white/40 bg-white/5 hover:bg-white/10 rounded-xl transition-all duration-300 backdrop-blur-sm"
              >
                Book a Demo
              </Link>
            </motion.div>
          </motion.div>

          {/* Trust indicators */}
          <motion.div
            className="flex items-center justify-center gap-8 mt-12 text-sm text-gray-500"
            initial={{ opacity: 0 }}
            animate={isInView ? { opacity: 1 } : {}}
            transition={{ duration: 0.8, delay: 0.8 }}
          >
            <div className="flex items-center gap-2">
              <svg className="w-5 h-5 text-green-400" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
              </svg>
              <span>Free forever</span>
            </div>
            <div className="flex items-center gap-2">
              <svg className="w-5 h-5 text-green-400" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
              </svg>
              <span>No credit card</span>
            </div>
            <div className="flex items-center gap-2">
              <svg className="w-5 h-5 text-green-400" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
              </svg>
              <span>5 min setup</span>
            </div>
          </motion.div>
        </motion.div>
      </div>
    </section>
  )
}
