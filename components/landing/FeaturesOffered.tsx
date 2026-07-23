'use client'

import { motion } from 'framer-motion'
import { GitBranch, Shield, Code2, Database, Network, FileCode, Server } from 'lucide-react'
import { FadeInSection } from './animations/FadeInSection'

const features = [
  {
    icon: GitBranch,
    title: 'Agentic PR Review',
    description: 'Runs a full project-wide AI review and identifies issues, risks, and improvement points across the entire codebase, similar to how a senior engineer evaluates your project.',
  },
  {
    icon: Shield,
    title: 'False Positive Agent',
    description: 'Re-checks findings, flags non-exploitable ones, and explains why they\'re likely false positives, reducing noise before developers lose time.',
  },
  {
    icon: Code2,
    title: 'Agentic Repo Analysis',
    description: 'Maps your entire project and generates AI-powered insights on architecture, documentation, endpoints, dependencies, and data flow for rapid understanding.',
  },
  {
    icon: GitBranch,
    title: 'Agentic Code Review',
    description: 'Performs an AI-driven review of your entire codebase, identifying issues, risks, and improvement points across the project with clear context.',
  },
  {
    icon: Network,
    title: 'Repo Mapping',
    description: 'Visualizes your whole repository, linking components, flows, and relationships so teams instantly understand structure without manual effort.',
  },
  {
    icon: Database,
    title: 'Database Brain',
    description: 'AI-powered database analysis that detects missing indexes, slow queries, schema drift, and suggests optimizations automatically.',
  },
  {
    icon: FileCode,
    title: 'AI Workspace',
    description: 'Natural language to code generation with real-time schema suggestions and interactive code review in your browser.',
  },
  {
    icon: Server,
    title: 'Monitoring & Metrics',
    description: 'Comprehensive monitoring with AI-powered anomaly detection, incident management, and performance insights.',
  },
]

export function FeaturesOffered() {
  return (
    <section className="py-32 px-4 sm:px-6 lg:px-8 bg-[#0A0E1A] relative">
      <div className="max-w-[1280px] mx-auto">
        <FadeInSection className="text-center mb-16">
          <motion.p
            className="text-sm font-medium text-[#3B82F6] mb-4 tracking-wide uppercase"
            initial={{ opacity: 0, y: 10 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.5 }}
          >
            our features
          </motion.p>
          <h2 className="text-4xl sm:text-5xl lg:text-6xl font-bold text-white mb-6 tracking-tight">
            What Backenly Offers
          </h2>
          <p className="text-xl text-gray-400 max-w-3xl mx-auto leading-relaxed">
            Unified backend analysis and AI powered code intelligence. All reviews, results and context in one place.
          </p>
        </FadeInSection>

        <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-6">
          {features.map((feature, index) => {
            const Icon = feature.icon
            return (
              <motion.div
                key={index}
                className="bg-[#0F1419] border border-white/5 rounded-2xl p-6 hover:border-white/10 transition-all duration-300 group"
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, margin: '-50px' }}
                transition={{ duration: 0.5, delay: index * 0.05 }}
                whileHover={{ y: -4 }}
              >
                <div className="w-12 h-12 bg-[#3B82F6]/10 rounded-xl flex items-center justify-center mb-4 group-hover:bg-[#3B82F6]/20 transition-colors">
                  <Icon className="w-6 h-6 text-[#3B82F6]" />
                </div>
                <h3 className="text-lg font-bold text-white mb-3">{feature.title}</h3>
                <p className="text-sm text-gray-400 leading-relaxed">{feature.description}</p>
              </motion.div>
            )
          })}
        </div>
      </div>
    </section>
  )
}

