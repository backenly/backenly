'use client'

import { ArrowRight, Check } from 'lucide-react'
import { BackenlyMark, SOURCES, SourceMark } from './sources'
import { n, type MovePlan, type MoveProgress, type RowProgress } from './plan'

/* ─────────────────────────────────────────────────────────────
   The move, as the database sees it: every table counted on both sides,
   then users, files and access rules. One component for the console's move
   screen and the landing page's illustration, so the page shows the product
   rather than a drawing of it.

   Founders' rules this follows (2026-10-29): a process is shown through the
   database's own artifacts, never as a cycle or step diagram; black and zinc
   with one violet touch (the "Moving" dot); no traffic-light colours; no SQL.

   Second pass (2026-11-14, "more professional, non AI slop"):
   - the project is named once, in the console's own face, with its route
     (Supabase → Backenly) as one line under it; no icon tiles;
   - state is a glyph (a hollow dot, a spinner, a check), the way build and
     CI logs show it, instead of a word repeated down every row;
   - the two counts carry the story, so the bars are thin and quiet;
   - the "Moving" dot is still; the numbers already move.
   Table names are machine text, so they are mono; counts are Geist with
   tabular figures. Bars scale on the compositor (transform), never by width.
───────────────────────────────────────────────────────────── */

/** One grid for every row: name, bar, the source's count, Backenly's count, state. */
const GRID =
  'grid grid-cols-[minmax(0,1fr)_84px_16px] items-center gap-x-4 px-4 sm:grid-cols-[minmax(112px,200px)_minmax(0,1fr)_84px_84px_16px] sm:px-5'

export function whereOf(plan: MovePlan): string {
  return plan.source === 'postgres' ? plan.sourceWhere : `${SOURCES[plan.source].name}, ${plan.sourceWhere}`
}

export function MoveLedger({
  plan,
  progress,
  clock,
  className = '',
}: {
  plan: MovePlan
  progress: MoveProgress
  /** Elapsed time, when the screen shows it ("2:41"). */
  clock?: string
  className?: string
}) {
  const p = progress
  const tableCount = plan.tables.length
  const tableWords = plan.tableWord
  const from = SOURCES[plan.source].name
  const pct = Math.floor(p.fraction * 100)

  return (
    <div className={`overflow-hidden rounded-[10px] border border-white/[0.08] bg-[#0f1012] ${className}`}>
      {/* The project, once, with where it is going. The header's bottom rule fills with the whole move. */}
      <div className="relative flex flex-wrap items-start gap-x-6 gap-y-2 border-b border-white/[0.06] px-4 pb-3.5 pt-3.5 sm:px-5">
        <div className="min-w-0">
          <p className="truncate text-[14px] font-semibold leading-[20px] tracking-[-0.01em] text-zinc-50">{plan.project}</p>
          <p className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[12px] leading-[16px] text-faint">
            <span className="inline-flex min-w-0 items-center gap-1.5">
              <SourceMark id={plan.source} className="h-[12px] w-[12px] text-zinc-400" />
              <span className="truncate">{whereOf(plan)}</span>
            </span>
            <ArrowRight aria-label="to" className="h-3 w-3 shrink-0 text-zinc-600" strokeWidth={2} />
            <span className="inline-flex min-w-0 items-center gap-1.5">
              <BackenlyMark className="h-[13px] w-[13px] rounded-[3px] ring-1 ring-white/[0.12]" />
              <span className="truncate">Backenly, {plan.region}</span>
            </span>
          </p>
        </div>
        <div className="ml-auto flex items-center gap-4 pt-[2px] text-[12.5px] leading-[18px]">
          {clock && <span className="tabular-nums text-faint">{clock}</span>}
          {!p.finished && <span className="tabular-nums text-zinc-400">{pct}%</span>}
          <MoveStatus progress={p} project={plan.project} />
        </div>
        <span aria-hidden className="absolute inset-x-0 bottom-[-1px] h-px overflow-hidden">
          <span
            className="block h-full origin-left bg-zinc-400/60 transition-transform duration-300 ease-linear motion-reduce:transition-none"
            style={{ transform: `scaleX(${p.fraction})` }}
          />
        </span>
      </div>

      <div role="table" aria-label={`Moving ${plan.project}`} className="pb-1.5 pt-1">
        <div role="row" className={`${GRID} h-[32px] text-[12px] leading-[16px] text-faint`}>
          <span role="columnheader">{tableWords.many.charAt(0).toUpperCase() + tableWords.many.slice(1)}</span>
          <span role="columnheader" className="hidden tabular-nums sm:block">
            {p.reading ? `Reading ${tableCount} ${tableWords.many}` : `${p.matchedTables} of ${tableCount} matched`}
          </span>
          <span role="columnheader" className="hidden text-right sm:block">
            {from}
          </span>
          <span role="columnheader" className="text-right">
            Backenly
          </span>
          <span role="columnheader">
            <span className="sr-only">State</span>
          </span>
        </div>
        {plan.tables.map((t, i) => (
          <LedgerRow key={t.name} label={t.name} mono row={p.tables[i]} />
        ))}

        {(p.users || p.files || p.rules) && <div className="mx-4 my-1.5 border-t border-white/[0.06] sm:mx-5" />}
        {p.users && <LedgerRow label="Users" row={p.users} />}
        {p.files && <LedgerRow label="Files" row={p.files} />}
        {p.rules && plan.rules && (
          <div role="row" className={`${GRID} h-[34px]`}>
            <span role="cell" className="truncate text-[13px] text-zinc-300">
              Access rules
            </span>
            <span role="cell" aria-hidden className="hidden sm:block" />
            <span role="cell" className="hidden text-right text-[12.5px] tabular-nums text-faint sm:block">
              {plan.rules.count} {plan.rules.short}
            </span>
            <span role="cell" className="whitespace-nowrap text-right text-[12.5px] tabular-nums">
              {p.rules.phase === 'review' ? (
                <span className="text-zinc-100">{plan.rules.count} to review</span>
              ) : (
                <span className="text-faint">–</span>
              )}
            </span>
            <span role="cell" className="flex justify-center">
              <StateGlyph phase={p.rules.phase === 'waiting' ? 'waiting' : p.rules.phase === 'rewriting' ? 'copying' : 'review'} />
            </span>
          </div>
        )}
      </div>

      <p className="border-t border-white/[0.06] px-4 py-3 text-[12px] leading-[18px] text-faint [text-wrap:pretty] sm:px-5">
        {plan.source === 'postgres'
          ? 'Read-only access. Nothing in the source database changes.'
          : `Read-only access. Nothing in ${plan.project} on ${from} changes.`}
        {plan.staysBehind && ` Its ${plan.staysBehind.count} ${plan.staysBehind.word} stay on ${from} for your agent to rebuild.`}
      </p>
    </div>
  )
}

