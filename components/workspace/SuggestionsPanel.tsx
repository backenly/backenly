'use client'

import { motion } from 'framer-motion'
import { Lightbulb, TestTube, Shield, Link as LinkIcon, Upload, Database, CheckCircle2 } from 'lucide-react'

interface SuggestionsPanelProps {
  suggestions: string[]
  onSuggestionClick: (suggestion: string) => void
}

export function SuggestionsPanel({ suggestions, onSuggestionClick }: SuggestionsPanelProps) {
  if (suggestions.length === 0) return null

  const getSuggestionContent = (suggestion: string) => {
    switch (suggestion) {
      case 'test-api':
        return {
          icon: <TestTube className="w-5 h-5 text-blue-400" />,
          title: 'Test Your APIs',
          description: 'Try out your endpoints to see how they work',
          color: 'blue',
          action: 'Test Endpoint',
        }
      case 'configure-auth':
        return {
          icon: <Shield className="w-5 h-5 text-purple-400" />,
          title: 'Configure Authentication',
          description: 'Set up auth providers and session settings',
          color: 'purple',
          action: 'Configure',
        }
      case 'connect-frontend':
        return {
          icon: <LinkIcon className="w-5 h-5 text-green-400" />,
          title: 'Connect Your Frontend',
          description: 'Link your app to start using the API',
          color: 'green',
          action: 'Connect',
        }
      case 'test-storage':
        return {
          icon: <Upload className="w-5 h-5 text-yellow-400" />,
          title: 'Test Storage',
          description: 'Upload a test file to verify storage works',
          color: 'yellow',
          action: 'Upload File',
        }
      case 'insert-test-data':
        return {
          icon: <Database className="w-5 h-5 text-cyan-400" />,
          title: 'Add Test Data',
          description: 'Insert sample rows to test your tables',
          color: 'cyan',
          action: 'Insert Row',
        }
      case 'verify-connection':
        return {
          icon: <CheckCircle2 className="w-5 h-5 text-emerald-400" />,
          title: 'Verify Connection',
          description: 'Run tests to confirm frontend can communicate',
          color: 'emerald',
          action: 'Verify',
        }
      default:
        return null
    }
  }

  const getColorClasses = (color: string) => {
    switch (color) {
      case 'blue':
        return 'bg-blue-500/10 border-blue-500/20 hover:border-blue-500/40'
      case 'purple':
        return 'bg-purple-500/10 border-purple-500/20 hover:border-purple-500/40'
      case 'green':
        return 'bg-green-500/10 border-green-500/20 hover:border-green-500/40'
      case 'yellow':
        return 'bg-yellow-500/10 border-yellow-500/20 hover:border-yellow-500/40'
      case 'cyan':
        return 'bg-cyan-500/10 border-cyan-500/20 hover:border-cyan-500/40'
      case 'emerald':
        return 'bg-emerald-500/10 border-emerald-500/20 hover:border-emerald-500/40'
      default:
        return 'bg-white/5 border-white/10 hover:border-white/20'
    }
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className="bg-[#151B2E]/60 backdrop-blur-xl border border-white/5 rounded-xl p-6"
    >
      <div className="flex items-center space-x-3 mb-4">
        <div className="w-10 h-10 rounded-xl bg-amber-500/20 flex items-center justify-center">
          <Lightbulb className="w-5 h-5 text-amber-500" />
        </div>
        <div>
          <h3 className="text-lg font-semibold text-[#E6E8EF]">
            Suggested Next Steps
          </h3>
          <p className="text-sm text-[#9AA3B2]">
            Recommended actions based on your progress
          </p>
        </div>
      </div>

      <div className="space-y-3">
        {suggestions.map((suggestion, index) => {
          const content = getSuggestionContent(suggestion)
          if (!content) return null

          return (
            <motion.button
              key={suggestion}
              initial={{ opacity: 0, x: -20 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: index * 0.1 }}
              onClick={() => onSuggestionClick(suggestion)}
              className={`w-full p-4 rounded-lg border transition-all text-left ${getColorClasses(
                content.color
              )}`}
            >
              <div className="flex items-start space-x-3">
                <div className="flex-shrink-0 mt-0.5">{content.icon}</div>
                <div className="flex-1 min-w-0">
                  <h4 className="text-sm font-semibold text-[#E6E8EF] mb-1">
                    {content.title}
                  </h4>
                  <p className="text-xs text-[#9AA3B2] mb-2">
                    {content.description}
                  </p>
                  <div className="flex items-center space-x-1 text-xs font-medium text-[#E6E8EF]">
                    <span>→</span>
                    <span>{content.action}</span>
                  </div>
                </div>
              </div>
            </motion.button>
          )
        })}
      </div>
    </motion.div>
  )
}
