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
import { Shield, SlidersHorizontal, Users, Search, Loader2, RefreshCw, X, Copy, Check } from 'lucide-react'
import { AuthConfiguration } from '@/components/auth/AuthConfiguration'
import { KitButton, EmptyState, KIT } from '@/components/inspector/kit'

interface EndUser {
  id: string
  email: string
  provider: string
  createdAt: string
  lastLogin?: string
}

type Tab = 'config' | 'users'

export function AuthWorkbench({ projectId }: { projectId: string }) {
  const searchParams = useSearchParams()
  // Deep link: /auth?tab=users lands on the Users tab (the old standalone
  // /users route redirects here).
  const [tab, setTab] = useState<Tab>(searchParams.get('tab') === 'users' ? 'users' : 'config')
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
    <div className={`flex h-[calc(100vh-48px)] flex-col overflow-hidden ${KIT.bg}`}>

      {/* ── Command bar ───────────────────────────────────── */}
      <div className="flex h-11 flex-shrink-0 items-center justify-between gap-4 border-b border-white/[0.06] px-4">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-600">
            <Shield className="h-3 w-3" />
            Inspector
          </span>
          <span className="h-3 w-px bg-white/10" />
          <h1 className="text-[13px] font-semibold text-zinc-100">Auth &amp; Users</h1>
          <span className="inline-flex items-center gap-1.5 font-mono text-[10.5px] font-medium text-zinc-400">
            <span className="h-[5px] w-[5px] rounded-full bg-zinc-500" />
            Governed
          </span>
          {users.length > 0 && (
            <span className="font-mono text-[10.5px] tabular-nums text-zinc-500">{users.length}</span>
          )}
        </div>
        <span className="hidden flex-shrink-0 font-mono text-[10.5px] tabular-nums text-zinc-600 sm:inline">
          {loading ? '—' : users.length} identit{users.length === 1 ? 'y' : 'ies'}
        </span>
      </div>

      {/* ── Tabs ──────────────────────────────────────────── */}
      <div className="flex h-9 flex-shrink-0 items-center gap-0.5 border-b border-white/[0.06] px-3">
        {([
          ['config', 'Configuration', SlidersHorizontal, undefined],
          ['users', 'Users', Users, users.length],
        ] as const).map(([key, label, Icon, count]) => (
          <button
            key={key}
            onClick={() => setTab(key as Tab)}
            className={`-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-[12px] font-medium transition-colors focus:outline-none ${
              tab === key ? 'border-violet-400 text-zinc-50' : 'border-transparent text-zinc-500 hover:text-zinc-200'
            }`}
          >
            <Icon className="h-3.5 w-3.5" />
            {label}
            {typeof count === 'number' && count > 0 && (
              <span
                className={`font-mono text-[10.5px] font-medium tabular-nums ${
                  tab === key ? 'text-violet-300' : 'text-zinc-600'
                }`}
              >
                {count}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* ── Body ──────────────────────────────────────────── */}
      <div className="relative min-h-0 flex-1">
        <div className="absolute inset-0 flex">
          {tab === 'config' ? (
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
  const [copied, setCopied] = useState(false)

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

  const copyId = async (id: string) => {
    try {
      await navigator.clipboard.writeText(id)
      setCopied(true)
      setTimeout(() => setCopied(false), 1400)
    } catch { /* clipboard unavailable */ }
  }

  return (
    <>
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Toolbar */}
        <div className="flex h-10 flex-shrink-0 items-center justify-between gap-3 border-b border-white/[0.06] px-4">
          <div className="flex min-w-0 items-baseline gap-2">
            <h2 className="truncate font-mono text-[13px] font-medium text-zinc-100">users</h2>
            <span className="whitespace-nowrap font-mono text-[11px] tabular-nums text-zinc-500">
              {filtered.length.toLocaleString()} identit{filtered.length === 1 ? 'y' : 'ies'}
            </span>
          </div>
          <div className="flex flex-shrink-0 items-center gap-2">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 h-3 w-3 -translate-y-1/2 text-zinc-600" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search email or provider…"
                className="h-7 w-56 rounded-lg border border-white/[0.07] bg-[#0f1015] pl-7 pr-3 text-[11.5px] text-zinc-300 transition-colors placeholder:text-zinc-600 focus:border-violet-400/40 focus:outline-none focus:ring-2 focus:ring-violet-400/15"
              />
            </div>
            <button
              onClick={onRefresh}
              className="rounded-md p-1.5 text-zinc-600 transition-colors hover:bg-white/[0.04] hover:text-zinc-200"
              title="Refresh"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            </button>
          </div>
        </div>

        {/* Grid */}
        <div className="min-h-0 flex-1 overflow-auto">
          {loading && users.length === 0 ? (
            <div className="flex h-full items-center justify-center">
              <Loader2 className="h-4 w-4 animate-spin text-white/30" />
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center px-8">
              <EmptyState
                icon={Users}
                title={query ? 'No users match your search' : 'No users yet'}
                description={
                  query
                    ? 'Try a different search term.'
                    : 'Your auth is live. The first sign-up from your app appears here instantly.'
                }
                action={
                  !query ? (
                    <KitButton variant="primary" onClick={() => router.push(`/app/projects/${projectId}/connect`)}>
                      Connect your agent
                    </KitButton>
                  ) : undefined
                }
              />
            </div>
          ) : (
            <table className="w-full border-collapse">
              <thead className="sticky top-0 z-10">
                <tr className={KIT.gridHead}>
                  <th className={`sticky left-0 z-20 w-12 border-b border-r border-white/[0.06] ${KIT.gridHead} px-2 py-2 text-right text-[9.5px] font-semibold uppercase tracking-[0.1em] text-zinc-700`}>
                    #
                  </th>
                  {['Email', 'Provider', 'Signed up', 'Last active'].map((h) => (
                    <th
                      key={h}
                      className="border-b border-white/[0.06] px-3 py-2 text-left text-[9.5px] font-semibold uppercase tracking-[0.1em] text-zinc-600"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map((u, i) => {
                  const isActive = selectedId === u.id
                  return (
                    <tr
                      key={u.id}
                      onClick={() => setSelectedId(u.id)}
                      className={`group/row cursor-pointer transition-colors ${isActive ? 'bg-white/[0.05]' : KIT.rowHoverOn}`}
                    >
                      <td
                        className={`sticky left-0 z-10 border-b border-r border-white/[0.04] px-2 py-[9px] text-right font-mono text-[11px] tabular-nums text-zinc-700 transition-colors ${
                          isActive ? 'bg-[#1a1b21]' : `${KIT.bg} ${KIT.rowHoverGroup}`
                        }`}
                      >
                        {i + 1}
                      </td>
                      <td className="border-b border-white/[0.04] px-3 py-[9px]">
                        <span className="truncate font-mono text-[12px] text-zinc-200" title={u.email}>
                          {u.email}
                        </span>
                      </td>
                      <td className="border-b border-white/[0.04] px-3 py-[9px] font-mono text-[11px] text-zinc-500">
                        {u.provider}
                      </td>
                      <td className="border-b border-white/[0.04] px-3 py-[9px] font-mono text-[11px] tabular-nums text-zinc-500">
                        {formatDate(u.createdAt)}
                      </td>
                      <td className="border-b border-white/[0.04] px-3 py-[9px] font-mono text-[11px] tabular-nums text-zinc-600">
                        {u.lastLogin ? formatDate(u.lastLogin) : '—'}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* Footer */}
        <div className="flex h-10 flex-shrink-0 items-center gap-4 border-t border-white/[0.06] px-4">
          <span className="font-mono text-[10.5px] tabular-nums text-zinc-600">
            {filtered.length === 0 ? '0 identities' : `1-${filtered.length} of ${filtered.length}`}
            {query.trim() && users.length !== filtered.length && (
              <span className="text-zinc-700"> · filtered from {users.length}</span>
            )}
          </span>
        </div>
      </div>

      {/* Identity detail */}
      {selected && (
        <div className={`hidden w-[300px] flex-shrink-0 flex-col border-l border-white/[0.06] lg:flex ${KIT.rail}`}>
          <div className="flex h-10 flex-shrink-0 items-center justify-between gap-2 border-b border-white/[0.06] px-3">
            <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-600">Identity</span>
            <button
              onClick={() => setSelectedId(null)}
              className="rounded-md p-1.5 text-zinc-600 transition-colors hover:bg-white/[0.04] hover:text-zinc-200"
              title="Close"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="border-b border-white/[0.06] p-3">
              <p className="break-all font-mono text-[12px] text-zinc-100">{selected.email}</p>
            </div>
            <dl className={`divide-y ${KIT.divide}`}>
              {[
                ['Provider', selected.provider],
                ['Signed up', new Date(selected.createdAt).toLocaleString()],
                ['Last active', selected.lastLogin ? new Date(selected.lastLogin).toLocaleString() : '—'],
              ].map(([label, value]) => (
                <div key={label} className="flex items-baseline justify-between gap-3 px-3 py-2.5">
                  <dt className="flex-shrink-0 text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-600">
                    {label}
                  </dt>
                  <dd className="min-w-0 truncate text-right font-mono text-[11.5px] tabular-nums text-zinc-300" title={value}>
                    {value}
                  </dd>
                </div>
              ))}
            </dl>
            <div className="border-t border-white/[0.06] p-3">
              <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-600">User ID</p>
              <div className="flex items-center gap-1.5">
                <code className="min-w-0 flex-1 truncate rounded-md border border-white/[0.06] bg-[#0f1015] px-2 py-1.5 font-mono text-[10.5px] text-zinc-400">
                  {selected.id}
                </code>
                <button
                  onClick={() => copyId(selected.id)}
                  className="flex-shrink-0 rounded-md p-1.5 text-zinc-600 transition-colors hover:bg-white/[0.04] hover:text-zinc-100"
                  title="Copy user ID"
                >
                  {copied ? <Check className="h-3.5 w-3.5 text-emerald-300" /> : <Copy className="h-3.5 w-3.5" />}
                </button>
              </div>
              <p className="mt-1.5 text-[11px] leading-snug text-zinc-600">
                Use this in RLS policies and as the foreign key from your own tables.
              </p>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