function MoveStatus({ progress, project }: { progress: MoveProgress; project: string }) {
  if (progress.finished) {
    return (
      <span className="inline-flex items-center gap-1.5 font-medium text-zinc-100">
        <Check aria-hidden className="h-[14px] w-[14px] text-zinc-200" strokeWidth={2.25} />
        Done
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-2 font-medium text-zinc-100" aria-live="polite">
      <span aria-hidden className="h-[6px] w-[6px] rounded-full bg-violet-300" />
      {progress.reading ? `Reading ${project}` : 'Moving'}
    </span>
  )
}

const PHASE_WORD: Record<RowProgress['phase'] | 'review', string> = {
  waiting: 'Waiting',
  copying: 'Copying',
  checking: 'Counting both sides',
  matched: 'Matched',
  review: 'Waiting for your review',
}

/** A row's state as a glyph, named for screen readers and on hover. */
function StateGlyph({ phase }: { phase: RowProgress['phase'] | 'review' }) {
  const word = PHASE_WORD[phase]
  return (
    <span title={word} className="flex h-[16px] w-[16px] items-center justify-center">
      <span className="sr-only">{word}</span>
      {phase === 'waiting' && <span aria-hidden className="h-[6px] w-[6px] rounded-full border border-zinc-600" />}
      {(phase === 'copying' || phase === 'checking') && (
        <span
          aria-hidden
          className="h-[11px] w-[11px] rounded-full border-[1.5px] border-zinc-700 border-t-zinc-200 motion-safe:animate-spin"
        />
      )}
      {phase === 'matched' && <Check aria-hidden className="h-[13px] w-[13px] text-zinc-300" strokeWidth={2.25} />}
      {phase === 'review' && <span aria-hidden className="h-[6px] w-[6px] rounded-full bg-zinc-200" />}
    </span>
  )
}

function LedgerRow({ label, row, mono = false }: { label: string; row: RowProgress; mono?: boolean }) {
  const { phase, done, total } = row
  const fill = total ? done / total : 0
  return (
    <div role="row" className={`relative ${GRID} h-[34px]`}>
      <span
        role="cell"
        className={`truncate ${mono ? 'font-mono text-[12px]' : 'text-[13px]'} ${
          phase === 'waiting' ? 'text-faint' : mono ? 'text-zinc-200' : 'text-zinc-300'
        }`}
      >
        {label}
      </span>

      {/* The bar: its own column from sm up; on a phone, the row's bottom rule fills instead. */}
      <span role="cell" aria-hidden className="hidden h-[2px] overflow-hidden rounded-full bg-white/[0.06] sm:block">
        <span
          className={`block h-full origin-left rounded-full transition-[transform,background-color] duration-300 ease-linear motion-reduce:transition-none ${
            phase === 'matched' ? 'bg-zinc-600' : 'bg-zinc-400'
          }`}
          style={{ transform: `scaleX(${fill})` }}
        />
      </span>
      <span aria-hidden className="absolute inset-x-4 bottom-0 h-px overflow-hidden bg-white/[0.04] sm:hidden">
        <span className="block h-full origin-left bg-zinc-500" style={{ transform: `scaleX(${fill})` }} />
      </span>

      {/* Counted on both sides: the source's count, then Backenly's, which climbs to meet it. */}
      <span role="cell" className="hidden text-right text-[12.5px] tabular-nums text-faint sm:block">
        {n(total)}
      </span>
      <span role="cell" className="text-right text-[12.5px] tabular-nums">
        {phase === 'waiting' ? (
          <span className="text-zinc-600">–</span>
        ) : (
          <span className={phase === 'matched' ? 'text-zinc-300' : 'text-zinc-50'}>{n(done)}</span>
        )}
      </span>

      <span role="cell" className="flex justify-center">
        <StateGlyph phase={phase} />
      </span>
    </div>
  )
}
