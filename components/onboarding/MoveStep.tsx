'use client'

/**
 * Move and Done: the import as it runs (GET /api/import/{jobId}, every
 * second), then what it came to.
 *
 *   Move  the ledger: one row per table (the source's rows, the rows copied,
 *         a thin bar, a check once both sides are counted), then users, then
 *         files. Leaving the page does not stop it.
 *   Done  the facts (tables, rows, users, files, time), the access rules
 *         that wait for approval on the project's Autonomy page, and
 *         Open project. The ledger stays below as the receipt.
 *
 * An import that ends without finishing says why, in the server's words,
 * and offers to delete the half-filled project or start again.
 */

import Link from 'next/link'
import type { ImportPreviewTable, ImportProgress } from '@/lib/import/contract'
import { elapsedOf, isRunning, isStopped, movedTotals } from '@/lib/import/client'
import { KitButton, KitButtonLink, StatusGlyph } from '@/components/inspector/kit'
import { EDGE, PLATE, RULE, R_PANEL } from '@/components/console/tokens'
import { Fact, Facts } from '@/components/autonomy/rows'
import { ImportLedger } from '@/components/migrate/ImportLedger'
import { SOURCES } from '@/components/migrate/sources'
import { clockTime, count, duration } from './format'

export function MoveStep({
  job,
  planned,
  projectName,
  region,
  now,
  staleSince,
  onStop,
  onStartAgain,
  onDelete,
}: {
  job: ImportProgress
  planned: ImportPreviewTable[] | null
  projectName: string | null
  region: string | null
  now: number
  /** When the last good read came, while reads are failing. */
  staleSince: number | null
  onStop: () => void
  onStartAgain: () => void
  onDelete: () => void
}) {
  const done = job.status === 'done'
  const stopped = isStopped(job)
  return (
    <div className="space-y-[16px]">
      {done && <DoneSummary job={job} projectName={projectName} now={now} />}
      {stopped && <StoppedSummary job={job} projectName={projectName} onStartAgain={onStartAgain} onDelete={onDelete} />}
      <ImportLedger
        job={job}
        planned={planned}
        projectName={projectName}
        region={region}
        now={now}
        showName={!done && !stopped}
      />
      {(staleSince !== null || isRunning(job)) && (
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <p role="status" className="min-w-0 text-[12.5px] leading-[18px] text-faint">
            {staleSince !== null
              ? `Could not refresh. Showing progress from ${clockTime(staleSince)}.`
              : job.status === 'queued' && job.queuePosition
                ? `Backenly moves one project in at a time. Yours starts as soon as ${
                    job.queuePosition === 1 ? 'the one ahead of it finishes' : 'the ones ahead of it finish'
                  }; you can close this page.`
                : ''}
          </p>
          {isRunning(job) && (
            <KitButton variant="ghost" onClick={onStop}>
              Stop the import
            </KitButton>
          )}
        </div>
      )}
    </div>
  )
}

