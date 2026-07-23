'use client'

import { motion } from 'framer-motion'
import { CheckCircle2 } from 'lucide-react'

interface WorkspaceHeaderProps {
  buildState: 'idle' | 'building' | 'complete'
  isConnected: boolean
  hasContent: boolean
}

export function WorkspaceHeader({ buildState, isConnected, hasContent }: WorkspaceHeaderProps) {
  const getHeaderContent = () => {
    if (buildState === 'idle' || !hasContent) {
      return {
        icon: <span className="w-5 h-5 text-purple-400">✨</span>,
        title: 'Describe your backend idea above',
        subtitle: "I'll build the database, APIs, and infrastructure for you",
        color: 'purple' as const,
      }
    }
    
    if (isConnected) {
      return {
        icon: <CheckCircle2 className="w-5 h-5 text-green-400" />,
        title: 'Frontend connected — you can now call these APIs',
        subtitle: 'Use the base URL and endpoints below in your app',
        color: 'green' as const,
      }
    }
    
    return {
      icon: <span className="w-5 h-5 text-blue-400">→</span>,
      title: 'Your backend is ready — explore results below',
      subtitle: 'Test endpoints, review capabilities, and connect your frontend',
      color: 'blue' as const,
    }
  }

  const content = getHeaderContent()
  const colorClasses = {
    purple: 'bg-purple-500/10 border-purple-500/20',
    blue: 'bg-blue-500/10 border-blue-500/20',
    green: 'bg-green-500/10 border-green-500/20',
  }

  return (
    <motion.div
      key={`${buildState}-${isConnected}-${hasContent}`}
      initial={{ opacity: 0, y: -10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className={`${colorClasses[content.color]} border rounded-xl p-4 mb-6`}
    >
      <div className="flex items-center space-x-3">
        <div className="flex-shrink-0">
          {content.icon}
        </div>
        <div className="flex-1 min-w-0">
          <h2 className="text-base font-semibold text-[#E6E8EF]">
            {content.title}
          </h2>
          <p className="text-sm text-[#9AA3B2] mt-0.5">
            {content.subtitle}
          </p>
        </div>
      </div>
    </motion.div>
  )
}
