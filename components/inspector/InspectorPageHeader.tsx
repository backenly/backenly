'use client'

/**
 * The page hero for DOCUMENT surfaces.
 *
 * When to use this vs. a command bar (settled 2026-07-29, after Tables dropped
 * this header and became the only section without it):
 *
 *   Document surface — scrolls the window, read top to bottom, orientation
 *   matters more than density. Settings, Connect, Integrations, Deploy,
 *   Autonomy, Branches. USE THIS HEADER.
 *
 *   Instrument surface — owns the viewport, scrolls internally, the data IS
 *   the page and every pixel of height is working area. Tables, Storage, and
 *   (in progress) Functions, Realtime, Monitoring, Auth's Users tab. USE A
 *   COMMAND BAR: one ~44px row carrying identity (section · name · state ·
 *   count) next to the view switch, then a full-height workbench below it.
 *   See app/app/projects/[id]/database/page.tsx and
 *   components/storage/StorageWorkbench.tsx.
 *
 * The 22px title and description earn their space wherever the reader needs
 * orienting, and stop earning it the moment the page becomes a browser over
 * its own data. Classify by what the surface IS, not by which list it is on
 * today: a page that gained a grid has become an instrument.
 */

import { Lock } from 'lucide-react'

interface BadgeProps {
  label: string
  variant: 'managed' | 'live' | 'governed' | 'beta'
}

interface InspectorPageHeaderProps {
  icon: React.ComponentType<{ className?: string }>
  title: string
  description: string
  badge?: BadgeProps
  actions?: React.ReactNode
  /** Optional: key metric shown inline next to title (e.g. "13 tables") */
  stat?: string
}

// Status renders as telemetry — dot + mono text — matching the workspace
// home command bar. live = healthy (emerald), managed/governed = system-owned
// (neutral), beta = brand-flagged (violet, the only decorative violet allowed).
const BADGE_STYLES: Record<BadgeProps['variant'], { dot: string; text: string }> = {
  managed:  { dot: 'bg-zinc-500',    text: 'text-zinc-400'       },
  live:     { dot: 'bg-emerald-400', text: 'text-emerald-300/90' },
  governed: { dot: 'bg-zinc-500',    text: 'text-zinc-400'       },
  beta:     { dot: 'bg-violet-300',  text: 'text-violet-300'     },
}

export function InspectorPageHeader({
  icon: Icon,
  title,
  description,
  badge,
  actions,
  stat,
}: InspectorPageHeaderProps) {
  return (
    <div className="bg-[#101116] px-8 pb-1 pt-5">
      <div className="flex items-end justify-between gap-5 border-b border-white/[0.06] pb-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2.5 text-[11px]">
            <span className="inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-600">
              <Icon className="h-3 w-3" />
              Inspector
            </span>
            {(badge || stat) && <span className="h-3 w-px bg-white/10" />}
            {badge && (
              <span className={`inline-flex items-center gap-1.5 font-mono text-[10.5px] font-medium ${BADGE_STYLES[badge.variant].text}`}>
                <span className={`h-[5px] w-[5px] rounded-full ${BADGE_STYLES[badge.variant].dot}`} />
                {badge.label}
              </span>
            )}
            {stat && (
              <span className="font-mono text-[10.5px] text-zinc-500 tabular-nums">{stat}</span>
            )}
          </div>
          <h1 className="mt-1.5 truncate text-[22px] font-semibold leading-tight tracking-[-0.01em] text-white">
            {title}
          </h1>
          <p className="mt-1 max-w-3xl text-[12.5px] leading-5 text-zinc-500">
            {description}
          </p>
        </div>

        {actions && (
          <div className="flex flex-shrink-0 items-center gap-2 pb-0.5">
            {actions}
          </div>
        )}
      </div>
    </div>
  )
}

/** Reusable section heading used within page content */
export function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-600 mb-3">
      {children}
    </p>
  )
}

/** Standard page wrapper for inspector content areas */
export function InspectorPageContent({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`min-h-screen bg-[#101116] ${className}`}>
      {children}
    </div>
  )
}

/** Bottom governance footer used on pages that need it */
export function InspectorGovernanceFooter() {
  return (
    <div className="flex items-center gap-1.5 px-1 pt-8 pb-2">
      <Lock className="w-3 h-3 text-zinc-700" />
      <span className="text-[11px] text-zinc-600">
        Every mutation is locked, snapshotted, and audited
      </span>
    </div>
  )
}
