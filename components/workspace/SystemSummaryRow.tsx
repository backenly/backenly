'use client'

import { motion } from 'framer-motion'
import { Database, Plug, Shield, Archive, Radio, Zap, Webhook, Share2, Search } from 'lucide-react'

interface Capability {
  name: string
  enabled: boolean
  icon: string
  count?: number
}

interface SystemSummaryRowProps {
  tablesCount: number
  apisCount: number
  capabilities: Capability[]
  projectId: string
  onOpenDeveloperTools: () => void
}

// Icon mapping for different capability types
const iconMap = {
  auth: Shield,
  storage: Archive,
  realtime: Radio,
  jobs: Zap,
  webhooks: Webhook,
  integrations: Share2,
}

export function SystemSummaryRow({
  tablesCount,
  apisCount,
  capabilities,
  projectId,
  onOpenDeveloperTools,
}: SystemSummaryRowProps) {
  // Build dynamic capability cards based on what exists
  const capabilityCards: Array<{
    icon: any
    label: string
    subtitle: string
    color: string
    priority: number
  }> = []

  // 1. Data Models (always show if > 0)
  if (tablesCount > 0) {
    capabilityCards.push({
      icon: Database,
      label: tablesCount === 1 ? '1 Table' : `${tablesCount} Tables`,
      subtitle: 'Ready',
      color: 'blue',
      priority: 1,
    })
  }

  // 2. APIs (always show if > 0)
  if (apisCount > 0) {
    capabilityCards.push({
      icon: Plug,
      label: apisCount === 1 ? '1 API' : `${apisCount} APIs`,
      subtitle: 'Live',
      color: 'green',
      priority: 2,
    })
  }

  // 3. Dynamic capabilities (only show if enabled)
  capabilities.forEach((cap) => {
    if (!cap.enabled) return

    let label = cap.name
    let priority = 10 // Default low priority

    // Customize label and priority based on capability type
    switch (cap.icon) {
      case 'auth':
        label = 'Auth'
        priority = 3
        break
      case 'storage':
        label = cap.count ? `${cap.count} Storage Bucket${cap.count > 1 ? 's' : ''}` : 'Storage'
        priority = 4
        break
      case 'realtime':
        label = 'Realtime'
        priority = 5
        break
      case 'jobs':
        label = cap.count ? `${cap.count} Background Job${cap.count > 1 ? 's' : ''}` : 'Background Jobs'
        priority = 6
        break
      case 'webhooks':
        label = cap.count ? `${cap.count} Webhook${cap.count > 1 ? 's' : ''}` : 'Webhooks'
        priority = 7
        break
      case 'integrations':
        label = cap.count ? `${cap.count} Integration${cap.count > 1 ? 's' : ''}` : 'Integrations'
        priority = 8
        break
    }

    const IconComponent = iconMap[cap.icon as keyof typeof iconMap]
    if (IconComponent) {
      capabilityCards.push({
        icon: IconComponent,
        label,
        subtitle: 'Enabled',
        color: 'purple',
        priority,
      })
    }
  })

  // Sort by priority
  capabilityCards.sort((a, b) => a.priority - b.priority)

  // Calculate grid columns based on card count
  const gridCols = capabilityCards.length === 1 
    ? 'grid-cols-1' 
    : capabilityCards.length === 2 
    ? 'grid-cols-2' 
    : capabilityCards.length === 3
    ? 'grid-cols-3'
    : 'grid-cols-4'

  // Don't render if no capabilities exist
  if (capabilityCards.length === 0) {
    return null
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, delay: 0.2 }}
    >
      {/* Summary Bar */}
      <div className="flex items-center justify-between bg-[#0B0F19] border border-slate-800/60 rounded-xl p-4">
        {/* Stats */}
        <div className="flex items-center gap-6">
          {capabilityCards.slice(0, 3).map((card, index) => (
            <div key={index} className="flex items-center gap-2.5">
              <div className={`w-7 h-7 rounded-md bg-${card.color}-500/10 border border-${card.color}-500/20 flex items-center justify-center`}>
                <card.icon className={`w-3.5 h-3.5 text-${card.color}-400`} />
              </div>
              <span className="text-sm font-medium text-slate-300">{card.label}</span>
            </div>
          ))}
        </div>

        {/* Actions */}
        <div className="flex items-center gap-3">
          <button
            onClick={onOpenDeveloperTools}
            className="flex items-center gap-2 px-4 py-2 bg-purple-600 hover:bg-purple-500 text-white text-xs font-semibold rounded-lg transition-all border border-purple-500/50 hover:border-purple-400/60 hover:shadow-lg hover:shadow-purple-900/30"
          >
            <Search className="w-3.5 h-3.5" />
            Open Inspector
          </button>
        </div>
      </div>
    </motion.div>
  )
}
