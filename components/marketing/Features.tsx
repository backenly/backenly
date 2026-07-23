'use client'

import { Code, Database, Rocket } from 'lucide-react'
import { motion } from 'framer-motion'

const features = [
  {
    icon: Code,
    title: 'AI Workspace',
    description: 'VS Code in the browser, with an intelligent backend engineer inside.',
  },
  {
    icon: Database,
    title: 'Database + Auth + Storage',
    description: 'Everything a backend needs, fully managed.',
  },
  {
    icon: Rocket,
    title: 'Deploy Anywhere',
    description: 'Deploy to Vercel, Render, AWS, or export as a ZIP.',
  },
]

export function Features() {
  return (
    <section className="py-20 px-6">
      <div className="max-w-7xl mx-auto">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5 }}
          className="text-center mb-16"
        >
          <h2 className="text-4xl font-bold text-white mb-4">Everything you need</h2>
          <p className="text-xl text-text-muted">One platform, infinite possibilities</p>
        </motion.div>
        
        <div className="grid md:grid-cols-3 gap-8">
          {features.map((feature, index) => (
            <motion.div
              key={feature.title}
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.5, delay: index * 0.1 }}
              whileHover={{ 
                y: -2,
                transition: { duration: 0.2 }
              }}
              className="glass rounded-xl p-8 group cursor-pointer"
            >
              <motion.div 
                className="w-12 h-12 bg-primary-500/20 rounded-lg flex items-center justify-center mb-6 group-hover:bg-primary-500/30 transition-all duration-200"
                whileHover={{ scale: 1.1 }}
              >
                <feature.icon className="w-6 h-6 text-primary-500" />
              </motion.div>
              <h3 className="text-2xl font-semibold text-white mb-3 group-hover:text-primary-400 transition-colors duration-200">{feature.title}</h3>
              <p className="text-text-muted leading-relaxed">{feature.description}</p>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  )
}

