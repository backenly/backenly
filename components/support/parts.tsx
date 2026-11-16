'use client'

/**
 * Small pieces the Support pages share: the case glyph, the severity tag, and
 * the two link looks (in-app, and one that opens a new tab).
 */

import type { ReactNode } from 'react'
import Link from 'next/link'
import { Tag } from '@/components/inspector/kit'
import { FOCUS } from '@/components/console/tokens'
import {
  CASE_STATE_LABEL, SEVERITY_TAG_TONE, isProductionSeverity, severityLabel, type CaseState,
} from './presentation'

const GLYPH_TONE: Record<CaseState, string> = {
  waiting: 'text-zinc-50',
  open: 'text-zinc-400',
  resolved: 'text-zinc-500',
  closed: 'text-zinc-500',
}

/**
 * A case's state as a shape, drawn like the kit's StatusGlyph: waiting on you
 * ◆ (white), with the team ● (neutral, it is not "live"), resolved ✓, closed ✓.
 * The word is always there for screen readers; `showLabel` writes it out, which
 * only "Waiting on you" earns.
 */
export function CaseGlyph({ state, showLabel = false, className = '' }: { state: CaseState; showLabel?: boolean; className?: string }) {
  return (
    <span className={`inline-flex flex-shrink-0 items-center gap-[6px] ${className}`}>
      <svg aria-hidden viewBox="0 0 12 12" className={`h-[12px] w-[12px] flex-shrink-0 ${GLYPH_TONE[state]}`} fill="none">
        {state === 'waiting' && <path d="M6 1.8 10.2 6 6 10.2 1.8 6Z" fill="currentColor" />}
        {state === 'open' && <circle cx="6" cy="6" r="3.6" fill="currentColor" />}
        {(state === 'resolved' || state === 'closed') && (
          <path d="M2.6 6.2 5 8.5l4.4-5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        )}
      </svg>
      {showLabel ? (
        <span className={state === 'waiting' ? 'font-medium text-zinc-50' : 'text-zinc-300'}>{CASE_STATE_LABEL[state]}</span>
      ) : (
        <span className="sr-only">{CASE_STATE_LABEL[state]}</span>
      )}
    </span>
  )
}

/** A tag only for the production severities; the others are not worth one in a list. */
export function SeverityTag({ severity }: { severity: string }) {
  if (!isProductionSeverity(severity)) return null
  return <Tag tone={SEVERITY_TAG_TONE[severity] ?? 'neutral'}>{severityLabel(severity)}</Tag>
}

/** The console's in-text link: white, underlined, white focus. */
export const TEXT_LINK = `rounded-[3px] text-zinc-200 underline decoration-white/25 underline-offset-[3px] transition-colors duration-150 hover:text-white hover:decoration-white/60 ${FOCUS}`

export function InlineLink({ href, children, className = '' }: { href: string; children: ReactNode; className?: string }) {
  return (
    <Link href={href} className={`${TEXT_LINK} ${className}`}>
      {children}
    </Link>
  )
}

/** A link that leaves the console: a new tab, and said so to screen readers. */
export function ExternalLink({ href, children, className = '' }: { href: string; children: ReactNode; className?: string }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={`${TEXT_LINK} ${className}`}>
      {children}
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  )
}
