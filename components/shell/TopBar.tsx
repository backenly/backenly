'use client'

/**
 * TopBar — the single persistent top bar across the project workspace.
 *
 * Replaces the three ad-hoc headers (the monolith's logo bar, the inspector
 * page headers, the app-shell header) with one breadcrumb chrome, per
 * IA restructure §4:
 *
 *   [◆] Org ▾ [Free] / project ▾ / [Production]   [📥 n] [Assistant] [Connect agent] [A]
 *
 * Locked kit language: #141519 surface, hairline border, mono numerals, violet
 * only for the primary action (Connect agent) and the lit review inbox.
 *
 * "Assistant" toggles the global Q&A panel — ⌘/Ctrl+J does the same. It answers
 * platform questions; it never builds. Building goes through the one door:
 * the user's coding agent over MCP (Connect agent). Org switcher is Phase 6 —
 * it shows the account name until the Organization model exists. The
 * environment chip is honest: one Hetzner region, one env, so it's static
 * "Production".
 */

import { useEffect, useRef, useState, useTransition } from 'react'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { useAssistantStore } from '@/lib/stores/use-assistant-store'
import {
  ChevronDown,
  Check,
  Inbox,
  Sparkles,
  Cable,
  Settings,
  LogOut,
  Plus,
  Circle,
} from 'lucide-react'
import { Logo } from '@/components/Logo'
import { OrgSwitcher } from '@/components/shell/OrgSwitcher'
import { getProjects, type Project } from '@/lib/api/projects'

interface MeUser {
  name?: string
  email?: string
}

