'use client'

/**
 * TopBar: the single persistent bar across the project workspace.
 *
 *   ≡ ▣ / team Free ⌃ / ● project ⌃        [Connect agent]  Search ⌘K  ▢◆  Ask ⌘J  (A)
 *
 * Location and global tools, nothing else (project console decisions,
 * 2026-11-16):
 *
 * - The team crumb, its plan and the project switcher are the project's own
 *   team (organizationId), never just the one the browser last remembered.
 * - The switcher lists only that team's projects, each led by its state glyph,
 *   with words only for Paused, Failed and Deploying, a search field from six
 *   projects, and "New project", which opens the team's create flow.
 * - Search ⌘K, an icon button below `lg`.
 * - The inbox opens Autonomy's queue. A white ◆ when anything waits, counted
 *   by useWaitingCount, the same count Overview and Autonomy show. No number
 *   (the founder's no-badge rule); the tooltip says "2 waiting on your approval".
 * - Ask ⌘J toggles the Q&A assistant, which answers and never builds.
 * - "Connect agent": one secondary button while this person's agent has never
 *   connected, on every page but Overview and Connect (both carry the setup
 *   themselves), and only for someone who can create keys (ADMIN and above,
 *   the floor of POST /mcp/keys). On a phone it is a plug icon with the same
 *   name. Once an agent connects, its state lives on the sidebar's Connect item.
 *
 * Removed: the "Production" chip (fixed green text, so a brand-new project read
 * "● Not published" on the page under "● Production" in the bar) and the agent
 * slot ("Last call 12 minutes ago", 170px of text, an empty box on a phone).
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState, useTransition, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import Link from 'next/link'
import { useParams, usePathname, useRouter } from 'next/navigation'
import { AnimatePresence, motion } from 'framer-motion'
import { Cable, Check, ChevronsUpDown, FolderKanban, Inbox, MessageSquare, Plus, Search } from 'lucide-react'
import { useAssistantStore } from '@/lib/stores/use-assistant-store'
import { CLOUD_CONTROL_PLANE } from '@cloud/control-plane'
import { getProject, getProjects, type Project } from '@/lib/api/projects'
import {
  BUTTON_BASE,
  BUTTON_VARIANTS,
  INPUT_BASE,
  Kbd,
  MenuItem,
  MenuSeparator,
  Skeleton,
  StatusGlyph,
  useDismiss,
  type GlyphState,
} from '@/components/inspector/kit'
import { FLOAT, FOCUS, RAISE, R_CONTROL } from '@/components/console/tokens'
import { useAgentConnection } from '@/lib/hooks/useAgentConnection'
import { useProjectRole } from '@/lib/hooks/useProjectRole'
import { useWaitingCount } from '@/lib/hooks/useWaitingCount'
import { AccountMenu, AccountScope, BrandHome, ConsoleBar, Crumb, MobileNavButton, SearchTrigger } from './ConsoleChrome'

// ── Project state, as the switcher says it ───────────────────────────────────

export interface SwitcherState {
  glyph: GlyphState
  /** Always given to screen readers. */
  label: string
  /** Written out only for the states that ask for something. */
  word: string | null
  tone: string
}

/**
 * A project's state in the switcher: the glyph always, the word only for
 * Paused, Deploying and Failed. The same words and glyphs as the Projects list
 * (components/projects/ProjectList.tsx stateOf). Paused wins: a paused
 * project's API refuses every call, so its publish status would mislead.
 */
export function switcherState(project: Pick<Project, 'projectStatus' | 'pausedAt'>): SwitcherState {
  if (project.pausedAt) return { glyph: 'paused', label: 'Paused', word: 'Paused', tone: 'text-zinc-300' }
  switch (project.projectStatus) {
    case 'LIVE':
      return { glyph: 'live', label: 'Live', word: null, tone: '' }
    case 'DEPLOYING':
      return { glyph: 'busy', label: 'Deploying', word: 'Deploying', tone: 'text-zinc-50' }
    case 'FAILED':
      return { glyph: 'failed', label: 'Failed', word: 'Failed', tone: 'text-zinc-50' }
    default:
      return { glyph: 'idle', label: 'Not published', word: null, tone: '' }
  }
}

/** The switcher asks for a search field from this many projects. */
export const SWITCHER_SEARCH_AT = 6

/** The open project's team's projects, in the list's order. A project with no team goes with the others that have none. */
export function teamProjects(all: Project[], teamId: string | null): Project[] {
  return all.filter((p) => (p.organizationId ?? null) === teamId)
}

// ── Project switcher ─────────────────────────────────────────────────────────

