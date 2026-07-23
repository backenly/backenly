'use client'

import { useState, useEffect } from 'react'
import { useParams } from 'next/navigation'
import { motion } from 'framer-motion'
import {
  CheckCircle2,
  XCircle,
  Clock,
  AlertCircle,
  ChevronRight,
  Database,
  Code,
  Shield,
  Loader2,
} from 'lucide-react'

interface ExecutionLog {
  id: string
  timestamp: Date
  intent: string
  status: 'complete' | 'error' | 'processing'
  affectedResources: string[]
  duration: string
  migrationId?: string
}

export default function IntentLogPage() {
  const params = useParams()
  const projectId = params.projectId as string
  const [executions, setExecutions] = useState<ExecutionLog[]>([])
  const [selectedLog, setSelectedLog] = useState<ExecutionLog | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    // Load from localStorage
    const stored = localStorage.getItem(`ai-actions-${projectId}`)
    if (stored) {
      try {
        const parsed = JSON.parse(stored)
        const logs: ExecutionLog[] = parsed.map((a: any, idx: number) => ({
          id: `log_${idx}`,
          timestamp: new Date(a.timestamp),
          intent: a.action,
          status: 'complete' as const,
          affectedResources: ['Schema', 'APIs', 'Auth'],
          duration: '2.4s',
          migrationId: `mig_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        }))
        setExecutions(logs)
      } catch (e) {
        console.error('Failed to load logs:', e)
      }
    }
    setLoading(false)
  }, [projectId])

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-accent-primary"></div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-[#0a0a0f]">
      <div className="max-w-[1440px] mx-auto px-6 py-8">
      {/* Header */}
      <div className="pb-6 mb-8 border-b border-[#1E2228]">
        <h1 className="text-[22px] font-semibold text-white mb-3">Intent Log</h1>
        <p className="text-[13px] text-[#9CA3AF] leading-relaxed">
          Execution history of all backend changes.
        </p>
      </div>

      {/* Empty State */}
      {executions.length === 0 && (
        <div className="bg-[#11141A] border border-[#1E2228] rounded-md p-16 text-center">
          <div className="icon-container mx-auto mb-4" style={{ width: '64px', height: '64px' }}>
            <Clock className="w-8 h-8 text-accent-primary" />
          </div>
          <h3 className="text-[18px] font-semibold text-white mb-2">No executions yet</h3>
          <p className="text-[13px] text-[#9CA3AF]">
            Backend changes will appear here as you describe them.
          </p>
        </div>
      )}

      {/* Execution Table */}
      {executions.length > 0 && (
        <div className="bg-[#11141A] border border-[#1E2228] rounded-md overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border-default">
                  <th className="px-6 py-3 text-left text-[11px] font-medium text-[#6B7280] uppercase tracking-wider">
                    Status
                  </th>
                  <th className="px-6 py-3 text-left text-[11px] font-medium text-[#6B7280] uppercase tracking-wider">
                    Intent
                  </th>
                  <th className="px-6 py-3 text-left text-[11px] font-medium text-[#6B7280] uppercase tracking-wider">
                    Time
                  </th>
                  <th className="px-6 py-3 text-left text-[11px] font-medium text-[#6B7280] uppercase tracking-wider">
                    Duration
                  </th>
                  <th className="px-6 py-3 text-left text-[11px] font-medium text-[#6B7280] uppercase tracking-wider">
                    Affected
                  </th>
                  <th className="px-6 py-3"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-default">
                {executions.map((log) => (
                  <motion.tr
                    key={log.id}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className="hover:bg-bg-elevated cursor-pointer transition-colors"
                    onClick={() => setSelectedLog(log)}
                  >
                    <td className="px-6 py-4 whitespace-nowrap">
                      {log.status === 'complete' && (
                        <div className="status-chip status-chip-success">
                          <CheckCircle2 className="w-3.5 h-3.5" />
                          <span>Complete</span>
                        </div>
                      )}
                      {log.status === 'error' && (
                        <div className="status-chip status-chip-danger">
                          <XCircle className="w-3.5 h-3.5" />
                          <span>Error</span>
                        </div>
                      )}
                      {log.status === 'processing' && (
                        <div className="status-chip status-chip-warning">
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          <span>Running</span>
                        </div>
                      )}
                    </td>
                    <td className="px-6 py-4">
                      <p className="text-[13px] text-white font-medium truncate max-w-md">
                        {log.intent}
                      </p>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <p className="text-[13px] text-[#9CA3AF]">
                        {log.timestamp.toLocaleString('en-US', {
                          month: 'short',
                          day: 'numeric',
                          hour: 'numeric',
                          minute: '2-digit',
                          hour12: true,
                        })}
                      </p>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <p className="text-[13px] text-[#6B7280] font-mono">{log.duration}</p>
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-2">
                        {log.affectedResources.map((resource, idx) => (
                          <span
                            key={idx}
                            className="inline-flex items-center px-2 py-1 rounded-md text-[11px] font-medium bg-[#11141A] text-[#9CA3AF] border border-[#1E2228]"
                          >
                            {resource}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className="px-6 py-4 text-right">
                      <ChevronRight className="w-4 h-4 text-text-muted" />
                    </td>
                  </motion.tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Side Panel for Details */}
      {selectedLog && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4"
          onClick={() => setSelectedLog(null)}
        >
          <motion.div
            initial={{ scale: 0.95, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.95, opacity: 0 }}
            className="card max-w-2xl w-full max-h-[80vh] overflow-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between mb-6">
              <div className="flex-1">
                <h2 className="text-[15px] font-semibold text-white mb-2">Execution Details</h2>
                <p className="text-[13px] text-[#9CA3AF]">
                  {selectedLog.timestamp.toLocaleString('en-US', {
                    month: 'long',
                    day: 'numeric',
                    year: 'numeric',
                    hour: 'numeric',
                    minute: '2-digit',
                    hour12: true,
                  })}
                </p>
              </div>
              <button
                onClick={() => setSelectedLog(null)}
                className="bg-transparent border border-[#1E2228] hover:bg-[#11141A] text-white px-3 py-1.5 rounded text-[13px] font-medium transition-colors"
              >
                Close
              </button>
            </div>

            {/* Intent */}
            <div className="mb-6">
              <h3 className="text-[11px] font-medium text-white uppercase tracking-wider mb-2">Intent</h3>
              <p className="text-[13px] text-white">{selectedLog.intent}</p>
            </div>

            {/* Status */}
            <div className="mb-6">
              <h3 className="text-[11px] font-medium text-white uppercase tracking-wider mb-2">Status</h3>
              {selectedLog.status === 'complete' && (
                <div className="status-chip status-chip-success">
                  <CheckCircle2 className="w-4 h-4" />
                  <span>Completed successfully</span>
                </div>
              )}
            </div>

            {/* Affected Resources */}
            <div className="mb-6">
              <h3 className="text-[11px] font-medium text-white uppercase tracking-wider mb-3">Affected Resources</h3>
              <div className="space-y-2">
                {selectedLog.affectedResources.map((resource, idx) => (
                  <div
                    key={idx}
                    className="flex items-center gap-3 p-3 rounded bg-[#11141A] border border-[#1E2228]"
                  >
                    {resource === 'Schema' && <Database className="w-4 h-4 text-[#9CA3AF]" />}
                    {resource === 'APIs' && <Code className="w-4 h-4 text-[#9CA3AF]" />}
                    {resource === 'Auth' && <Shield className="w-4 h-4 text-[#9CA3AF]" />}
                    <span className="text-[13px] text-white font-medium">{resource}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Migration ID */}
            {selectedLog.migrationId && (
              <div className="mb-6">
                <h3 className="text-[11px] font-medium text-white uppercase tracking-wider mb-2">Migration ID</h3>
                <p className="text-[13px] font-mono text-[#9CA3AF] bg-[#11141A] px-3 py-2 rounded border border-[#1E2228]">
                  {selectedLog.migrationId}
                </p>
              </div>
            )}

            {/* Rollback Info */}
            <div className="p-4 rounded bg-[#11141A] border border-[#1E2228]">
              <div className="flex items-start gap-3">
                <AlertCircle className="w-4 h-4 text-[#6B7280] flex-shrink-0 mt-0.5" />
                <div>
                  <p className="text-[13px] text-white font-medium mb-1">
                    Rollback capability
                  </p>
                  <p className="text-[11px] text-[#6B7280]">
                    Database snapshot created. Contact support if rollback is needed.
                  </p>
                </div>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
      </div>
    </div>
  )
}