const STATUS_DOT: Record<string, string> = {
  LIVE: 'text-emerald-400',
  DEPLOYING: 'text-amber-400',
  FAILED: 'text-rose-400',
  PRIVATE: 'text-zinc-500',
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
  const [user, setUser] = useState<MeUser | null>(null)
  const [projects, setProjects] = useState<Project[]>([])
  const [pendingReview, setPendingReview] = useState(0)

  const [projectMenu, setProjectMenu] = useState(false)
  const [accountMenu, setAccountMenu] = useState(false)
  const projectMenuRef = useRef<HTMLDivElement>(null)
  const accountMenuRef = useRef<HTMLDivElement>(null)

  const currentProject = projects.find((p) => p.id === projectId)

  // ── Data ────────────────────────────────────────────────────────────────
  useEffect(() => {
    fetch('/api/auth/me')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d?.user) setUser(d.user) })
      .catch(() => {})

    getProjects().then(setProjects).catch(() => {})
  }, [])

  // Review inbox count — lit only when a change is actually waiting on the user.
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
      } catch { /* silent */ }
    }
    poll()
    const t = setInterval(poll, 30_000)
    return () => { cancelled = true; clearInterval(t) }
  }, [projectId])

  // ── Menu dismissal ──────────────────────────────────────────────────────
  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (projectMenuRef.current && !projectMenuRef.current.contains(e.target as Node)) setProjectMenu(false)
      if (accountMenuRef.current && !accountMenuRef.current.contains(e.target as Node)) setAccountMenu(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [])

  const go = (href: string) => startTransition(() => router.push(href))

  const initials = () => {
    if (!user) return '?'
    if (user.name) return user.name.split(' ').map((n) => n[0]).join('').toUpperCase().slice(0, 2)
    return user.email?.[0]?.toUpperCase() ?? '?'
  }

  const logout = async () => {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' })
    router.push('/login')
  }

  return (
    <header className="fixed top-0 left-0 right-0 h-12 z-30 bg-[#141519] border-b border-white/[0.07] flex items-center px-3 gap-1">
      {/* ── Left: brand + breadcrumb ─────────────────────────────────────── */}
      <Link href="/app" className="flex items-center pl-1 pr-2 group" aria-label="Backenly home">
        <Logo />
      </Link>

      <Separator />

      {/* Org switcher — renders as the old static chip for solo personal orgs,
          becomes a dropdown once the user belongs to more than one org. */}
      <OrgSwitcher
        fallbackName={user?.name?.split(' ')[0] ?? user?.email?.split('@')[0] ?? 'Personal'}
        plan="Free"
      />

      <Slash />

      {/* Project switcher */}
      <div className="relative" ref={projectMenuRef}>
        <button
          onClick={() => setProjectMenu((o) => !o)}
          className="flex items-center gap-1.5 h-8 px-2 rounded-md hover:bg-white/[0.05] transition-colors"
        >
          <Circle className={`w-2 h-2 fill-current ${STATUS_DOT[currentProject?.projectStatus ?? 'PRIVATE']}`} />
          <span className="text-[12.5px] font-medium text-zinc-100 truncate max-w-[180px]">
            {currentProject?.name ?? 'Project'}
          </span>
          <ChevronDown className="w-3.5 h-3.5 text-zinc-500" />
        </button>

        {projectMenu && (
          <div className="absolute top-full left-0 mt-1 w-[280px] bg-[#1c1d23] border border-white/[0.10] rounded-lg shadow-[0_12px_32px_-16px_rgba(0,0,0,0.85)] overflow-hidden z-40">
            <div className="max-h-[320px] overflow-y-auto py-1">
              {projects.map((p) => {
                const active = p.id === projectId
                return (
                  <button
                    key={p.id}
                    onClick={() => { setProjectMenu(false); go(`/app/projects/${p.id}`) }}
                    className="w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-white/[0.05] transition-colors"
                  >
                    <Circle className={`w-2 h-2 fill-current flex-shrink-0 ${STATUS_DOT[p.projectStatus ?? 'PRIVATE']}`} />
                    <span className="text-[12.5px] text-zinc-200 truncate flex-1">{p.name}</span>
                    {active && <Check className="w-3.5 h-3.5 text-violet-300 flex-shrink-0" />}
                  </button>
                )
              })}
            </div>
            <button
              onClick={() => { setProjectMenu(false); go('/app') }}
              className="w-full flex items-center gap-2.5 px-3 py-2.5 text-left border-t border-white/[0.07] text-zinc-300 hover:text-zinc-50 hover:bg-white/[0.05] transition-colors"
            >
              <Plus className="w-3.5 h-3.5" />
              <span className="text-[12.5px] font-medium">New project</span>
            </button>
          </div>
        )}
      </div>

      <Slash />

      {/* Environment chip — honest: one region, one env */}
      <span
        title="Backenly runs one EU · Hetzner region today"
        className="hidden md:inline-flex items-center gap-1.5 h-7 px-2 rounded-md bg-white/[0.03] border border-white/[0.06] text-[11px] font-mono text-zinc-400"
      >
        <span className="h-[5px] w-[5px] rounded-full bg-emerald-400" />
        Production
      </span>

      {/* ── Right cluster ────────────────────────────────────────────────── */}
      <div className="ml-auto flex items-center gap-1.5">
        {/* Review inbox — lit only when something waits on the user. Lands on
            Autonomy, which owns the queue since the 2026-07-18 consolidation. */}
        <button
          onClick={() => go(`${basePath}/autonomy`)}
          title={
            pendingReview > 0
              ? `${pendingReview} change${pendingReview === 1 ? '' : 's'} waiting on your approval`
              : 'Review queue'
          }
          aria-label="Review queue"
          className={`relative inline-flex items-center justify-center w-8 h-8 mr-0.5 rounded-md border transition-colors ${
            pendingReview > 0
              ? 'bg-white/[0.06] border-white/[0.14] text-zinc-100 hover:bg-white/[0.10]'
              : 'border-transparent text-zinc-400 hover:text-zinc-100 hover:bg-white/[0.05]'
          }`}
        >
          {/* No count badge (2026-07-23, founder): the lifted chrome + tooltip
              carry "something is waiting"; a numbered dot is exactly the badge
              noise the no-badges rule bans elsewhere. The count lives in the
              queue itself and on the Overview loop. */}
          <Inbox className="w-4 h-4" />
        </button>

        {/* Assistant — the Q&A helper (answers, never builds). ⌘J does the same. */}
        <button
          onClick={toggleAssistant}
          title={assistantOpen ? 'Hide the assistant (⌘J)' : 'Ask how anything works (⌘J)'}
          aria-pressed={assistantOpen}
          className={`inline-flex items-center gap-1.5 h-8 px-3 rounded-md border text-[12px] font-semibold transition-colors ${
            assistantOpen
              ? 'bg-white/[0.12] border-white/[0.18] text-zinc-50'
              : 'bg-white/[0.06] border-white/[0.12] text-zinc-100 hover:bg-white/[0.10] hover:border-white/[0.18]'
          }`}
        >
          <Sparkles className="w-3.5 h-3.5" />
          <span className="hidden sm:inline">Assistant</span>
        </button>

        {/* Connect agent — the one build door, the primary violet action */}
        <button
          onClick={() => go(`${basePath}/connect`)}
          className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md bg-white text-black text-[12px] font-semibold hover:bg-zinc-200 transition-colors"
        >
          <Cable className="w-3.5 h-3.5" />
          <span className="hidden sm:inline">Connect agent</span>
        </button>


        {/* Avatar menu */}
        <div className="relative" ref={accountMenuRef}>
          <button
            onClick={() => setAccountMenu((o) => !o)}
            className="w-7 h-7 ml-1 rounded-full bg-white/[0.08] ring-1 ring-white/[0.12] flex items-center justify-center text-[11px] font-semibold text-zinc-100 hover:ring-white/25 transition-colors"
            aria-label="Account menu"
          >
            {initials()}
          </button>

          {accountMenu && (
            <div className="absolute top-full right-0 mt-1 w-[220px] bg-[#1c1d23] border border-white/[0.10] rounded-lg shadow-[0_12px_32px_-16px_rgba(0,0,0,0.85)] overflow-hidden z-40">
              {user && (
                <div className="px-3 py-2.5 border-b border-white/[0.07]">
                  <p className="text-[12px] font-medium text-zinc-200 truncate">{user.name ?? user.email?.split('@')[0]}</p>
                  <p className="text-[11px] text-zinc-500 truncate">{user.email}</p>
                </div>
              )}
              <button
                onClick={() => { setAccountMenu(false); go('/app/settings') }}
                className="w-full flex items-center gap-2.5 px-3 py-2.5 text-left text-zinc-300 hover:text-zinc-50 hover:bg-white/[0.05] transition-colors"
              >
                <Settings className="w-3.5 h-3.5" />
                <span className="text-[12.5px] font-medium">Account settings</span>
              </button>
              <button
                onClick={() => { setAccountMenu(false); logout() }}
                className="w-full flex items-center gap-2.5 px-3 py-2.5 text-left text-zinc-300 hover:text-rose-300 hover:bg-rose-500/[0.06] transition-colors"
              >
                <LogOut className="w-3.5 h-3.5" />
                <span className="text-[12.5px] font-medium">Log out</span>
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  )
}

function Separator() {
  return <div className="h-5 w-px bg-white/[0.08] mx-1 hidden sm:block" />
}

function Slash() {
  return <span className="text-zinc-700 text-[13px] px-0.5 hidden sm:inline">/</span>
}
