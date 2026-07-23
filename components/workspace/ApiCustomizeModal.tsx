'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/Button'
import { motion, AnimatePresence } from 'framer-motion'
import {
  X, Check, Settings, Shield, Info, ChevronDown, ChevronRight
} from 'lucide-react'

interface ApiCustomizeModalProps {
  isOpen: boolean
  tableName: string
  onClose: () => void
  onGenerate: (config: ApiConfig) => void
  isGenerating?: boolean
}

export interface ApiConfig {
  tableName: string
  apiName: string
  version: string
  basePath: string
  authStrategy: 'jwt' | 'api-key' | 'public'
  operations: {
    list: boolean
    get: boolean
    create: boolean
    update: boolean
    delete: boolean
    search: boolean
    bulk: boolean
  }
  rateLimit: number
  validation: boolean
}

export default function ApiCustomizeModal({
  isOpen,
  tableName,
  onClose,
  onGenerate,
  isGenerating = false,
}: ApiCustomizeModalProps) {
  const [config, setConfig] = useState<ApiConfig>({
    tableName,
    apiName: tableName.toLowerCase(),
    version: 'v1',
    basePath: `/api/v1/${tableName.toLowerCase()}`,
    authStrategy: 'jwt',
    operations: {
      list: true,
      get: true,
      create: true,
      update: true,
      delete: true,
      search: false,
      bulk: false,
    },
    rateLimit: 100,
    validation: true,
  })

  const [showAdvanced, setShowAdvanced] = useState(false)

  const handleSubmit = () => {
    onGenerate(config)
  }

  const toggleOperation = (op: keyof ApiConfig['operations']) => {
    setConfig(prev => ({
      ...prev,
      operations: {
        ...prev.operations,
        [op]: !prev.operations[op],
      },
    }))
  }

  if (!isOpen) return null

  const operationsList = [
    { key: 'list' as const, label: 'GET /  (List all)', description: 'Fetch paginated list' },
    { key: 'get' as const, label: 'GET /:id  (Get by ID)', description: 'Fetch single record' },
    { key: 'create' as const, label: 'POST /  (Create)', description: 'Create new record' },
    { key: 'update' as const, label: 'PUT /:id  (Update)', description: 'Update existing record' },
    { key: 'delete' as const, label: 'DELETE /:id  (Delete)', description: 'Remove record' },
    { key: 'search' as const, label: 'GET /search  (Search)', description: 'Full-text search' },
    { key: 'bulk' as const, label: 'POST /bulk  (Bulk ops)', description: 'Batch create/update' },
  ]

  const authStrategies = [
    { value: 'jwt' as const, label: 'JWT Auth', icon: '🔐', description: 'User authentication required' },
    { value: 'api-key' as const, label: 'API Key', icon: '🔑', description: 'API key in headers' },
    { value: 'public' as const, label: 'Public', icon: '🌐', description: 'No authentication' },
  ]

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4"
        onClick={onClose}
      >
        <motion.div
          initial={{ scale: 0.95, opacity: 0, y: 20 }}
          animate={{ scale: 1, opacity: 1, y: 0 }}
          exit={{ scale: 0.95, opacity: 0, y: 20 }}
          className="bg-gradient-to-br from-[#0A0E1A] to-[#0F1419] border border-purple-500/30 rounded-[2.5rem] shadow-2xl max-w-3xl w-full max-h-[90vh] overflow-hidden flex flex-col relative"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Decorative Glow */}
          <div className="absolute top-0 right-0 -mr-20 -mt-20 w-64 h-64 bg-purple-500/10 rounded-full blur-[100px] pointer-events-none" />
          
          {/* Header */}
          <div className="px-8 py-6 border-b border-white/10 flex items-center justify-between bg-white/5 backdrop-blur-xl relative z-10">
            <div className="flex items-center space-x-4">
              <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-purple-500/20 to-blue-500/20 border border-purple-500/30 flex items-center justify-center shadow-lg shadow-purple-500/10">
                <Settings className="w-6 h-6 text-purple-400" />
              </div>
              <div>
                <h2 className="text-2xl font-bold text-white tracking-tight">Customize APIs</h2>
                <p className="text-sm text-gray-400 font-medium">
                  Settings for <span className="text-purple-400 font-bold font-mono px-2 py-0.5 bg-purple-500/10 rounded-md">{tableName}</span>
                </p>
              </div>
            </div>
            <button
              onClick={onClose}
              className="p-3 text-gray-500 hover:text-white hover:bg-white/5 rounded-2xl transition-all"
            >
              <X className="w-6 h-6" />
            </button>
          </div>

          {/* Content */}
          <div className="flex-1 overflow-y-auto p-8 space-y-8 thin-scrollbar relative z-10">
            {/* Basic Configuration */}
            <div className="bg-white/5 backdrop-blur-xl border border-white/10 rounded-3xl p-6 shadow-xl">
              <h3 className="text-base font-bold text-white mb-6 flex items-center space-x-3">
                <span>Routing & Path</span>
              </h3>
              <div className="space-y-6">
                <div className="grid grid-cols-2 gap-6">
                  <div>
                    <label className="text-xs font-black uppercase tracking-[0.15em] text-gray-500 mb-2.5 block ml-1">API Name</label>
                    <input
                      type="text"
                      value={config.apiName}
                      onChange={(e) => setConfig({ ...config, apiName: e.target.value })}
                      className="w-full px-5 py-3.5 bg-black/40 border border-white/10 rounded-2xl text-white text-sm font-medium focus:outline-none focus:ring-2 focus:ring-purple-500/50 transition-all"
                      placeholder="categories"
                    />
                  </div>
                  <div>
                    <label className="text-xs font-black uppercase tracking-[0.15em] text-gray-500 mb-2.5 block ml-1">Version</label>
                    <div className="relative">
                      <select
                        value={config.version}
                        onChange={(e) => setConfig({ ...config, version: e.target.value })}
                        className="w-full px-5 py-3.5 bg-black/40 border border-white/10 rounded-2xl text-white text-sm font-bold focus:outline-none focus:ring-2 focus:ring-purple-500/50 appearance-none cursor-pointer transition-all"
                      >
                        <option value="v1">v1</option>
                        <option value="v2">v2</option>
                        <option value="v3">v3</option>
                      </select>
                      <ChevronDown className="w-4 h-4 text-gray-500 absolute right-5 top-1/2 -translate-y-1/2 pointer-events-none" />
                    </div>
                  </div>
                </div>

                <div>
                  <label className="text-xs font-black uppercase tracking-[0.15em] text-gray-500 mb-2.5 block ml-1">API Route Prefix</label>
                  <div className="relative group">
                    <input
                      type="text"
                      value={config.basePath}
                      onChange={(e) => setConfig({ ...config, basePath: e.target.value })}
                      className="w-full px-5 py-3.5 bg-black/40 border border-white/10 rounded-2xl text-purple-300 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-purple-500/50 transition-all"
                      placeholder="/api/v1/categories"
                    />
                    <div className="absolute right-4 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 transition-opacity">
                      <span className="text-purple-500/50">→</span>
                    </div>
                  </div>
                  <p className="text-[11px] text-gray-500 mt-2.5 font-medium ml-1 flex items-center gap-1.5">
                    <Info className="w-3 h-3" />
                    Routes are automatically handled by the system
                  </p>
                </div>
              </div>
            </div>

            {/* Authentication Strategy */}
            <div className="bg-white/5 backdrop-blur-xl border border-white/10 rounded-3xl p-6 shadow-xl">
              <h3 className="text-base font-bold text-white mb-6 flex items-center space-x-3">
                <div className="p-1.5 bg-emerald-500/20 rounded-lg">
                  <Shield className="w-4 h-4 text-emerald-400" />
                </div>
                <span>Security Access</span>
              </h3>
              <div className="grid grid-cols-3 gap-4">
                {authStrategies.map((strategy) => (
                  <button
                    key={strategy.value}
                    onClick={() => setConfig({ ...config, authStrategy: strategy.value })}
                    className={`p-5 rounded-[1.5rem] border-2 transition-all text-left relative overflow-hidden group ${
                      config.authStrategy === strategy.value
                        ? 'border-purple-500 bg-purple-500/10 shadow-lg shadow-purple-500/10'
                        : 'border-white/5 bg-black/40 hover:border-white/20'
                    }`}
                  >
                    {config.authStrategy === strategy.value && (
                      <div className="absolute top-3 right-3 bg-purple-500 rounded-full p-1 shadow-lg">
                        <Check className="w-3 h-3 text-white" />
                      </div>
                    )}
                    <div className="text-2xl mb-3 group-hover:scale-110 transition-transform">{strategy.icon}</div>
                    <div className="text-sm font-bold text-white mb-1">{strategy.label}</div>
                    <div className="text-[11px] text-gray-500 font-medium leading-relaxed">{strategy.description}</div>
                  </button>
                ))}
              </div>
            </div>

            {/* Operations Selection */}
            <div className="bg-white/5 backdrop-blur-xl border border-white/10 rounded-3xl p-6 shadow-xl">
              <h3 className="text-base font-bold text-white mb-6 flex items-center space-x-3">
                <div className="p-1.5 bg-amber-500/20 rounded-lg">
                  <Check className="w-4 h-4 text-amber-500" />
                </div>
                <span>Allowed Operations</span>
              </h3>
              <div className="grid grid-cols-1 gap-3">
                {operationsList.map((op) => (
                  <button
                    key={op.key}
                    onClick={() => toggleOperation(op.key)}
                    className={`w-full p-4 rounded-2xl border flex items-center justify-between transition-all group ${
                      config.operations[op.key]
                        ? 'border-purple-500/50 bg-white/5 shadow-inner'
                        : 'border-white/5 bg-black/40 hover:border-white/10'
                    }`}
                  >
                    <div className="flex items-center space-x-4 flex-1 text-left">
                      <div
                        className={`w-6 h-6 rounded-lg border-2 flex items-center justify-center transition-all ${
                          config.operations[op.key]
                            ? 'border-purple-500 bg-purple-500 shadow-lg shadow-purple-500/30'
                            : 'border-white/10 group-hover:border-white/30'
                        }`}
                      >
                        {config.operations[op.key] && <Check className="w-4 h-4 text-white" />}
                      </div>
                      <div className="flex-1">
                        <div className="text-sm font-bold text-white font-mono flex items-center gap-2">
                          {op.label}
                          {op.key === 'search' && <span className="text-[10px] font-black uppercase px-1.5 py-0.5 bg-blue-500/20 text-blue-400 rounded-md">Smart Search</span>}
                        </div>
                        <div className="text-[11px] text-gray-500 font-medium">{op.description}</div>
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            </div>

            {/* Advanced Options */}
            <div className="px-2">
              <button
                onClick={() => setShowAdvanced(!showAdvanced)}
                className="flex items-center space-x-3 text-sm font-bold text-gray-500 hover:text-white transition-all group"
              >
                <div className={`p-1 rounded-md bg-white/5 group-hover:bg-white/10 transition-colors ${showAdvanced ? 'rotate-90' : ''}`}>
                  <ChevronRight className="w-4 h-4" />
                </div>
                <span>Advanced Configuration</span>
              </button>

              <AnimatePresence>
                {showAdvanced && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    className="overflow-hidden"
                  >
                    <div className="mt-6 p-6 bg-black/40 border border-white/5 rounded-[2rem] space-y-6">
                      <div className="grid grid-cols-2 gap-8">
                        <div>
                          <label className="text-xs font-black uppercase tracking-widest text-gray-500 mb-3 block ml-1">Rate Limit</label>
                          <div className="flex items-center gap-4">
                            <input
                              type="number"
                              value={config.rateLimit}
                              onChange={(e) => setConfig({ ...config, rateLimit: parseInt(e.target.value) || 100 })}
                              className="w-full px-5 py-3.5 bg-white/5 border border-white/10 rounded-2xl text-white text-sm font-bold focus:outline-none focus:ring-2 focus:ring-purple-500/50 transition-all"
                              min="1"
                              max="1000"
                            />
                            <span className="text-xs text-gray-500 font-bold whitespace-nowrap">req / min</span>
                          </div>
                        </div>
                        <div className="flex items-center pt-6">
                          <label className="flex items-center space-x-4 cursor-pointer group">
                            <div className="relative">
                              <input
                                type="checkbox"
                                checked={config.validation}
                                onChange={(e) => setConfig({ ...config, validation: e.target.checked })}
                                className="sr-only peer"
                              />
                              <div className="w-12 h-6.5 bg-white/10 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[3px] after:left-[3px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-purple-500" />
                            </div>
                            <span className="text-sm font-bold text-gray-400 group-hover:text-white transition-colors">Enable Input Validation</span>
                          </label>
                        </div>
                      </div>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            {/* Info Box */}
            <div className="bg-gradient-to-r from-blue-500/10 to-blue-600/10 border border-blue-500/20 rounded-2xl p-6 relative overflow-hidden group">
              <div className="absolute top-0 right-0 p-4 opacity-10 group-hover:rotate-12 transition-transform">
                <Info className="w-12 h-12 text-blue-400" />
              </div>
              <div className="flex items-start space-x-4 relative z-10">
                <div className="p-2 bg-blue-500/20 rounded-lg">
                  <Info className="w-5 h-5 text-blue-400" />
                </div>
                <div>
                  <p className="text-sm font-bold text-blue-300 mb-1.5">Handled Logic</p>
                  <p className="text-[11px] text-gray-400 font-medium leading-relaxed">
                    Your configuration is stored and <strong>immediately active</strong>. The system will handle these APIs automatically—no deployments or manual code changes required.
                  </p>
                </div>
              </div>
            </div>
          </div>

          {/* Footer */}
          <div className="px-8 py-6 border-t border-white/10 flex items-center justify-between bg-white/5 backdrop-blur-xl relative z-10">
            <div className="text-xs font-bold text-gray-500 uppercase tracking-widest px-4 py-2 bg-white/5 rounded-xl border border-white/5">
              {Object.values(config.operations).filter(Boolean).length} Active Routes
            </div>
            <div className="flex items-center space-x-4">
              <Button
                variant="ghost"
                onClick={onClose}
                disabled={isGenerating}
                className="text-gray-400 hover:text-white hover:bg-white/5 font-bold px-6 py-3 rounded-xl transition-all"
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                onClick={handleSubmit}
                disabled={isGenerating}
                className="bg-gradient-to-r from-purple-600 to-blue-600 hover:from-purple-500 hover:to-blue-500 text-white font-black px-8 py-3 rounded-xl shadow-xl shadow-purple-500/20 hover:shadow-purple-500/40 transition-all transform hover:scale-105"
              >
                {isGenerating ? (
                  <>
                    <motion.div
                      animate={{ rotate: 360 }}
                      transition={{ duration: 1, repeat: Infinity, ease: 'linear' }}
                      className="w-5 h-5 border-2 border-white border-t-transparent rounded-full mr-3"
                    />
                    Building...
                  </>
                ) : (
                  <>
                    Generate API
                  </>
                )}
              </Button>
            </div>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  )
}
