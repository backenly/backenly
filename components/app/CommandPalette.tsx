'use client'

/**
 * CommandPalette: ⌘K navigation.
 *
 * The command registry mirrors today's IA exactly: the org level (Projects,
 * Usage, Members, Billing, Account settings) plus every section of the
 * project currently in scope. Navigation only. Building happens through the
 * user's coding agent (Connect) and questions go to the Assistant (⌘J).
 *
 * Opened by ⌘K / Ctrl+K anywhere under /app, or by `openCommandPalette()`
 * (the Search button in the top bar), which dispatches a window event rather
 * than reaching into this component's state.
 */

import { useState, useEffect, useRef, useMemo, useId } from 'react'
import {
  Search,
  LayoutDashboard,
  Database,
  Shield,
  HardDrive,
  Code2,
  Radio,
  Zap,
  Bot,
  Activity,
  GitBranch,
  Rocket,
  Cable,
  Webhook,
  Settings,
  FolderKanban,
  Gauge,
  Users,
  CreditCard,
  Sparkles,
  CornerDownLeft,
} from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import { useRouter, usePathname } from 'next/navigation'
import { useAssistantStore } from '@/lib/stores/use-assistant-store'
import { CLOUD_CONTROL_PLANE } from '@cloud/control-plane'

interface Command {
  id: string
  label: string
  icon: any
  category: string
  action: () => void
  keywords: string[]
}

const OPEN_EVENT = 'backenly:open-command-palette'

/** Opens the palette from anywhere (a button, a menu item). */
export function openCommandPalette() {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(OPEN_EVENT))
}

