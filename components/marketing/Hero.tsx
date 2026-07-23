'use client'

import { Button } from '@/components/ui/Button'
import { motion } from 'framer-motion'

export function Hero() {
  return (
    <section className="pt-32 pb-20 px-6">
      <div className="max-w-7xl mx-auto">
        <div className="grid lg:grid-cols-2 gap-12 items-center">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
          >
            <h1 className="text-5xl lg:text-6xl font-bold text-white mb-6 leading-tight">
              The AI That Builds Your Backend.
            </h1>
            <p className="text-xl text-text-muted mb-8 leading-relaxed">
              APIs, auth, and databases — generated and deployed instantly.
            </p>
            <div className="flex flex-col sm:flex-row gap-4 mb-6">
              <a href="/auth/signup">
                <Button variant="primary" size="lg">
                  Start Building
                </Button>
              </a>
              <Button variant="outline" size="lg">
                View Demo
              </Button>
            </div>
            <p className="text-sm text-text-muted">
              Free tier available · No credit card required
            </p>
          </motion.div>
          
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.5, delay: 0.2 }}
            className="relative"
          >
            <div className="glass rounded-xl p-6 border border-dark-border">
              <div className="bg-dark-surface rounded-lg p-4 mb-4">
                <div className="flex items-center space-x-2 mb-3">
                  <div className="w-3 h-3 rounded-full bg-red-500"></div>
                  <div className="w-3 h-3 rounded-full bg-yellow-500"></div>
                  <div className="w-3 h-3 rounded-full bg-green-500"></div>
                </div>
                <div className="space-y-2">
                  <div className="h-4 bg-dark-elevated rounded w-3/4 animate-pulse"></div>
                  <div className="h-4 bg-dark-elevated rounded w-1/2 animate-pulse" style={{ animationDelay: '0.2s' }}></div>
                  <div className="h-4 bg-primary-500/20 rounded w-2/3 animate-pulse" style={{ animationDelay: '0.4s' }}></div>
                </div>
              </div>
              <div className="text-sm text-text-muted font-mono">
                <div className="mb-2">AI: Generating routes...</div>
                <div className="text-primary-500">✓ Database schema updated</div>
              </div>
            </div>
          </motion.div>
        </div>
      </div>
    </section>
  )
}

