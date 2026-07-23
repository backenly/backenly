'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { motion, AnimatePresence } from 'framer-motion'
import {
  CheckCircle2,
  XCircle,
  Loader2,
  Clock,
  ExternalLink,
  Shield,
  Rocket,
  Eye,
  Copy,
  Check,
  Server,
} from 'lucide-react'
import { getCurrentProjectId } from '@/lib/api/client'
import { Logo } from '@/components/Logo'
import { GlobalLoading } from '@/components/ui/GlobalLoading'

interface Deployment {
  id: string
  provider: string
  environment: string
  status: 'queued' | 'validating' | 'building' | 'deploying' | 'migrating' | 'verifying' | 'live' | 'failed' | 'rolled_back' | 'cancelled'
  url?: string
  createdAt: string
  completedAt?: string
}

export default function DeployPage() {
  const router = useRouter()
  const [projectId, setProjectId] = useState<string | null>(null)
  const [deployments, setDeployments] = useState<Deployment[]>([])
  const [loading, setLoading] = useState(true)
  const [deploying, setDeploying] = useState(false)
  const [showConfirm, setShowConfirm] = useState(false)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    const loadProjectId = async () => {
      const currentProjectId = await getCurrentProjectId()
      if (!currentProjectId) {
        // No project selected — send them to the project list, not to a page
        // that happens to render without one.
        router.push('/app')
        return
      }
      setProjectId(currentProjectId)
    }
    loadProjectId()
  }, [router])

  useEffect(() => {
    if (!projectId) return

    const fetchDeployments = async () => {
      try {
        const response = await fetch(`/api/deployments?projectId=${projectId}&limit=10`)
        if (response.ok) {
          const data = await response.json()
          setDeployments(data.deployments || [])
        }
      } catch (error) {
        console.error('Failed to fetch deployments:', error)
      } finally {
        setLoading(false)
      }
    }

    fetchDeployments()
    const interval = setInterval(fetchDeployments, 5000)
    return () => clearInterval(interval)
  }, [projectId])

  const handleDeploy = async () => {
    if (!projectId || deploying) return

    setDeploying(true)
    setShowConfirm(false)

    try {
      const response = await fetch('/api/deployments', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-project-id': projectId,
        },
        body: JSON.stringify({
          provider: 'serverless',
          environment: 'hosted',
          config: {},
        }),
      })

      if (!response.ok) {
        const errorData = await response.json()
        console.error('Deployment failed:', errorData)
        throw new Error(errorData.error || 'Deployment failed')
      }

      // Refresh deployment list
      const refreshResponse = await fetch(`/api/deployments?projectId=${projectId}&limit=10`)
      if (refreshResponse.ok) {
        const data = await refreshResponse.json()
        setDeployments(data.deployments || [])
      }
    } catch (error) {
      console.error('Deployment error:', error)
      alert(`Deployment failed: ${error instanceof Error ? error.message : 'Unknown error'}`)
    } finally {
      setDeploying(false)
    }
  }

  const handleCopyURL = () => {
    if (liveDeployment?.url) {
      navigator.clipboard.writeText(liveDeployment.url)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }

  const liveDeployment = deployments.find(d => d.status === 'live')
  const isLive = !!liveDeployment

  const getStatusBadge = (status: Deployment['status']) => {
    switch (status) {
      case 'live':
        return (
          <div className="status-chip status-chip-success">
            <CheckCircle2 className="w-3.5 h-3.5" />
            <span>Live</span>
          </div>
        )
      case 'failed':
        return (
          <div className="status-chip status-chip-danger">
            <XCircle className="w-3.5 h-3.5" />
            <span>Failed</span>
          </div>
        )
      case 'cancelled':
      case 'rolled_back':
        return (
          <div className="status-chip">
            <XCircle className="w-3.5 h-3.5" />
            <span>Cancelled</span>
          </div>
        )
      default:
        return (
          <div className="status-chip status-chip-warning">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            <span>Deploying</span>
          </div>
        )
    }
  }

  if (loading || !projectId) {
    return <GlobalLoading message="Loading deployment..." />
  }

  return (
    <div className="min-h-screen bg-gradient-to-br [#0A0E1A] p-8">
      <div className="max-w-4xl mx-auto">
        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-12"
        >
          <div className="flex items-start justify-between mb-6">
            <div className="flex items-start space-x-4">
              <div className="w-14 h-14 rounded-lg bg-purple-500/10 border border-purple-500/20 flex items-center justify-center">
                <Rocket className="w-7 h-7 text-purple-400" />
              </div>
              <div>
                <h1 className="text-4xl font-semibold text-white tracking-tight mb-3">
                  Go Live
                </h1>
                <p className="text-sm text-gray-400">
                  Make your backend reachable on the internet
                </p>
              </div>
            </div>
            
            {/* Badge */}
            <div className="px-4 py-2 bg-[#111827] backdrop-blur-sm border border-white/[0.05] rounded-lg">
              <div className="flex items-center space-x-2">
                <Server className="w-3.5 h-3.5 text-purple-400/70" />
                <span className="text-xs font-semibold text-white">Managed Infrastructure</span>
              </div>
            </div>
          </div>
        </motion.div>

        {/* Hero Status Card + Deploy Action */}
        {!isLive ? (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 }}
            className="space-y-8"
          >
            {/* Status Hero Card */}
            <div className="bg-[#111827] backdrop-blur-sm border border-white/[0.05] rounded-lg p-12 text-center shadow-[0_8px_32px_rgba(0,0,0,0.6)]">
              <div className="max-w-md mx-auto">
                {/* Icon with soft glow */}
                <div className="w-20 h-20 rounded-lg bg-purple-500/10 border border-purple-500/20 flex items-center justify-center mx-auto mb-6 shadow-[0_0_40px_rgba(139,92,246,0.15)]">
                  <Shield className="w-10 h-10 text-purple-400/80" />
                </div>
                
                <h2 className="text-2xl font-semibold text-white mb-4">
                  Your backend is not live yet
                </h2>
                
                <p className="text-sm text-gray-400 leading-relaxed">
                  It exists privately and safely.
                  <br />
                  Deploy when you're ready to expose it.
                </p>
              </div>
            </div>

            {/* Deploy Action Card */}
            {!deploying ? (
              <div className="bg-[#111827] backdrop-blur-sm border border-white/[0.05] rounded-lg p-10 shadow-[0_8px_32px_rgba(0,0,0,0.6)]">
                <div className="max-w-2xl mx-auto">
                  <h3 className="text-xl font-semibold text-white mb-4 text-center">
                    Deploy to Production
                  </h3>
                  
                  <p className="text-sm text-gray-400 leading-relaxed text-center mb-8">
                    Backenly will host, scale, secure, and monitor your backend automatically.
                    <br />
                    No configuration required.
                  </p>

                  {/* Action Button */}
                  <div className="flex justify-center mb-8">
                    <button
                      onClick={() => setShowConfirm(true)}
                      className="px-8 py-4 bg-purple-600 hover:bg-purple-700 text-white rounded-xl text-base font-semibold transition-all duration-200 shadow-[0_4px_16px_rgba(139,92,246,0.4)] hover:shadow-[0_6px_24px_rgba(139,92,246,0.5)] hover:scale-105 flex items-center space-x-2"
                    >
                      <Rocket className="w-5 h-5" />
                      <span>Make it live</span>
                    </button>
                  </div>

                  {/* Reassurance Strip */}
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4 pt-8 border-t border-white/[0.06]">
                    <div className="flex items-center space-x-2 text-xs text-gray-400/70">
                      <Check className="w-4 h-4 text-purple-400" />
                      <span>Automatic scaling</span>
                    </div>
                    <div className="flex items-center space-x-2 text-xs text-gray-400/70">
                      <Check className="w-4 h-4 text-purple-400" />
                      <span>Security handled</span>
                    </div>
                    <div className="flex items-center space-x-2 text-xs text-gray-400/70">
                      <Check className="w-4 h-4 text-purple-400" />
                      <span>Rollbacks protected</span>
                    </div>
                    <div className="flex items-center space-x-2 text-xs text-gray-400/70">
                      <Check className="w-4 h-4 text-purple-400" />
                      <span>Zero downtime</span>
                    </div>
                  </div>
                </div>

                {/* Confirmation Modal */}
                <AnimatePresence>
                  {showConfirm && (
                    <motion.div
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-50 p-8"
                      onClick={() => setShowConfirm(false)}
                    >
                      <motion.div
                        initial={{ scale: 0.95, opacity: 0 }}
                        animate={{ scale: 1, opacity: 1 }}
                        exit={{ scale: 0.95, opacity: 0 }}
                        onClick={(e) => e.stopPropagation()}
                        className="bg-[#111827] border border-white/[0.05] rounded-lg p-8 max-w-md w-full shadow-[0_8px_32px_rgba(0,0,0,0.8)]"
                      >
                        <div className="flex items-start space-x-4 mb-6">
                          <div className="w-12 h-12 rounded-xl bg-purple-500/10 border border-purple-500/20 flex items-center justify-center">
                            <Shield className="w-6 h-6 text-purple-400" />
                          </div>
                          <div>
                            <h3 className="text-lg font-semibold text-white mb-2">
                              Confirm Deployment
                            </h3>
                            <p className="text-sm text-gray-400 mb-4">
                              This will make your backend publicly accessible.
                            </p>
                          </div>
                        </div>

                        <div className="space-y-2 mb-6 p-4 bg-[#0a0a0f]/60 rounded-lg border border-white/[0.06]">
                          <div className="flex items-center space-x-2 text-xs text-gray-400">
                            <span>Database migrations will be applied</span>
                          </div>
                          <div className="flex items-center space-x-2 text-xs text-gray-400">
                            <span>APIs will be generated and deployed</span>
                          </div>
                          <div className="flex items-center space-x-2 text-xs text-gray-400">
                            <span>Auth system will be configured</span>
                          </div>
                        </div>

                        <div className="flex items-center space-x-3">
                          <button
                            onClick={handleDeploy}
                            className="flex-1 px-4 py-3 bg-purple-600 hover:bg-purple-700 text-white rounded-xl text-sm font-semibold transition-all"
                          >
                            Confirm
                          </button>
                          <button
                            onClick={() => setShowConfirm(false)}
                            className="flex-1 px-4 py-3 bg-white/5 hover:bg-white/10 border border-white/[0.05] text-white rounded-xl text-sm font-semibold transition-all"
                          >
                            Cancel
                          </button>
                        </div>
                      </motion.div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            ) : (
              // Deployment Progress State
              <div className="bg-[#111827] backdrop-blur-sm border border-purple-500/20 rounded-lg p-10 shadow-[0_8px_32px_rgba(139,92,246,0.3)]">
                <div className="max-w-md mx-auto">
                  <div className="flex justify-center mb-8">
                    <Loader2 className="w-12 h-12 text-purple-400 animate-spin" />
                  </div>
                  
                  <h3 className="text-xl font-semibold text-white mb-8 text-center">
                    Deploying...
                  </h3>

                  {/* Animated Timeline */}
                  <div className="space-y-4">
                    {[
                      { label: 'Preparing environment', delay: 0 },
                      { label: 'Provisioning infrastructure', delay: 0.1 },
                      { label: 'Applying configuration', delay: 0.2 },
                      { label: 'Activating endpoints', delay: 0.3 },
                    ].map((step, index) => (
                      <motion.div
                        key={index}
                        initial={{ opacity: 0, x: -20 }}
                        animate={{ opacity: 1, x: 0 }}
                        transition={{ delay: step.delay }}
                        className="flex items-center space-x-3 text-sm text-gray-400"
                      >
                        <div className="w-2 h-2 rounded-full bg-purple-400 animate-pulse" />
                        <span>{step.label}</span>
                      </motion.div>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </motion.div>
        ) : (
          // Post Deploy - Live State
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 }}
          >
            {/* Live Hero Card */}
            <div className="bg-[#111827] backdrop-blur-sm border border-purple-500/20 rounded-lg p-10 shadow-[0_8px_32px_rgba(139,92,246,0.3)]">
              <div className="max-w-2xl mx-auto">
                {/* Success Icon */}
                <div className="flex justify-center mb-6">
                  <div className="w-16 h-16 rounded-lg bg-purple-500/10 border border-purple-500/20 flex items-center justify-center shadow-[0_0_40px_rgba(139,92,246,0.2)]">
                    <CheckCircle2 className="w-8 h-8 text-purple-400" />
                  </div>
                </div>

                <h2 className="text-2xl font-semibold text-white mb-3 text-center">
                  Your backend is live
                </h2>
                
                <p className="text-sm text-gray-400 text-center mb-8">
                  Reachable on the internet and ready to handle requests
                </p>

                {/* Endpoint URL */}
                {liveDeployment?.url && (
                  <div className="bg-[#0a0a0f]/60 border border-white/[0.06] rounded-xl p-5 mb-6">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-xs text-gray-400/70 uppercase tracking-wide font-semibold">Endpoint URL</span>
                      <div className="flex items-center space-x-2 text-xs text-purple-400">
                        <div className="w-2 h-2 rounded-full bg-purple-400 animate-pulse" />
                        <span>Active</span>
                      </div>
                    </div>
                    <div className="flex items-center justify-between">
                      <code className="text-sm text-white font-mono">
                        {liveDeployment.url}
                      </code>
                      <button
                        onClick={handleCopyURL}
                        className="ml-4 p-2 hover:bg-white/5 rounded-lg transition-colors"
                        title="Copy URL"
                      >
                        {copied ? (
                          <Check className="w-4 h-4 text-purple-400" />
                        ) : (
                          <Copy className="w-4 h-4 text-gray-400" />
                        )}
                      </button>
                    </div>
                  </div>
                )}

                {/* Action Buttons */}
                <div className="flex items-center justify-center space-x-3">
                  {liveDeployment?.url && (
                    <a
                      href={liveDeployment.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="px-5 py-3 bg-purple-600 hover:bg-purple-700 text-white rounded-xl text-sm font-semibold transition-all flex items-center space-x-2"
                    >
                      <ExternalLink className="w-4 h-4" />
                      <span>Open endpoint</span>
                    </a>
                  )}
                  <button
                    onClick={() => router.push(`/app/projects/${projectId}/apis`)}
                    className="px-5 py-3 bg-white/5 hover:bg-white/10 border border-white/[0.05] text-white rounded-xl text-sm font-semibold transition-all"
                  >
                    View APIs
                  </button>
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </div>
    </div>
  )
}
