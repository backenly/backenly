'use client'

/**
 * Auth & Users workbench.
 *
 * A mixed surface, handled honestly: Configuration is a document (providers,
 * policies, branded emails) and keeps a scrolling pane, while Users is an
 * instrument — an identity table that deserves the same grid the Tables
 * inspector uses rather than a four-column div list inside a card.
 *
 * One shell carries both: a command bar with identity and live counts, tabs
 * under it, and a fixed-height body so the user grid gets every remaining pixel
 * and scrolls internally instead of running off the page.
 *
 * Runtime landmines this list rides on (documented in project memory): the
 * workspace users table is RLS-forced (service-role read path) and the
 * behavioral verifier can leak synthetic `.internal` users — both are handled
 * server-side by /api/auth/users.
 */

import { useCallback, useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { SlidersHorizontal, Users, Search, RefreshCw, X, Mail } from 'lucide-react'
import { AuthConfiguration } from '@/components/auth/AuthConfiguration'
import { EmailSettingsPanel } from '@/components/auth/EmailSettingsPanel'
import {
  AgentPrompt, CommandBar, CopyField, EmptyState, IconButton, INPUT_BASE, KIT, KitTab, KitTabs, Spinner, Tag,
} from '@/components/inspector/kit'
import { FOCUS_INSET } from '@/components/console/tokens'

interface EndUser {
  id: string
  email: string
  provider: string
  createdAt: string
  lastLogin?: string
}

type Tab = 'config' | 'users' | 'email'

export function AuthWorkbench({ projectId }: { projectId: string }) {
  const searchParams = useSearchParams()
  // Deep link: /auth?tab=users lands on the Users tab (the old standalone
  // /users route redirects here).
  const [tab, setTab] = useState<Tab>(() => {
    const requested = searchParams.get('tab')
    return requested === 'users' || requested === 'email' ? requested : 'config'
  })
  const [users, setUsers] = useState<EndUser[]>([])
  const [loading, setLoading] = useState(true)

  const fetchUsers = useCallback(async () => {
    if (!projectId) return
    try {
      setLoading(true)
      const token = typeof window !== 'undefined' ? localStorage.getItem('auth-token') : null
      const headers: HeadersInit = { 'Content-Type': 'application/json', 'X-Project-Id': projectId }
      if (token) headers['Authorization'] = `Bearer ${token}`
      const res = await fetch('/api/auth/users', { headers })
      const data = await res.json()
      setUsers(data.users || [])
    } catch (err) {
      console.error('Error fetching users:', err)
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => { fetchUsers() }, [fetchUsers])

  return (
    <div className={`console-fill flex flex-col overflow-hidden ${KIT.bg}`}>
      <CommandBar
        title="Auth & Users"
        context={
          <span className="tabular-nums">
            {loading ? 'Loading users…' : `${users.length.toLocaleString()} ${users.length === 1 ? 'user' : 'users'}`}
          </span>
        }
      />

      <KitTabs className="flex-shrink-0 px-3 sm:px-4">
        <KitTab active={tab === 'config'} onClick={() => setTab('config')}>
          <SlidersHorizontal />
          Configuration
        </KitTab>
        <KitTab active={tab === 'users'} onClick={() => setTab('users')} count={users.length > 0 ? users.length : undefined}>
          <Users />
          Users
        </KitTab>
        {/* Outgoing mail lives beside the rest of auth because that is what it
            is for: verification, reset and magic links. */}
        <KitTab active={tab === 'email'} onClick={() => setTab('email')}>
          <Mail />
          Email
        </KitTab>
      </KitTabs>

      {/* ── Body ──────────────────────────────────────────── */}
      <div className="relative min-h-0 flex-1">
        <div className="absolute inset-0 flex">
          {tab === 'email' ? (
            // Mail settings are a document too, and scroll in their own pane.
            <div className="min-w-0 flex-1 overflow-y-auto">
              <EmailSettingsPanel projectId={projectId} />
            </div>
          ) : tab === 'config' ? (
            // Configuration is a document: it scrolls inside its own pane.
            <div className="min-w-0 flex-1 overflow-y-auto">
              <AuthConfiguration />
            </div>
          ) : (
            <UsersGrid projectId={projectId} users={users} loading={loading} onRefresh={fetchUsers} />
          )}
        </div>
      </div>
    </div>
  )
}

// ── Users grid ───────────────────────────────────────────────────────────────

function UsersGrid({
  projectId,
  users,
  loading,
  onRefresh,
}: {
  projectId: string
  users: EndUser[]
  loading: boolean
  onRefresh: () => void
}) {
  const router = useRouter()
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const filtered = query.trim()
    ? users.filter(
        (u) =>
          u.email.toLowerCase().includes(query.trim().toLowerCase()) ||
          u.provider.toLowerCase().includes(query.trim().toLowerCase())
      )
    : users

  const selected = selectedId ? users.find((u) => u.id === selectedId) ?? null : null

  const formatDate = (s: string) =>
    new Date(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })


  return (
    <>
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Toolbar */}
        <div className="flex h-[44px] flex-shrink-0 items-center justify-between gap-3 border-b border-white/[0.06] px-3 sm:px-4">
          <div className="flex min-w-0 items-center gap-3">
            <h2 className="truncate text-[13px] font-medium text-zinc-100">All users</h2>
            <span className="whitespace-nowrap text-[12px] tabular-nums text-zinc-500">
              {query.trim() && filtered.length !== users.length
                ? `${filtered.length.toLocaleString()} of ${users.length.toLocaleString()}`
                : filtered.length.toLocaleString()}
            </span>
          </div>
          <div className="flex flex-shrink-0 items-center gap-1.5">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-600" />
              <input
                type="search"
                aria-label="Search users"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search users…"
                className={`${INPUT_BASE} h-[30px] w-40 pl-8 pr-2.5 sm:w-64`}
              />
            </div>
            <IconButton icon={RefreshCw} label="Refresh users" onClick={onRefresh} className={loading ? '[&_svg]:animate-spin' : ''} />
          </div>
        </div>

        {/* Grid */}
        <div className="min-h-0 flex-1 overflow-auto">
          {loading && users.length === 0 ? (
            <div className="flex h-full items-center justify-center text-zinc-500">
              <Spinner className="h-4 w-4" />
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex min-h-full flex-col items-center justify-center px-6">
              <EmptyState
                icon={query ? Search : Users}
                title={query ? 'No users match' : 'No users yet'}
                description={
                  query
                    ? `Nothing matches “${query.trim()}”. Search covers email and sign-in provider.`
                    : 'Accounts created in your app land here as they sign up, with how they signed in and when they were last active.'
                }
                action={
                  !query ? (
                    <div className="flex w-full flex-col items-center gap-4">
                      <AgentPrompt prompt="Add email and password sign-up and sign-in to the app, with password reset." />
                      <button
                        type="button"
                        onClick={() => router.push(`/app/projects/${projectId}/connect`)}
                        className="text-[13px] font-medium text-zinc-300 underline decoration-white/20 underline-offset-4 transition-colors hover:text-zinc-50 hover:decoration-white/50"
                      >
                        Connect your agent
                      </button>
                    </div>
                  ) : undefined
                }
              />
            </div>
          ) : (
            <div className="min-w-full overflow-x-auto">
              <table className="w-full min-w-[560px] border-collapse">
                <thead className="sticky top-0 z-10">
                  <tr className={KIT.gridHead}>
                    <th className={TH}>Email</th>
                    <th className={TH}>Provider</th>
                    <th className={`${TH} hidden sm:table-cell`}>Signed up</th>
                    <th className={TH}>Last active</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((u) => {
                    const isActive = selectedId === u.id
                    return (
                      <tr
                        key={u.id}
                        onClick={() => setSelectedId(u.id)}
                        aria-selected={isActive}
                        className={`cursor-pointer transition-colors ${isActive ? 'bg-white/[0.05]' : KIT.rowHoverOn}`}
                      >
                        <td className={`${TD} max-w-0 w-full`}>
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); setSelectedId(u.id) }}
                            className={`flex min-w-0 max-w-full items-center gap-2.5 rounded-[5px] text-left ${FOCUS_INSET}`}
                          >
                            <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full border border-white/[0.10] bg-white/[0.04] text-[11px] font-semibold uppercase text-zinc-300">
                              {(u.email || '?').slice(0, 1)}
                            </span>
                            <span className={`truncate text-[13px] ${isActive ? 'text-zinc-50' : 'text-zinc-200'}`} title={u.email}>
                              {u.email}
                            </span>
                          </button>
                        </td>
                        <td className={TD}>
                          <Tag mono>{u.provider}</Tag>
                        </td>
                        <td className={`${TD} hidden text-[12.5px] tabular-nums text-zinc-400 sm:table-cell`}>{formatDate(u.createdAt)}</td>
                        <td className={`${TD} text-[12.5px] tabular-nums text-zinc-500`}>
                          {u.lastLogin ? formatDate(u.lastLogin) : 'Never'}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* Identity detail: responsive bottom sheet on mobile, rail on desktop */}
      {selected && (
        <>
          <div
            className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm lg:hidden"
            onClick={() => setSelectedId(null)}
          />

          <aside
            aria-label="User details"
            className={`fixed inset-x-0 bottom-0 z-50 max-h-[85vh] flex-shrink-0 flex-col rounded-t-2xl border-t border-white/10 pb-[max(1rem,env(safe-area-inset-bottom))] shadow-2xl lg:static lg:inset-auto lg:z-auto lg:flex lg:max-h-none lg:w-[320px] lg:rounded-none lg:border-l lg:border-t-0 lg:border-white/[0.06] lg:pb-0 lg:shadow-none ${KIT.rail}`}
          >
            <div className="flex justify-center pb-1 pt-2.5 lg:hidden">
              <div className="h-1 w-10 rounded-full bg-white/20" />
            </div>

            <div className="flex h-[44px] flex-shrink-0 items-center justify-between gap-2 border-b border-white/[0.06] pl-4 pr-2">
              <span className="text-[13px] font-medium text-zinc-200">User</span>
              <IconButton icon={X} label="Close user details" onClick={() => setSelectedId(null)} />
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto">
              <div className="flex items-center gap-3 border-b border-white/[0.06] px-4 py-4">
                <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full border border-white/[0.10] bg-white/[0.04] text-[13px] font-semibold uppercase text-zinc-200">
                  {(selected.email || '?').slice(0, 1)}
                </span>
                <p className="min-w-0 break-all text-[13px] font-medium text-zinc-50">{selected.email}</p>
              </div>
              <dl className="divide-y divide-white/[0.05]">
                {[
                  ['Provider', selected.provider],
                  ['Signed up', new Date(selected.createdAt).toLocaleString()],
                  ['Last active', selected.lastLogin ? new Date(selected.lastLogin).toLocaleString() : 'Never'],
                ].map(([label, value]) => (
                  <div key={label} className="flex items-baseline justify-between gap-3 px-4 py-2.5">
                    <dt className="flex-shrink-0 text-[13px] text-zinc-500">{label}</dt>
                    <dd className="min-w-0 truncate text-right text-[13px] tabular-nums text-zinc-200" title={value}>
                      {value}
                    </dd>
                  </div>
                ))}
              </dl>
              <div className="border-t border-white/[0.06] px-4 py-4">
                <p className="mb-2 text-[13px] font-medium text-zinc-200">User ID</p>
                <CopyField value={selected.id} />
                <p className="mt-2 text-[12.5px] leading-[19px] text-zinc-500">
                  Use it in row-level policies, and as the foreign key from your own tables.
                </p>
              </div>
            </div>
          </aside>
        </>
      )}
    </>
  )
}

const TH = 'h-[36px] whitespace-nowrap border-b border-white/[0.06] px-3 text-left text-[12px] font-medium text-zinc-500 first:pl-4'
const TD = 'h-[44px] whitespace-nowrap border-b border-white/[0.04] px-3 first:pl-4'
