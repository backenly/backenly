'use client'

/**
 * The projects: a grid of cards (ProjectCard), one per project, three across
 * from 1280 px. The founder's call (2026-11-16): one project as a row across
 * the whole page looked unfinished; Supabase and its peers lay projects out as
 * cards. Each card writes its state out beside its mark (StatusGlyph: ● live,
 * ○ not published, ◐ deploying or importing, ‖ paused, ✕ failed), so there is
 * no legend.
 *
 * A project being moved in (lib/import) says "◐ Importing" and how far, and
 * its row opens the import's own page until it is done; one whose import
 * ended without finishing in the last day says so the same way. Once moved,
 * a project with no description of its own says where it came from.
 */

import { type ReactNode } from 'react'
import Link from 'next/link'
import { Pencil, Trash2 } from 'lucide-react'
import type { Project } from '@/lib/api/projects'
import type { ImportProgress } from '@/lib/import/contract'
import { fractionOf, isRunning } from '@/lib/import/client'
import { KitButtonLink, OverflowMenu, Skeleton, StatusGlyph, type GlyphState } from '@/components/inspector/kit'
import { EDGE, PLATE, RULE, R_PANEL } from '@/components/console/tokens'
import { LoopMark } from '@/components/console/LoopMark'
import { MovedLine } from '@/components/migrate/MovedNotice'
import { SOURCES, SourceMark } from '@/components/migrate/sources'
import { checkedAgo, lastUsed, regionOf, tables } from './labels'
import type { LiveStatus } from './useLiveStatus'

// ─── State ───────────────────────────────────────────────────────────────────

interface StateOf {
  glyph: GlyphState
  label: string
  /** Written out next to the name: only the states that ask for something. */
  shown: boolean
  tone: string
}

/** The project's state, in the words the top bar's project switcher uses. */
export function stateOf(project: Project): StateOf {
  // A paused project's API refuses every call, so its publish status would
  // mislead. Paused is a state, not an alarm.
  if (project.pausedAt) return { glyph: 'paused', label: 'Paused', shown: true, tone: 'text-zinc-300' }
  switch (project.projectStatus) {
    case 'LIVE':
      return { glyph: 'live', label: 'Live', shown: false, tone: '' }
    case 'DEPLOYING':
      return { glyph: 'busy', label: 'Deploying', shown: true, tone: 'text-zinc-50' }
    case 'FAILED':
      return { glyph: 'failed', label: 'Failed', shown: true, tone: 'text-zinc-50' }
    default:
      return { glyph: 'idle', label: 'Not published', shown: false, tone: '' }
  }
}

/** An import in progress, or one that ended without finishing, comes before the project's own state. */
function importStateOf(job: ImportProgress | null | undefined): StateOf | null {
  if (!job) return null
  if (isRunning(job)) return { glyph: 'busy', label: 'Importing', shown: true, tone: 'text-zinc-50' }
  if (job.status === 'failed') return { glyph: 'failed', label: 'Import failed', shown: true, tone: 'text-zinc-50' }
  if (job.status === 'canceled') return { glyph: 'paused', label: 'Import stopped', shown: true, tone: 'text-zinc-300' }
  return null
}

/** The line under an importing project's name: where it comes from and how far it is. */
function ImportLine({ job }: { job: ImportProgress }) {
  const from = SOURCES[job.source].name
  if (isRunning(job)) {
    return (
      <p className="flex min-w-0 items-center gap-x-[10px] text-[13px] leading-[20px]">
        <span className="inline-flex min-w-0 items-center gap-1.5 text-zinc-400">
          <SourceMark id={job.source} className="h-[13px] w-[13px]" />
          <span className="truncate">Moving in from {from}</span>
        </span>
        <span className="flex-shrink-0 tabular-nums text-faint">{Math.floor(fractionOf(job) * 100)}%</span>
      </p>
    )
  }
  const said = job.status === 'failed' ? job.error || `The import from ${from} stopped.` : 'Stopped before it finished.'
  return (
    <p title={said} className="truncate text-[13px] leading-[20px] text-zinc-400">
      {said}
    </p>
  )
}

// ─── Panel (messages) ────────────────────────────────────────────────────────

/** One panel for a message in place of projects: a failed read, no projects, no match. */
export function ProjectsPanel({ children }: { children: ReactNode }) {
  return <div className={`border ${EDGE} ${R_PANEL} ${PLATE}`}>{children}</div>
}

// ─── Grid ────────────────────────────────────────────────────────────────────
// Cards, as Supabase lays out its projects: one column on a phone, two beside
// the sidebar, three from 1280 px. A single project is one card, never a row
// stretched across the page (the founder's call, 2026-11-16).

const GRID = 'grid grid-cols-1 gap-[14px] md:grid-cols-2 xl:grid-cols-3'
const CARD = `relative flex min-h-[176px] flex-col border ${EDGE} ${R_PANEL} ${PLATE} transition-colors duration-150`

export function ProjectGrid({ children }: { children: ReactNode }) {
  return <ul className={GRID}>{children}</ul>
}

