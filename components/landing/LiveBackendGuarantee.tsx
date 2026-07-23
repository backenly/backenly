'use client'

import { motion } from 'framer-motion'
import { Shield, Database, Lock, Zap, Cpu, Globe } from 'lucide-react'

const guarantees = [
  {
    icon: Database,
    text: 'Isolated PostgreSQL',
    gradient: 'from-blue-500 to-cyan-500'
  },
  {
    icon: Shield,
    text: 'Secure API gateways',
    gradient: 'from-purple-500 to-pink-500'
  },
  {
    icon: Lock,
    text: 'Rate limiting',
    gradient: 'from-orange-500 to-red-500'
  },
  {
    icon: Zap,
    text: 'Real deployment URLs',
    gradient: 'from-yellow-500 to-orange-500'
  },
]

export function LiveBackendGuarantee() {
  return (
    <section className="py-32 px-4 sm:px-6 lg:px-8 bg-[#0A0E1A] relative overflow-hidden">
      {/* Background effects */}
      <div className="absolute inset-0">
        <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-purple-500/20 rounded-full blur-3xl animate-pulse" />
        <div className="absolute bottom-1/4 right-1/4 w-96 h-96 bg-blue-500/20 rounded-full blur-3xl animate-pulse" style={{ animationDelay: '1s' }} />
      </div>
      
      <div className="max-w-7xl mx-auto relative z-10">
        {/* Header */}
        <motion.div
          className="text-center mb-20"
          initial={{ opacity: 0, y: 30 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6 }}
        >
          <motion.div
            className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-purple-500/10 border border-purple-500/20 mb-6"
            initial={{ opacity: 0, scale: 0.8 }}
            whileInView={{ opacity: 1, scale: 1 }}
            viewport={{ once: true }}
          >
            <div className="w-2 h-2 bg-purple-500 rounded-full animate-pulse" />
            <span className="text-sm text-purple-400 font-medium">Production Backend</span>
          </motion.div>
          
          <h2 className="text-5xl sm:text-6xl lg:text-7xl font-bold text-white mb-6 tracking-tight leading-[1.1]">
            This is not a prototype.
            <br />
            <span className="bg-gradient-to-r from-purple-400 via-pink-400 to-blue-400 bg-clip-text text-transparent">
              This is your production backend.
            </span>
          </h2>
          <p className="text-xl text-gray-400 max-w-3xl mx-auto">
            Every Backenly project runs on:
          </p>
        </motion.div>

        {/* Feature Grid - 2x2 Layout */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-16 max-w-4xl mx-auto">
          {guarantees.map((item, index) => {
            const Icon = item.icon
            return (
              <motion.div
                key={index}
                className="group relative bg-gradient-to-br from-white/5 to-white/[0.02] border border-white/10 rounded-2xl p-8 hover:border-white/20 transition-all duration-300 overflow-hidden"
                initial={{ opacity: 0, y: 30 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, margin: '-50px' }}
                transition={{ duration: 0.4, delay: index * 0.1 }}
                whileHover={{ y: -5 }}
              >
                {/* Gradient overlay on hover */}
                <div className={`absolute inset-0 bg-gradient-to-br ${item.gradient} opacity-0 group-hover:opacity-10 transition-opacity duration-300`} />
                
                {/* Icon */}
                <motion.div
                  className={`inline-flex items-center justify-center w-16 h-16 rounded-xl bg-gradient-to-br ${item.gradient} mb-4 shadow-lg relative z-10`}
                  whileHover={{ scale: 1.1, rotate: 5 }}
                  transition={{ duration: 0.2 }}
                >
                  <Icon className="w-8 h-8 text-white" />
                </motion.div>
                
                {/* Text */}
                <h3 className="text-xl font-bold text-white relative z-10 group-hover:text-purple-300 transition-colors">
                  {item.text}
                </h3>
              </motion.div>
            )
          })}
        </div>

        {/* Bottom Statement - Full Width */}
        <motion.div
          className="relative bg-gradient-to-br from-white/5 to-white/[0.02] border border-white/10 rounded-3xl p-12 md:p-16 text-center overflow-hidden"
          initial={{ opacity: 0, y: 30 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6, delay: 0.4 }}
        >
          {/* Animated gradient background */}
          <motion.div
            className="absolute inset-0 opacity-30"
            animate={{
              background: [
                'radial-gradient(circle at 20% 50%, rgba(139, 92, 246, 0.4) 0%, transparent 50%)',
                'radial-gradient(circle at 80% 50%, rgba(59, 130, 246, 0.4) 0%, transparent 50%)',
                'radial-gradient(circle at 20% 50%, rgba(139, 92, 246, 0.4) 0%, transparent 50%)',
              ],
            }}
            transition={{ duration: 8, repeat: Infinity, ease: 'linear' }}
          />
          
          <div className="relative z-10">
            <motion.p 
              className="text-3xl md:text-4xl font-bold text-white mb-4"
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.6, delay: 0.5 }}
            >
              This is not "AI code".
            </motion.p>
            <motion.p 
              className="text-xl md:text-2xl text-gray-300"
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.6, delay: 0.6 }}
            >
              This is hosted, managed infrastructure.
            </motion.p>
          </div>
        </motion.div>
      </div>
    </section>
  )
}
