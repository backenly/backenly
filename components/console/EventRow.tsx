'use client'

/**
 * One row shape for "something happened": a function run, a webhook
 * delivery, a request, a log line, a tool call, a realtime event.
 *
 *   Today
 *   ✓  2:18:41 AM   recommend-movies     60 ms   user 506a28c4: picks=20 genres=1
 *   ✕  7:30:01 AM   send-welcome-email  214 ms   Resend error: Too many requests…
 *   ◐  2:20:16 AM                          500   Retrying  3 attempts  Next attempt 2:26 AM   ⌄
 *      ┌ Response ─────────────────────────────────────────────────────── Copy ┐   flush code well,
 *      │ {"error":"internal_error","message":"Cannot read properties of null…"} │   no nested box
 *
 * Success is the glyph alone; a word only for Failed, Gave up, Retrying, Off.
 * A log line has no glyph at all. The row expands in place (decision 6): the
 * whole line is the toggle, and an action at its right edge stays its own
 * control. Times are the clock, with seconds for runs, requests and logs, under
 * a DayGroup heading that carries the date.
 */

import { useId, type ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
import { CopyButton, Skeleton, StatusGlyph, type GlyphState } from '@/components/inspector/kit'
import { FOCUS_INSET, RULE, WELL } from './tokens'
import { Time } from './Time'
import type { Moment } from './format'

// Monochrome status words: white where the state asks for the person.
const WORD_TONE: Partial<Record<GlyphState, string>> = {
  failed: 'text-zinc-50',
  waiting: 'text-zinc-50',
  busy: 'text-zinc-50',
  paused: 'text-zinc-300',
}

export interface EventRowProps {
  /** ✓ done · ✕ failed · ◐ busy (retrying) · ‖ paused (off). Null keeps the column empty; omit it for log lines. */
  glyph?: GlyphState | null
  /** The glyph in words, read by screen readers: "Succeeded", "Failed". */
  glyphLabel?: string
  /** Written out only for Failed, Gave up, Retrying, Off. Toned by the glyph. */
  word?: string
  /** When it happened. */
  time: Moment
  /** 'clockSeconds' (runs, requests, logs) by default; 'clock' for coarser events. */
  timeMode?: 'clock' | 'clockSeconds'
  /** What it happened to: a function, a path, an event. Omit on a page about one thing. */
  what?: ReactNode
  /** `what` is machine text (a path, an event name): set in mono. */
  mono?: boolean
  /** The result: "60 ms", "200". */
  result?: ReactNode
  /** The first line of output, or the error (rose when the glyph is failed). */
  line?: ReactNode
  /** The line is output exactly as the machine wrote it: set in mono. */
  lineMono?: boolean
  /** One control at the right edge ("Send again"). It stays outside the row's toggle. */
  action?: ReactNode
  expanded?: boolean
  /** Makes the row a toggle for its details. */
  onToggle?: () => void
  /** What the row expands into: usually a <CodeWell>. */
  children?: ReactNode
  /** Column widths in px, the same on every row of one list. */
  columns?: { what?: number; result?: number }
  /** The open record: highlighted, and marked for screen readers. */
  current?: boolean
  id?: string
  className?: string
}

export function EventRow({
  glyph,
  glyphLabel,
  word,
  time,
  timeMode = 'clockSeconds',
  what,
  mono = false,
  result,
  line,
  lineMono = false,
  action,
  expanded = false,
  onToggle,
  children,
  columns,
  current = false,
  id,
  className = '',
}: EventRowProps) {
  const detailId = useId()
  const expandable = !!onToggle
  const failed = glyph === 'failed'
  const whatW = columns?.what ?? 176
  const resultW = columns?.result ?? 64
  const cells = (
    <>
      <span className="flex flex-shrink-0 items-center gap-[12px]">
        {glyph !== undefined && (
          <span className="flex w-[12px] justify-center">{glyph ? <StatusGlyph state={glyph} label={glyphLabel ?? glyph} /> : null}</span>
        )}
        <span className="w-[80px] text-[12.5px] leading-[18px] text-faint">
          <Time iso={time} mode={timeMode} />
        </span>
      </span>
      {what !== undefined && (
        // A phone gives the name the rest of the first line and lets it wrap; it is never cut there.
        <span
          style={{ ['--what' as string]: `${whatW}px` }}
          className={`min-w-0 flex-1 text-zinc-100 [overflow-wrap:anywhere] sm:w-[var(--what)] sm:flex-none sm:truncate ${
            mono ? 'font-mono text-[12px] leading-[18px]' : 'text-[13px] leading-[20px]'
          }`}
        >
          {what}
        </span>
      )}
      {result !== undefined && (
        <span style={{ width: resultW }} className="hidden flex-shrink-0 text-right text-[12.5px] leading-[18px] tabular-nums text-zinc-300 sm:block">
          {result}
        </span>
      )}
      {(word || line || result !== undefined) && (
        <span
          className={`flex min-w-0 basis-full items-baseline gap-[10px] sm:flex-1 sm:basis-auto ${glyph !== undefined ? 'pl-[24px] sm:pl-0' : ''} ${
            word || line ? '' : 'sm:hidden'
          }`}
        >
          {/* On a phone the result opens the second line; from sm it has its own column. */}
          {result !== undefined && <span className="flex-shrink-0 text-[12.5px] leading-[18px] tabular-nums text-zinc-300 sm:hidden">{result}</span>}
          {word && <span className={`flex-shrink-0 text-[12.5px] font-medium leading-[18px] ${glyph ? WORD_TONE[glyph] ?? 'text-zinc-300' : 'text-zinc-300'}`}>{word}</span>}
          {line && (
            <span
              className={`min-w-0 truncate ${failed ? 'text-rose-300' : 'text-zinc-400'} ${
                lineMono ? 'font-mono text-[12px] leading-[18px]' : 'text-[12.5px] leading-[18px]'
              }`}
            >
              {line}
            </span>
          )}
        </span>
      )}
    </>
  )
  // Top-aligned on a phone, so the time sits on the first line of a name that wraps.
  const lineCls = 'flex min-w-0 flex-1 flex-wrap items-start gap-x-[16px] gap-y-[3px] text-left sm:flex-nowrap sm:items-center'
  return (
    <li id={id} aria-current={current || undefined} className={className}>
      <div
        className={`relative flex min-h-[40px] items-center gap-[12px] px-[16px] py-[9px] sm:px-[20px] ${
          current ? 'bg-white/[0.04]' : expandable ? 'transition-colors duration-150 hover:bg-[#121316]' : ''
        }`}
      >
        {expandable ? (
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={expanded}
            aria-controls={expanded ? detailId : undefined}
            className={`${lineCls} after:absolute after:inset-0 after:content-[''] focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-inset focus-visible:after:ring-white/70`}
          >
            {cells}
          </button>
        ) : (
          <div className={lineCls}>{cells}</div>
        )}
        {action && <div className="relative z-[1] flex flex-shrink-0 items-center">{action}</div>}
        {expandable && (
          <ChevronDown
            aria-hidden
            className={`h-3.5 w-3.5 flex-shrink-0 text-zinc-500 transition-transform duration-150 ${expanded ? 'rotate-180' : ''}`}
            strokeWidth={1.75}
          />
        )}
      </div>
      {expandable && expanded && children && <div id={detailId}>{children}</div>}
      {!expandable && children}
    </li>
  )
}

/** A flat list of event rows, divided by hairlines. */
export function EventList({ children, label, className = '' }: { children: ReactNode; label?: string; className?: string }) {
  return (
    <ul aria-label={label} className={`divide-y divide-white/[0.06] ${className}`}>
      {children}
    </ul>
  )
}

/** Day groups, one after another, divided by hairlines. */
export function DayGroupList({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`divide-y divide-white/[0.06] ${className}`}>{children}</div>
}

/**
 * The rows of one day under its heading: "Today", "Yesterday", "Sat, Nov 14"
 * (dayLabel / groupByDay in format.ts). `sticky` keeps the heading in view
 * while a pane scrolls.
 */
export function DayGroup({
  label,
  children,
  headingLevel = 3,
  sticky = false,
}: {
  label: string
  children: ReactNode
  headingLevel?: 2 | 3 | 4
  sticky?: boolean
}) {
  const id = useId()
  const Heading = `h${headingLevel}` as 'h2' | 'h3' | 'h4'
  return (
    <div role="group" aria-labelledby={id}>
      <Heading
        id={id}
        className={`border-b ${RULE} bg-[#111214] px-[16px] py-[7px] text-[12px] font-medium leading-[16px] text-faint sm:px-[20px] ${
          sticky ? 'sticky top-0 z-[2]' : ''
        }`}
      >
        {label}
      </Heading>
      <ul className="divide-y divide-white/[0.06]">{children}</ul>
    </div>
  )
}

/**
 * What an expanded row shows: output, a response, statements. Flush with the
 * panel's edges, a step darker, no box inside the box. Long output scrolls
 * inside it.
 */
export function CodeWell({
  children,
  label,
  copy,
  maxHeight = 320,
  className = '',
}: {
  children: ReactNode
  /** A word for what this is: "Response", "Output", "Statements". */
  label?: string
  /** The text Copy copies, usually the whole output. */
  copy?: string
  maxHeight?: number
  className?: string
}) {
  return (
    <div className={`border-t ${RULE} ${WELL} ${className}`}>
      {(label || copy) && (
        <div className="flex min-h-[32px] items-center justify-between gap-3 pl-[16px] pr-[8px] pt-[4px] sm:pl-[20px] sm:pr-[12px]">
          <p className="text-[12px] leading-[16px] text-faint">{label}</p>
          {copy !== undefined && <CopyButton value={copy} label={label ? `Copy ${label.toLowerCase()}` : 'Copy'} />}
        </div>
      )}
      <pre
        tabIndex={0}
        style={{ maxHeight }}
        className={`overflow-auto whitespace-pre-wrap break-words px-[16px] pb-[12px] font-mono text-[12px] leading-[19px] text-zinc-300 sm:px-[20px] ${
          label || copy ? 'pt-[2px]' : 'pt-[12px]'
        } ${FOCUS_INSET}`}
      >
        {children}
      </pre>
    </div>
  )
}

/** Event-row placeholders, in the rows' own columns, so the list loads in one pass. */
export function EventRowSkeleton({ rows = 6, glyph = true, what = true }: { rows?: number; glyph?: boolean; what?: boolean }) {
  return (
    <ul aria-hidden className="divide-y divide-white/[0.06]">
      {Array.from({ length: rows }, (_, i) => (
        <li key={i} className="flex min-h-[40px] items-center gap-[16px] px-[16px] py-[9px] sm:px-[20px]">
          <span className="flex items-center gap-[12px]">
            {glyph && <Skeleton className="h-[12px] w-[12px] !rounded-full" />}
            <Skeleton className="h-[11px] w-[72px]" />
          </span>
          {what && <Skeleton className="h-[12px] w-[132px]" />}
          <Skeleton className="hidden h-[11px] w-[44px] sm:block" />
          <Skeleton className={`hidden h-[11px] sm:block ${i % 3 === 0 ? 'w-[38%]' : i % 3 === 1 ? 'w-[28%]' : 'w-[44%]'}`} />
        </li>
      ))}
    </ul>
  )
}