/** Card-shaped placeholders, the same size as the cards they stand in for. */
export function SkeletonCards({ count = 3 }: { count?: number }) {
  return (
    <ul className={GRID} aria-hidden>
      {Array.from({ length: count }, (_, i) => (
        <li key={i} className={CARD}>
          <div className="flex flex-1 flex-col px-[20px] pt-[18px]">
            <Skeleton className={`h-[14px] ${['w-[132px]', 'w-[104px]', 'w-[148px]'][i % 3]}`} />
            <Skeleton className={`mt-[10px] h-[12px] ${['w-[220px]', 'w-[180px]', 'w-[160px]'][i % 3]} max-w-full`} />
            <Skeleton className="mb-[16px] mt-auto h-[12px] w-[168px]" />
          </div>
          <div className={`flex h-[44px] items-center border-t ${RULE} px-[20px]`}>
            <Skeleton className="h-[11px] w-[120px]" />
          </div>
        </li>
      ))}
    </ul>
  )
}

// ─── Card ────────────────────────────────────────────────────────────────────

export interface RowActions {
  canRename: boolean
  canDelete: boolean
  onStartRename: () => void
  onDelete: () => void
}

export interface RenameState {
  value: string
  onChange: (value: string) => void
  onSubmit: () => void
  onCancel: () => void
}

/** The waiting mark, drawn here so a link's name is its words alone. */
function Diamond() {
  return (
    <svg aria-hidden viewBox="0 0 12 12" className="h-[11px] w-[11px] flex-shrink-0 text-zinc-50" fill="none">
      <path d="M6 1.8 10.2 6 6 10.2 1.8 6Z" fill="currentColor" />
    </svg>
  )
}

function WaitingLink({ projectId, count }: { projectId: string; count: number }) {
  return (
    <Link
      href={`/app/projects/${projectId}/autonomy`}
      className="relative z-10 inline-flex items-center gap-[6px] rounded-[4px] text-[12.5px] font-medium leading-[20px] text-zinc-50 transition-colors hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
    >
      <Diamond />
      {count} waiting on you
    </Link>
  )
}

/**
 *   checkout-api                                     ⋯
 *   Orders, carts and payments for the web store.
 *
 *   ● Live    N. Virginia    14 tables
 *   ─────────────────────────────────────────────────
 *   ◆ 2 waiting on you                  Used 1 h ago
 *
 * The name is the card's link and covers the whole card, so the card opens the
 * project and Cmd-click opens a tab; the menu, the waiting link and Connect
 * agent sit above it. The state is written out beside its mark on every card,
 * so no legend is needed. The footer is Backenly's side: what waits on you,
 * else when the loop last checked (its ring), else when the project was last
 * used. A project with nothing built offers Connect agent there instead.
 */
