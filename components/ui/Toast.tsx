'use client'

/**
 * Toast: a transient confirmation. Raised surface, coloured icon, neutral
 * text, announced politely to assistive technology.
 *
 * Success and info toasts dismiss themselves after a few seconds; warnings and
 * errors stay until closed, because a message someone has to act on should not
 * vanish while they are reading it.
 */

import { useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { CheckCircle2, XCircle, Info, AlertTriangle, X } from 'lucide-react'

interface ToastProps {
  message: string
  type?: 'success' | 'error' | 'info' | 'warning'
  isVisible: boolean
  onClose: () => void
}

const ICONS = {
  success: CheckCircle2,
  error: XCircle,
  info: Info,
  warning: AlertTriangle,
}

const ICON_TONE = {
  success: 'text-emerald-400',
  error: 'text-rose-400',
  info: 'text-zinc-400',
  warning: 'text-amber-400',
}

export function Toast({ message, type = 'info', isVisible, onClose }: ToastProps) {
  const Icon = ICONS[type]
  const transient = type === 'success' || type === 'info'

  useEffect(() => {
    if (!isVisible || !transient) return
    const t = setTimeout(onClose, 4200)
    return () => clearTimeout(t)
    // Keyed on the message too, so a second toast restarts the clock.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isVisible, transient, message])

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-5 z-[90] flex justify-center px-4">
      <AnimatePresence>
        {isVisible && (
          <motion.div
            initial={{ opacity: 0, y: 12, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.98 }}
            transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
            role={type === 'error' || type === 'warning' ? 'alert' : 'status'}
            aria-live={type === 'error' || type === 'warning' ? 'assertive' : 'polite'}
            className="pointer-events-auto flex max-w-[520px] items-center gap-3 rounded-[10px] bg-[#141518] py-2.5 pl-3.5 pr-2 shadow-[0_0_0_1px_rgba(255,255,255,0.09),0_2px_8px_-2px_rgba(0,0,0,0.5),0_24px_64px_-16px_rgba(0,0,0,0.8),inset_0_1px_0_rgba(255,255,255,0.05)]"
          >
            <Icon className={`h-4 w-4 flex-shrink-0 ${ICON_TONE[type]}`} strokeWidth={2} />
            <span className="min-w-0 flex-1 text-[13px] leading-[20px] text-zinc-100">{message}</span>
            <button
              type="button"
              onClick={onClose}
              aria-label="Dismiss"
              className="flex h-[26px] w-[26px] flex-shrink-0 items-center justify-center rounded-[6px] text-zinc-500 transition-colors hover:bg-white/[0.06] hover:text-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-300/60"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
