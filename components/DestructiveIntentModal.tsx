'use client'

import { motion, AnimatePresence } from 'framer-motion'
import { AlertTriangle, X } from 'lucide-react'
import type { IntentClassification } from '@/lib/safety/intent-classifier'

interface DestructiveIntentModalProps {
  isOpen: boolean
  onClose: () => void
  onConfirm: () => void
  classification: IntentClassification | null
  intent: string
}

export function DestructiveIntentModal({
  isOpen,
  onClose,
  onConfirm,
  classification,
  intent,
}: DestructiveIntentModalProps) {
  if (!classification) return null

  const isDestructive = classification.riskLevel === 'destructive'

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center px-6"
          />

          {/* Modal */}
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 20 }}
            transition={{ type: 'spring', damping: 25, stiffness: 300 }}
            className="fixed inset-0 z-50 flex items-center justify-center px-6 pointer-events-none"
          >
            <div className={`bg-white rounded-2xl shadow-2xl max-w-lg w-full pointer-events-auto ${
              isDestructive ? 'border-2 border-[#EF4444]' : 'border-2 border-[#F59E0B]'
            }`}>
              {/* Header with Warning */}
              <div className={`flex items-start space-x-4 p-8 pb-6 ${
                isDestructive ? 'border-b border-[#FEE2E2]' : 'border-b border-[#FEF3C7]'
              }`}>
                <div className={`w-12 h-12 rounded-full flex items-center justify-center flex-shrink-0 ${
                  isDestructive ? 'bg-[#FEE2E2]' : 'bg-[#FEF3C7]'
                }`}>
                  <AlertTriangle className={`w-6 h-6 ${
                    isDestructive ? 'text-[#EF4444]' : 'text-[#F59E0B]'
                  }`} />
                </div>
                <div className="flex-1">
                  <h2 className="text-xl font-semibold text-[#111827] mb-2">
                    {isDestructive ? 'This is a destructive action' : 'This might cause issues'}
                  </h2>
                  <p className="text-sm text-[#6B7280] leading-relaxed">
                    {classification.consequence}
                  </p>
                </div>
                <button
                  onClick={onClose}
                  className="p-2 hover:bg-[#F3F4F6] rounded-lg transition-colors"
                >
                  <X className="w-5 h-5 text-[#6B7280]" />
                </button>
              </div>

              {/* Warning Content */}
              <div className="p-8 space-y-4">
                <div className={`rounded-xl p-4 ${
                  isDestructive ? 'bg-[#FEE2E2] border border-[#FCA5A5]' : 'bg-[#FEF3C7] border border-[#FDE68A]'
                }`}>
                  <p className={`text-sm font-medium mb-2 ${
                    isDestructive ? 'text-[#991B1B]' : 'text-[#92400E]'
                  }`}>
                    You said: "{intent}"
                  </p>
                  <p className={`text-sm leading-relaxed ${
                    isDestructive ? 'text-[#7F1D1D]' : 'text-[#78350F]'
                  }`}>
                    {isDestructive
                      ? 'This cannot be undone automatically. Make sure you understand what will happen.'
                      : 'You can undo this later if something breaks.'}
                  </p>
                </div>

                {isDestructive && (
                  <p className="text-xs text-[#9CA3AF] leading-relaxed">
                    If you're not sure what this means, it's safer to cancel and ask for help.
                  </p>
                )}
              </div>

              {/* Actions */}
              <div className="flex items-center justify-end space-x-3 px-8 py-6 bg-[#F9FAFB] rounded-b-2xl border-t border-[#E5E7EB]">
                <button
                  onClick={onClose}
                  className="px-6 py-2.5 text-sm font-medium text-[#374151] hover:bg-white border border-[#E5E7EB] rounded-lg transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={() => {
                    onConfirm()
                    onClose()
                  }}
                  className={`px-6 py-2.5 text-white text-sm font-semibold rounded-lg transition-colors ${
                    isDestructive
                      ? 'bg-[#EF4444] hover:bg-[#DC2626]'
                      : 'bg-[#F59E0B] hover:bg-[#D97706]'
                  }`}
                >
                  {isDestructive ? 'I understand, do it anyway' : 'I understand, proceed'}
                </button>
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  )
}