export function ProjectCard({
  project,
  live,
  liveSettled,
  now,
  region,
  actions,
  rename,
  renameError,
  job = null,
  jobHref = null,
}: {
  project: Project
  /** This project's live state, once GET /api/projects/status has answered. */
  live: LiveStatus | undefined
  /** The live read has finished, answered or not. */
  liveSettled: boolean
  now: number
  region: boolean
  actions: RowActions
  /** Set while the name is being edited in place. */
  rename: RenameState | null
  renameError: string | null
  /** The project's newest import (GET /api/import?orgId=), when it has one. */
  job?: ImportProgress | null
  /** The import's own page, which the card opens while the import is not done. */
  jobHref?: string | null
}) {
  const importing = importStateOf(job)
  const state = importing ?? stateOf(project)
  const href = importing && jobHref ? jobHref : `/app/projects/${project.id}`
  const description = project.description?.trim()
  const place = regionOf(project.region)
  const used = lastUsed(project.lastActivityAt, now)
  const tableCount = project.metrics?.totalTables
  const waiting = live?.waiting ?? 0
  const checked = checkedAgo(live?.lastCheckAt, now)
  // Nothing built yet: the next step instead of empty facts. A project being
  // moved in is not empty: its tables are on their way.
  const unbuilt = tableCount === 0 && !importing
  const agentConnected = !!live?.agentLastSeenAt
  const running = job && isRunning(job)
  const attention = state.glyph === 'failed' || state.glyph === 'busy'

  const menu: Array<{ separator: true } | { label: string; icon: typeof Pencil; onClick: () => void; danger?: boolean }> = []
  if (actions.canRename) menu.push({ label: 'Rename', icon: Pencil, onClick: actions.onStartRename })
  if (actions.canRename && actions.canDelete) menu.push({ separator: true })
  if (actions.canDelete) menu.push({ label: 'Delete', icon: Trash2, onClick: actions.onDelete, danger: true })

  // The line under the name: what the project is, where it comes from, or its next step.
  const subline =
    importing && job ? (
      <ImportLine job={job} />
    ) : description ? (
      <p title={description} className="line-clamp-2 text-[13px] leading-[20px] text-zinc-400">
        {description}
      </p>
    ) : project.importedFrom ? (
      <p className="truncate text-[13px] leading-[20px]">
        <MovedLine moved={project.importedFrom} />
      </p>
    ) : unbuilt ? (
      <p className={`text-[13px] leading-[20px] text-zinc-400 transition-opacity duration-200 ${liveSettled ? 'opacity-100' : 'opacity-0'}`}>
        {agentConnected ? 'Your agent is connected. Ask it to build the first table.' : 'Connect your coding agent to build it.'}
      </p>
    ) : null

  const connectAgent = unbuilt && liveSettled && !agentConnected
  const usedLine = (
    <span title={used.exact ?? undefined} className="truncate tabular-nums">
      {used.fact}
    </span>
  )

  return (
    <li className={`${CARD} ${rename ? '' : 'hover:border-white/[0.14] hover:bg-[#121316]'}`}>
      <div className="flex flex-1 flex-col px-[20px] pt-[16px]">
        <div className="flex min-w-0 items-start justify-between gap-[12px]">
          {rename ? (
            <input
              value={rename.value}
              onChange={(e) => rename.onChange(e.target.value)}
              onBlur={rename.onSubmit}
              onKeyDown={(e) => {
                if (e.key === 'Enter') rename.onSubmit()
                if (e.key === 'Escape') rename.onCancel()
              }}
              onFocus={(e) => e.currentTarget.select()}
              aria-label="Project name"
              maxLength={100}
              autoFocus
              className="relative z-10 -mx-[8px] h-[28px] w-full min-w-0 rounded-[6px] border border-white/30 bg-[#08090a] px-2 text-[16px] font-medium text-zinc-50 outline-none ring-[3px] ring-white/[0.08] sm:text-[14.5px]"
            />
          ) : (
            <Link
              href={href}
              title={project.name}
              className="min-w-0 truncate pt-[2px] text-[14.5px] font-medium leading-[22px] tracking-[-0.008em] text-zinc-50 focus-visible:outline-none after:absolute after:inset-0 after:rounded-[9px] after:content-[''] focus-visible:after:ring-2 focus-visible:after:ring-inset focus-visible:after:ring-white/70"
            >
              {project.name}
            </Link>
          )}
          <div className="relative z-10 -mr-[8px] flex h-[28px] w-[28px] flex-shrink-0 justify-end">
            {menu.length > 0 && <OverflowMenu label={`Actions for ${project.name}`} items={menu} width="w-[168px]" />}
          </div>
        </div>

        {renameError && (
          <p role="alert" className="mt-1 text-[12.5px] leading-[18px] text-rose-300">
            {renameError}
          </p>
        )}

        {subline && <div className="mt-[4px] min-w-0">{subline}</div>}

        {/* The facts: the state in words beside its mark, where it runs, how big it is. */}
        <div className="mb-[14px] mt-auto flex min-w-0 flex-wrap items-center gap-x-[16px] gap-y-[4px] pt-[14px] text-[12.5px] leading-[18px] text-zinc-400">
          <span className={`inline-flex items-center gap-[6px] ${attention ? 'font-medium text-zinc-50' : state.glyph === 'live' ? 'text-zinc-300' : ''}`}>
            <StatusGlyph state={state.glyph} label="" />
            {state.label}
          </span>
          {region && (
            <span title={place.id} className="truncate">
              {place.city}
            </span>
          )}
          {typeof tableCount === 'number' && !unbuilt && !importing && <span className="tabular-nums">{tables(tableCount)}</span>}
        </div>
      </div>

      {/* Backenly's side: what waits on you, when the loop last checked, or the next step. */}
      <div className={`flex min-h-[44px] items-center justify-between gap-[12px] border-t ${RULE} px-[20px] py-[8px] text-[12.5px] leading-[18px] text-faint`}>
        {running && job ? (
          <span className="flex w-full items-center gap-[10px]" aria-hidden>
            <span className="h-[3px] flex-1 overflow-hidden rounded-full bg-white/[0.08]">
              <span className="block h-full rounded-full bg-zinc-200 transition-[width] duration-500" style={{ width: `${Math.max(2, Math.floor(fractionOf(job) * 100))}%` }} />
            </span>
          </span>
        ) : (
          <>
            <span className="flex min-w-0 items-center gap-[8px]">
              {waiting > 0 ? (
                <WaitingLink projectId={project.id} count={waiting} />
              ) : checked ? (
                <>
                  <LoopMark state="still" size={12} />
                  <span className="truncate tabular-nums">{checked}</span>
                </>
              ) : (
                usedLine
              )}
            </span>
            {connectAgent ? (
              <span className="relative z-10 flex-shrink-0">
                <KitButtonLink href={`/app/projects/${project.id}/connect`} size="sm">
                  Connect agent
                </KitButtonLink>
              </span>
            ) : waiting > 0 || checked ? (
              <span className="flex-shrink-0">{usedLine}</span>
            ) : null}
          </>
        )}
      </div>
    </li>
  )
}
