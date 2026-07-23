'use client'

import { Check } from 'lucide-react'

interface BuildSummaryCardProps {
  summary: string
  entities: string[]
  capabilities: string[]
}

// Entity icon mapping
const entityIcons: Record<string, string> = {
  users: '👤',
  user: '👤',
  members: '👥',
  member: '👥',
  projects: '📁',
  project: '📁',
  tasks: '✅',
  task: '✅',
  comments: '💬',
  comment: '💬',
  files: '📎',
  file: '📎',
  activity_logs: '📊',
  activity: '📊',
  logs: '📊',
  companies: '🏢',
  company: '🏢',
  workspaces: '🗂️',
  workspace: '🗂️',
  orders: '🛒',
  order: '🛒',
  products: '📦',
  product: '📦',
  payments: '💳',
  payment: '💳',
  invoices: '🧾',
  invoice: '🧾',
  posts: '📝',
  post: '📝',
  categories: '🏷️',
  category: '🏷️',
}

// Capability icon mapping
const capabilityIcons: Record<string, string> = {
  auth: '🔐',
  authentication: '🔐',
  storage: '📁',
  'file uploads': '📤',
  uploads: '📤',
  'activity tracking': '📊',
  tracking: '📊',
  'real-time': '⚡',
  realtime: '⚡',
  notifications: '🔔',
  email: '📧',
  search: '🔍',
  analytics: '📈',
}

function getEntityIcon(entity: string): string {
  const key = entity.toLowerCase().replace(/\s+/g, '_')
  return entityIcons[key] || '📋'
}

function getCapabilityIcon(capability: string): string {
  const key = capability.toLowerCase()
  return capabilityIcons[key] || '⚙️'
}

function formatEntityName(entity: string): string {
  return entity
    .split('_')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

export default function BuildSummaryCard({ summary, entities, capabilities }: BuildSummaryCardProps) {
  // Deduplicate and format entities
  const uniqueEntities = Array.from(new Set(entities.map(e => e.toLowerCase())))
  const hasEntities = uniqueEntities.length > 0
  const hasCapabilities = capabilities.length > 0

  return (
    <div className="bg-white/[0.02] border border-white/[0.06] rounded-xl p-5">
      {/* Header */}
      <div className="flex items-center gap-2 mb-4">
        <div className="flex items-center justify-center w-6 h-6 rounded-full bg-emerald-500/10 border border-emerald-500/15">
          <Check className="w-4 h-4 text-emerald-400" />
        </div>
        <h3 className="text-[14px] font-medium text-zinc-200">Backend Created</h3>
      </div>

      {/* Summary Text */}
      <p className="text-sm text-gray-300 mb-4 leading-relaxed">
        {summary}
      </p>

      {/* Entities Section */}
      {hasEntities && (
        <div className="mb-4">
          <h4 className="text-xs font-medium text-gray-400 uppercase tracking-wider mb-2">
            Entities
          </h4>
          <div className="flex flex-wrap gap-2">
            {uniqueEntities.map((entity) => (
              <div
                key={entity}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-gray-800/50 border border-gray-700/50 text-sm text-gray-200"
              >
                <span className="text-base">{getEntityIcon(entity)}</span>
                <span>{formatEntityName(entity)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Capabilities Section */}
      {hasCapabilities && (
        <div className="mb-4">
          <h4 className="text-xs font-medium text-gray-400 uppercase tracking-wider mb-2">
            Capabilities Enabled
          </h4>
          <div className="space-y-1.5">
            {capabilities.map((capability) => (
              <div key={capability} className="flex items-center gap-2 text-sm text-gray-300">
                <span className="text-base">{getCapabilityIcon(capability)}</span>
                <span>{capability}</span>
                <Check className="w-3.5 h-3.5 text-emerald-400 ml-auto" />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Next Steps */}
      <div className="mt-4 pt-4 border-t border-gray-700/50">
        <h4 className="text-xs font-medium text-gray-400 uppercase tracking-wider mb-2">
          Next Steps
        </h4>
        <div className="space-y-1.5 text-sm text-gray-400">
          <div className="flex items-center gap-2">
            <span className="text-gray-500">→</span>
            <span>Test APIs in the APIs panel</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-gray-500">→</span>
            <span>Connect your frontend</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-gray-500">→</span>
            <span>Review schema in Inspector</span>
          </div>
        </div>
      </div>
    </div>
  )
}
