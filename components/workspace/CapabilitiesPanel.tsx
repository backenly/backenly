'use client'

import { useState } from 'react'
import { motion } from 'framer-motion'
import { ShieldCheck, HardDrive, Radio, Check, Settings, Upload } from 'lucide-react'
import { StorageTestModal } from './StorageTestModal'
import { useRouter } from 'next/navigation'

interface Capability {
  name: string
  enabled: boolean
  icon: 'auth' | 'storage' | 'realtime' | 'jobs'
}

interface CapabilitiesPanelProps {
  capabilities: Capability[]
  stageCompleted: boolean
  showIndicator: boolean
  projectId: string
}

export function CapabilitiesPanel({ capabilities, stageCompleted, showIndicator, projectId }: CapabilitiesPanelProps) {
  const router = useRouter()
  const [hoveredCapability, setHoveredCapability] = useState<string | null>(null)
  const [storageModalOpen, setStorageModalOpen] = useState(false)
  const enabledCapabilities = capabilities.filter(c => c.enabled)
  
  if (enabledCapabilities.length === 0) return null

  const getIcon = (iconType: string) => {
    switch (iconType) {
      case 'auth': return <ShieldCheck className="w-5 h-5 stroke-[2]" />
      case 'storage': return <HardDrive className="w-5 h-5 stroke-[2]" />
      case 'realtime': return <Radio className="w-5 h-5 stroke-[2]" />
      case 'jobs': return <Check className="w-5 h-5 stroke-[2]" />
      default: return <Check className="w-5 h-5 stroke-[2]" />
    }
  }

  const getColor = (iconType: string) => {
    // Clean dark theme - no purple backgrounds
    return 'bg-gray-800/50 text-gray-300 border-gray-700/50'
  }

  const getAction = (iconType: string) => {
    switch (iconType) {
      case 'auth': return { 
        label: 'Configure Auth', 
        icon: <Settings className="w-3 h-3" />, 
        disabled: false,
        onClick: () => router.push(`/app/projects/${projectId}/inspector`)
      }
      case 'storage': return { 
        label: 'Test Storage', 
        icon: <Upload className="w-3 h-3" />, 
        disabled: false,
        onClick: () => setStorageModalOpen(true)
      }
      case 'realtime': return { 
        label: 'Configure', 
        icon: <Settings className="w-3 h-3" />, 
        disabled: true,
        onClick: () => {}
      }
      case 'jobs': return { 
        label: 'Configure', 
        icon: <Settings className="w-3 h-3" />, 
        disabled: true,
        onClick: () => {}
      }
      default: return { 
        label: 'Configure', 
        icon: <Settings className="w-3 h-3" />, 
        disabled: true,
        onClick: () => {}
      }
    }
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, delay: 0.3 }}
      data-panel="capabilities"
      className={`bg-[#151B2E]/60 backdrop-blur-xl border rounded-xl p-6 transition-all ${
        showIndicator && !stageCompleted ? 'border-purple-500/50 shadow-lg shadow-purple-500/20' : 'border-white/5'
      }`}
    >
      <div className="flex items-center space-x-3 mb-4">
        <div className="w-10 h-10 rounded-xl bg-purple-500/20 flex items-center justify-center">
          <Check className="w-5 h-5 text-purple-400" />
        </div>
        <div>
          <h3 className="text-lg font-semibold text-[#E6E8EF]">
            Capabilities
          </h3>
          <p className="text-sm text-[#9AA3B2]">
            {enabledCapabilities.length} enabled
          </p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        {enabledCapabilities.map((capability) => {
          const action = getAction(capability.icon)
          const isHovered = hoveredCapability === capability.name
          
          // Clean dark theme hover - subtle gray highlight
          const getHoverColor = (iconType: string) => {
            return 'hover:border-gray-600 hover:shadow-lg hover:shadow-black/20'
          }
          
          return (
            <div
              key={capability.name}
              onMouseEnter={() => setHoveredCapability(capability.name)}
              onMouseLeave={() => setHoveredCapability(null)}
              className={`bg-gray-900 border border-gray-800 rounded-lg overflow-hidden ${getHoverColor(capability.icon)} transition-all duration-200 group`}
            >
              <div className={`p-4 border ${getColor(capability.icon)}`}>
                <div className="flex items-center gap-3">
                  <div className="flex-shrink-0 transition-transform duration-200 group-hover:scale-110">
                    {getIcon(capability.icon)}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-200 group-hover:text-white transition-colors duration-200 truncate">
                      {capability.name}
                    </p>
                  </div>
                </div>
              </div>
              
              {/* Quick Actions - Smooth Slide Animation */}
              {isHovered && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ 
                    height: { duration: 0.2, ease: [0.4, 0, 0.2, 1] },
                    opacity: { duration: 0.15, ease: 'easeOut' }
                  }}
                  className="border-t border-gray-800 bg-black/40 backdrop-blur-sm"
                >
                  <div className="p-2">
                    <button
                      onClick={action.onClick}
                      disabled={action.disabled}
                      className={`w-full px-4 py-2 text-xs font-medium rounded-md flex items-center justify-center gap-2 transition-all duration-150 ${
                        action.disabled
                          ? 'text-gray-500 bg-gray-800/40 cursor-not-allowed'
                          : 'text-gray-300 hover:text-white hover:bg-gray-800 cursor-pointer'
                      }`}
                      title={action.disabled ? 'Coming soon' : ''}
                    >
                      {action.icon}
                      <span>{action.label}</span>
                    </button>
                  </div>
                </motion.div>
              )}
            </div>
          )
        })}
      </div>

      {/* PHASE 2: Modals */}
      <StorageTestModal
        isOpen={storageModalOpen}
        onClose={() => setStorageModalOpen(false)}
        projectId={projectId}
      />
    </motion.div>
  )
}
