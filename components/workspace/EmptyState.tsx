'use client'

import { motion } from 'framer-motion'
import { Logo } from '@/components/Logo'

interface EmptyStateProps {
  onExampleClick: (prompt: string) => void
}

export function EmptyState({ onExampleClick }: EmptyStateProps) {
  const examples = [
    { text: 'Blog with posts, comments, and auth', icon: '✍️' },
    { text: 'Marketplace with products and orders', icon: '🏪' },
    { text: 'SaaS with subscriptions and billing', icon: '💳' },
  ]

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5 }}
      className="flex flex-col items-center justify-center min-h-[60vh] px-6"
    >
      {/* Backenly Logo */}
      <motion.div
        initial={{ scale: 0.8, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ delay: 0.2, duration: 0.5 }}
        className="relative mb-8"
      >
        <div className="absolute inset-0 bg-purple-500/20 blur-xl rounded-full scale-150" />
        <div className="relative w-16 h-16 rounded-2xl bg-gradient-to-br from-purple-500/10 to-blue-500/10 border border-purple-500/20 flex items-center justify-center">
          <Logo />
        </div>
      </motion.div>

      {/* Main heading */}
      <motion.h2
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.3 }}
        className="text-2xl font-semibold text-white mb-3 text-center"
      >
        What are you building today?
      </motion.h2>

      {/* Subtext */}
      <motion.p
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.4 }}
        className="text-[#9AA3B2] text-sm mb-10 text-center max-w-sm"
      >
        Describe your idea and I'll generate the database, APIs, and infrastructure.
      </motion.p>

      {/* Example cards */}
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.5 }}
        className="space-y-2 w-full max-w-md"
      >
        {examples.map((example, idx) => (
          <motion.button
            key={idx}
            initial={{ opacity: 0, x: -10 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: 0.5 + idx * 0.08 }}
            onClick={() => onExampleClick(example.text)}
            className="w-full group flex items-center gap-4 px-5 py-4 bg-[#151B2E]/50 hover:bg-[#1A2035] border border-white/[0.06] hover:border-purple-500/30 rounded-xl transition-all duration-200"
          >
            <span className="text-xl">{example.icon}</span>
            <span className="text-sm text-[#E6E8EF] group-hover:text-white transition-colors">
              {example.text}
            </span>
          </motion.button>
        ))}
      </motion.div>
    </motion.div>
  )
}
