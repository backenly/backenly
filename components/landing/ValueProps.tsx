'use client'

import { motion, useInView } from 'framer-motion'
import { useRef } from 'react'
import { Zap, Database, Lock, Cloud } from 'lucide-react'

const features = [
  {
    icon: Zap,
    title: 'AI API Builder',
    description: 'Describe your backend in plain English. AI generates REST APIs with validation, relationships, and authentication.',
    gradient: 'from-purple-500 to-blue-500',
    delay: 0,
  },
  {
    icon: Database,
    title: 'Managed PostgreSQL',
    description: 'Full PostgreSQL database with visual editor. Modify schema, add columns, define foreign keys — no SQL required.',
    gradient: 'from-blue-500 to-cyan-500',
    delay: 0.1,
  },
  {
    icon: Cloud,
    title: 'One-Click Deploy',
    description: 'Backend deployed in isolated Docker containers with unique URLs. Zero DevOps, zero configuration.',
    gradient: 'from-cyan-500 to-teal-500',
    delay: 0.2,
  },
  {
    icon: Lock,
    title: 'Auth & Storage',
    description: 'JWT authentication, user management, and file storage with signed URLs. Production-ready security built-in.',
    gradient: 'from-teal-500 to-purple-500',
    delay: 0.3,
  },
]

const container = {
  hidden: { opacity: 0 },
  show: {
    opacity: 1,
    transition: {
      staggerChildren: 0.1,
    },
  },
}

const item = {
  hidden: { opacity: 0, y: 40 },
  show: { opacity: 1, y: 0 },
}

export function ValueProps() {
  const ref = useRef(null)
  const isInView = useInView(ref, { once: true, margin: '-100px' })

  return (
    <section id="product" className="py-32 px-4 sm:px-6 lg:px-8 bg-[#0A0E1A] relative overflow-hidden">
      {/* Animated background */}
      <motion.div
        className="absolute inset-0 opacity-30"
        animate={{
          background: [
            'radial-gradient(circle at 20% 20%, #8b5cf6 0%, transparent 50%)',
            'radial-gradient(circle at 80% 80%, #3b82f6 0%, transparent 50%)',
            'radial-gradient(circle at 20% 20%, #8b5cf6 0%, transparent 50%)',
          ],
        }}
        transition={{ duration: 20, repeat: Infinity, ease: 'linear' }}
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
      
      <div className="max-w-7xl mx-auto relative z-10" ref={ref}>
        {/* Header */}
        <motion.div
          className="text-center mb-20"
          initial={{ opacity: 0, y: 30 }}
          animate={isInView ? { opacity: 1, y: 0 } : {}}
          transition={{ duration: 0.8 }}
        >
          <motion.div
            className="inline-block mb-4 px-4 py-2 rounded-full bg-purple-500/10 border border-purple-500/20"
            whileHover={{ scale: 1.05 }}
          >
            <span className="text-sm font-semibold text-purple-400">Everything You Need</span>
          </motion.div>
          <h2 className="text-5xl sm:text-6xl font-bold text-white mb-6">
            <span className="bg-gradient-to-r from-purple-400 via-violet-400 to-blue-400 bg-clip-text text-transparent">
              Ship Faster.
            </span>
            <br />
            <span className="text-white">Build Less.</span>
          </h2>
          <p className="text-xl text-gray-400 max-w-2xl mx-auto">
            All the backend infrastructure you need, zero configuration required.
          </p>
        </motion.div>

        {/* Feature Grid */}
        <motion.div
          className="grid md:grid-cols-2 gap-6"
          variants={container}
          initial="hidden"
          animate={isInView ? 'show' : 'hidden'}
        >
          {features.map((feature, index) => {
            const Icon = feature.icon
            return (
              <motion.div
                key={index}
                variants={item}
                className="group relative"
                whileHover={{ scale: 1.02 }}
                transition={{ duration: 0.3 }}
              >
                {/* Glow effect */}
                <motion.div
                  className="absolute -inset-1 rounded-2xl opacity-0 group-hover:opacity-100 transition-opacity duration-500 blur-xl"
                  style={{
                    background: `linear-gradient(135deg, ${feature.gradient.split(' ')[0].replace('from-', '')}, ${feature.gradient.split(' ')[1].replace('to-', '')})`,
                  }}
                  animate={{
                    opacity: [0, 0.5, 0],
                  }}
                  transition={{
                    duration: 3,
                    repeat: Infinity,
                    repeatDelay: 2,
                  }}
                />

                <div className="relative h-full bg-gradient-to-br from-white/10 to-white/5 backdrop-blur-xl border border-white/10 rounded-2xl p-8 group-hover:border-white/20 transition-all duration-300 overflow-hidden">
                  {/* Icon with gradient background */}
                  <motion.div
                    className={`inline-flex items-center justify-center w-14 h-14 rounded-xl bg-gradient-to-br ${feature.gradient} mb-6`}
                    whileHover={{ rotate: [0, -10, 10, -10, 0], scale: 1.1 }}
                    transition={{ duration: 0.5 }}
                  >
                    <Icon className="w-7 h-7 text-white" />
                  </motion.div>

                  <h3 className="text-2xl font-bold text-white mb-3 group-hover:text-transparent group-hover:bg-clip-text group-hover:bg-gradient-to-r group-hover:from-purple-400 group-hover:to-blue-400 transition-all duration-300">
                    {feature.title}
                  </h3>
                  <p className="text-gray-400 leading-relaxed group-hover:text-gray-300 transition-colors duration-300">
                    {feature.description}
                  </p>

                  {/* Animated corner accent */}
                  <motion.div
                    className="absolute top-0 right-0 w-32 h-32 opacity-0 group-hover:opacity-100 transition-opacity duration-500"
                    style={{
                      background: `radial-gradient(circle at top right, ${feature.gradient.split(' ')[1].replace('to-', '')}20, transparent)`,
                    }}
                  />
                </div>
              </motion.div>
            )
          })}
        </motion.div>
      </div>
    </section>
  )
}
