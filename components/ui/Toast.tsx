'use client'

import { motion, AnimatePresence } from 'framer-motion'
import { CheckCircle, XCircle, Info, AlertTriangle } from 'lucide-react'

interface ToastProps {
  message: string
  type?: 'success' | 'error' | 'info' | 'warning'
  isVisible: boolean
  onClose: () => void
}

export function Toast({ message, type = 'info', isVisible, onClose }: ToastProps) {
  const icons = {
    success: CheckCircle,
    error: XCircle,
    info: Info,
    warning: AlertTriangle,
  }

  const colors = {
    success: 'bg-green-500/20 text-green-400 border-green-500/30',
    error: 'bg-red-500/20 text-red-400 border-red-500/30',
    info: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
    warning: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30',
  }

  const Icon = icons[type]

  return (
    <AnimatePresence>
      {isVisible && (
        <motion.div
          initial={{ opacity: 0, y: -20, x: '-50%' }}
          animate={{ opacity: 1, y: 0, x: '-50%' }}
          exit={{ opacity: 0, y: -20, x: '-50%' }}
          className="fixed top-4 left-1/2 z-50"
        >
          <div className={`${colors[type]} border rounded-lg px-4 py-3 flex items-center space-x-2 shadow-xl`}>
            <Icon className="w-5 h-5" />
            <span className="text-sm font-medium">{message}</span>
            <button
              onClick={onClose}
              className="ml-4 text-current opacity-70 hover:opacity-100"
            >
              ×
            </button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