function ProjectSwitcher({ projectId }: { projectId: string }) {
  const router = useRouter()
  const [, startTransition] = useTransition()
  const role = useProjectRole(projectId)
  const [list, setList] = useState<Project[] | null>(null)
  const [listFailed, setListFailed] = useState(false)
  const [current, setCurrent] = useState<Project | null>(null)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const triggerRef = useRef<HTMLButtonElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const headingId = useId()
  const menuId = useId()

  const close = useCallback((returnFocus = false) => {
    setOpen(false)
    setQuery('')
    if (returnFocus) triggerRef.current?.focus()
  }, [])
  const dismiss = useCallback(() => close(), [close])
  const ref = useDismiss(open, dismiss)

  useEffect(() => {
    let cancelled = false
    getProjects()
      .then((all) => {
        if (!cancelled) setList(all)
      })
      .catch(() => {
        if (cancelled) return
        setList([])
        setListFailed(true)
      })
    // The project's own read, shared with the role and the page (one request):
    // the crumb names the open project even before the list arrives.
    getProject(projectId)
      .then((p) => {
        if (!cancelled) setCurrent(p)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [projectId])

  const here = current ?? list?.find((p) => p.id === projectId) ?? null
  const teamId = here ? (here.organizationId ?? null) : role.organizationId
  const projects = useMemo(() => (list ? teamProjects(list, teamId) : []), [list, teamId])
  const searchable = projects.length >= SWITCHER_SEARCH_AT
  const needle = query.trim().toLowerCase()
  const shown = needle ? projects.filter((p) => p.name.toLowerCase().includes(needle)) : projects

  // Opened: the search field takes focus when there is one, else the first
  // item. Not the field on a touch screen, where focusing it would raise the
  // keyboard over the list the person opened the menu to see.
  useEffect(() => {
    if (!open) return
    const frame = requestAnimationFrame(() => {
      const touch = typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches
      if (inputRef.current && !touch) inputRef.current.focus()
      else menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [open])

  const go = (href: string) => {
    close()
    startTransition(() => router.push(href))
  }

  const teamBase = teamId ? `/app/org/${encodeURIComponent(teamId)}` : '/app'
  const state = here ? switcherState(here) : null

  // Up and down move through the items; down from the search field enters them.
  const onMenuKey = (e: ReactKeyboardEvent<HTMLElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      close(true)
      return
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])
    if (items.length === 0) return
    e.preventDefault()
    const at = items.indexOf(document.activeElement as HTMLElement)
    const next = e.key === 'ArrowDown' ? (at + 1) % items.length : at <= 0 ? items.length - 1 : at - 1
    items[next].focus()
  }

  return (
    <div className="relative min-w-0" ref={ref}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => (open ? close() : setOpen(true))}
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={here && state ? `Project: ${here.name}, ${state.label.toLowerCase()}. Switch project` : 'Switch project'}
        // w-full: a button sizes to its content, so without it a long name ran
        // under the tools on a phone instead of truncating.
        className={`flex h-[32px] w-full min-w-0 max-w-[240px] items-center gap-2 ${R_CONTROL} px-2 transition-colors hover:bg-white/[0.05] ${FOCUS}`}
      >
        {here && state ? (
          <>
            <StatusGlyph state={state.glyph} label={state.label} />
            <span className="truncate text-[13px] font-medium text-zinc-100">{here.name}</span>
          </>
        ) : (
          <Skeleton className="h-[14px] w-[96px]" />
        )}
        <ChevronsUpDown aria-hidden className="h-3.5 w-3.5 flex-shrink-0 text-zinc-500" strokeWidth={1.75} />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -4, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.98 }}
            transition={{ duration: 0.14, ease: [0.16, 1, 0.3, 1] }}
            onKeyDown={onMenuKey}
            // A phone gets the bar's width less a 12px gutter; wider, a 300px menu under the crumb.
            className={`fixed inset-x-3 top-[calc(var(--console-bar)-2px)] z-40 origin-top overflow-hidden rounded-[10px] ${RAISE} ${FLOAT} p-1 sm:absolute sm:inset-x-auto sm:left-0 sm:top-full sm:mt-1.5 sm:w-[300px] sm:origin-top-left`}
          >
            <p id={headingId} className="px-2.5 pb-1 pt-1.5 text-[12px] font-medium text-faint">
              Projects
            </p>
            {searchable && (
              <div className="relative px-1 pb-1">
                <Search aria-hidden className="pointer-events-none absolute left-[14px] top-1/2 h-3.5 w-3.5 -translate-y-[calc(50%+2px)] text-zinc-500" strokeWidth={2} />
                <input
                  ref={inputRef}
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && shown[0]) {
                      e.preventDefault()
                      go(`/app/projects/${shown[0].id}`)
                    }
                  }}
                  aria-label="Find a project"
                  aria-controls={menuId}
                  placeholder="Find a project"
                  autoComplete="off"
                  spellCheck={false}
                  className={`${INPUT_BASE} h-[32px] pl-8 pr-2.5 [&::-webkit-search-cancel-button]:hidden`}
                />
              </div>
            )}
            {shown.length === 0 && (
              <p className="px-2.5 py-2 text-[13px] text-faint">
                {list === null
                  ? 'Loading projects…'
                  : listFailed
                    ? 'Could not load your projects.'
                    : needle
                      ? `No project matches “${query.trim()}”.`
                      : 'No projects in this team.'}
              </p>
            )}
            <div ref={menuRef} id={menuId} role="menu" aria-labelledby={headingId}>
              {shown.length > 0 && (
                <div role="none" className="max-h-[296px] overflow-y-auto">
                  {shown.map((p) => {
                    const active = p.id === projectId
                    const s = switcherState(p)
                    return (
                      <MenuItem
                        key={p.id}
                        onClick={() => (active ? close(true) : go(`/app/projects/${p.id}`))}
                        trailing={
                          s.word || active ? (
                            <span className="flex flex-shrink-0 items-center gap-2">
                              {s.word && <span className={`text-[12px] ${s.tone}`}>{s.word}</span>}
                              {active && (
                                <>
                                  <Check aria-hidden className="h-4 w-4 text-zinc-200" strokeWidth={2} />
                                  <span className="sr-only">, open now</span>
                                </>
                              )}
                            </span>
                          ) : undefined
                        }
                      >
                        <span className="flex min-w-0 items-center gap-2.5">
                          {/* The word is on the row when it matters; otherwise the glyph says it to screen readers. */}
                          <StatusGlyph state={s.glyph} label={s.word ? '' : s.label} />
                          <span className="truncate">{p.name}</span>
                        </span>
                      </MenuItem>
                    )
                  })}
                </div>
              )}
              <MenuSeparator />
              <MenuItem icon={FolderKanban} onClick={() => go(CLOUD_CONTROL_PLANE ? teamBase : '/app')}>
                All projects
              </MenuItem>
              {/* Creating happens on the team's Projects page, which opens its
                  create flow from ?new=1. A self-hosted deployment is one
                  project, so it has nothing to create. */}
              {CLOUD_CONTROL_PLANE && (
                <MenuItem icon={Plus} onClick={() => go(`${teamBase}?new=1`)}>
                  New project
                </MenuItem>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

// ── Inbox ────────────────────────────────────────────────────────────────────

/**
 * The review inbox: Autonomy's queue. Lit by a white ◆ when anything waits on
 * a decision, never by a number (no count badges, founder, 2026-07-23): the
 * count is in the tooltip and on the queue itself.
 */
function InboxLink({ projectId }: { projectId: string }) {
  const waiting = useWaitingCount(projectId)
  const n = waiting.total ?? 0
  const said = n > 0 ? `${n.toLocaleString('en-US')} waiting on your approval` : null
  return (
    <Link
      href={`/app/projects/${projectId}/autonomy`}
      data-tour="review-inbox"
      title={said ?? 'Review queue'}
      aria-label={said ? `Review queue, ${said}` : 'Review queue'}
      className={`relative inline-flex h-[32px] w-[32px] flex-shrink-0 items-center justify-center ${R_CONTROL} transition-colors hover:bg-white/[0.05] hover:text-zinc-100 ${FOCUS} ${
        n > 0 ? 'text-zinc-100' : 'text-zinc-400'
      }`}
    >
      <Inbox aria-hidden className="h-4 w-4" strokeWidth={1.75} />
      {n > 0 && (
        <svg aria-hidden data-waiting viewBox="0 0 10 10" className="absolute right-[4px] top-[4px] h-[10px] w-[10px] text-zinc-50">
          {/* The bar's own colour as a ring, so the ◆ reads apart from the tray it sits on. */}
          <path d="M5 0.9 9.1 5 5 9.1 0.9 5Z" fill="currentColor" stroke="#08090a" strokeWidth="1.6" strokeLinejoin="round" />
        </svg>
      )}
    </Link>
  )
}

// ── Unpublished draft indicator ──────────────────────────────────────────────

/**
 * Unpublished draft indicator: displays when working draft differs from published
 * version or has pending changes, so developers immediately notice when they are behind.
 */
function UnpublishedDraftPill({ projectId }: { projectId: string }) {
  const [hasDrift, setHasDrift] = useState(false)
  const pathname = usePathname() ?? ''

  useEffect(() => {
    let cancelled = false
    const checkDrift = () => {
      fetch(`/api/projects/${projectId}/rollback`, { credentials: 'include' })
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => {
          if (cancelled || !data?.versions) return
          const versions = data.versions
          const drifted = versions.length > 0 && !versions.some((v: any) => v.isActive)
          setHasDrift(drifted)
        })
        .catch(() => {})
    }
    checkDrift()
    const timer = setInterval(checkDrift, 15000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [projectId])

  // Don't show while on the deploy page itself
  if (!hasDrift || pathname.endsWith('/deploy')) return null

  return (
    <Link
      href={`/app/projects/${projectId}/deploy`}
      title="Working draft has unpublished changes. Click to review and deploy."
      className="hidden sm:inline-flex items-center gap-1.5 h-[28px] px-2.5 rounded-full bg-amber-500/10 border border-amber-500/25 text-amber-300 text-[12px] font-medium transition-colors hover:bg-amber-500/20 hover:border-amber-500/40"
    >
      <span className="h-1.5 w-1.5 rounded-full bg-amber-400 motion-safe:animate-pulse" />
      <span>Unpublished draft</span>
      <span className="text-amber-400/80 font-normal">Publish →</span>
    </Link>
  )
}

// ── Connect agent ────────────────────────────────────────────────────────────

/**
 * The bar's one way to connect, while this person's agent never has. Nothing
 * while either answer (the agent, the role) is still on its way, so it never
 * flashes in and out; it sits first in the right-hand group, so appearing
 * there moves none of the tools.
 */
function ConnectAgentButton({ projectId }: { projectId: string }) {
  const pathname = usePathname() ?? ''
  const agent = useAgentConnection(projectId)
  const role = useProjectRole(projectId)
  const base = `/app/projects/${projectId}`
  // Overview and Connect carry the setup on the page.
  const setupHere =
    pathname === base || pathname === `${base}/` || pathname.startsWith(`${base}/connect`) || pathname.startsWith(`${base}/mcp`)
  if (setupHere || !agent.needsConnect || !role.canAdminister) return null
  return (
    <Link
      href={`${base}/connect`}
      title="Connect agent"
      className={`${BUTTON_BASE} ${BUTTON_VARIANTS.secondary} h-[32px] w-[32px] flex-shrink-0 px-0 text-[13px] sm:w-auto sm:px-2.5`}
    >
      <Cable aria-hidden className="h-[15px] w-[15px]" strokeWidth={1.75} />
      <span className="sr-only sm:not-sr-only">Connect agent</span>
    </Link>
  )
}

// ── Bar ──────────────────────────────────────────────────────────────────────

export function TopBar() {
  const params = useParams()
  const projectId = params.id as string

  const assistantOpen = useAssistantStore((s) => s.open)
  const toggleAssistant = useAssistantStore((s) => s.toggle)

  // ⌘/Ctrl+J — toggle the assistant from anywhere in the workspace.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'j') {
        e.preventDefault()
        toggleAssistant()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [toggleAssistant])

  return (
    <ConsoleBar>
      <MobileNavButton />
      <BrandHome />

      <div className="hidden min-w-0 items-center sm:flex">
        <Crumb />
        <AccountScope />
      </div>
      {/* On a phone the logo and the project glyph already read as a path. */}
      <Crumb className="hidden sm:block" />

      <ProjectSwitcher projectId={projectId} />

      {/* ── Right cluster ────────────────────────────────────────────────── */}
      <div className="ml-auto flex flex-shrink-0 items-center gap-1 sm:gap-1.5">
        {projectId && <UnpublishedDraftPill projectId={projectId} />}
        <ConnectAgentButton projectId={projectId} />
        <SearchTrigger />
        <InboxLink projectId={projectId} />

        {/* Assistant — the Q&A helper (answers, never builds). ⌘J does the same. */}
        <button
          type="button"
          data-assistant-toggle
          onClick={toggleAssistant}
          title={assistantOpen ? 'Hide the assistant (⌘J)' : 'Ask how anything works (⌘J)'}
          aria-label="Ask"
          aria-pressed={assistantOpen}
          className={`${BUTTON_BASE} h-[32px] min-w-[32px] flex-shrink-0 px-2 text-[13px] sm:px-2.5 ${
            assistantOpen ? 'bg-white/[0.10] text-zinc-50' : 'text-zinc-400 hover:bg-white/[0.05] hover:text-zinc-100'
          }`}
        >
          <MessageSquare aria-hidden className="h-[15px] w-[15px]" strokeWidth={1.75} />
          <span aria-hidden className="hidden sm:inline">Ask</span>
          <Kbd className="ml-0.5 hidden xl:inline-flex">⌘J</Kbd>
        </button>

        <AccountMenu />
      </div>
    </ConsoleBar>
  )
}
