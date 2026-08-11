'use client'

/**
 * CommandPalette — ⌘K navigation, kit language.
 *
 * The command registry mirrors today's IA exactly: the org level (Projects,
 * Usage, Members, Billing, Account settings) plus every section of the
 * project currently in scope. Navigation only — building happens through the
 * user's coding agent (Connect) and questions go to the Assistant (⌘J).
 */

import { useState, useEffect, useRef, useMemo } from 'react'
import {
  Search,
  LayoutDashboard,
  Database,
  Plug,
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
  Settings,
  FolderKanban,
  Gauge,
  Users,
  CreditCard,
  Sparkles,
} from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import { useRouter, usePathname } from 'next/navigation'
import { useAssistantStore } from '@/lib/stores/use-assistant-store'

interface Command {
  id: string
  label: string
  icon: any
  category: string
  action: () => void
  keywords: string[]
}

export function CommandPalette() {
  const [isOpen, setIsOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const router = useRouter()
  const pathname = usePathname()
  const inputRef = useRef<HTMLInputElement>(null)
  const toggleAssistant = useAssistantStore((s) => s.toggle)

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
          { id: 'p-branches',     label: 'Branches',      icon: GitBranch,       category: 'Project',  action: go(`${base}/branches`),      keywords: ['preview', 'environments'] },
          { id: 'p-deploy',       label: 'Deploy',        icon: Rocket,          category: 'Project',  action: go(`${base}/deploy`),        keywords: ['publish', 'release', 'rollback'] },
          { id: 'p-connect',      label: 'Connect agent', icon: Cable,           category: 'Project',  action: go(`${base}/connect`),       keywords: ['mcp', 'cursor', 'claude', 'agent', 'sdk', 'api key'] },
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
      { id: 'a-usage',    label: 'Usage',            icon: Gauge,        category: 'Account', action: go('/app/usage'),    keywords: ['quota', 'limits', 'requests'] },
      { id: 'a-members',  label: 'Members',          icon: Users,        category: 'Account', action: go('/app/members'),  keywords: ['team', 'invite', 'organization'] },
      { id: 'a-billing',  label: 'Billing',          icon: CreditCard,   category: 'Account', action: go('/app/billing'), keywords: ['plan', 'subscription', 'upgrade', 'pro'] },
      { id: 'a-settings', label: 'Account settings', icon: Settings,     category: 'Account', action: go('/app/settings'), keywords: ['profile', 'password', 'email'] },
    ]

    return [...project, ...assistant, ...account]
  }, [base, inProject, router, toggleAssistant])

  const filteredCommands = allCommands.filter((cmd) => {
    const searchLower = search.toLowerCase()
    return (
      cmd.label.toLowerCase().includes(searchLower) ||
      cmd.keywords.some((kw) => kw.toLowerCase().includes(searchLower))
    )
  })

  const groupedCommands = filteredCommands.reduce((acc, cmd) => {
    if (!acc[cmd.category]) acc[cmd.category] = []
    acc[cmd.category].push(cmd)
    return acc
  }, {} as Record<string, Command[]>)

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        setIsOpen(true)
      }
      if (e.key === 'Escape' && isOpen) {
        setIsOpen(false)
        setSearch('')
      }
      if (isOpen && e.key === 'ArrowDown') {
        e.preventDefault()
        setSelectedIndex((prev) => Math.min(prev + 1, filteredCommands.length - 1))
      }
      if (isOpen && e.key === 'ArrowUp') {
        e.preventDefault()
        setSelectedIndex((prev) => Math.max(prev - 1, 0))
      }
      if (isOpen && e.key === 'Enter' && filteredCommands[selectedIndex]) {
        e.preventDefault()
        filteredCommands[selectedIndex].action()
        setIsOpen(false)
        setSearch('')
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, search, selectedIndex, filteredCommands])

  useEffect(() => {
    if (isOpen) {
      setTimeout(() => inputRef.current?.focus(), 100)
      setSelectedIndex(0)
    }
  }, [isOpen])

  useEffect(() => {
    setSelectedIndex(0)
  }, [search])

  // Mounted in the root layout — the palette belongs to the app, not the
  // marketing site.
  if (!pathname?.startsWith('/app')) return null

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setIsOpen(false)}
            className="fixed inset-0 bg-black/70 z-50"
          />
          <motion.div
            initial={{ opacity: 0, scale: 0.98, y: -8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.98, y: -8 }}
            transition={{ duration: 0.15 }}
            className="fixed top-[22%] left-1/2 -translate-x-1/2 z-50 w-full max-w-lg px-4"
          >
            <div className="bg-[#16171d] rounded-xl border border-white/[0.12] shadow-[0_12px_32px_-16px_rgba(0,0,0,0.85)] overflow-hidden">
              <div className="relative border-b border-white/[0.06]">
                <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-zinc-600" />
                <input
                  ref={inputRef}
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Jump to a section…"
                  className="w-full h-11 pl-10 pr-4 bg-transparent text-[13px] text-zinc-50 placeholder:text-zinc-600 focus:outline-none"
                />
              </div>

              <div className="max-h-80 overflow-y-auto py-1.5">
                {Object.entries(groupedCommands).map(([category, cmds]) => (
                  <div key={category} className="px-1.5 pb-1">
                    <div className="px-2.5 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-600">
                      {category}
                    </div>
                    {cmds.map((cmd) => {
                      const globalIndex = filteredCommands.indexOf(cmd)
                      const isSelected = globalIndex === selectedIndex
                      return (
                        <button
                          key={cmd.id}
                          onClick={() => {
                            cmd.action()
                            setIsOpen(false)
                            setSearch('')
                          }}
                          onMouseEnter={() => setSelectedIndex(globalIndex)}
                          className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-md transition-colors text-left ${
                            isSelected
                              ? 'bg-white/[0.07] text-zinc-50'
                              : 'text-zinc-400 hover:bg-white/[0.04] hover:text-zinc-100'
                          }`}
                        >
                          <cmd.icon className={`w-3.5 h-3.5 flex-shrink-0 ${isSelected ? 'text-violet-300' : 'text-zinc-500'}`} />
                          <span className="flex-1 text-[12.5px] font-medium truncate">{cmd.label}</span>
                          {isSelected && <span className="h-[5px] w-[5px] rounded-full bg-violet-400" />}
                        </button>
                      )
                    })}
                  </div>
                ))}
                {filteredCommands.length === 0 && (
                  <div className="px-4 py-10 text-center">
                    <p className="text-[12.5px] text-zinc-500">Nothing matches &quot;{search}&quot;.</p>
                  </div>
                )}
              </div>

              <div className="px-3.5 py-2.5 border-t border-white/[0.06] flex items-center justify-between font-mono text-[10.5px] text-zinc-600">
                <div className="flex items-center gap-3">
                  <span className="flex items-center gap-1.5">
                    <kbd className="px-1.5 py-0.5 bg-white/[0.04] rounded border border-white/[0.07]">↑↓</kbd>
                    navigate
                  </span>
                  <span className="flex items-center gap-1.5">
                    <kbd className="px-1.5 py-0.5 bg-white/[0.04] rounded border border-white/[0.07]">↵</kbd>
                    open
                  </span>
                </div>
                <span className="flex items-center gap-1.5">
                  <kbd className="px-1.5 py-0.5 bg-white/[0.04] rounded border border-white/[0.07]">esc</kbd>
                  close
                </span>
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  )
}
