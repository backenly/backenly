'use client'

import { useState } from 'react'
import Link from 'next/link'
import { X } from 'lucide-react'
import { IconButton, KitButtonLink } from '@/components/inspector/kit'
import type { Project } from '@/lib/api/projects'
import { n } from './plan'
import { SOURCES, SourceMark } from './sources'

/* ─────────────────────────────────────────────────────────────
   The dashboard after a move. The project card carries where it came from
   in its description slot (MovedLine), and one notice above the grid says
   what matched and what still waits on a person: the access rules, which
   keep the moved tables closed to the app until they are approved.

   The notice stays until the rules are approved or it is dismissed; it is
   about the next step, not a celebration.
───────────────────────────────────────────────────────────── */

type Moved = NonNullable<Project['importedFrom']>

const DAY = 24 * 60 * 60 * 1000

export function MovedLine({ moved }: { moved: Moved }) {
  // The clock is read once, when the card mounts: "today" never flips mid-render.
  const [now] = useState(() => Date.now())
  const at = new Date(moved.at)
  const when =
    now - at.getTime() < DAY ? 'today' : `on ${at.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
  return (
    <span className="inline-flex items-center gap-1.5 text-zinc-400">
      <SourceMark id={moved.source} className="h-[13px] w-[13px] text-zinc-400" />
      Moved from {SOURCES[moved.source].name} {when}
    </span>
  )
}

export function MovedNotice({ projects }: { projects: Project[] }) {
  const [dismissed, setDismissed] = useState<string[]>([])
  const project = projects.find(
    (p) => p.importedFrom && p.importedFrom.rulesPending > 0 && !dismissed.includes(p.id),
  )
  if (!project?.importedFrom) return null
  const moved = project.importedFrom
  const from = SOURCES[moved.source].name

  return (
    <section
      aria-label={`${project.name} moved from ${from}`}
      className="mb-4 flex flex-col gap-3 rounded-[10px] border border-white/[0.08] bg-[#0f1012] px-4 py-3.5 sm:flex-row sm:items-center sm:gap-4 sm:px-5"
    >
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <SourceMark id={moved.source} className="mt-[3px] h-[14px] w-[14px] text-zinc-400" />
        <p className="min-w-0 text-[13px] leading-[20px] text-zinc-400 [text-wrap:pretty]">
          <span className="font-medium text-zinc-100">
            <Link href={`/app/projects/${project.id}`} className="hover:underline">
              {project.name}
            </Link>{' '}
            moved from {from}.
          </span>{' '}
          All {n(moved.tables)} tables match their source. Approve its {n(moved.rulesPending)} access rules to open the tables
          to your app.
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1.5 pl-[26px] sm:pl-0">
        <KitButtonLink href={`/app/projects/${project.id}/auth`} variant="secondary">
          Review access rules
        </KitButtonLink>
        <IconButton icon={X} label="Dismiss" onClick={() => setDismissed((d) => [...d, project.id])} />
      </div>
    </section>
  )
}
