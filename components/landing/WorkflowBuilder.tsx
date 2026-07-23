'use client'

import { motion, useInView } from 'framer-motion'
import { useRef } from 'react'
import { MessageSquare, Eye, Rocket, ArrowRight } from 'lucide-react'

const steps = [
  {
    icon: MessageSquare,
    number: '01',
    title: 'Describe',
    description: 'Tell AI what you need in plain English',
    detail: '"Build a todo app with users and due dates"',
    color: 'from-purple-500 to-violet-500',
  },
  {
    icon: Eye,
    number: '02',
    title: 'Review',
    description: 'See your database schema and API endpoints',
    detail: 'Edit tables, add relationships, customize routes',
    color: 'from-blue-500 to-cyan-500',
  },
  {
    icon: Rocket,
    number: '03',
    title: 'Publish',
    description: 'One click to deploy your backend',
    detail: 'Live URL, PostgreSQL, auth — all ready',
    color: 'from-cyan-500 to-teal-500',
  },
]

export function WorkflowBuilder() {
  const ref = useRef(null)
  const isInView = useInView(ref, { once: true, margin: '-100px' })

  return (
    <section id="use-cases" className="py-32 px-4 sm:px-6 lg:px-8 bg-[#0A0E1A] relative overflow-hidden">
      {/* Background effects */}
      <div className="absolute inset-0">
        <motion.div
          className="absolute top-1/4 left-1/4 w-96 h-96 bg-purple-500/20 rounded-full blur-3xl"
          animate={{
            scale: [1, 1.2, 1],
            opacity: [0.3, 0.5, 0.3],
          }}
          transition={{
            duration: 8,
            repeat: Infinity,
            ease: 'easeInOut',
          }}
        />
        <motion.div
          className="absolute bottom-1/4 right-1/4 w-96 h-96 bg-blue-500/20 rounded-full blur-3xl"
          animate={{
            scale: [1.2, 1, 1.2],
            opacity: [0.3, 0.5, 0.3],
          }}
          transition={{
            duration: 8,
            repeat: Infinity,
            ease: 'easeInOut',
            delay: 1,
          }}
        />
      </div>

      <div className="max-w-7xl mx-auto relative z-10" ref={ref}>
        {/* Header */}
        <motion.div
          className="text-center mb-20"
          initial={{ opacity: 0, y: 30 }}
          animate={isInView ? { opacity: 1, y: 0 } : {}}
          transition={{ duration: 0.8 }}
        >
          <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full border border-white/20 bg-white/5 mb-6">
            <span className="text-sm text-gray-400 uppercase tracking-wider font-medium">How it Works</span>
          </div>
          <h2 className="text-5xl sm:text-6xl lg:text-7xl font-bold text-white mb-6 tracking-tight">
            Backend in{' '}
            <span className="bg-gradient-to-r from-purple-400 via-pink-400 to-blue-400 bg-clip-text text-transparent">
              3 Simple Steps
            </span>
          </h2>
          <p className="text-xl text-gray-400 max-w-2xl mx-auto">
            From idea to production in under 5 minutes
          </p>
        </motion.div>

        {/* Steps Grid */}
        <div className="grid md:grid-cols-3 gap-8 mb-16">
          {steps.map((step, index) => {
            const Icon = step.icon
            
            return (
              <motion.div
                key={index}
                initial={{ opacity: 0, y: 50 }}
                animate={isInView ? { opacity: 1, y: 0 } : {}}
                transition={{ duration: 0.6, delay: index * 0.2 }}
                className="group relative"
              >
                {/* Card */}
                <div className="relative bg-gradient-to-br from-white/5 to-white/[0.02] border border-white/10 rounded-3xl p-8 hover:border-white/20 hover:from-white/10 hover:to-white/5 transition-all duration-500 h-full">
                  {/* Gradient overlay on hover */}
                  <div className={`absolute inset-0 rounded-3xl bg-gradient-to-br ${step.color} opacity-0 group-hover:opacity-10 transition-opacity duration-500`} />
                  
                  {/* Icon */}
                  <motion.div
                    className={`inline-flex items-center justify-center w-20 h-20 rounded-2xl bg-gradient-to-br ${step.color} mb-6 relative overflow-hidden`}
                    whileHover={{ scale: 1.1, rotate: 5 }}
                    transition={{ duration: 0.3 }}
                  >
                    <Icon className="w-10 h-10 text-white relative z-10" />
                    <motion.div
                      className="absolute inset-0 bg-white"
                      initial={{ x: '-100%' }}
                      whileHover={{ x: '100%' }}
                      transition={{ duration: 0.6 }}
                      style={{ opacity: 0.2 }}
                    />
                  </motion.div>

                  {/* Number Badge */}
                  <div className="absolute top-8 right-8">
                    <div className="text-7xl font-bold text-white/5 group-hover:text-white/10 transition-colors duration-500">
                      {step.number}
                    </div>
                  </div>

                  {/* Content */}
                  <div className="relative z-10">
                    <h3 className="text-2xl font-bold text-white mb-3 group-hover:text-purple-300 transition-colors duration-300">
                      {step.title}
                    </h3>
                    <p className="text-gray-400 text-base mb-4 leading-relaxed">
                      {step.description}
                    </p>
                    <div className="bg-white/5 border border-white/10 rounded-xl px-4 py-3 font-mono text-sm text-purple-300">
                      {step.detail}
                    </div>
                  </div>

                  {/* Connecting Line (only for first two cards) */}
                  {index < 2 && (
                    <div className="hidden md:block absolute top-1/2 -right-4 w-8 h-0.5 bg-gradient-to-r from-purple-500/50 to-transparent">
                      <motion.div
                        className="absolute right-0 top-1/2 -translate-y-1/2 w-2 h-2 bg-purple-500 rounded-full"
                        animate={{
                          scale: [1, 1.5, 1],
                          opacity: [0.5, 1, 0.5],
                        }}
                        transition={{
                          duration: 2,
                          repeat: Infinity,
                          delay: index * 0.3,
                        }}
                      />
                    </div>
                  )}
                </div>
              </motion.div>
            )
          })}
        </div>

        {/* CTA */}
        <motion.div
          className="text-center"
          initial={{ opacity: 0, y: 30 }}
          animate={isInView ? { opacity: 1, y: 0 } : {}}
          transition={{ duration: 0.8, delay: 0.8 }}
        >
          <motion.a
            href="/auth/signup"
            className="inline-flex items-center gap-3 px-10 py-5 text-lg font-semibold text-black bg-white hover:bg-gray-100 rounded-2xl relative overflow-hidden group transition-all"
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
          >
            {/* hover overlay */}
            <div className="absolute inset-0 bg-gray-100 opacity-0 group-hover:opacity-100 transition-opacity duration-300" />
            <span className="relative z-10">Try It Now — Free</span>
            <ArrowRight className="w-5 h-5 relative z-10 group-hover:translate-x-1 transition-transform" />
          </motion.a>
        </motion.div>
      </div>
    </section>
  )
}
