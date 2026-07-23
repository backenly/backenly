'use client'

import { useState, useEffect } from 'react'
import { Button } from '@/components/ui/Button'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Database, ChevronDown, ChevronRight, X, Loader2, CheckCircle2, Info, RefreshCw, Settings
} from 'lucide-react'
import { detectNewTables, type NewTableSuggestion } from '@/lib/api/workspace'

interface NewTablesSuggestionWidgetProps {
  onGenerateClick: (prompt: string, tableName: string) => void
  onCustomizeClick?: (tableName: string) => void
  isGenerating?: boolean
}

export default function NewTablesSuggestionWidget({ 
  onGenerateClick,
  onCustomizeClick,
  isGenerating = false,
}: NewTablesSuggestionWidgetProps) {
  const [newTables, setNewTables] = useState<NewTableSuggestion[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [isExpanded, setIsExpanded] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const [generatingFor, setGeneratingFor] = useState<string | null>(null)

  // Check for new tables on mount and when user navigates back from Database page
  // Event-driven approach - no constant polling
  useEffect(() => {
    // Initial check on mount
    checkForNewTables()
    
    // Listen for database changes (dispatched when user creates a table)
    const handleDatabaseChange = () => {
      console.log('[TableSync] Database change detected, checking for new tables...')
      checkForNewTables()
    }
    
    // Listen for page visibility changes (when user returns to tab)
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible' && !isGenerating) {
        console.log('[TableSync] Page visible, refreshing table list...')
        checkForNewTables()
      }
    }
    
    window.addEventListener('databaseChanged', handleDatabaseChange)
    document.addEventListener('visibilitychange', handleVisibilityChange)
    
    // Optional: Poll only if not generating (fallback for edge cases)
    // Reduced frequency to 60 seconds to avoid interruptions
    let interval: NodeJS.Timeout | null = null
    if (!isGenerating) {
      interval = setInterval(() => {
        console.log('[TableSync] Periodic check (60s)...')
        checkForNewTables()
      }, 60000) // 60 seconds instead of 30
    }
    
    return () => {
      window.removeEventListener('databaseChanged', handleDatabaseChange)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      if (interval) clearInterval(interval)
    }
  }, [isGenerating])

  const checkForNewTables = async () => {
    try {
      setLoading(true)
      setError(null)
      const result = await detectNewTables()
      setNewTables(result.newTables)
      
      // Auto-expand if there are new tables
      if (result.newTables.length > 0 && !dismissed) {
        setIsExpanded(true)
      }
    } catch (err: any) {
      console.error('Failed to detect new tables:', err)
      setError(err.message || 'Failed to check for new tables')
    } finally {
      setLoading(false)
    }
  }

  const handleGenerateAPI = (table: NewTableSuggestion) => {
    setGeneratingFor(table.name)
    onGenerateClick(table.suggestedPrompt, table.name)
  }

  const handleDismiss = () => {
    setDismissed(true)
    setIsExpanded(false)
  }

  // Don't show if dismissed or no tables
  if (dismissed || (newTables.length === 0 && !loading)) {
    return null
  }

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -20 }}
        className="bg-gradient-to-br from-purple-500/10 to-blue-500/10 border border-purple-500/30 rounded-lg p-4 mb-4"
      >
        {/* Header */}
        <div className="flex items-start justify-between mb-3">
          <div className="flex items-center space-x-3 flex-1">
            <div className="w-10 h-10 rounded-lg bg-purple-500/20 flex items-center justify-center flex-shrink-0">
              <Database className="w-5 h-5 text-purple-400" />
            </div>
            <div className="flex-1 min-w-0">
              <h3 className="text-sm font-semibold text-white flex items-center space-x-2">
                <span>Data Without APIs</span>
                {loading && <Loader2 className="w-3.5 h-3.5 animate-spin text-purple-400" />}
              </h3>
              <p className="text-xs text-gray-400 mt-0.5">
                {loading ? (
                  'Checking your data...'
                ) : newTables.length === 0 ? (
                  'All data is handled ✅'
                ) : (
                  <>
                    <span className="text-purple-400 font-medium">{newTables.length}</span>
                    {' '}
                    {newTables.length === 1 ? 'item has' : 'items have'} no APIs yet
                  </>
                )}
              </p>
            </div>
          </div>

          <div className="flex items-center space-x-2">
            {/* Manual refresh button */}
            <button
              onClick={() => {
                console.log('[TableSync] Manual refresh triggered')
                checkForNewTables()
              }}
              disabled={loading}
              className="p-1.5 text-gray-400 hover:text-white hover:bg-[#181B20] rounded transition-colors disabled:opacity-50"
              title="Refresh collection list"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            </button>
            
            {newTables.length > 0 && (
              <button
                onClick={() => setIsExpanded(!isExpanded)}
                className="p-1.5 text-gray-400 hover:text-white hover:bg-[#181B20] rounded transition-colors"
              >
                {isExpanded ? (
                  <ChevronDown className="w-4 h-4" />
                ) : (
                  <ChevronRight className="w-4 h-4" />
                )}
              </button>
            )}
            <button
              onClick={handleDismiss}
              className="p-1.5 text-gray-400 hover:text-white hover:bg-[#181B20] rounded transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Expanded Table List */}
        <AnimatePresence>
          {isExpanded && newTables.length > 0 && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              className="space-y-2 overflow-hidden"
            >
              {newTables.map((table) => (
                <div
                  key={table.name}
                  className="bg-[#111418] border border-[#23262B] rounded-lg p-3 flex items-start justify-between"
                >
                  <div className="flex items-start space-x-3 flex-1 min-w-0">
                    <Database className="w-4 h-4 text-emerald-400 mt-0.5 flex-shrink-0" />
                    <div className="flex-1 min-w-0">
                      <h4 className="text-sm font-medium text-white truncate">
                        {table.name}
                      </h4>
                      {table.description && (
                        <p className="text-xs text-gray-400 mt-0.5 line-clamp-1">
                          {table.description}
                        </p>
                      )}
                      <p className="text-xs text-gray-500 mt-1">
                        Created: {new Date(table.createdAt).toLocaleDateString()}
                      </p>
                      <p className="text-xs text-purple-400 mt-2 font-medium">
                        This data has no APIs yet.
                      </p>
                      <p className="text-xs text-gray-400 mt-0.5">
                        Would you like to generate CRUD endpoints?
                      </p>
                    </div>
                  </div>

                  <div className="flex flex-col space-y-2 flex-shrink-0 ml-3">
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={() => handleGenerateAPI(table)}
                      disabled={isGenerating || generatingFor === table.name}
                      className="bg-purple-500 hover:bg-purple-600 text-white"
                    >
                      {generatingFor === table.name ? (
                        <>
                          <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                          Generating...
                        </>
                      ) : (
                        <>
                          <Database className="w-3.5 h-3.5 mr-1.5" />
                          Generate APIs
                        </>
                      )}
                    </Button>
                    
                    {onCustomizeClick && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => onCustomizeClick(table.name)}
                        disabled={isGenerating || generatingFor === table.name}
                        className="border-purple-500/30 text-purple-400 hover:bg-purple-500/10"
                      >
                        <Settings className="w-3.5 h-3.5 mr-1.5" />
                        Customize
                      </Button>
                    )}
                  </div>
                </div>
              ))}

              <div className="pt-2 border-t border-[#23262B] mt-3">
                <p className="text-xs text-gray-500 flex items-center space-x-1.5">
                  <Info className="w-3.5 h-3.5" />
                  <span>
                    <strong className="text-gray-400">Assistive, not automatic.</strong> We suggest, you decide. APIs are generated on confirmation only.
                  </span>
                </p>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Error State */}
        {error && (
          <div className="mt-3 text-xs text-red-400 flex items-center space-x-1.5">
            <X className="w-3.5 h-3.5" />
            <span>{error}</span>
          </div>
        )}
      </motion.div>
    </AnimatePresence>
  )
}
