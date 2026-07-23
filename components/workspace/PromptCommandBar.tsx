'use client'

import { useState, useEffect } from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/Button'

interface PromptCommandBarProps {
  onPreview: (prompt: string) => Promise<void>
  isLoading?: boolean
  initialPrompt?: string // Add support for pre-filled prompt
}

export function PromptCommandBar({ onPreview, isLoading = false, initialPrompt = '' }: PromptCommandBarProps) {
  const [prompt, setPrompt] = useState(initialPrompt)

  // Update prompt when initialPrompt changes (e.g., from URL parameter)
  useEffect(() => {
    if (initialPrompt) {
      setPrompt(initialPrompt)
    }
  }, [initialPrompt])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!prompt.trim() || isLoading) return
    
    await onPreview(prompt.trim())
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Submit on Cmd/Ctrl + Enter
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      handleSubmit(e as any)
    }
  }

  return (
    <div className="py-3 px-4">
      <form onSubmit={handleSubmit} className="max-w-4xl mx-auto">
        {/* Floating Command Center with Purple Glow */}
        <div className="relative">
          {/* Purple glow effect */}
          <div className="absolute -inset-1 bg-gradient-to-r from-purple-600/20 via-pink-500/20 to-indigo-600/20 rounded-xl blur-lg opacity-75"></div>
            
          {/* Main command bar */}
          <div className="relative flex items-center gap-3 bg-[#0B0D10] border border-gray-800 rounded-xl p-3 shadow-2xl">
            <div className="flex items-center gap-2 text-purple-400 flex-shrink-0">
              <span className="text-sm font-semibold hidden sm:inline">AI Builder</span>
            </div>
              
            <div className="flex-1 relative">
              <input
                type="text"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Describe the change you want in your backend..."
                disabled={isLoading}
                className="w-full px-4 py-2.5 bg-[#1A1D24] border border-gray-700 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-purple-500/50 focus:border-purple-500 disabled:opacity-50 disabled:cursor-not-allowed transition-all text-sm"
              />
            </div>
              
            {/* Keyboard shortcut badge */}
            <div className="hidden lg:flex items-center gap-1.5 px-2.5 py-1 bg-[#1A1D24] border border-gray-700 rounded text-xs text-gray-400 font-mono">
              <span className="text-gray-500">⌘</span>
              <span>K</span>
            </div>
      
            <Button
              type="submit"
              disabled={!prompt.trim() || isLoading}
              className="px-5 py-2.5 bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2 shadow-lg hover:shadow-purple-500/50 transition-all text-sm font-medium"
            >
              {isLoading ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span className="hidden sm:inline">Processing</span>
                </>
              ) : (
                <>
                  <span className="hidden sm:inline">Preview</span>
                </>
              )}
            </Button>
          </div>
        </div>
      </form>
    </div>
  )
}
