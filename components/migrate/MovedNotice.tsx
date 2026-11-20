'use client'

import { useState } from 'react'
import Link from 'next/link'
import { X } from 'lucide-react'
import { IconButton, KitButtonLink } from '@/components/inspector/kit'
import { EDGE, PLATE, R_PANEL } from '@/components/console/tokens'
import type { Project } from '@/lib/api/projects'
import { shortDate } from '@/components/onboarding/format'
import { n } from './plan'
import { SOURCES, SourceMark } from './sources'

/* ─────────────────────────────────────────────────────────────
   The dashboard after a move. A moved project's row carries where it came
   from in its description slot when it has no description (MovedLine), and
   one notice above the list says what matched and what still waits on a
   person: the access rules, which keep the moved tables closed to the app
   until they are approved.

   One row on its own panel, the way the list's rows are set. It stays until
   the rules are approved or it is dismissed; it is about the next step, not
   a celebration. The rules wait where Backenly's other approvals do: the
   project's Autonomy page (the import spec of 2026-11-16).
───────────────────────────────────────────────────────────── */

type Moved = NonNullable<Project['importedFrom']>

const DAY = 24 * 60 * 60 * 1000

/** "Moved in from Supabase today", "Moved in from Supabase on Nov 12". */
export function MovedLine({ moved }: { moved: Moved }) {
  // The clock is read once, when the row mounts: "today" never flips mid-render.
  const [now] = useState(() => Date.now())
  const at = new Date(moved.at)
  const when = now - at.getTime() < DAY ? 'today' : `on ${shortDate(at, now)}`
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 text-zinc-400">
      <SourceMark id={moved.source} className="h-[13px] w-[13px] text-zinc-400" />
      <span className="truncate">
        Moved in from {SOURCES[moved.source].name} {when}
      </span>
    </span>
  )
}

export function MovedNotice({ projects }: { projects: Project[] }) {
  const [dismissed, setDismissed] = useState<string[]>([])
  // The newest move whose rules still wait: the one just finished, not whichever the list shows first.
  const project = projects
    .filter((p) => p.importedFrom && p.importedFrom.rulesPending > 0 && !dismissed.includes(p.id))
    .sort((a, b) => Date.parse(b.importedFrom?.at ?? '') - Date.parse(a.importedFrom?.at ?? ''))[0]
  if (!project?.importedFrom) return null
  const moved = project.importedFrom
  const from = SOURCES[moved.source].name
  const rules = moved.rulesPending
  // Firestore security rules have no exact translation, so nothing waits in
  // Autonomy for a Firebase move: its tables stay closed until rules are
  // written (the import's own Done summary says the same, components/onboarding/MoveStep.tsx).
  const closedOnly = moved.source === 'firebase'

  return (
    <section
      aria-label={`${project.name} moved from ${from}`}
      className={`mb-4 flex flex-col gap-3 border ${EDGE} ${R_PANEL} ${PLATE} px-[20px] py-[14px] sm:flex-row sm:items-center sm:gap-6`}
    >
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <SourceMark id={moved.source} className="mt-[3px] h-[14px] w-[14px] text-zinc-400" />
        <p className="min-w-0 text-[13px] leading-[20px] text-zinc-400 [text-wrap:pretty]">
          <span className="font-medium text-zinc-100">
            <Link
              href={`/app/projects/${project.id}`}
              className="rounded-[3px] underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
            >
              {project.name}
            </Link>{' '}
            moved from {from}.
          </span>{' '}
          {moved.tables === 1 ? 'Its table matches.' : `All ${n(moved.tables)} tables match.`} Your app can’t read{' '}
          {moved.tables === 1 ? 'it' : 'them'}{' '}
          {closedOnly
            ? 'until access rules are added: Firestore security rules don’t carry over.'
            : `until you approve ${n(rules)} access ${rules === 1 ? 'rule' : 'rules'}.`}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2 pl-[26px] sm:pl-0">
        {closedOnly ? (
          <KitButtonLink href={`/app/projects/${project.id}/database`}>Open the tables</KitButtonLink>
        ) : (
          <KitButtonLink href={`/app/projects/${project.id}/autonomy`}>Review access rules</KitButtonLink>
        )}
        <IconButton icon={X} label="Dismiss" onClick={() => setDismissed((d) => [...d, project.id])} />
      </div>
    </section>
  )
}
