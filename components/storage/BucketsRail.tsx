'use client'

/**
 * The buckets rail: "All files", then each bucket with its server count. The
 * rows only, with no header or footer (project decision 2); a search appears
 * once there are enough buckets to need one. A bucket's actions live in the
 * files pane's toolbar, behind its ⋯, never in hover-only icons here.
 */

import { useState, type ReactNode } from 'react'
import { SearchField } from '@/components/console/InstrumentBar'
import { Skeleton } from '@/components/inspector/kit'
import { FOCUS_INSET, RULE } from '@/components/console/tokens'
import type { StorageBucket } from '@/lib/api/storage'
import { isPublicPolicy } from './format'

/** Buckets from which the rail offers a search. */
const SEARCH_FROM = 6

export function BucketsRail({
  buckets,
  loading,
  selected,
  totalFiles,
  countFor,
  onSelect,
  className = '',
}: {
  buckets: StorageBucket[]
  /** The first read is in flight: placeholders. */
  loading: boolean
  /** The selected bucket's name; null is All files. */
  selected: string | null
  totalFiles: number
  countFor: (bucketName: string) => number
  onSelect: (bucketName: string | null) => void
  className?: string
}) {
  const [query, setQuery] = useState('')
  const q = query.trim().toLowerCase()
  const shown = q ? buckets.filter((b) => b.name.toLowerCase().includes(q)) : buckets

  return (
    <nav aria-label="Buckets" className={`flex-col border-r ${RULE} ${className}`}>
      {buckets.length >= SEARCH_FROM && (
        <div className={`flex-shrink-0 border-b ${RULE} p-[8px]`}>
          <SearchField value={query} onChange={setQuery} placeholder="Find a bucket" className="w-full" />
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden py-[6px]">
        {loading ? (
          <div aria-hidden className="space-y-[6px] px-[12px] py-[8px]">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-[24px] w-full" />
            ))}
          </div>
        ) : (
          <ul className="space-y-px px-[8px]">
            <RailItem active={selected === null} onClick={() => onSelect(null)} count={totalFiles}>
              <span className="truncate text-[13px] font-medium">All files</span>
            </RailItem>
            {shown.map((b) => (
              <RailItem key={b.id} active={selected === b.name} onClick={() => onSelect(b.name)} count={countFor(b.name)}>
                <span className="min-w-0 truncate font-mono text-[12.5px]">{b.name}</span>
                {/* The policy, said only where it opens the bucket to anyone: one plain word. */}
                {isPublicPolicy(b.accessPolicy) && <span className="flex-shrink-0 text-[12px] text-faint">Public</span>}
              </RailItem>
            ))}
            {q && shown.length === 0 && (
              <li className="px-[10px] py-[10px] text-[12.5px] leading-[18px] text-faint">No bucket matches “{query.trim()}”.</li>
            )}
          </ul>
        )}
      </div>
    </nav>
  )
}

function RailItem({
  active,
  onClick,
  count,
  children,
}: {
  active: boolean
  onClick: () => void
  count: number
  children: ReactNode
}) {
  return (
    <li>
      <button
        type="button"
        aria-current={active ? 'true' : undefined}
        onClick={onClick}
        className={`flex h-[36px] w-full items-center gap-[10px] rounded-[7px] px-[10px] text-left transition-colors duration-150 md:h-[32px] ${FOCUS_INSET} ${
          active ? 'bg-white/[0.07] text-zinc-50' : 'text-zinc-400 hover:bg-white/[0.04] hover:text-zinc-100'
        }`}
      >
        <span className="flex min-w-0 flex-1 items-center gap-[8px]">{children}</span>
        <span className={`flex-shrink-0 text-[12px] tabular-nums ${active ? 'text-zinc-400' : 'text-faint'}`}>{count.toLocaleString('en-US')}</span>
      </button>
    </li>
  )
}