function DoneSummary({ job, projectName, now }: { job: ImportProgress; projectName: string | null; now: number }) {
  const from = SOURCES[job.source].name
  const moved = movedTotals(job)
  return (
    <section aria-labelledby="import-done" className={`${PLATE} border ${EDGE} ${R_PANEL}`}>
      <div className="flex flex-col gap-x-6 gap-y-3 px-5 py-4 sm:flex-row sm:items-start">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <StatusGlyph state="done" label="Done" className="mt-[4px]" />
          <div className="min-w-0">
            <h2 id="import-done" className="text-[14px] font-medium leading-[20px] tracking-[-0.006em] text-zinc-50 [overflow-wrap:anywhere]">
              {projectName ?? 'The new project'} moved in from {from}
            </h2>
            <Facts className="tabular-nums">
              <Fact>{count(moved.tables, 'table', 'tables')}</Fact>
              <Fact>{count(moved.rows, 'row', 'rows')}</Fact>
              {moved.users !== null && <Fact>{count(moved.users, 'user', 'users')}</Fact>}
              {moved.files !== null && <Fact>{count(moved.files, 'file', 'files')}</Fact>}
              <Fact>Took {duration(elapsedOf(job, now))}</Fact>
            </Facts>
          </div>
        </div>
        <div className="flex-shrink-0 pl-[24px] sm:pl-0">
          <KitButtonLink href={`/app/projects/${job.projectId}`} variant="primary">
            Open project
          </KitButtonLink>
        </div>
      </div>

      {job.rulesPending > 0 && (
        <div className={`flex items-start gap-3 border-t ${RULE} px-5 py-[12px]`}>
          <StatusGlyph state="waiting" label="Waiting on you" className="mt-[4px]" />
          <div className="min-w-0">
            {job.source === 'firebase' ? (
              // Firestore security rules have no exact translation, so nothing
              // waits in Autonomy: the tables stay closed until rules are written.
              <>
                <Link
                  href={`/app/projects/${job.projectId}/database`}
                  className="rounded-[3px] text-[13px] font-medium leading-[20px] text-zinc-50 underline-offset-[3px] transition-colors hover:text-white hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
                >
                  {count(job.rulesPending, 'table answers', 'tables answer')} only your server key
                </Link>
                <p className="text-[12.5px] leading-[18px] text-faint">
                  Firestore security rules don&rsquo;t carry over. Ask your agent to add access rules for your app.
                </p>
              </>
            ) : (
              <>
                <Link
                  href={`/app/projects/${job.projectId}/autonomy`}
                  className="rounded-[3px] text-[13px] font-medium leading-[20px] text-zinc-50 underline-offset-[3px] transition-colors hover:text-white hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
                >
                  {count(job.rulesPending, 'access rule waits', 'access rules wait')} for your approval
                </Link>
                <p className="text-[12.5px] leading-[18px] text-faint">
                  Until then, only your server key can read or write the moved tables.
                </p>
              </>
            )}
          </div>
        </div>
      )}

      {job.warnings.length > 0 && (
        // The notes start where the title's words do: an empty glyph column, then the text.
        <div className={`flex items-start gap-3 border-t ${RULE} px-5 py-[12px]`}>
          <span aria-hidden className="w-[12px] flex-shrink-0" />
          <ul className="min-w-0 space-y-[4px] text-[12.5px] leading-[18px] text-zinc-400">
            {job.warnings.map((warning) => (
              <li key={warning} className="[overflow-wrap:anywhere]">
                {warning}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}

function StoppedSummary({
  job,
  projectName,
  onStartAgain,
  onDelete,
}: {
  job: ImportProgress
  projectName: string | null
  onStartAgain: () => void
  onDelete: () => void
}) {
  const from = SOURCES[job.source].name
  const failed = job.status === 'failed'
  const name = projectName ?? 'The new project'
  const why = failed && job.error ? job.error : `Nothing in ${from} changed.`
  return (
    <section aria-labelledby="import-stopped" className={`${PLATE} border ${EDGE} ${R_PANEL}`}>
      <div className="flex flex-col gap-x-6 gap-y-3 px-5 py-4 sm:flex-row sm:items-start">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <StatusGlyph state={failed ? 'failed' : 'paused'} label={failed ? 'Failed' : 'Stopped'} className="mt-[4px]" />
          <div className="min-w-0">
            <h2 id="import-stopped" className="text-[14px] font-medium leading-[20px] tracking-[-0.006em] text-zinc-50">
              {failed ? 'Import failed' : 'Import stopped'}
            </h2>
            <p role={failed ? 'alert' : undefined} className="mt-1 text-[13px] leading-[20px] text-zinc-400 [overflow-wrap:anywhere]">
              {why} {name} keeps the rows copied so far.
            </p>
          </div>
        </div>
        <div className="flex flex-shrink-0 items-center gap-[8px] pl-[24px] sm:pl-0">
          <KitButton variant="danger" onClick={onDelete}>
            Delete project
          </KitButton>
          <KitButton variant="primary" onClick={onStartAgain}>
            Start again
          </KitButton>
        </div>
      </div>
    </section>
  )
}
