'use client'

import Link from 'next/link'
import { Globe2 } from 'lucide-react'
import { useConnectionHealth, type ConnectionStatus } from '@/lib/hooks/useConnectionHealth'

/**
 * FrontendConnectionPill — a compact, always-visible "is my frontend talking
 * to this backend?" indicator. Used in the inspector sidebar bottom strip
 * and the Publish page runtime status bar.
 *
 * One indicator, four states, one link:
 *   emerald → connected, no failures      ("lovable.app")
 *   amber   → connected but some failures ("lovable.app, with errors")
 *   rose    → only failures               ("lovable.app, failing")
 *   gray    → no frontend has connected   ("No frontend yet")
 *
 * Clicking jumps to Connect → Direct, where the full Activity card
 * (connection health + copy-paste fix prompts) and origin allowlist live.
 *
 * Variants:
 *   - 'compact'  : the sidebar footer row, the height of a nav item
 *   - 'badge'    : an inline chip with the origin and a count tooltip
 */

interface FrontendConnectionPillProps {
  projectId: string
  variant?: 'compact' | 'badge'
  className?: string
}

const STATUS_STYLES: Record<ConnectionStatus, {
  dotClass: string
  labelClass: string
  label: (origin: string | null) => string
}> = {
  loading: {
    dotClass: 'bg-zinc-600',
    labelClass: 'text-zinc-500',
    label: () => 'Checking frontend…',
  },
  idle: {
    dotClass: 'bg-zinc-600',
    labelClass: 'text-zinc-500',
    label: () => 'No frontend yet',
  },
  connected: {
    dotClass: 'bg-emerald-400',
    labelClass: 'text-zinc-300',
    label: (origin) => origin ?? 'Frontend connected',
  },
  degraded: {
    dotClass: 'bg-amber-400',
    labelClass: 'text-amber-200',
    label: (origin) => origin ? `${origin}, with errors` : 'Frontend degraded',
  },
  failing: {
    dotClass: 'bg-rose-400',
    labelClass: 'text-rose-300',
    label: (origin) => origin ? `${origin}, failing` : 'Frontend failing',
  },
}

export function FrontendConnectionPill({
  projectId,
  variant = 'compact',
  className = '',
}: FrontendConnectionPillProps) {
  const { status, primaryOrigin, health } = useConnectionHealth(projectId)
  const style = STATUS_STYLES[status]

  // Truncate long preview-deploy origins so the label stays single-line.
  // id-preview--92c0acc1-….lovable.app → …lovable.app
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
    if (status === 'connected') return `${health?.totals.bootstraps24h ?? 0} requests in the last 24h from ${health?.totals.distinctOriginsConnected ?? 0} origin(s).`
    if (status === 'degraded') return `${health?.totals.failures24h ?? 0} requests failing. Open for fix prompts.`
    if (status === 'failing') return `${health?.totals.failures24h ?? 0} requests failing with a wrong API key. Open for a one-click fix.`
    return ''
  })()

  const href = `/app/projects/${projectId}/connect?tab=direct`

  if (variant === 'badge') {
    return (
      <Link
        href={href}
        title={tooltip}
        className={`inline-flex h-[26px] items-center gap-2 rounded-[7px] border border-white/[0.08] bg-white/[0.03] px-2.5 text-[12px] font-medium transition-colors hover:border-white/[0.14] hover:bg-white/[0.05] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-300/60 ${className}`}
      >
        <span className={`h-[6px] w-[6px] flex-shrink-0 rounded-full ${style.dotClass}`} aria-hidden />
        <Globe2 className="h-3.5 w-3.5 text-zinc-500" strokeWidth={1.75} aria-hidden />
        <span className={style.labelClass}>{style.label(displayOrigin)}</span>
      </Link>
    )
  }

  // Compact (sidebar footer): one row, the same height as a nav item.
  return (
    <Link
      href={href}
      title={tooltip}
      className={`group flex h-[36px] w-full items-center gap-2.5 rounded-[7px] border border-white/[0.06] px-2.5 transition-colors hover:border-white/[0.12] hover:bg-white/[0.03] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-300/60 ${className}`}
    >
      <Globe2 className="h-4 w-4 flex-shrink-0 text-zinc-500 group-hover:text-zinc-300" strokeWidth={1.75} aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="block text-[11px] leading-[13px] text-zinc-600">Frontend</span>
        <span className={`block truncate text-[12px] leading-[16px] ${style.labelClass}`}>{style.label(displayOrigin)}</span>
      </span>
      <span className={`h-[6px] w-[6px] flex-shrink-0 rounded-full ${style.dotClass}`} aria-hidden />
    </Link>
  )
}
