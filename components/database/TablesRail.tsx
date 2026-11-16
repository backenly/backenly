'use client'

/**
 * The tables rail: each table with its row count, nothing else. No header or
 * footer (project decision 2) and no icons; a search appears once there are
 * enough tables to need one. A table's actions live in its pane's ⋯, never in
 * icons that appear on hover.
 */

import { useState } from 'react'
import { SearchField } from '@/components/console/InstrumentBar'
import { FOCUS_INSET, RULE } from '@/components/console/tokens'
import { Skeleton } from '@/components/inspector/kit'
import type { TableInfo } from '@/lib/api/database'

/** Tables from which the rail offers a search. */
const SEARCH_FROM = 6

export function TablesRail({
  tables,
  selected,
  onSelect,
  className = '',
}: {
  /** Null while the first read is in flight. */
  tables: readonly TableInfo[] | null
  selected: string | null
  onSelect: (name: string) => void
  className?: string
}) {
  const [query, setQuery] = useState('')
  const q = query.trim().toLowerCase()
  const shown = tables ? (q ? tables.filter((t) => t.name.toLowerCase().includes(q)) : tables) : []
  return (
    <nav aria-label="Tables" className={`flex-col border-r ${RULE} ${className}`}>
      {tables && tables.length >= SEARCH_FROM && (
        <div className={`flex-shrink-0 border-b ${RULE} p-[8px]`}>
          <SearchField value={query} onChange={setQuery} placeholder="Find a table" className="w-full" />
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden py-[6px]">
        {!tables ? (
          <div aria-hidden className="space-y-[6px] px-[12px] py-[8px]">
            {[0, 1, 2, 3, 4].map((i) => (
              <Skeleton key={i} className="h-[24px] w-full" />
            ))}
          </div>
        ) : (
          <ul className="space-y-px px-[8px]">
            {shown.map((t) => {
              const active = t.name === selected
              return (
                <li key={t.name}>
                  <button
                    type="button"
                    aria-current={active ? 'true' : undefined}
                    onClick={() => onSelect(t.name)}
                    className={`flex h-[36px] w-full items-center gap-[10px] rounded-[7px] px-[10px] text-left transition-colors duration-150 md:h-[32px] ${FOCUS_INSET} ${
                      active ? 'bg-white/[0.07] text-zinc-50' : 'text-zinc-400 hover:bg-white/[0.04] hover:text-zinc-100'
                    }`}
                  >
                    <span className="min-w-0 flex-1 truncate font-mono text-[12.5px]">{t.name}</span>
                    <span className={`flex-shrink-0 text-[12px] tabular-nums ${active ? 'text-zinc-400' : 'text-faint'}`}>
                      {(t.rows ?? 0).toLocaleString('en-US')}
                    </span>
                  </button>
                </li>
              )
            })}
            {q && shown.length === 0 && <li className="px-[10px] py-[10px] text-[12.5px] leading-[18px] text-faint">No table matches “{query.trim()}”.</li>}
          </ul>
        )}
      </div>
    </nav>
  )
}
