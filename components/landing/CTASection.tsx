'use client'

import Link from 'next/link'
import { motion } from 'framer-motion'
import { ArrowRight } from 'lucide-react'
import { FadeInSection } from './animations/FadeInSection'

export function CTASection() {
  return (
    <section className="py-40 px-4 sm:px-6 lg:px-8 bg-[#0A0E1A] relative overflow-hidden">
      <motion.div
        className="absolute inset-0 bg-[radial-gradient(ellipse_80%_50%_at_50%_50%,rgba(59,130,246,0.1),transparent)]"
        animate={{
          opacity: [0.8, 1, 0.8],
        }}
        transition={{ duration: 12, repeat: Infinity, ease: 'easeInOut' }}
      />
      
      <div className="max-w-[1280px] mx-auto text-center relative z-10">
        <FadeInSection>
          <h2 className="text-5xl sm:text-6xl lg:text-7xl font-bold mb-4 text-white tracking-tight leading-[1.1]">
            All it takes is an idea.
          </h2>
          
          <h3 className="text-5xl sm:text-6xl lg:text-7xl font-bold mb-12 text-white tracking-tight leading-[1.1]">
            The AI That Builds Your Backend.
          </h3>

          <div className="flex flex-col sm:flex-row gap-4 justify-center">
            <motion.div 
              whileHover={{ scale: 1.02 }} 
              whileTap={{ scale: 0.98 }}
              transition={{ type: 'spring', stiffness: 400, damping: 17 }}
            >
              <Link
                href="/auth/signup"
                className="inline-flex items-center gap-2 px-8 py-4 text-base font-semibold text-white bg-[#3B82F6] hover:bg-[#2563EB] rounded-xl transition-all duration-200 shadow-lg shadow-blue-500/20 hover:shadow-xl hover:shadow-blue-500/30"
              >
                Get Started — It's Free
                <ArrowRight className="w-4 h-4" />
              </Link>
            </motion.div>
            <motion.div 
              whileHover={{ scale: 1.02 }} 
              whileTap={{ scale: 0.98 }}
              transition={{ type: 'spring', stiffness: 400, damping: 17 }}
            >
              <Link
                href="#demo"
                className="inline-flex items-center px-8 py-4 text-base font-semibold text-white/90 border border-white/10 hover:border-white/20 rounded-xl transition-all duration-200 hover:bg-white/5"
              >
                Book a Demo
              </Link>
            </motion.div>
          </div>
        </FadeInSection>
      </div>
    </section>
  )
}
