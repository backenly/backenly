'use client'

/**
 * ProjectSidebar: the single, persistent project-level navigation.
 *
 *   Overview
 *   Connect            ● called within the hour · ○ connected, quiet · Not connected
 *   Build      Database, Auth & Users, Storage, Functions, Realtime, Webhooks, Integrations
 *   Operate    Autonomy, Monitoring, History, Branches, Deploy
 *   ─────
 *   Settings
 *
 * Rebuilt 2026-11-16 (project console decisions 1 and 5). Connect is top level,
 * second, because it is the second thing a new project needs, and it carries
 * the agent's state: the top bar's agent slot ("Last call 12 minutes ago", an
 * empty box on a phone) is gone, and the bar offers "Connect agent" only until
 * an agent first connects. Webhooks moved into Build, beside Realtime. Settings
 * sits in the footer, as on the team-level shell.
 *
 * Gone, on purpose: the MCP tag (violet when active, and Connect names the page
 * already), the Functions count (the one item with a number, polled every 30 s;
 * nav items carry no counts), and the "Frontend · Not connected" footer, which
 * said exactly that on a project an iOS app had called 18,685 times in a day,
 * because a native app sends no Origin. Failing browser calls are shown where
 * they can be acted on: Overview and Connect → API. Nothing here signals what
 * waits on you either: the inbox's white ◆ is the one signal.
 *
 * Items are real links, so they prefetch and open in a new tab on
 * Cmd/Ctrl-click; group labels are sentence case.
 */

import { useEffect, useState } from 'react'
import { useParams, usePathname } from 'next/navigation'
import {
  LayoutDashboard,
  Database,
  Shield,
  HardDrive,
  Code2,
  Radio,
  Zap,
  Bot,
  Activity,
  Rocket,
  Cable,
  Webhook,
  GitBranch,
  History,
  Settings,
  type LucideIcon,
} from 'lucide-react'
import { CLOUD_CONTROL_PLANE } from '@cloud/control-plane'
import { StatusGlyph } from '@/components/inspector/kit'
import { formatTime } from '@/components/console/format'
import { useAgentConnection, type UseAgentConnectionResult } from '@/lib/hooks/useAgentConnection'
import { NavGroup, NavItem, SidebarNav } from './ConsoleChrome'

// ── Section registry ─────────────────────────────────────────────────────────

interface NavEntry {
  id: string
  title: string
  icon: LucideIcon
  /** Path suffix appended to /app/projects/[id]. */
  href: string
  /** Substrings that mark this item active when found in the pathname. */
  match?: string[]
}

interface NavSection {
  label?: string
  items: NavEntry[]
}

/** Connect's own entry: its row carries the agent's state, so it is drawn on its own. */
const CONNECT: NavEntry = { id: 'connect', title: 'Connect', icon: Cable, href: '/connect', match: ['/connect', '/mcp'] }

const NAV: NavSection[] = [
  {
    items: [{ id: 'overview', title: 'Overview', icon: LayoutDashboard, href: '', match: ['__exact__'] }, CONNECT],
  },
  {
    label: 'Build',
    items: [
      { id: 'database',     title: 'Database',      icon: Database, href: '/database',     match: ['/database'] },
      // APIs entry removed 2026-07-21: under PostgREST the API IS the schema,
      // so the tables page is the API page. /apis redirects to /database.
      { id: 'auth',         title: 'Auth & Users',  icon: Shield,   href: '/auth',         match: ['/auth', '/users'] },
      { id: 'storage',      title: 'Storage',       icon: HardDrive,href: '/storage',      match: ['/storage'] },
      { id: 'functions',    title: 'Functions',     icon: Code2,    href: '/functions',    match: ['/functions'] },
      { id: 'realtime',     title: 'Realtime',      icon: Radio,    href: '/realtime',     match: ['/realtime'] },
      { id: 'webhooks',     title: 'Webhooks',      icon: Webhook,  href: '/webhooks',     match: ['/webhooks'] },
      { id: 'integrations', title: 'Integrations',  icon: Zap,      href: '/integrations', match: ['/integrations'] },
    ],
  },
  {
    label: 'Operate',
    items: [
      { id: 'autonomy',   title: 'Autonomy',   icon: Bot,      href: '/autonomy',   match: ['/autonomy'] },
      { id: 'monitoring', title: 'Monitoring', icon: Activity, href: '/monitoring', match: ['/monitoring'] },
      // One history for the whole backend, and the way back from any change.
      { id: 'history',    title: 'History',    icon: History,  href: '/changes',    match: ['/changes'] },
      // Preview branches are a Cloud capability: the engine refuses off Cloud
      // (lib/branches/engine.ts) and the routes answer 404, so listing the item
      // here would offer a control for work that cannot happen.
      ...(CLOUD_CONTROL_PLANE
        ? [{ id: 'branches', title: 'Branches', icon: GitBranch, href: '/branches', match: ['/branches'] } as NavEntry]
        : []),
      { id: 'deploy',     title: 'Deploy',     icon: Rocket,   href: '/deploy',     match: ['/deploy'] },
    ],
  },
]

