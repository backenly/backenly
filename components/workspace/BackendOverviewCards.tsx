'use client'

import { Route, Database, Lock, FolderOpen, Zap } from 'lucide-react'

interface BackendOverviewCardsProps {
  stats: {
    endpoints: number
    models: number
    authEnabled: boolean
    storageEnabled: boolean
    environment: 'dev' | 'prod'
  }
}

export function BackendOverviewCards({ stats }: BackendOverviewCardsProps) {
  const cards = [
    {
      label: 'APIs',
      value: stats.endpoints,
      icon: Route,
      color: 'text-blue-400',
      bgColor: 'bg-blue-500/10',
    },
    {
      label: 'Data',
      value: stats.models,
      icon: Database,
      color: 'text-green-400',
      bgColor: 'bg-green-500/10',
    },
    {
      label: 'Auth',
      value: stats.authEnabled ? 'Enabled' : 'Disabled',
      icon: Lock,
      color: stats.authEnabled ? 'text-purple-400' : 'text-gray-500',
      bgColor: stats.authEnabled ? 'bg-purple-500/10' : 'bg-gray-500/10',
    },
    {
      label: 'Storage',
      value: stats.storageEnabled ? 'Enabled' : 'Disabled',
      icon: FolderOpen,
      color: stats.storageEnabled ? 'text-orange-400' : 'text-gray-500',
      bgColor: stats.storageEnabled ? 'bg-orange-500/10' : 'bg-gray-500/10',
    },
    {
      label: 'Environment',
      value: stats.environment.toUpperCase(),
      icon: Zap,
      color: stats.environment === 'prod' ? 'text-red-400' : 'text-yellow-400',
      bgColor: stats.environment === 'prod' ? 'bg-red-500/10' : 'bg-yellow-500/10',
    },
  ]

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4 p-6 bg-[#0F1116] border-b border-gray-800">
      {cards.map((card) => {
        const Icon = card.icon
        return (
          <div
            key={card.label}
            className={`${card.bgColor} border border-gray-800 rounded-lg p-4 transition-all hover:scale-105`}
          >
            <div className="flex items-center gap-3">
              <div className={`p-2 rounded-lg ${card.bgColor}`}>
                <Icon className={`w-5 h-5 ${card.color}`} />
              </div>
              <div>
                <div className="text-xs text-gray-500 uppercase tracking-wider">{card.label}</div>
                <div className={`text-lg font-bold ${card.color}`}>{card.value}</div>
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}
