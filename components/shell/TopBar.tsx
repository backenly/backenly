'use client'

/**
 * TopBar: the single persistent bar across the project workspace.
 *
 *   ◆ / account Pro / ● project ▾  Production       Search ⌘K  ⎔  Ask  Connect agent  (A)
 *
 * The breadcrumb names where you are; the right cluster holds the only
 * global actions. "Ask" toggles the Q&A Assistant (⌘/Ctrl+J), which answers
 * platform questions and never builds. Building goes through the one door:
 * the user's coding agent over MCP (Connect agent, the primary action).
 *
 * The environment label is honest: one environment today. Its tooltip names
 * the AWS region only on Backenly Cloud, because a self-hosted deployment runs
 * wherever its operator put it.
 */

import { useCallback, useEffect, useState, useTransition } from 'react'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { AnimatePresence } from 'framer-motion'
import { Cable, Check, ChevronsUpDown, Inbox, Plus, Sparkles } from 'lucide-react'
import { useAssistantStore } from '@/lib/stores/use-assistant-store'
import { CLOUD_CONTROL_PLANE } from '@cloud/control-plane'
import { getProjects, type Project } from '@/lib/api/projects'
import { BUTTON_BASE, BUTTON_VARIANTS, Kbd } from '@/components/inspector/kit'
import { FOCUS, R_CONTROL } from '@/components/console/tokens'
import {
  AccountMenu,
  AccountScope,
  BrandHome,
  ConsoleBar,
  Crumb,
  MenuItem,
  MenuPanel,
  MenuSeparator,
  MobileNavButton,
  SearchTrigger,
  useDismiss,
} from './ConsoleChrome'

const STATUS_DOT: Record<string, string> = {
  LIVE: 'bg-emerald-400',
  DEPLOYING: 'bg-amber-400',
  FAILED: 'bg-rose-400',
  PRIVATE: 'bg-zinc-500',
}

const STATUS_LABEL: Record<string, string> = {
  LIVE: 'Live',
  DEPLOYING: 'Deploying',
  FAILED: 'Failed',
  PRIVATE: 'Not published',
}

