'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { motion } from 'framer-motion'
import { ArrowRight } from 'lucide-react'

// Static star data to avoid hydration mismatch
const STARS = Array.from({ length: 120 }, (_, i) => ({
  id: i,
  x: ((i * 137.508) % 100),
  y: ((i * 97.333) % 100),
  size: i % 3 === 0 ? 1.5 : i % 5 === 0 ? 1 : 0.75,
  delay: (i * 0.13) % 5,
  duration: 3 + (i % 4),
}))

export function Hero() {
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
  }, [])

  return (
    <section
      className="relative overflow-hidden px-4 sm:px-6 lg:px-8 min-h-screen flex items-center justify-center"
      style={{ background: '#08080f' }}
    >
      {/* Universe background layers */}
      <div className="absolute inset-0 overflow-hidden">

        {/* Subtle dot-grid mesh (Framer-style) */}
        <div
          className="absolute inset-0"
          style={{
            backgroundImage: 'radial-gradient(circle, rgba(255,255,255,0.07) 1px, transparent 1px)',
            backgroundSize: '32px 32px',
          }}
        />

        {/* Deep nebula glow — center */}
        <div
          className="absolute inset-0"
          style={{
            background: `
              radial-gradient(ellipse 80% 60% at 50% 40%, rgba(88, 28, 220, 0.18) 0%, transparent 70%),
              radial-gradient(ellipse 50% 40% at 20% 70%, rgba(49, 10, 120, 0.22) 0%, transparent 60%),
              radial-gradient(ellipse 40% 30% at 80% 20%, rgba(30, 8, 90, 0.2) 0%, transparent 55%)
            `,
          }}
        />

        {/* Animated slow nebula pulse */}
        <motion.div
          className="absolute inset-0"
          animate={{
            opacity: [0.6, 1, 0.6],
          }}
          transition={{ duration: 8, repeat: Infinity, ease: 'easeInOut' }}
          style={{
            background: 'radial-gradient(ellipse 60% 50% at 50% 45%, rgba(109, 40, 217, 0.12) 0%, transparent 65%)',
          }}
        />

        {/* Starfield */}
        {mounted && STARS.map((star) => (
          <motion.div
            key={star.id}
            className="absolute rounded-full bg-white"
            style={{
              left: `${star.x}%`,
              top: `${star.y}%`,
              width: `${star.size}px`,
              height: `${star.size}px`,
            }}
            animate={{ opacity: [0.2, 0.9, 0.2] }}
            transition={{
              duration: star.duration,
              repeat: Infinity,
              delay: star.delay,
              ease: 'easeInOut',
            }}
          />
        ))}

        {/* A couple of slightly brighter accent stars */}
        {mounted && [
          { x: 18, y: 22, s: 2.5, d: 0 },
          { x: 73, y: 14, s: 2, d: 1.2 },
          { x: 88, y: 63, s: 2.5, d: 2.4 },
          { x: 32, y: 78, s: 2, d: 0.8 },
        ].map((s, i) => (
          <motion.div
            key={`bright-${i}`}
            className="absolute rounded-full"
            style={{
              left: `${s.x}%`,
              top: `${s.y}%`,
              width: `${s.s}px`,
              height: `${s.s}px`,
              background: 'white',
              boxShadow: '0 0 6px 2px rgba(180,160,255,0.5)',
            }}
            animate={{ opacity: [0.4, 1, 0.4], scale: [1, 1.4, 1] }}
            transition={{ duration: 4, repeat: Infinity, delay: s.d, ease: 'easeInOut' }}
          />
        ))}

        {/* Horizontal edge vignette */}
        <div
          className="absolute inset-0"
          style={{
            background: 'radial-gradient(ellipse 100% 100% at 50% 50%, transparent 40%, #08080f 100%)',
          }}
        />
      </div>

      {/* Content */}
      <div className="relative max-w-5xl mx-auto z-10 w-full py-20">
        <div className="text-center">
          {/* Main headline */}
          <motion.h1
            className="text-4xl sm:text-5xl lg:text-6xl font-bold mb-8 leading-tight"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.1 }}
          >
            <span className="text-white">
              Describe what you want to build
            </span>
            <br />
            <span className="text-transparent bg-clip-text bg-gradient-to-r from-purple-400 to-purple-600">
              It becomes a real backend
            </span>
          </motion.h1>

          {/* Subheadline */}
          <motion.p
            className="text-lg text-gray-300 mb-12 max-w-4xl mx-auto leading-relaxed"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.6, delay: 0.3 }}
          >
            Paste your idea from ChatGPT. Get a complete backend. Connect to Cursor or Bolt in one line.
          </motion.p>

          {/* CTA */}
          <motion.div
            className="flex flex-col sm:flex-row gap-4 justify-center items-center mb-10"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.5 }}
          >
            <Link
              href="/auth/signup"
              className="group relative inline-flex items-center gap-2 px-8 py-4 bg-white hover:bg-gray-100 text-black rounded-lg font-semibold transition-all overflow-hidden"
            >
              <span className="relative z-10">Start building your backend</span>
              <ArrowRight className="relative z-10 w-4 h-4 transition-transform group-hover:translate-x-1" />
              
              {/* Shine effect */}
              <motion.div
                className="absolute inset-0 bg-gradient-to-r from-transparent via-white/20 to-transparent"
                animate={{
                  x: ['-100%', '200%'],
                }}
                transition={{
                  duration: 3,
                  repeat: Infinity,
                  repeatDelay: 2,
                  ease: 'easeInOut',
                }}
              />
            </Link>
          </motion.div>

          {/* Trust line */}
          <motion.p
            className="text-sm text-gray-500 font-medium"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.6, delay: 0.7 }}
          >
            Undo any change. Nothing breaks. Ever.
          </motion.p>

          {/* Decorative line */}
          <motion.div
            className="mt-16 h-px bg-gradient-to-r from-transparent via-purple-500/20 to-transparent max-w-3xl mx-auto"
            initial={{ scaleX: 0 }}
            animate={{ scaleX: 1 }}
            transition={{ duration: 1, delay: 0.9 }}
          />
        </div>
      </div>

      {/* Bottom fade */}
      <div className="absolute bottom-0 left-0 right-0 h-32 pointer-events-none" style={{ background: 'linear-gradient(to top, #08080f, transparent)' }} />
    </section>
  )
}
