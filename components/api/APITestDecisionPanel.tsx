'use client'

import { useState } from 'react'
import { Rocket, AlertCircle, Play, Loader2 } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'

/**
 * PHASE 3: UX State Improvements - Decision UI
 * 
 * Replaces blocking "Backend is not deployed" error with intelligent choice UI.
 * Users can choose to run in sandbox or deploy - no blocking states.
 */

interface APITestDecisionPanelProps {
  projectId: string
  onStartSandbox: () => Promise<void>
  onDeploy: () => void
  onDismiss: () => void
}

export function APITestDecisionPanel({
  projectId,
  onStartSandbox,
  onDeploy,
  onDismiss,
}: APITestDecisionPanelProps) {
  const [loading, setLoading] = useState(false)
  const [loadingAction, setLoadingAction] = useState<'sandbox' | 'deploy' | null>(null)

  const handleStartSandbox = async () => {
    setLoading(true)
    setLoadingAction('sandbox')
    try {
      await onStartSandbox()
    } catch (error) {
      console.error('Failed to start sandbox:', error)
    } finally {
      setLoading(false)
      setLoadingAction(null)
    }
  }

  const handleDeploy = () => {
    setLoading(true)
    setLoadingAction('deploy')
    onDeploy()
  }

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.95 }}
        transition={{ duration: 0.2 }}
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
        onClick={onDismiss}
      >
        <motion.div
          initial={{ y: 20 }}
          animate={{ y: 0 }}
          exit={{ y: 20 }}
          className="bg-[#0B0D10] border border-[#23262B] rounded-xl shadow-2xl max-w-md w-full mx-4"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div className="p-6 border-b border-[#23262B]">
            <div className="flex items-start gap-3">
              <div className="p-2 bg-blue-500/10 rounded-lg flex-shrink-0">
                <AlertCircle className="w-5 h-5 text-blue-400" />
              </div>
              <div className="flex-1">
                <h3 className="text-lg font-semibold text-white">
                  This API is not live yet
                </h3>
                <p className="text-sm text-text-muted mt-1">
                  Choose how you want to test your API
                </p>
              </div>
            </div>
          </div>

          {/* Options */}
          <div className="p-6 space-y-3">
            {/* Option 1: Run in Sandbox */}
            <button
              onClick={handleStartSandbox}
              disabled={loading}
              className="w-full group relative"
            >
              <div className="absolute inset-0 bg-gradient-to-r from-yellow-500/20 to-amber-500/20 rounded-lg blur-sm opacity-0 group-hover:opacity-100 transition-opacity" />
              <div className="relative flex items-start gap-4 p-4 bg-[#181B20] border border-[#23262B] rounded-lg hover:border-yellow-500/50 transition-all">
                <div className="p-2 bg-yellow-500/10 rounded-lg flex-shrink-0">
                  {loadingAction === 'sandbox' ? (
                    <Loader2 className="w-5 h-5 text-yellow-400 animate-spin" />
                  ) : (
                    <Play className="w-5 h-5 text-yellow-400" />
                  )}
                </div>
                <div className="flex-1 text-left">
                  <div className="flex items-center gap-2">
                    <h4 className="text-sm font-semibold text-white">Run in Sandbox</h4>
                    <span className="px-2 py-0.5 text-xs font-medium bg-yellow-500/10 text-yellow-400 border border-yellow-500/30 rounded">
                      Instant
                    </span>
                  </div>
                  <p className="text-xs text-text-muted mt-1 leading-relaxed">
                    Test immediately with mock data. Perfect for development and quick iteration. No deployment needed.
                  </p>
                  <div className="flex items-center gap-4 mt-3 text-xs text-text-muted">
                    <span className="flex items-center gap-1">
                      <Play className="w-3 h-3" />
                      &lt;2s startup
                    </span>
                    <span>•</span>
                    <span>In-memory</span>
                    <span>•</span>
                    <span>Auto-destroy</span>
                  </div>
                </div>
              </div>
            </button>

            {/* Option 2: Deploy Backend */}
            <button
              onClick={handleDeploy}
              disabled={loading}
              className="w-full group relative"
            >
              <div className="absolute inset-0 bg-gradient-to-r from-purple-500/20 to-blue-500/20 rounded-lg blur-sm opacity-0 group-hover:opacity-100 transition-opacity" />
              <div className="relative flex items-start gap-4 p-4 bg-[#181B20] border border-[#23262B] rounded-lg hover:border-purple-500/50 transition-all">
                <div className="p-2 bg-purple-500/10 rounded-lg flex-shrink-0">
                  {loadingAction === 'deploy' ? (
                    <Loader2 className="w-5 h-5 text-purple-400 animate-spin" />
                  ) : (
                    <Rocket className="w-5 h-5 text-purple-400" />
                  )}
                </div>
                <div className="flex-1 text-left">
                  <div className="flex items-center gap-2">
                    <h4 className="text-sm font-semibold text-white">Deploy Backend</h4>
                    <span className="px-2 py-0.5 text-xs font-medium bg-purple-500/10 text-purple-400 border border-purple-500/30 rounded">
                      Production
                    </span>
                  </div>
                  <p className="text-xs text-text-muted mt-1 leading-relaxed">
                    Deploy to cloud for production testing with real data, persistent storage, and live endpoints.
                  </p>
                  <div className="flex items-center gap-4 mt-3 text-xs text-text-muted">
                    <span className="flex items-center gap-1">
                      <Rocket className="w-3 h-3" />
                      2-3 min deploy
                    </span>
                    <span>•</span>
                    <span>Persistent</span>
                    <span>•</span>
                    <span>Public URL</span>
                  </div>
                </div>
              </div>
            </button>
          </div>

          {/* Footer */}
          <div className="p-4 bg-[#181B20]/50 border-t border-[#23262B] rounded-b-xl">
            <p className="text-xs text-center text-text-muted">
              💡 <strong>Tip:</strong> Use sandbox for quick tests, deploy when you&apos;re ready to share
            </p>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  )
}