const SETTINGS: NavEntry = { id: 'settings', title: 'Settings', icon: Settings, href: '/settings', match: ['/settings', '/iam'] }

// ── Active resolution ─────────────────────────────────────────────────────────

function isActive(item: NavEntry, pathname: string, basePath: string): boolean {
  // Overview is active only on the exact base path.
  if (item.match?.includes('__exact__')) {
    return pathname === basePath || pathname === `${basePath}/`
  }
  return (item.match ?? []).some((m) => pathname.startsWith(`${basePath}${m}`))
}

// ── The agent's state, on Connect ─────────────────────────────────────────────

/**
 * How recent a call must be for the agent to count as at work: the server's
 * rule (lib/mcp/agent-connection.ts ACTIVE_WITHIN_MS), which cannot be imported
 * into the browser. Checked again here as the page stays open, so an hour-old
 * "at work" answer turns quiet instead of staying live.
 */
const ACTIVE_WITHIN_MS = 60 * 60_000

const MINUTE = 60_000

export interface AgentNavState {
  /** ● at work, ○ connected and quiet, or the words "Not connected". */
  shown: 'active' | 'quiet' | 'none'
  /** "Claude Code, last call 12 min ago". */
  title?: string
  /** "Connect, not connected": the name with its state, for screen readers. */
  ariaLabel?: string
}

/** What Connect's row says about the agent. Nothing while the answer loads, so it never flashes the wrong state. */
export function agentNavState(agent: Pick<UseAgentConnectionResult, 'status' | 'active' | 'lastSeenAt' | 'client'>, now: number = Date.now()): AgentNavState | null {
  if (agent.status === 'loading') return null
  if (agent.status === 'disconnected') return { shown: 'none', ariaLabel: 'Connect, not connected' }
  // The console's one way to say a moment (decision 13): "12 min ago", "6 d ago", "Nov 14".
  const when = agent.lastSeenAt ? formatTime(agent.lastSeenAt, 'ago', { now }) || null : null
  const title =
    agent.client && when
      ? `${agent.client}, last call ${when}`
      : when
        ? `Last call ${when}`
        : agent.client
          ? `${agent.client}, connected`
          : 'Agent connected'
  const recent = !!agent.lastSeenAt && now - new Date(agent.lastSeenAt).getTime() < ACTIVE_WITHIN_MS
  // Live (●) only while the agent is at work: the server said so, and it still holds.
  return { shown: agent.active && recent ? 'active' : 'quiet', title, ariaLabel: `Connect, ${title}` }
}

/** Re-renders once a minute, so "12 min ago" and the live dot keep up with an open page. */
function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), MINUTE)
    return () => clearInterval(timer)
  }, [])
  return now
}

function ConnectItem({ projectId, href, active }: { projectId: string; href: string; active: boolean }) {
  const agent = useAgentConnection(projectId)
  const now = useMinuteClock()
  const state = agentNavState(agent, now)
  return (
    <NavItem
      tourTarget="nav-connect"
      href={href}
      icon={CONNECT.icon}
      label={CONNECT.title}
      active={active}
      ariaLabel={state?.ariaLabel}
      title={state?.title}
      trailing={
        state?.shown === 'none' ? (
          <span aria-hidden data-agent-state="none" className="flex-shrink-0 text-[12px] font-normal text-faint">
            Not connected
          </span>
        ) : state ? (
          // The glyph is the whole signal; its words are in the row's name.
          <span aria-hidden data-agent-state={state.shown} className="flex flex-shrink-0">
            <StatusGlyph state={state.shown === 'active' ? 'live' : 'idle'} label="" />
          </span>
        ) : undefined
      }
    />
  )
}

// ── Sidebar ───────────────────────────────────────────────────────────────────

/**
 * The navigation list. ProjectShell mounts it in the desktop rail and in the
 * phone drawer (ConsoleFrame owns both), so it carries no positioning itself.
 */
export function ProjectSidebar() {
  const params = useParams()
  const pathname = usePathname() ?? ''
  const projectId = params.id as string
  const basePath = `/app/projects/${projectId}`

  return (
    <SidebarNav
      footer={
        <ul>
          <NavItem
            tourTarget={`nav-${SETTINGS.id}`}
            href={`${basePath}${SETTINGS.href}`}
            icon={SETTINGS.icon}
            label={SETTINGS.title}
            active={isActive(SETTINGS, pathname, basePath)}
          />
        </ul>
      }
    >
      {NAV.map((group, gi) => (
        <NavGroup key={group.label ?? `g${gi}`} label={group.label} first={gi === 0}>
          {group.items.map((item) =>
            item.id === CONNECT.id ? (
              <ConnectItem
                key={item.id}
                projectId={projectId}
                href={`${basePath}${item.href}`}
                active={isActive(item, pathname, basePath)}
              />
            ) : (
              <NavItem
                key={item.id}
                tourTarget={`nav-${item.id}`}
                href={`${basePath}${item.href}`}
                icon={item.icon}
                label={item.title}
                active={isActive(item, pathname, basePath)}
              />
            ),
          )}
        </NavGroup>
      ))}
    </SidebarNav>
  )
}
