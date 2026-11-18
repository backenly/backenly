'use client'

import { Check } from 'lucide-react'
import type { ImportPhase, ImportPreviewTable, ImportProgress, ImportProgressTable } from '@/lib/import/contract'
import { countPhase, elapsedOf, fractionOf, isRunning, tablePhase } from '@/lib/import/client'
import { StatusGlyph } from '@/components/inspector/kit'
import { EDGE, PLATE, RULE, R_PANEL } from '@/components/console/tokens'
import { findRegion } from '@/lib/regions'
import { clock, size } from '@/components/onboarding/format'
import { LedgerHead, LedgerRow } from './MoveLedger'
import { SOURCES, SourceMark } from './sources'

/* ─────────────────────────────────────────────────────────────
   A real import, as the ledger: every table counted on both sides, then
   users, then files, read from GET /api/import/{jobId} every second
   (lib/import/contract.ts). The rows, bars and glyphs are MoveLedger's, so
   the console's move and the migration guide's picture of it are one thing.

   The project is named once: here in the header while it moves, or by the
   page's summary once it has finished (showName false). Each row's state is
   a glyph (hollow dot, spinner, check); the whole move has one phrase,
   beside Backenly's violet mark while Backenly works.
───────────────────────────────────────────────────────────── */

const PHASE_WORD: Record<ImportPhase, string> = {
  creating_project: 'Creating the project',
  tables: 'Creating tables',
  rows: 'Copying rows',
  users: 'Copying users',
  files: 'Copying files',
  verifying: 'Counting both sides',
  finished: 'Finishing',
}

/**
 * A waiting import (lib/import/gate.ts runs one at a time per server): its
 * place in line, so a still ledger reads as waiting, not stuck.
 */
function queuedWords(place: number | null | undefined): string {
  if (!place) return 'Starting'
  return place === 1 ? 'Waiting, next in line' : `Waiting, ${ordinal(place)} in line`
}

function ordinal(n: number): string {
  const tens = n % 100
  if (tens >= 11 && tens <= 13) return `${n}th`
  return `${n}${({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th'}`
}

function JobState({ job }: { job: ImportProgress }) {
  if (job.status === 'done') {
    return (
      <span className="inline-flex items-center gap-1.5 font-medium text-zinc-100">
        <Check aria-hidden className="h-[14px] w-[14px] text-zinc-200" strokeWidth={2.25} />
        Done
      </span>
    )
  }
  if (job.status === 'failed') return <StatusGlyph state="failed" label="Failed" showLabel />
  if (job.status === 'canceled') return <StatusGlyph state="paused" label="Stopped" showLabel />
  return (
    <span className="inline-flex items-center gap-2 font-medium text-zinc-100" aria-live="polite">
      <span aria-hidden className="h-[6px] w-[6px] rounded-full bg-violet-300" />
      {job.status === 'queued' ? queuedWords(job.queuePosition) : PHASE_WORD[job.phase]}
    </span>
  )
}

export function ImportLedger({
  job,
  planned,
  projectName,
  region,
  showName = true,
  now,
}: {
  job: ImportProgress
  /** The preview's tables, standing in until the job lists its own. */
  planned?: ImportPreviewTable[] | null
  projectName: string | null
  /** Where the new project runs (a lib/regions.ts id). */
  region: string | null
  showName?: boolean
  now: number
}) {
  const from = SOURCES[job.source].name
  const rows: ImportProgressTable[] =
    job.tables.length > 0
      ? job.tables
      : (planned ?? []).map((t) => ({ name: t.name, sourceRows: t.rows, copiedRows: 0, verified: false }))
  const matched = rows.filter((t) => tablePhase(t, job) === 'matched').length
  const fraction = fractionOf(job)
  const running = isRunning(job)
  const place = findRegion(region)
  const ended = !running

  return (
    <div className={`overflow-hidden border ${EDGE} ${R_PANEL} ${PLATE}`}>
      {/* The project, once, with where it comes from and where it goes. The header's bottom rule fills with the whole move. */}
      <div className={`relative flex flex-wrap items-start gap-x-6 gap-y-2 border-b ${RULE} px-4 py-[14px] sm:px-5`}>
        <div className="min-w-0">
          {showName && (
            <p className="truncate text-[14px] font-medium leading-[20px] tracking-[-0.006em] text-zinc-50">
              {projectName ?? 'New project'}
            </p>
          )}
          <p
            className={`flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1 text-[12px] leading-[16px] text-faint ${
              showName ? 'mt-[3px]' : 'pt-[2px]'
            }`}
          >
            <span className="inline-flex items-center gap-1.5">
              <SourceMark id={job.source} className="h-[12px] w-[12px] text-zinc-400" />
              From {from}
            </span>
            {place && (
              <span className="inline-flex items-center gap-1.5">
                Into {place.city}
                <code className="font-mono text-[11.5px]">{place.id}</code>
              </span>
            )}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-4 pt-[2px] text-[12.5px] leading-[18px]">
          {/* While it waits in line there is no clock or percentage yet; the state says why. */}
          {job.status !== 'queued' && (
            <span className="tabular-nums text-faint" title="Time since the import started">
              {clock(elapsedOf(job, now))}
            </span>
          )}
          {running && job.status !== 'queued' && <span className="tabular-nums text-zinc-400">{Math.floor(fraction * 100)}%</span>}
          <JobState job={job} />
        </div>
        <span aria-hidden className="absolute inset-x-0 bottom-[-1px] h-px overflow-hidden">
          <span
            className="block h-full origin-left bg-zinc-400/60 transition-transform duration-300 ease-linear motion-reduce:transition-none"
            style={{ transform: `scaleX(${fraction})` }}
          />
        </span>
      </div>

      {rows.length === 0 ? (
        <p className="px-4 py-4 text-[13px] leading-[20px] text-zinc-400 sm:px-5">
          {running ? `Reading the tables in ${from}.` : 'No tables were copied.'}
        </p>
      ) : (
        <div role="table" aria-label={`Tables moving from ${from}`} className="pb-1.5 pt-1">
          <LedgerHead name="Tables" progress={`${matched} of ${rows.length} matched`} from={from} />
          {rows.map((t) => (
            <LedgerRow
              key={t.name}
              label={t.name}
              mono
              row={{ phase: tablePhase(t, job), done: t.copiedRows, total: t.sourceRows }}
            />
          ))}

          {(job.users || job.files) && <div className="mx-4 my-1.5 border-t border-white/[0.06] sm:mx-5" />}
          {job.users && (
            <LedgerRow
              label="Users"
              row={{
                phase: countPhase(job.users.copied, job.users.total, job, 'users'),
                done: job.users.copied,
                total: job.users.total,
              }}
            />
          )}
          {job.files && (
            <LedgerRow
              label="Files"
              note={job.files.bytes > 0 ? size(job.files.bytes) : undefined}
              row={{
                phase: countPhase(job.files.copied, job.files.total, job, 'files'),
                done: job.files.copied,
                total: job.files.total,
              }}
            />
          )}
        </div>
      )}

      <p className={`border-t ${RULE} px-4 py-3 text-[12px] leading-[18px] text-faint sm:px-5`}>
        {ended ? `Backenly only read ${from}. Nothing there changed.` : `Backenly only reads ${from}. Nothing there changes.`}
      </p>
    </div>
  )
}
