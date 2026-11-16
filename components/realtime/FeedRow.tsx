'use client'

/**
 * One event in the Realtime feed: time, event, table, row.
 *
 *   2:22:37 AM   insert   reviews          9415c3d0 rating=3 body="The score carries it…"
 *   2:21:23 AM   presence                  506a28c4 joined screen="feed"
 *
 * The EventRow anatomy (components/console/EventRow.tsx: the same 40px line,
 * time column, hover and current marks), but a realtime event opens the
 * shared record drawer instead of expanding in place (decision 6), so the row
 * is a plain button that opens it, without EventRow's aria-expanded and
 * chevron. On a phone the row takes two lines: time, event and table, then
 * the row.
 */

import { Time } from '@/components/console/Time'
import { FOCUS_INSET } from '@/components/console/tokens'
import { presenceVerb, rowSummary, type LiveEvent } from './event-format'

export function FeedRow({ event: ev, current, onOpen }: { event: LiveEvent; current: boolean; onOpen: (id: string) => void }) {
  const { key, rest } = rowSummary(ev)
  const where = ev.type === 'broadcast' ? ev.channel : ev.table
  const verb = ev.type === 'presence' && ev.presence ? presenceVerb(ev.presence.event) : null
  return (
    <li aria-current={current || undefined}>
      <button
        type="button"
        onClick={() => onOpen(ev.id)}
        className={`flex min-h-[40px] w-full flex-wrap items-baseline gap-x-[16px] gap-y-[3px] px-[16px] py-[9px] text-left transition-colors duration-150 md:flex-nowrap md:items-center md:px-[20px] ${FOCUS_INSET} ${
          current ? 'bg-white/[0.04]' : 'hover:bg-[#121316]'
        }`}
      >
        <span className="w-[88px] flex-shrink-0 text-[12.5px] leading-[18px] text-faint">
          <Time iso={ev.at} mode="clockSeconds" />
        </span>
        <span className="w-[72px] flex-shrink-0 font-mono text-[12px] leading-[18px] text-zinc-300">{ev.type}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[12px] leading-[18px] text-zinc-200 md:w-[168px] md:flex-none">
          {where ?? ''}
        </span>
        {(key || verb || ev.truncated || rest) && (
          <span className="flex min-w-0 basis-full items-baseline gap-x-[10px] overflow-hidden leading-[18px] md:flex-1 md:basis-auto">
            {key && <code className="flex-shrink-0 font-mono text-[12px] text-zinc-200">{key}</code>}
            {verb && <span className="flex-shrink-0 text-[12.5px] text-zinc-400">{verb}</span>}
            {ev.truncated && <span className="flex-shrink-0 text-[12.5px] text-faint">Cut short</span>}
            {rest && <code className="min-w-0 truncate font-mono text-[12px] text-zinc-400">{rest}</code>}
          </span>
        )}
      </button>
    </li>
  )
}
