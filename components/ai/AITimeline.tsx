'use client'

import { useState, useEffect } from 'react'
import { useParams } from 'next/navigation'
import { Clock, CheckCircle, XCircle, RotateCcw, AlertTriangle, User, FileText, Terminal } from 'lucide-react'

/**
 * TRUST UI: AI Execution Timeline
 * 
 * Shows what AI has done - builds emotional trust
 * "Nothing happened behind my back"
 */

interface TimelineEvent {
  id: string
  type: 'execution' | 'rollback' | 'approval' | 'learning'
  action: string
  timestamp: Date
  user: {
    email: string
    name: string
  } | null
  description: string
  changes: {
    filesCreated: string[]
    filesModified: string[]
    commandsRun: string[]
  }
  riskLevel: string
  status: string
  canRollback: boolean
  journalId?: string
}

interface TimelineStats {
  totalExecutions: number
  last24Hours: number
  last7Days: number
  rollbacks: number
  approvals: number
  successRate: string
}

export function AITimeline() {
  const params = useParams()
  const projectId = params?.projectId as string | undefined
  
  const [timeline, setTimeline] = useState<TimelineEvent[]>([])
  const [stats, setStats] = useState<TimelineStats | null>(null)
  const [loading, setLoading] = useState(true)
  const [selectedEvent, setSelectedEvent] = useState<TimelineEvent | null>(null)

  useEffect(() => {
    if (!projectId) return
    loadTimeline()
  }, [projectId])

  const loadTimeline = async () => {
    try {
      const response = await fetch(`/api/ai/timeline?projectId=${projectId}`)
      const data = await response.json()
      
      setTimeline(data.timeline || [])
      setStats(data.stats || null)
    } catch (error) {
      console.error('Failed to load timeline:', error)
    } finally {
      setLoading(false)
    }
  }

  const handleRollback = async (journalId: string) => {
    if (!confirm('Are you sure you want to undo this execution?')) return
    
    try {
      const response = await fetch(`/api/ai/journal?projectId=${projectId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ journalId }),
      })
      
      const result = await response.json()
      
      if (result.success) {
        alert(`✅ Rollback successful: ${result.message}`)
        loadTimeline() // Refresh
      } else {
        alert(`❌ Rollback failed: ${result.message}`)
      }
    } catch (error) {
      console.error('Rollback error:', error)
      alert('Failed to rollback execution')
    }
  }

  if (loading) {
    return <div className="p-4 text-gray-500">Loading AI activity...</div>
  }

  return (
    <div className="flex flex-col h-full bg-gray-50">
      {/* Stats Header */}
      {stats && (
        <div className="p-4 bg-white border-b">
          <h2 className="text-lg font-semibold mb-3">AI Activity</h2>
          <div className="grid grid-cols-3 gap-4">
            <StatCard
              icon={<CheckCircle className="w-4 h-4 text-green-600" />}
              label="Success Rate"
              value={`${stats.successRate}%`}
            />
            <StatCard
              icon={<Clock className="w-4 h-4 text-blue-600" />}
              label="Last 24h"
              value={stats.last24Hours.toString()}
            />
            <StatCard
              icon={<RotateCcw className="w-4 h-4 text-orange-600" />}
              label="Rollbacks"
              value={stats.rollbacks.toString()}
            />
          </div>
        </div>
      )}

      {/* Timeline */}
      <div className="flex-1 overflow-auto p-4">
        {timeline.length === 0 ? (
          <div className="text-center py-12 text-gray-500">
            <FileText className="w-12 h-12 mx-auto mb-3 opacity-50" />
            <p>No AI activity yet</p>
            <p className="text-sm mt-1">AI executions will appear here</p>
          </div>
        ) : (
          <div className="space-y-3">
            {timeline.map((event) => (
              <TimelineItem
                key={event.id}
                event={event}
                onSelect={() => setSelectedEvent(event)}
                onRollback={event.canRollback ? () => handleRollback(event.journalId!) : undefined}
              />
            ))}
          </div>
        )}
      </div>

      {/* Detail Panel */}
      {selectedEvent && (
        <div className="border-t bg-white p-4">
          <div className="flex justify-between items-start mb-3">
            <h3 className="font-semibold">Execution Details</h3>
            <button
              onClick={() => setSelectedEvent(null)}
              className="text-gray-400 hover:text-gray-600"
            >
              ✕
            </button>
          </div>
          
          <div className="space-y-2 text-sm">
            {selectedEvent.changes.filesCreated.length > 0 && (
              <div>
                <p className="font-medium text-green-700">Files Created:</p>
                <ul className="ml-4 text-gray-600">
                  {selectedEvent.changes.filesCreated.map((file, i) => (
                    <li key={i} className="font-mono text-xs">+ {file}</li>
                  ))}
                </ul>
              </div>
            )}
            
            {selectedEvent.changes.filesModified.length > 0 && (
              <div>
                <p className="font-medium text-blue-700">Files Modified:</p>
                <ul className="ml-4 text-gray-600">
                  {selectedEvent.changes.filesModified.map((file, i) => (
                    <li key={i} className="font-mono text-xs">~ {file}</li>
                  ))}
                </ul>
              </div>
            )}
            
            {selectedEvent.changes.commandsRun.length > 0 && (
              <div>
                <p className="font-medium text-purple-700">Commands Run:</p>
                <ul className="ml-4 text-gray-600">
                  {selectedEvent.changes.commandsRun.map((cmd, i) => (
                    <li key={i} className="font-mono text-xs">$ {cmd}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function StatCard({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="bg-gray-50 rounded-lg p-3">
      <div className="flex items-center gap-2 mb-1">
        {icon}
        <span className="text-xs text-gray-600">{label}</span>
      </div>
      <div className="text-xl font-bold">{value}</div>
    </div>
  )
}

function TimelineItem({ 
  event, 
  onSelect, 
  onRollback 
}: { 
  event: TimelineEvent
  onSelect: () => void
  onRollback?: () => void
}) {
  const getIcon = () => {
    switch (event.type) {
      case 'execution':
        return <CheckCircle className="w-5 h-5 text-green-600" />
      case 'rollback':
        return <RotateCcw className="w-5 h-5 text-orange-600" />
      case 'approval':
        return <User className="w-5 h-5 text-blue-600" />
      default:
        return <Clock className="w-5 h-5 text-gray-600" />
    }
  }

  const getRiskBadge = () => {
    const colors: Record<string, string> = {
      safe: 'bg-green-100 text-green-800',
      moderate: 'bg-yellow-100 text-yellow-800',
      destructive: 'bg-orange-100 text-orange-800',
      critical: 'bg-red-100 text-red-800',
    }
    
    const color = colors[event.riskLevel] || 'bg-gray-100 text-gray-800'
    
    return (
      <span className={`text-xs px-2 py-0.5 rounded ${color}`}>
        {event.riskLevel}
      </span>
    )
  }

  return (
    <div
      onClick={onSelect}
      className="bg-white rounded-lg p-4 border border-gray-200 hover:border-blue-300 cursor-pointer transition-all"
    >
      <div className="flex items-start gap-3">
        <div className="mt-0.5">{getIcon()}</div>
        
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <p className="font-medium text-sm truncate">{event.description}</p>
            {getRiskBadge()}
          </div>
          
          <div className="flex items-center gap-3 text-xs text-gray-500">
            <span>{new Date(event.timestamp).toLocaleString()}</span>
            {event.user && (
              <>
                <span>•</span>
                <span>{event.user.name}</span>
              </>
            )}
          </div>
          
          {/* Quick summary */}
          <div className="flex gap-3 mt-2 text-xs text-gray-600">
            {event.changes.filesCreated.length > 0 && (
              <span className="text-green-700">+{event.changes.filesCreated.length} files</span>
            )}
            {event.changes.filesModified.length > 0 && (
              <span className="text-blue-700">~{event.changes.filesModified.length} modified</span>
            )}
            {event.changes.commandsRun.length > 0 && (
              <span className="text-purple-700">{event.changes.commandsRun.length} commands</span>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
