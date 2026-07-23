'use client'

import { useRouter } from 'next/navigation'
import { Globe2 } from 'lucide-react'
import { useConnectionHealth, type ConnectionStatus } from '@/lib/hooks/useConnectionHealth'

/**
 * FrontendConnectionPill — a compact, always-visible "is my frontend talking
 * to this backend?" indicator. Used in the inspector sidebar bottom strip
 * and the Publish page runtime status bar.
 *
 * One pill, four colors, one click target:
 *   violet → connected, no failures     ("Frontend · lovable.app")
 *   amber  → connected but some failures ("Frontend · degraded")
 *   rose   → only failures              ("Frontend · failing")
 *   gray   → no frontend has connected yet ("No frontend yet")
 *
 * Clicking jumps to Connect → Direct, where the full Activity card
 * (connection health + copy-paste fix prompts) and origin allowlist live.
 *
 * Variants:
 *   - 'compact'  : sidebar pill — 9.5px text, no origin in label, dot only
 *   - 'badge'    : full row — full origin name + count tooltip
 */

interface FrontendConnectionPillProps {
  projectId: string
  variant?: 'compact' | 'badge'
  className?: string
}

const STATUS_STYLES: Record<ConnectionStatus, {
  dotClass: string
  ringClass: string
  labelClass: string
  label: (origin: string | null) => string
}> = {
  loading: {
    dotClass: 'bg-zinc-500',
    ringClass: '',
    labelClass: 'text-zinc-500',
    label: () => 'Checking frontend…',
  },
  idle: {
    dotClass: 'bg-white/25',
    ringClass: '',
    labelClass: 'text-zinc-500',
    label: () => 'No frontend yet',
  },
  connected: {
    dotClass: 'bg-violet-400',
    ringClass: '',
    labelClass: 'text-violet-300/85',
    label: (origin) => origin ? `Frontend · ${origin}` : 'Frontend connected',
  },
  degraded: {
    dotClass: 'bg-amber-400',
    ringClass: '',
    labelClass: 'text-amber-500/85',
    label: (origin) => origin ? `Frontend · ${origin} (issues)` : 'Frontend degraded',
  },
  failing: {
    dotClass: 'bg-rose-400',
    ringClass: '',
    labelClass: 'text-rose-300/85',
    label: (origin) => origin ? `Frontend · ${origin} failing` : 'Frontend failing',
  },
}

export function FrontendConnectionPill({
  projectId,
  variant = 'compact',
  className = '',
}: FrontendConnectionPillProps) {
  const router = useRouter()
  const { status, primaryOrigin, health } = useConnectionHealth(projectId)
  const style = STATUS_STYLES[status]

  // Truncate long preview-deploy origins so the pill stays single-line.
  // id-preview--92c0acc1-….lovable.app → id-preview--….lovable.app
  const displayOrigin = (() => {
    if (!primaryOrigin) return null
    if (primaryOrigin.length <= 32) return primaryOrigin
    const parts = primaryOrigin.split('.')
    if (parts.length < 2) return primaryOrigin.slice(0, 28) + '…'
    const tail = parts.slice(-2).join('.')
    return `…${tail}`
  })()

  const tooltip = (() => {
    if (status === 'idle') return 'No frontend has connected to this backend yet. Your agent wires the SDK; coordinates live on the Connect page.'
    if (status === 'connected') return `${health?.totals.bootstraps24h ?? 0} requests in last 24h from ${health?.totals.distinctOriginsConnected ?? 0} origin(s).`
    if (status === 'degraded') return `${health?.totals.failures24h ?? 0} requests failing. Click for fix prompts.`
    if (status === 'failing') return `${health?.totals.failures24h ?? 0} requests failing with a wrong API key. Click for a one-click fix.`
    return ''
  })()

  const goToSdk = () => router.push(`/app/projects/${projectId}/connect?tab=direct`)

  if (variant === 'badge') {
    return (
      <button
        onClick={goToSdk}
        title={tooltip}
        className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[10.5px] font-medium transition-all cursor-pointer hover:opacity-90 ${
          status === 'connected'
            ? 'bg-violet-500/[0.08] border-violet-500/25'
            : status === 'degraded'
            ? 'bg-amber-500/[0.08] border-amber-500/25'
            : status === 'failing'
            ? 'bg-rose-500/[0.08] border-rose-500/25'
            : 'bg-white/[0.03] border-white/[0.08]'
        } ${className}`}
      >
        <span className="relative flex h-1.5 w-1.5 flex-shrink-0">
          {style.ringClass && <span className={style.ringClass} />}
          <span className={`relative inline-flex rounded-full h-1.5 w-1.5 ${style.dotClass}`} />
        </span>
        <Globe2 className={`w-3 h-3 ${style.labelClass}`} />
        <span className={style.labelClass}>{style.label(displayOrigin)}</span>
      </button>
    )
  }

  // Compact (sidebar) variant — minimal real-estate, dot + short label.
  return (
    <button
      onClick={goToSdk}
      title={tooltip}
      className={`flex items-center gap-2 w-full transition-opacity hover:opacity-80 cursor-pointer ${className}`}
    >
      <span className="relative flex h-1.5 w-1.5 flex-shrink-0">
        {style.ringClass && <span className={style.ringClass} />}
        <span className={`relative inline-flex rounded-full h-1.5 w-1.5 ${style.dotClass}`} />
      </span>
      <span className={`text-[9.5px] leading-tight truncate ${style.labelClass}`}>
        {style.label(displayOrigin)}
      </span>
    </button>
  )
}