export function TopBar() {
  const params = useParams()
  const router = useRouter()
  const projectId = params.id as string
  const basePath = `/app/projects/${projectId}`

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

  const [, startTransition] = useTransition()
  const [projects, setProjects] = useState<Project[]>([])
  const [pendingReview, setPendingReview] = useState(0)
  const [projectMenu, setProjectMenu] = useState(false)
  const closeProjectMenu = useCallback(() => setProjectMenu(false), [])
  const projectMenuRef = useDismiss(projectMenu, closeProjectMenu)

  const currentProject = projects.find((p) => p.id === projectId)
  const status = currentProject?.projectStatus ?? 'PRIVATE'

  useEffect(() => {
    getProjects().then(setProjects).catch(() => {})
  }, [])

  // Review inbox — lit only when a change is actually waiting on the user.
  useEffect(() => {
    if (!projectId) return
    let cancelled = false
    async function poll() {
      try {
        const res = await fetch(`/api/projects/${projectId}/health`, { credentials: 'include' })
        if (!res.ok) return
        const j = await res.json()
        const findings = j.data?.findings ?? []
        const pending = findings.filter((f: any) => f.status === 'pending_approval').length
        if (!cancelled) setPendingReview(pending)
      } catch {
        /* silent */
      }
    }
    poll()
    const t = setInterval(poll, 30_000)
    return () => {
      cancelled = true
      clearInterval(t)
    }
  }, [projectId])

  const go = (href: string) => startTransition(() => router.push(href))

  return (
    <ConsoleBar>
      <MobileNavButton />
      <BrandHome />

      <div className="hidden min-w-0 items-center sm:flex">
        <Crumb />
        <AccountScope />
      </div>
      <Crumb />

      {/* Project switcher */}
      <div className="relative min-w-0" ref={projectMenuRef}>
        <button
          type="button"
          onClick={() => setProjectMenu((o) => !o)}
          aria-haspopup="menu"
          aria-expanded={projectMenu}
          className={`flex h-[32px] min-w-0 max-w-[160px] items-center gap-2 ${R_CONTROL} px-2 transition-colors hover:bg-white/[0.05] sm:max-w-[240px] ${FOCUS}`}
        >
          <span className={`h-[7px] w-[7px] flex-shrink-0 rounded-full ${STATUS_DOT[status]}`} aria-hidden />
          <span className="truncate text-[13px] font-medium text-zinc-100">{currentProject?.name ?? 'Project'}</span>
          <ChevronsUpDown className="h-3.5 w-3.5 flex-shrink-0 text-zinc-500" strokeWidth={1.75} />
        </button>

        <AnimatePresence>
          {projectMenu && (
            <MenuPanel width="w-[300px]">
              <p className="px-2.5 pb-1 pt-1.5 text-[12px] font-medium text-zinc-500">Projects</p>
              <div className="max-h-[320px] overflow-y-auto">
                {projects.map((p) => {
                  const active = p.id === projectId
                  const s = p.projectStatus ?? 'PRIVATE'
                  return (
                    <MenuItem
                      key={p.id}
                      onClick={() => {
                        setProjectMenu(false)
                        go(`/app/projects/${p.id}`)
                      }}
                      trailing={
                        active ? (
                          <Check className="h-4 w-4 flex-shrink-0 text-zinc-200" strokeWidth={2} />
                        ) : (
                          <span className="text-[12px] text-zinc-600">{STATUS_LABEL[s]}</span>
                        )
                      }
                    >
                      <span className="flex items-center gap-2.5">
                        <span className={`h-[7px] w-[7px] flex-shrink-0 rounded-full ${STATUS_DOT[s]}`} aria-hidden />
                        <span className="truncate">{p.name}</span>
                      </span>
                    </MenuItem>
                  )
                })}
              </div>
              <MenuSeparator />
              <MenuItem
                icon={Plus}
                onClick={() => {
                  setProjectMenu(false)
                  go('/app')
                }}
              >
                {CLOUD_CONTROL_PLANE ? 'New project' : 'All projects'}
              </MenuItem>
            </MenuPanel>
          )}
        </AnimatePresence>
      </div>

      <span
        title={
          CLOUD_CONTROL_PLANE
            ? 'Backenly Cloud runs one environment, in AWS ap-south-1, today'
            : 'This deployment runs one environment'
        }
        className="ml-1 hidden h-[22px] items-center gap-1.5 rounded-[5px] border border-white/[0.07] px-1.5 text-[12px] text-zinc-400 lg:inline-flex"
      >
        <span className="h-[6px] w-[6px] rounded-full bg-emerald-400" aria-hidden />
        Production
      </span>

      {/* ── Right cluster ────────────────────────────────────────────────── */}
      <div className="ml-auto flex items-center gap-1.5">
        <SearchTrigger />

        {/* Review inbox — lit only when something waits on the user. Lands on
            Autonomy, which owns the queue since the 2026-07-18 consolidation.
            No count badge (2026-07-23, founder): the lifted chrome + tooltip
            carry "something is waiting"; a numbered dot is exactly the badge
            noise the no-badges rule bans elsewhere. The count lives in the
            queue itself and on the Overview loop. */}
        <Link
          href={`${basePath}/autonomy`}
          data-tour="review-inbox"
          title={
            pendingReview > 0
              ? `${pendingReview} change${pendingReview === 1 ? '' : 's'} waiting on your approval`
              : 'Review queue'
          }
          aria-label={
            pendingReview > 0
              ? `Review queue, ${pendingReview} waiting on your approval`
              : 'Review queue'
          }
          className={`relative inline-flex h-[32px] w-[32px] items-center justify-center ${R_CONTROL} border transition-colors ${FOCUS} ${
            pendingReview > 0
              ? 'border-white/[0.14] bg-white/[0.07] text-zinc-50 hover:bg-white/[0.10]'
              : 'border-transparent text-zinc-500 hover:bg-white/[0.05] hover:text-zinc-100'
          }`}
        >
          <Inbox className="h-4 w-4" strokeWidth={1.75} />
        </Link>

        {/* Assistant — the Q&A helper (answers, never builds). ⌘J does the same. */}
        <button
          type="button"
          onClick={toggleAssistant}
          title={assistantOpen ? 'Hide the assistant (⌘J)' : 'Ask how anything works (⌘J)'}
          aria-pressed={assistantOpen}
          className={`${BUTTON_BASE} h-[32px] px-2.5 text-[13px] ${
            assistantOpen ? 'bg-white/[0.10] text-zinc-50' : 'text-zinc-400 hover:bg-white/[0.05] hover:text-zinc-100'
          }`}
        >
          <Sparkles className="h-[15px] w-[15px]" strokeWidth={1.75} />
          <span className="hidden sm:inline">Ask</span>
          <Kbd className="ml-0.5 hidden xl:inline-flex">⌘J</Kbd>
        </button>

        {/* Connect agent — the one build door, the primary action. */}
        <Link data-tour="connect-agent" href={`${basePath}/connect`} className={`${BUTTON_BASE} ${BUTTON_VARIANTS.primary} h-[32px] px-3 text-[13px]`}>
          <Cable className="h-[15px] w-[15px]" strokeWidth={2} />
          <span className="hidden sm:inline">Connect agent</span>
        </Link>

        <AccountMenu />
      </div>
    </ConsoleBar>
  )
}
