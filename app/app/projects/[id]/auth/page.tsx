'use client'

/**
 * Auth & Users — merged section (IA restructure §6.5).
 *
 * The standalone /users route folds in here as a tab: "Authentication" is
 * scoped to include the end-user list. Two tabs:
 *
 *   • Configuration — sign-in methods (providers, magic links, email
 *     verification), policies (RLS / permissions), and branded emails. This is
 *     the existing AuthPageContent, which already sections these internally.
 *   • Users — the end-user table. Note the runtime landmines this list rides on
 *     (documented in project memory): the workspace users table is RLS-forced
 *     (service-role read path) and the behavioral verifier can leak synthetic
 *     `.internal` users — both handled server-side by /api/auth/users.
 *
 * The old /users page used gradient chrome, which violates the locked flat kit
 * (§11); the Users tab below is rebuilt in kit language — flat panel, hairline
 * rows, mono numerals, violet only for action.
 *
 * setCurrentProjectId is called synchronously in render (not useEffect) so
 * AuthPageContent's first-mount fetch sees the correct project id.
 */

import { useCallback, useEffect, useState } from 'react'
import { useParams, useRouter, useSearchParams } from 'next/navigation'
import { Shield, SlidersHorizontal, Users, Search, Mail, Loader2 } from 'lucide-react'
import { setCurrentProjectId } from '@/lib/api/client'
import AuthPageContent from '@/app/app/auth/page'
import { InspectorPageHeader } from '@/components/inspector/InspectorPageHeader'
import { KitTabs, KitTab, KitCard, KitButton, EmptyState, KitPage } from '@/components/inspector/kit'

interface EndUser {
  id: string
  email: string
  provider: string
  createdAt: string
  lastLogin?: string
}

type Tab = 'config' | 'users'

export default function ProjectAuthPage() {
  const params = useParams()
  const searchParams = useSearchParams()
  const projectId = params.id as string
  // Deep-link support: /auth?tab=users lands directly on the Users tab
  // (the old standalone /users route now redirects here — §14).
  const [tab, setTab] = useState<Tab>(searchParams.get('tab') === 'users' ? 'users' : 'config')
  const [userCount, setUserCount] = useState<number | undefined>(undefined)

  if (projectId && typeof window !== 'undefined') setCurrentProjectId(projectId)
  useEffect(() => {
    if (projectId) setCurrentProjectId(projectId)
  }, [projectId])

  return (
    <div className="min-h-screen bg-[#101116] flex flex-col">
      <InspectorPageHeader
        icon={Shield}
        title="Auth & Users"
        description="JWT authentication · email/password · OAuth providers · magic links · row-level policies · end-user management"
        badge={{ label: 'Governed', variant: 'governed' }}
      />

      <div className="px-8 pt-4">
        <KitTabs>
          <KitTab active={tab === 'config'} onClick={() => setTab('config')}>
            <SlidersHorizontal className="w-3.5 h-3.5" />
            Configuration
          </KitTab>
          <KitTab active={tab === 'users'} onClick={() => setTab('users')} count={userCount}>
            <Users className="w-3.5 h-3.5" />
            Users
          </KitTab>
        </KitTabs>
      </div>

      <div className="flex-1">
        {/* Keep both mounted-cheap: render the active one. AuthPageContent owns
            its own internal state and fetches, so only mount it when shown. */}
        {tab === 'config' && <AuthPageContent />}
        {tab === 'users' && <UsersTab projectId={projectId} onCount={setUserCount} />}
      </div>
    </div>
  )
}

// ── Users tab (flat kit rebuild of the old /users page) ──────────────────────

function UsersTab({ projectId, onCount }: { projectId: string; onCount: (n: number) => void }) {
  const router = useRouter()
  const [users, setUsers] = useState<EndUser[]>([])
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')

  const fetchUsers = useCallback(async () => {
    if (!projectId) return
    try {
      setLoading(true)
      const token = typeof window !== 'undefined' ? localStorage.getItem('auth-token') : null
      const headers: HeadersInit = { 'Content-Type': 'application/json', 'X-Project-Id': projectId }
      if (token) headers['Authorization'] = `Bearer ${token}`
      const res = await fetch('/api/auth/users', { headers })
      const data = await res.json()
      const list: EndUser[] = data.users || []
      setUsers(list)
      onCount(list.length)
    } catch (err) {
      console.error('Error fetching users:', err)
    } finally {
      setLoading(false)
    }
  }, [projectId, onCount])

  useEffect(() => { fetchUsers() }, [fetchUsers])

  const filtered = users.filter(
    (u) =>
      u.email.toLowerCase().includes(query.toLowerCase()) ||
      u.provider.toLowerCase().includes(query.toLowerCase())
  )

  const formatDate = (s: string) =>
    new Date(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })

  return (
    <KitPage>
      <div className="max-w-4xl">
        {/* Search */}
        <div className="relative mb-4">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-zinc-600" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by email or provider…"
            className="w-full h-9 pl-9 pr-3 bg-[#0f1015] border border-white/[0.08] rounded-md text-[12.5px] text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:border-violet-400/40 focus:ring-2 focus:ring-violet-400/15 transition-colors"
          />
        </div>

        <KitCard>
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-16 text-[12.5px] text-zinc-500">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading users…
            </div>
          ) : filtered.length === 0 ? (
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
          ) : (
            <>
              <div className="grid grid-cols-4 gap-4 px-4 py-2.5 border-b border-white/[0.06]">
                {['Email', 'Provider', 'Signed up', 'Last active'].map((h) => (
                  <span key={h} className="text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-600">{h}</span>
                ))}
              </div>
              <div className="divide-y divide-white/[0.04]">
                {filtered.map((u) => (
                  <div key={u.id} className="grid grid-cols-4 gap-4 items-center px-4 py-3 hover:bg-white/[0.02] transition-colors">
                    <div className="flex items-center gap-2.5 min-w-0">
                      <span className="w-7 h-7 rounded-full bg-white/[0.05] border border-white/[0.08] flex items-center justify-center flex-shrink-0">
                        <Mail className="w-3 h-3 text-zinc-400" />
                      </span>
                      <span className="text-[12.5px] font-medium text-zinc-100 truncate">{u.email}</span>
                    </div>
                    <span className="text-[12.5px] text-zinc-400 capitalize">{u.provider}</span>
                    <span className="text-[12.5px] font-mono tabular-nums text-zinc-500">{formatDate(u.createdAt)}</span>
                    <span className="text-[12.5px] font-mono tabular-nums text-zinc-600">
                      {u.lastLogin ? formatDate(u.lastLogin) : '—'}
                    </span>
                  </div>
                ))}
              </div>
            </>
          )}
        </KitCard>
      </div>
    </KitPage>
  )
}
