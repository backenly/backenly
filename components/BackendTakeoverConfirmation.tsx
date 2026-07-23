'use client'

/**
 * PHASE 4 — BACKEND TAKEOVER CONFIRMATION
 * 
 * ONE clear, human decision.
 * NO checkboxes. NO granular permissions. NO partial takeover.
 * 
 * Language implies: safety, reversibility, no risk
 * "You can undo this anytime."
 */

import { motion } from 'framer-motion'
import { Check, Shield, ArrowLeft } from 'lucide-react'
import { useState } from 'react'
import type { AppDiscovery } from '@/lib/services/intent-reconstruction'

interface BackendTakeoverProps {
  discovery: AppDiscovery
  onConfirm: () => Promise<void>
  onCancel: () => void
}

export function BackendTakeoverConfirmation({
  discovery,
  onConfirm,
  onCancel,
}: BackendTakeoverProps) {
  const [confirming, setConfirming] = useState(false)

  const handleConfirm = async () => {
    setConfirming(true)
    try {
      await onConfirm()
    } catch (error) {
      console.error('Takeover failed:', error)
      // Error will be handled by parent component
    } finally {
      setConfirming(false)
    }
  }

  return (
    <div className="min-h-screen bg-[#F9FAFB] flex items-center justify-center px-6 py-12">
      <div className="w-full max-w-2xl">
        {/* Back Button */}
        <button
          onClick={onCancel}
          disabled={confirming}
          className="flex items-center space-x-2 text-sm text-[#6B7280] hover:text-[#111827] mb-8 transition-colors disabled:opacity-50"
        >
          <ArrowLeft className="w-4 h-4" />
          <span>Back</span>
        </button>

        {/* Discovery Summary */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-8"
        >
          <div className="flex items-start space-x-4 mb-6">
            <div className="w-14 h-14 rounded-xl bg-[#EFF6FF] flex items-center justify-center flex-shrink-0">
              <Shield className="w-7 h-7 text-[#2563EB]" />
            </div>
            <div>
              <h1 className="text-3xl font-semibold text-[#111827] mb-2">
                We found your app
              </h1>
              <p className="text-lg text-[#6B7280]">
                {discovery.summary}
              </p>
            </div>
          </div>
        </motion.div>

        {/* What Backenly Will Manage */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
          className="bg-white border border-[#E5E7EB] rounded-2xl p-8 mb-6"
        >
          <h2 className="text-lg font-semibold text-[#111827] mb-6">
            Backenly will handle:
          </h2>

          <div className="space-y-4">
            {/* Users & Sign-in */}
            <div className="flex items-start space-x-3">
              <div className="w-6 h-6 rounded-full bg-[#EFF6FF] flex items-center justify-center flex-shrink-0 mt-0.5">
                <Check className="w-4 h-4 text-[#2563EB]" />
              </div>
              <div>
                <p className="text-base font-medium text-[#111827]">Users & sign-in</p>
                <p className="text-sm text-[#6B7280] mt-1">
                  Secure authentication and user management
                </p>
              </div>
            </div>

            {/* Data Storage */}
            <div className="flex items-start space-x-3">
              <div className="w-6 h-6 rounded-full bg-[#EFF6FF] flex items-center justify-center flex-shrink-0 mt-0.5">
                <Check className="w-4 h-4 text-[#2563EB]" />
              </div>
              <div>
                <p className="text-base font-medium text-[#111827]">Data storage</p>
                <p className="text-sm text-[#6B7280] mt-1">
                  All your app data, safely stored and backed up
                </p>
              </div>
            </div>

            {/* File Uploads */}
            {discovery.capabilities.some((c) => c.toLowerCase().includes('upload')) && (
              <div className="flex items-start space-x-3">
                <div className="w-6 h-6 rounded-full bg-[#EFF6FF] flex items-center justify-center flex-shrink-0 mt-0.5">
                  <Check className="w-4 h-4 text-[#2563EB]" />
                </div>
                <div>
                  <p className="text-base font-medium text-[#111827]">File uploads</p>
                  <p className="text-sm text-[#6B7280] mt-1">
                    Handle files securely with automatic storage
                  </p>
                </div>
              </div>
            )}

            {/* App Logic */}
            <div className="flex items-start space-x-3">
              <div className="w-6 h-6 rounded-full bg-[#EFF6FF] flex items-center justify-center flex-shrink-0 mt-0.5">
                <Check className="w-4 h-4 text-[#2563EB]" />
              </div>
              <div>
                <p className="text-base font-medium text-[#111827]">App logic</p>
                <p className="text-sm text-[#6B7280] mt-1">
                  Everything your app needs to work, automatically
                </p>
              </div>
            </div>
          </div>
        </motion.div>

        {/* Safety & Reversibility Banner */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2 }}
          className="bg-[#F0FDF4] border border-[#BBF7D0] rounded-xl p-4 mb-8"
        >
          <p className="text-sm text-[#166534] text-center">
            <strong>Safe to try.</strong> You can undo this anytime, and your app keeps working.
          </p>
        </motion.div>

        {/* Primary CTA */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.3 }}
          className="flex items-center space-x-4"
        >
          <button
            onClick={onCancel}
            disabled={confirming}
            className="flex-1 px-8 py-4 bg-white border-2 border-[#E5E7EB] hover:border-[#D1D5DB] text-[#374151] font-semibold rounded-xl transition-all disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Maybe later
          </button>
          <button
            onClick={handleConfirm}
            disabled={confirming}
            className="flex-1 px-8 py-4 bg-gradient-to-r from-[#2563EB] to-[#1D4ED8] hover:from-[#1D4ED8] hover:to-[#1E40AF] text-white font-semibold rounded-xl transition-all hover:scale-[1.02] disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:scale-100"
          >
            {confirming ? (
              <div className="flex items-center justify-center space-x-2">
                <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                <span>Connecting...</span>
              </div>
            ) : (
              'Let Backenly handle the backend'
            )}
          </button>
        </motion.div>

        {/* Footer Note */}
        <motion.p
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.4 }}
          className="text-center text-sm text-[#9CA3AF] mt-6"
        >
          Your frontend stays exactly the same. Nothing breaks.
        </motion.p>
      </div>
    </div>
  )
}
