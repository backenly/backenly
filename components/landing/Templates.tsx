'use client'

import { motion } from 'framer-motion'
import { MessageSquare, Database, Image, FileText, Zap, Globe } from 'lucide-react'

const templates = [
  { icon: MessageSquare, title: 'Social Network', category: 'Social', gradient: 'from-[#8b5cf6] to-[#3b82f6]' },
  { icon: Database, title: 'E-commerce', category: 'Commerce', gradient: 'from-[#3b82f6] to-[#06b6d4]' },
  { icon: Image, title: 'Content Platform', category: 'Content', gradient: 'from-[#06b6d4] to-[#8b5cf6]' },
  { icon: FileText, title: 'Authentication', category: 'Auth', gradient: 'from-[#8b5cf6] to-[#3b82f6]' },
  { icon: Zap, title: 'Task Manager', category: 'Productivity', gradient: 'from-[#3b82f6] to-[#06b6d4]' },
  { icon: Globe, title: 'Booking System', category: 'Services', gradient: 'from-[#06b6d4] to-[#8b5cf6]' },
]

export function Templates() {
  return (
    <section className="py-32 px-4 sm:px-6 lg:px-8 bg-[#0A0E1A] relative overflow-hidden">
      {/* Background gradient */}
      <div className="absolute inset-0 bg-gradient-to-b from-transparent via-[#1a0f2e]/10 to-transparent pointer-events-none"></div>
      
      <div className="max-w-7xl mx-auto relative z-10">
        <motion.div
          className="text-center mb-16"
          initial={{ opacity: 0, y: 30 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6 }}
        >
          <h2 className="text-4xl sm:text-5xl lg:text-6xl font-bold text-white mb-6 tracking-tight">
            Common Use Cases
          </h2>
          <p className="text-xl text-gray-400 max-w-3xl mx-auto leading-relaxed">
            From e-commerce to social networks, build any backend with AI. Just describe what you need.
          </p>
        </motion.div>

        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
          {templates.map((template, index) => {
            const Icon = template.icon
            return (
              <motion.div
                key={index}
                className="bg-white/5 border border-white/10 rounded-xl p-6 hover:border-white/20 hover:bg-white/10 transition-all duration-300 cursor-pointer group"
                initial={{ opacity: 0, y: 30 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, margin: '-50px' }}
                transition={{ 
                  duration: 0.4, 
                  delay: index * 0.08,
                  ease: [0.16, 1, 0.3, 1],
                }}
                whileHover={{ 
                  y: -8,
                  scale: 1.05,
                  boxShadow: '0 20px 40px rgba(139, 92, 246, 0.2)',
                }}
              >
                <motion.div 
                  className={`w-12 h-12 bg-gradient-to-br ${template.gradient} rounded-lg flex items-center justify-center mb-4 shadow-lg`}
                  whileHover={{ 
                    scale: 1.15,
                    rotate: [0, -5, 5, -5, 0],
                  }}
                  transition={{ duration: 0.3 }}
                >
                  <Icon className="w-6 h-6 text-white" />
                </motion.div>
                <h3 className="text-white font-medium text-sm mb-1 group-hover:text-transparent group-hover:bg-clip-text group-hover:bg-gradient-to-r group-hover:from-[#8b5cf6] group-hover:to-[#3b82f6] transition-all duration-300">
                  {template.title}
                </h3>
                <p className="text-xs text-gray-400 group-hover:text-gray-300 transition-colors duration-300">
                  {template.category}
                </p>
              </motion.div>
            )
          })}
        </div>
      </div>
    </section>
  )
}