export function CommandPalette() {
  const [isOpen, setIsOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const router = useRouter()
  const pathname = usePathname()
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const toggleAssistant = useAssistantStore((s) => s.toggle)
  const listId = useId()

  // Project in scope — from the URL when inside a project, else last visited.
  const projectId = useMemo(() => {
    const m = pathname?.match(/\/app\/projects\/([^/]+)/)
    if (m) return m[1]
    if (typeof window !== 'undefined') return localStorage.getItem('current-project-id')
    return null
  }, [pathname])

  const inProject = !!pathname?.startsWith('/app/projects/')
  const base = projectId ? `/app/projects/${projectId}` : null

  const allCommands: Command[] = useMemo(() => {
    const go = (href: string) => () => router.push(href)

    const project: Command[] = base
      ? [
          { id: 'p-overview',     label: 'Overview',      icon: LayoutDashboard, category: 'Project',  action: go(base),                    keywords: ['home', 'workspace', 'system'] },
          { id: 'p-database',     label: 'Database',      icon: Database,        category: 'Project',  action: go(`${base}/database`),      keywords: ['tables', 'rows', 'schema', 'sql'] },
          { id: 'p-auth',         label: 'Auth & Users',  icon: Shield,          category: 'Project',  action: go(`${base}/auth`),          keywords: ['users', 'login', 'oauth', 'rls', 'policies', 'security'] },
          { id: 'p-storage',      label: 'Storage',       icon: HardDrive,       category: 'Project',  action: go(`${base}/storage`),       keywords: ['files', 'buckets', 'uploads'] },
          { id: 'p-functions',    label: 'Functions',     icon: Code2,           category: 'Project',  action: go(`${base}/functions`),     keywords: ['serverless', 'cron', 'triggers', 'code'] },
          { id: 'p-realtime',     label: 'Realtime',      icon: Radio,           category: 'Project',  action: go(`${base}/realtime`),      keywords: ['sse', 'presence', 'broadcast', 'live'] },
          { id: 'p-integrations', label: 'Integrations',  icon: Zap,             category: 'Project',  action: go(`${base}/integrations`),  keywords: ['stripe', 'connectors', 'keys'] },
          { id: 'p-autonomy',     label: 'Autonomy',      icon: Bot,             category: 'Project',  action: go(`${base}/autonomy`),      keywords: ['self-healing', 'review', 'approvals', 'loop'] },
          { id: 'p-monitoring',   label: 'Monitoring',    icon: Activity,        category: 'Project',  action: go(`${base}/monitoring`),    keywords: ['metrics', 'health', 'logs', 'status'] },
          ...(CLOUD_CONTROL_PLANE
            ? [{ id: 'p-branches',     label: 'Branches',      icon: GitBranch,       category: 'Project',  action: go(`${base}/branches`),      keywords: ['preview', 'environments'] }]
            : []),
          { id: 'p-deploy',       label: 'Deploy',        icon: Rocket,          category: 'Project',  action: go(`${base}/deploy`),        keywords: ['publish', 'release', 'rollback'] },
          { id: 'p-connect',      label: 'Connect agent', icon: Cable,           category: 'Project',  action: go(`${base}/connect`),       keywords: ['mcp', 'cursor', 'claude', 'agent', 'sdk', 'api key'] },
          { id: 'p-webhooks',     label: 'Webhooks',      icon: Webhook,         category: 'Project',  action: go(`${base}/webhooks`),      keywords: ['hook', 'endpoint', 'event', 'delivery', 'signature', 'hmac'] },
          { id: 'p-settings',     label: 'Project settings', icon: Settings,     category: 'Project',  action: go(`${base}/settings`),      keywords: ['config', 'keys', 'danger'] },
        ]
      : []

    const assistant: Command[] = inProject
      ? [
          { id: 'assistant', label: 'Ask the Assistant', icon: Sparkles, category: 'Help', action: () => toggleAssistant(), keywords: ['help', 'question', 'how', 'docs', 'ai'] },
        ]
      : []

    const account: Command[] = [
      { id: 'a-projects', label: 'All projects',     icon: FolderKanban, category: 'Account', action: go('/app'),          keywords: ['dashboard', 'home', 'list'] },
      // Cloud surfaces. Offering a command that navigates to a page this build
      // does not contain is worse than not offering it: the palette is how
      // people look for a feature, so a dead entry reads as a broken feature
      // rather than an absent one. Usage is one of them: it reads the billing
      // cycle, which a self-hosted deployment does not have (see OrgShell).
      ...(CLOUD_CONTROL_PLANE
        ? [
            { id: 'a-usage',    label: 'Usage',            icon: Gauge,        category: 'Account', action: go('/app/usage'),    keywords: ['quota', 'limits', 'requests'] },
            { id: 'a-members',  label: 'Members',          icon: Users,        category: 'Account', action: go('/app/members'),  keywords: ['team', 'invite', 'organization'] },
            { id: 'a-billing',  label: 'Billing',          icon: CreditCard,   category: 'Account', action: go('/app/billing'), keywords: ['plan', 'subscription', 'upgrade', 'pro'] },
          ]
        : []),
      { id: 'a-settings', label: 'Account settings', icon: Settings,     category: 'Account', action: go('/app/settings'), keywords: ['profile', 'password', 'email'] },
    ]

    return [...project, ...assistant, ...account]
  }, [base, inProject, router, toggleAssistant])

  const filteredCommands = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return allCommands
    return allCommands.filter(
      (cmd) => cmd.label.toLowerCase().includes(q) || cmd.keywords.some((kw) => kw.toLowerCase().includes(q)),
    )
  }, [allCommands, search])

  const groupedCommands = useMemo(
    () =>
      filteredCommands.reduce((acc, cmd) => {
        if (!acc[cmd.category]) acc[cmd.category] = []
        acc[cmd.category].push(cmd)
        return acc
      }, {} as Record<string, Command[]>),
    [filteredCommands],
  )

  const close = () => {
    setIsOpen(false)
    setSearch('')
  }

  const run = (cmd: Command) => {
    cmd.action()
    close()
  }

  useEffect(() => {
    const onOpen = () => setIsOpen(true)
    window.addEventListener(OPEN_EVENT, onOpen)
    return () => window.removeEventListener(OPEN_EVENT, onOpen)
  }, [])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        if (!pathname?.startsWith('/app')) return
        e.preventDefault()
        setIsOpen((o) => !o)
        return
      }
      if (!isOpen) return
      if (e.key === 'Escape') {
        close()
      } else if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSelectedIndex((prev) => Math.min(prev + 1, filteredCommands.length - 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelectedIndex((prev) => Math.max(prev - 1, 0))
      } else if (e.key === 'Enter' && filteredCommands[selectedIndex]) {
        e.preventDefault()
        run(filteredCommands[selectedIndex])
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, selectedIndex, filteredCommands, pathname])

  useEffect(() => {
    if (isOpen) {
      const t = setTimeout(() => inputRef.current?.focus(), 30)
      setSelectedIndex(0)
      return () => clearTimeout(t)
    }
  }, [isOpen])

  useEffect(() => {
    setSelectedIndex(0)
  }, [search])

  // Keep the highlighted row in view while arrowing through a long list.
  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  // Mounted in the root layout — the palette belongs to the app, not the
  // marketing site.
  if (!pathname?.startsWith('/app')) return null

  const activeId = filteredCommands[selectedIndex] ? `${listId}-${filteredCommands[selectedIndex].id}` : undefined

  return (
    <AnimatePresence>
      {isOpen && (
        <div className="fixed inset-0 z-[70]" role="dialog" aria-modal="true" aria-label="Search and jump to">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            onClick={close}
            className="absolute inset-0 bg-black/60"
          />
          {/* Centred by flex, not translate: framer writes an inline transform
              for the entrance, which would override a -translate-x-1/2 class
              and leave the panel hanging off to the right. */}
          <div className="pointer-events-none absolute inset-x-0 top-[14vh] flex justify-center px-4">
            <motion.div
              initial={{ opacity: 0, scale: 0.98, y: -6 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.98, y: -6 }}
              transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
              className="pointer-events-auto w-full max-w-[560px] overflow-hidden rounded-[14px] bg-[#141518] shadow-[0_0_0_1px_rgba(255,255,255,0.09),0_2px_8px_-2px_rgba(0,0,0,0.5),0_32px_80px_-16px_rgba(0,0,0,0.85),inset_0_1px_0_rgba(255,255,255,0.05)]"
            >
              <div className="relative flex items-center border-b border-white/[0.07]">
                <Search className="pointer-events-none absolute left-4 h-4 w-4 text-zinc-500" strokeWidth={1.75} />
                <input
                  ref={inputRef}
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Jump to a section…"
                  role="combobox"
                  aria-expanded="true"
                  aria-controls={listId}
                  aria-activedescendant={activeId}
                  aria-autocomplete="list"
                  autoComplete="off"
                  spellCheck={false}
                  className="h-[52px] w-full bg-transparent pl-11 pr-4 text-[16px] text-zinc-50 placeholder:text-zinc-600 focus:outline-none sm:text-[14px]"
                />
              </div>

              <div ref={listRef} id={listId} role="listbox" className="max-h-[min(360px,55vh)] overflow-y-auto overscroll-contain p-1.5">
                {Object.entries(groupedCommands).map(([category, cmds]) => (
                  <div key={category} role="group" aria-label={category} className="pb-1">
                    <div className="px-2.5 pb-1 pt-2 text-[12px] font-medium text-zinc-500">{category}</div>
                    {cmds.map((cmd) => {
                      const globalIndex = filteredCommands.indexOf(cmd)
                      const isSelected = globalIndex === selectedIndex
                      return (
                        <button
                          key={cmd.id}
                          id={`${listId}-${cmd.id}`}
                          type="button"
                          role="option"
                          aria-selected={isSelected}
                          onClick={() => run(cmd)}
                          onMouseMove={() => setSelectedIndex(globalIndex)}
                          className={`flex h-[38px] w-full items-center gap-3 rounded-[8px] px-2.5 text-left transition-colors duration-75 ${
                            isSelected ? 'bg-white/[0.07] text-zinc-50' : 'text-zinc-400'
                          }`}
                        >
                          <cmd.icon
                            className={`h-4 w-4 flex-shrink-0 ${isSelected ? 'text-zinc-100' : 'text-zinc-500'}`}
                            strokeWidth={1.75}
                          />
                          <span className="flex-1 truncate text-[13.5px] font-medium">{cmd.label}</span>
                          {isSelected && <CornerDownLeft className="h-3.5 w-3.5 text-zinc-500" strokeWidth={1.75} />}
                        </button>
                      )
                    })}
                  </div>
                ))}
                {filteredCommands.length === 0 && (
                  <div className="px-4 py-10 text-center">
                    <p className="text-[13px] text-zinc-500">Nothing matches “{search}”.</p>
                  </div>
                )}
              </div>

              <div className="hidden items-center justify-between border-t border-white/[0.07] px-4 py-2.5 text-[12px] text-zinc-500 sm:flex">
                <div className="flex items-center gap-4">
                  <span className="flex items-center gap-1.5">
                    <PaletteKey>↑</PaletteKey>
                    <PaletteKey>↓</PaletteKey>
                    to move
                  </span>
                  <span className="flex items-center gap-1.5">
                    <PaletteKey>↵</PaletteKey>
                    to open
                  </span>
                </div>
                <span className="flex items-center gap-1.5">
                  <PaletteKey>esc</PaletteKey>
                  to close
                </span>
              </div>
            </motion.div>
          </div>
        </div>
      )}
    </AnimatePresence>
  )
}

function PaletteKey({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-[4px] border border-white/[0.10] bg-white/[0.04] px-1 font-sans text-[11px] font-medium leading-none text-zinc-400">
      {children}
    </kbd>
  )
}
