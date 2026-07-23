'use client'

import { useState, useRef, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Send, Loader2 } from 'lucide-react'

/**
 * ELITE BOTTOM COMMAND BAR
 * 
 * Matches professional agent consoles:
 * - Replit, Cursor, Linear AI, Vercel AI
 * 
 * Features:
 * - Fixed bottom position
 * - Auto-expanding textarea
 * - Enter to submit, Shift+Enter for newline
 * - Character counter
 * - Loading states
 * - Professional density
 */

interface CommandBarProps {
  prompt: string
  setPrompt: (value: string) => void
  onSubmit: () => void
  submitting: boolean
  buildState: 'idle' | 'building' | 'complete'
  placeholder?: string
  disabled?: boolean
}

export function CommandBar({
  prompt,
  setPrompt,
  onSubmit,
  submitting,
  buildState,
  placeholder = 'Type what to build...',
  disabled = false,
}: CommandBarProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [isFocused, setIsFocused] = useState(false)

  // Auto-resize textarea
  useEffect(() => {
    const textarea = textareaRef.current
    if (textarea) {
      textarea.style.height = 'auto'
      textarea.style.height = Math.min(textarea.scrollHeight, 200) + 'px'
    }
  }, [prompt])

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      if (prompt.trim() && !submitting && buildState !== 'building') {
        onSubmit()
      }
    }
  }

  const handleSubmit = () => {
    if (prompt.trim() && !submitting && buildState !== 'building') {
      onSubmit()
    }
  }

  const isDisabled = disabled || submitting || buildState === 'building'
  const charCount = prompt.length
  const showCharCount = charCount > 0

  return (
    <div className="fixed bottom-0 left-0 right-0 z-30 bg-[#0a0a0a] border-t border-slate-800">
      <div className="max-w-[1200px] mx-auto px-6 py-4">
        <div
          className={`
            bg-slate-900/60 border rounded-xl transition-all duration-200
            ${isFocused ? 'border-purple-500/50 shadow-lg shadow-purple-500/10' : 'border-slate-700'}
          `}
        >
          <div className="flex items-end gap-3 p-3">
            {/* Textarea */}
            <div className="flex-1 relative">
              <textarea
                ref={textareaRef}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={handleKeyDown}
                onFocus={() => setIsFocused(true)}
                onBlur={() => setIsFocused(false)}
                placeholder={placeholder}
                disabled={isDisabled}
                rows={1}
                className="
                  w-full resize-none bg-transparent text-white placeholder-slate-500
                  text-[15px] leading-relaxed outline-none
                  disabled:opacity-50 disabled:cursor-not-allowed
                  max-h-[200px] overflow-y-auto
                "
                style={{ minHeight: '24px' }}
              />
              
              {/* Character counter */}
              <AnimatePresence>
                {showCharCount && (
                  <motion.div
                    initial={{ opacity: 0, y: 5 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: 5 }}
                    className="absolute -bottom-5 right-0 text-[10px] text-slate-500 tabular-nums"
                  >
                    {charCount}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            {/* Submit button */}
            <button
              onClick={handleSubmit}
              disabled={isDisabled || !prompt.trim()}
              className="
                flex-shrink-0 w-9 h-9 rounded-lg
                bg-purple-600 hover:bg-purple-700 active:bg-purple-800
                disabled:bg-slate-800 disabled:cursor-not-allowed
                flex items-center justify-center
                transition-colors
              "
            >
              {buildState === 'building' ? (
                <Loader2 className="w-4 h-4 text-white animate-spin" />
              ) : (
                <Send className="w-4 h-4 text-white" />
              )}
            </button>
          </div>

          {/* Building indicator */}
          <AnimatePresence>
            {buildState === 'building' && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                className="px-3 pb-3"
              >
                <div className="flex items-center gap-2 text-xs text-purple-400">
                  <span>Building your backend...</span>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Hint text */}
        <div className="mt-2 text-center">
          <p className="text-[11px] text-slate-500">
            <span className="font-semibold">Enter</span> to submit • <span className="font-semibold">Shift + Enter</span> for new line
          </p>
        </div>
      </div>
    </div>
  )
}
