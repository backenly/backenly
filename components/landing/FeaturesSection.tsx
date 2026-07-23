'use client'

import { Database, Rocket, Code2, Server, Shield } from 'lucide-react'
import { motion } from 'framer-motion'
import { FadeInSection } from './animations/FadeInSection'

const features = [
  {
    icon: Code2,
    title: 'AI Workspace',
    description: 'Prompt-driven backend design with an intelligent engineer inside your browser.',
    bullets: [
      'Natural language to code generation',
      'Real-time schema suggestions',
      'Interactive code review',
    ],
  },
  {
    icon: Database,
    title: 'Data + Auth + Storage',
    description: 'Managed data models, auth, and file storage wired together automatically.',
    bullets: [
      'Row-level security policies',
      'Connection pooling',
      'Automatic migrations',
    ],
  },
  {
    icon: Rocket,
    title: 'Deploy Anywhere',
    description: 'Export your backend and deploy to Vercel, Render, AWS, or your own servers.',
    bullets: [
      'One-click deployment',
      'Exportable codebase',
      'Multi-cloud support',
    ],
  },
  {
    icon: Code2,
    title: 'Type-Safe APIs',
    description: 'Auto-generated TypeScript types and OpenAPI specs for seamless frontend integration.',
    bullets: [
      'End-to-end type safety',
      'OpenAPI documentation',
      'GraphQL support',
    ],
  },
  {
    icon: Shield,
    title: 'Built-in Security',
    description: 'Row-level security, API rate limiting, and authentication out of the box.',
    bullets: [
      'Row-level permissions',
      'API rate limiting',
      'OAuth & JWT support',
    ],
  },
  {
    icon: Server,
    title: 'Edge Functions',
    description: 'Write serverless functions that run close to your users for minimal latency.',
    bullets: [
      'Global edge network',
      'Sub-100ms response times',
      'Auto-scaling compute',
    ],
  },
]

export function FeaturesSection() {
  return (
    <section id="features" className="py-40 px-4 sm:px-6 lg:px-8 bg-[#0F1419] relative">
      <div className="relative max-w-[1280px] mx-auto">
        {/* Section Header - Professional */}
        <FadeInSection className="text-center mb-32">
          <h2 className="text-6xl sm:text-7xl font-bold text-white mb-6 tracking-[-0.02em] leading-[1.1]">
            Everything you need
          </h2>
          <p className="text-xl text-gray-400 max-w-2xl mx-auto">
            One platform, infinite backends. Build faster with AI-powered tools and infrastructure.
          </p>
        </FadeInSection>

        {/* Feature Grid - Clean, Professional */}
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
          {features.map((feature, index) => {
            const Icon = feature.icon
            return (
              <motion.div
                key={index}
                className="group relative bg-[#0A0E1A] border border-white/5 rounded-2xl p-8 hover:border-white/10 transition-all duration-300"
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, margin: '-50px' }}
                transition={{ duration: 0.5, delay: index * 0.05, ease: [0.16, 1, 0.3, 1] }}
                whileHover={{ y: -4 }}
              >
                <div className="w-12 h-12 bg-[#3B82F6]/10 rounded-xl flex items-center justify-center mb-6 group-hover:bg-[#3B82F6]/20 transition-colors">
                  <Icon className="w-6 h-6 text-[#3B82F6]" />
                </div>
                <h3 className="text-2xl font-bold text-white mb-3">{feature.title}</h3>
                <p className="text-gray-400 leading-relaxed mb-6 text-base">{feature.description}</p>
                <ul className="space-y-2.5">
                  {feature.bullets.map((bullet, bulletIndex) => (
                    <li key={bulletIndex} className="flex items-start gap-2.5 text-sm text-gray-500">
                      <span className="text-[#3B82F6] mt-1.5">•</span>
                      <span>{bullet}</span>
                    </li>
                  ))}
                </ul>
              </motion.div>
            )
          })}
        </div>
      </div>
    </section>
  )
}
