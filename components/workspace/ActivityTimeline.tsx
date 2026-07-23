'use client'

import { motion } from 'framer-motion'
import { Table, Waypoints, ShieldCheck, CheckCircle2, History, HardDrive } from 'lucide-react'

interface TimelineItem {
  id: string
  description: string
  details?: string[]
  timestamp?: string
  category?: 'tables' | 'apis' | 'capabilities' | 'auth' | 'storage'
}

interface ActivityTimelineProps {
  items: TimelineItem[]
  maxItems?: number
}

function getCategoryIcon(category?: string) {
  switch (category) {
    case 'tables':
      return { icon: Table, color: 'text-blue-400 bg-blue-500/10' }
    case 'apis':
      return { icon: Waypoints, color: 'text-purple-400 bg-purple-500/10' }
    case 'capabilities':
      return { icon: CheckCircle2, color: 'text-emerald-400 bg-emerald-500/10' }
    case 'auth':
      return { icon: ShieldCheck, color: 'text-orange-400 bg-orange-500/10' }
    case 'storage':
      return { icon: HardDrive, color: 'text-cyan-400 bg-cyan-500/10' }
    default:
      return { icon: CheckCircle2, color: 'text-gray-400 bg-gray-500/10' }
  }
}

function getCategoryLabel(description: string): 'tables' | 'apis' | 'capabilities' | 'auth' | 'storage' | undefined {
  const lower = description.toLowerCase()
  if (lower.includes('table') || lower.includes('entity') || lower.includes('data')) return 'tables'
  if (lower.includes('api') || lower.includes('endpoint')) return 'apis'
  if (lower.includes('auth') || lower.includes('sign in') || lower.includes('login')) return 'auth'
  if (lower.includes('storage') || lower.includes('file') || lower.includes('upload')) return 'storage'
  if (lower.includes('capability') || lower.includes('feature')) return 'capabilities'
  return undefined
}

function formatTimeAgo(timestamp?: string): string {
  if (!timestamp) return 'Just now'
  
  const date = new Date(timestamp)
  const now = new Date()
  const seconds = Math.floor((now.getTime() - date.getTime()) / 1000)
  
  if (seconds < 60) return 'Just now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`
  return `${Math.floor(seconds / 86400)}d ago`
}

export function ActivityTimeline({ items, maxItems = 5 }: ActivityTimelineProps) {
  const displayItems = (items || []).slice(0, maxItems)

  if (displayItems.length === 0) {
    return null
  }

  return (
    <div className="bg-gray-800/20 border border-gray-700/30 rounded-xl p-5">
      <div className="flex items-center justify-between mb-5 gap-4">
        <h3 className="text-sm font-semibold text-gray-200">Activity Timeline</h3>
        <History className="w-4 h-4 text-gray-400 stroke-[2]" />
      </div>

      <div className="space-y-3">
        {displayItems.map((item, index) => {
          const category = getCategoryLabel(item.description)
          const { icon: Icon, color } = getCategoryIcon(category)
          
          return (
            <motion.div
              key={item.id}
              initial={{ opacity: 0, x: -10 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: index * 0.05 }}
              className="flex items-start gap-3 group"
            >
              {/* Icon */}
              <div className={`flex-shrink-0 w-8 h-8 rounded-lg ${color} flex items-center justify-center`}>
                <Icon className="w-4 h-4 stroke-[2]" />
              </div>

              {/* Content */}
              <div className="flex-1 min-w-0">
                <div className="flex items-start justify-between gap-4">
                  <p className="text-sm font-medium text-gray-200 leading-tight">
                    {item.description}
                  </p>
                  {item.timestamp && (
                    <span className="flex-shrink-0 text-xs font-semibold text-gray-300 tabular-nums">
                      {formatTimeAgo(item.timestamp)}
                    </span>
                  )}
                </div>

                {/* Details */}
                {item.details && item.details.length > 0 && (
                  <div className="mt-1.5 space-y-0.5">
                    {item.details.slice(0, 3).map((detail, idx) => (
                      <p key={idx} className="text-xs text-gray-400 leading-tight">
                        {detail}
                      </p>
                    ))}
                  </div>
                )}
              </div>

              {/* Completion Badge */}
              <div className="flex-shrink-0 ml-2">
                <CheckCircle2 className="w-4 h-4 text-emerald-400 stroke-[2]" />
              </div>
            </motion.div>
          )
        })}
      </div>

      {items.length > maxItems && (
        <div className="mt-4 pt-3 border-t border-gray-700/30">
          <p className="text-xs text-gray-400 text-center">
            +{items.length - maxItems} more changes
          </p>
        </div>
      )}
    </div>
  )
}
