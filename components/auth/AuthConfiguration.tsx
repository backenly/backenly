'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Toast } from '@/components/ui/Toast'
import { getProject } from '@/lib/api/projects'
import { Mail, Shield, ExternalLink, KeyRound, ArrowRight } from 'lucide-react'
import {
  CopyField, KitButton, KitChecklist, KitField, KitInput, KitModal, KitNote, SettingsCard, Stat, StatStrip,
  StatusDot,
} from '@/components/inspector/kit'

type ProviderId = 'google' | 'github' | 'discord' | 'facebook'

interface AuthStats {
  totalUsers: number
  activeUsers: number
  activeUsersDelta: number
  verifications: number
  signups24h: number
  signupsDelta: number
  signups7d: number
}

interface RecentUser {
  id: string
  email: string
  provider: string
  createdAt: string
}

// ─── Brand marks ──────────────────────────────────────────────────────────────
// Real provider logos (not generic lucide stand-ins) — the single biggest
// signal that an auth screen is production-grade.

function GoogleMark({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden>
      <path fill="#4285F4" d="M23.49 12.27c0-.79-.07-1.54-.19-2.27H12v4.51h6.47a5.57 5.57 0 0 1-2.4 3.58v3h3.86c2.26-2.09 3.56-5.17 3.56-8.82Z" />
      <path fill="#34A853" d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.86-3c-1.08.72-2.45 1.16-4.07 1.16-3.13 0-5.78-2.11-6.73-4.96H1.29v3.09A11.99 11.99 0 0 0 12 24Z" />
      <path fill="#FBBC05" d="M5.27 14.29a7.16 7.16 0 0 1 0-4.58V6.62H1.29a12.04 12.04 0 0 0 0 10.76l3.98-3.09Z" />
      <path fill="#EA4335" d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0A11.99 11.99 0 0 0 1.29 6.62l3.98 3.09C6.22 6.86 8.87 4.75 12 4.75Z" />
    </svg>
  )
}

function GitHubMark({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden>
      <path fillRule="evenodd" clipRule="evenodd" d="M12 0C5.37 0 0 5.37 0 12c0 5.3 3.44 9.8 8.21 11.39.6.11.82-.26.82-.58 0-.28-.01-1.04-.02-2.04-3.34.73-4.04-1.61-4.04-1.61-.55-1.39-1.33-1.76-1.33-1.76-1.09-.74.08-.73.08-.73 1.2.09 1.84 1.24 1.84 1.24 1.07 1.84 2.81 1.31 3.5 1 .1-.78.42-1.31.76-1.61-2.67-.3-5.47-1.33-5.47-5.93 0-1.31.47-2.38 1.24-3.22-.13-.3-.54-1.52.11-3.18 0 0 1.01-.32 3.3 1.23a11.5 11.5 0 0 1 6.01 0c2.29-1.55 3.29-1.23 3.29-1.23.66 1.66.25 2.88.12 3.18.77.84 1.24 1.91 1.24 3.22 0 4.61-2.81 5.63-5.48 5.92.43.37.81 1.1.81 2.22 0 1.61-.01 2.9-.01 3.29 0 .32.21.7.82.58A12 12 0 0 0 24 12c0-6.63-5.37-12-12-12Z" />
    </svg>
  )
}

function DiscordMark({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden>
      <path d="M20.317 4.3698a19.7913 19.7913 0 0 0-4.8851-1.5152.0741.0741 0 0 0-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 0 0-.0785-.037 19.7363 19.7363 0 0 0-4.8852 1.515.0699.0699 0 0 0-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 0 0 .0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 0 0 .0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 0 0-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 0 1-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 0 1 .0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 0 1 .0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 0 1-.0066.1276 12.2986 12.2986 0 0 1-1.873.8914.0766.0766 0 0 0-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 0 0 .0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 0 0 .0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 0 0-.0312-.0286ZM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189Zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z" />
    </svg>
  )
}

function FacebookMark({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden>
      <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073Z" />
    </svg>
  )
}

const PROVIDER_META: Record<ProviderId, {
  name: string
  Mark: typeof GoogleMark
  markClass: string
  console: string
  consoleName: string
  tagline: string
}> = {
  google: {
    name: 'Google',
    Mark: GoogleMark,
    markClass: 'w-[18px] h-[18px]',
    console: 'https://console.cloud.google.com/apis/credentials',
    consoleName: 'Google Cloud Console',
    tagline: 'One-tap OAuth 2.0 sign-in',
  },
  github: {
    name: 'GitHub',
    Mark: GitHubMark,
    markClass: 'w-[18px] h-[18px] text-zinc-200',
    console: 'https://github.com/settings/developers',
    consoleName: 'GitHub Developer Settings',
    tagline: 'OAuth sign-in built for developer apps',
  },
  // The runtime serves these (server/routes/oauth.ts) and the agent configures
  // them (add_oauth_provider) — the page only knew Google and GitHub, so a
  // Discord sign-in worked for end users while the owner's console showed no
  // row to see or disable it.
  discord: {
    name: 'Discord',
    Mark: DiscordMark,
    markClass: 'w-[18px] h-[18px] text-indigo-300',
    console: 'https://discord.com/developers/applications',
    consoleName: 'Discord Developer Portal',
    tagline: 'OAuth sign-in for community apps',
  },
  facebook: {
    name: 'Facebook',
    Mark: FacebookMark,
    markClass: 'w-[18px] h-[18px] text-blue-300',
    console: 'https://developers.facebook.com/apps',
    consoleName: 'Meta for Developers',
    tagline: 'OAuth sign-in with a Facebook account',
  },
}

function timeAgo(iso?: string | null): string {
  if (!iso) return ''
  const t = new Date(iso).getTime()
  if (isNaN(t)) return ''
  const s = Math.floor((Date.now() - t) / 1000)
  if (s < 45) return 'just now'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 7) return `${d}d ago`
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

// Identity avatars stay neutral — color is reserved for state, not decoration.
const AVATAR_TONE = 'bg-white/[0.04] border-white/[0.10] text-zinc-300'

function delta(value: number | undefined) {
  if (!value) return undefined
  return (
    <span className={value > 0 ? 'text-emerald-300/90' : 'text-rose-300'}>
      {value > 0 ? '+' : '−'}
      {Math.abs(value)}% vs previous period
    </span>
  )
}

export function AuthConfiguration() {
  const router = useRouter()
  const [toast, setToast] = useState<{ message: string, type: 'success' | 'error' | 'info' | 'warning' } | null>(null)
  const [showWorkspaceOAuthModal, setShowWorkspaceOAuthModal] = useState<ProviderId | null>(null)
  const [configClientId, setConfigClientId] = useState('')
  const [configClientSecret, setConfigClientSecret] = useState('')
  const [saving, setSaving] = useState(false)
  const [currentProjectId, setCurrentProjectId] = useState<string | null>(null)
  const [enabledProviders, setEnabledProviders] = useState<Set<string>>(new Set())
  // Genuine email/password enablement — resolved from the shared auth-status
  // resolver (agent-built graph provider or real usage), NEVER the bare
  // jwtSecret. Drives whether Email & password reads as "active".
  const [emailProviderEnabled, setEmailProviderEnabled] = useState(false)
  const [stats, setStats] = useState<AuthStats | null>(null)
  const [statsLoading, setStatsLoading] = useState(true)
  const [recent, setRecent] = useState<RecentUser[]>([])
  // The project's API base in its own region ({origin}/api/v1/{id}), from the
  // server. This page's origin is the console's, which is not where a project
  // in another region is served, and the redirect URI below is registered with
  // the provider and kept.
  const [apiBaseUrl, setApiBaseUrl] = useState<string | null>(null)
  const [loadError, setLoadError] = useState(false)

  const authHeaders = useCallback((projectId: string): HeadersInit => {
    const token = localStorage.getItem('auth-token')
    const headers: HeadersInit = { 'X-Project-Id': projectId }
    if (token) headers['Authorization'] = `Bearer ${token}`
    return headers
  }, [])

  const fetchEnabledProviders = useCallback(async (projectId: string) => {
    try {
      const res = await fetch('/api/workspace-oauth', {
        headers: authHeaders(projectId),
        credentials: 'include',
        cache: 'no-store',
      })
      if (res.ok) {
        const data = await res.json()
        setEnabledProviders(new Set<string>(
          (data.configs ?? []).filter((c: any) => c.enabled).map((c: any) => c.provider as string)
        ))
      } else {
        setLoadError(true)
      }
    } catch { setLoadError(true) }
  }, [authHeaders])

  const fetchEmailAuthStatus = useCallback(async (projectId: string) => {
    try {
      const res = await fetch(`/api/projects/${projectId}/auth-state`, {
        headers: authHeaders(projectId),
        credentials: 'include',
        cache: 'no-store',
      })
      if (res.ok) {
        const data = await res.json()
        const email = (data.providers ?? []).find((p: any) => p.id === 'email')
        setEmailProviderEnabled(!!email?.enabled)
      }
    } catch { /* soft-fail — default to not active */ }
  }, [authHeaders])

  const fetchStats = useCallback(async (projectId: string) => {
    try {
      const res = await fetch('/api/auth/users/stats', {
        headers: authHeaders(projectId),
        credentials: 'include',
        cache: 'no-store',
      })
      if (res.ok) setStats(await res.json())
      else setLoadError(true)
    } catch { setLoadError(true) } finally {
      setStatsLoading(false)
    }
  }, [authHeaders])

  const fetchRecent = useCallback(async (projectId: string) => {
    try {
      const res = await fetch('/api/auth/users?limit=5', {
        headers: authHeaders(projectId),
        credentials: 'include',
        cache: 'no-store',
      })
      if (res.ok) {
        const data = await res.json()
        setRecent((data.users ?? []).slice(0, 5))
      } else {
        setLoadError(true)
      }
    } catch { setLoadError(true) }
  }, [authHeaders])

  const fetchApiBaseUrl = useCallback(async (projectId: string) => {
    try {
      const project = await getProject(projectId)
      setApiBaseUrl(project.apiBaseUrl ?? null)
    } catch {
      setApiBaseUrl(null)
    }
  }, [])

  const loadAll = useCallback((projectId: string) => {
    setLoadError(false)
    fetchApiBaseUrl(projectId)
    fetchEnabledProviders(projectId)
    fetchEmailAuthStatus(projectId)
    fetchStats(projectId)
    fetchRecent(projectId)
  }, [fetchApiBaseUrl, fetchEnabledProviders, fetchEmailAuthStatus, fetchStats, fetchRecent])

  useEffect(() => {
    const projectId = localStorage.getItem('current-project-id')
    setCurrentProjectId(projectId)
    if (projectId) {
      loadAll(projectId)
    } else {
      const retryTimer = setTimeout(() => {
        const pid = localStorage.getItem('current-project-id')
        if (pid) {
          setCurrentProjectId(pid)
          loadAll(pid)
        }
      }, 100)
      return () => clearTimeout(retryTimer)
    }

    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        const pid = localStorage.getItem('current-project-id')
        if (pid) loadAll(pid)
      }
    }
    document.addEventListener('visibilitychange', handleVisibility)

    const handleOAuthConnected = () => {
      const pid = localStorage.getItem('current-project-id')
      if (pid) loadAll(pid)
    }
    window.addEventListener('backenly:oauth-connected', handleOAuthConnected)

    return () => {
      document.removeEventListener('visibilitychange', handleVisibility)
      window.removeEventListener('backenly:oauth-connected', handleOAuthConnected)
    }
  }, [loadAll])

  /** Resolves true only when the credentials were stored, so the dialog can stay open on failure. */
  const handleSaveWorkspaceOAuth = async (provider: ProviderId, clientId: string, clientSecret: string): Promise<boolean> => {
    if (!currentProjectId) {
      setToast({ message: 'No project selected', type: 'error' })
      return false
    }

    setSaving(true)
    try {
      const token = localStorage.getItem('auth-token')
      const headers: HeadersInit = { 'Content-Type': 'application/json' }
      if (token) headers['Authorization'] = `Bearer ${token}`

      const envKeys: Record<ProviderId, Record<string, string>> = {
        google: { GOOGLE_CLIENT_ID: clientId, GOOGLE_CLIENT_SECRET: clientSecret },
        github: { GITHUB_CLIENT_ID: clientId, GITHUB_CLIENT_SECRET: clientSecret },
        discord: { DISCORD_CLIENT_ID: clientId, DISCORD_CLIENT_SECRET: clientSecret },
        facebook: { FACEBOOK_CLIENT_ID: clientId, FACEBOOK_CLIENT_SECRET: clientSecret },
      }
      const response = await fetch(`/api/projects/${currentProjectId}/credentials`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ integrationId: provider, values: envKeys[provider] }),
      })

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}))
        throw new Error((errData as any).error || 'Failed to save OAuth config')
      }

      setToast({ message: `${PROVIDER_META[provider].name} sign-in activated`, type: 'success' })
      if (currentProjectId) fetchEnabledProviders(currentProjectId)
      return true
    } catch (error) {
      console.error('Error saving workspace OAuth:', error)
      setToast({
        message: error instanceof Error && error.message ? error.message : 'The credentials could not be saved. Try again.',
        type: 'error',
      })
      return false
    } finally {
      setSaving(false)
    }
  }

  const openOAuthModal = (provider: ProviderId) => {
    if (!currentProjectId) {
      router.push('/app')
      return
    }
    setShowWorkspaceOAuthModal(provider)
    setConfigClientId('')
    setConfigClientSecret('')
  }

  const callbackUrl = (provider: ProviderId) =>
    apiBaseUrl ? `${apiBaseUrl}/auth/${provider}/callback` : ''


  const emailActive = emailProviderEnabled || (stats?.totalUsers ?? 0) > 0
  const modalProvider = showWorkspaceOAuthModal
  const modalMeta = modalProvider ? PROVIDER_META[modalProvider] : null
  const modalIsUpdate = modalProvider ? enabledProviders.has(modalProvider) : false
  const usersHref = currentProjectId ? `/app/projects/${currentProjectId}/auth?tab=users` : '/app'

  return (
    <div className="mx-auto w-full max-w-[1200px] px-4 py-6 sm:px-6 lg:px-8">
      <Toast
        message={toast?.message || ''}
        type={toast?.type || 'info'}
        isVisible={!!toast}
        onClose={() => setToast(null)}
      />

      {loadError && (
        <div className="mb-5">
          <KitNote
            tone="danger"
            icon={Shield}
            actions={
              <KitButton size="sm" variant="secondary" onClick={() => currentProjectId && loadAll(currentProjectId)}>
                Retry
              </KitButton>
            }
          >
            Some auth data couldn&apos;t be loaded, so the numbers below may be incomplete.
          </KitNote>
        </div>
      )}

      <StatStrip className="mb-8">
        <Stat label="Users" value={(stats?.totalUsers ?? 0).toLocaleString()} loading={statsLoading} />
        <Stat
          label="Active in 30 days"
          value={(stats?.activeUsers ?? 0).toLocaleString()}
          hint={delta(stats?.activeUsersDelta)}
          loading={statsLoading}
        />
        <Stat label="Verified email" value={(stats?.verifications ?? 0).toLocaleString()} loading={statsLoading} />
        <Stat
          label="New in 24 hours"
          value={(stats?.signups24h ?? 0).toLocaleString()}
          hint={delta(stats?.signupsDelta)}
          loading={statsLoading}
        />
      </StatStrip>

      <div className="grid grid-cols-1 items-start gap-8 lg:grid-cols-[minmax(0,1fr)_320px]">
        <SettingsCard
          title="Sign-in methods"
          description="How the people using your app create an account and sign in. Social providers use your own OAuth app, stored encrypted for this project."
        >
          <ul className="-mx-5 divide-y divide-white/[0.06] border-t border-white/[0.06] sm:-mx-6">
            <li className="flex items-center gap-4 px-5 py-4 sm:px-6">
              <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-[8px] border border-white/[0.08] bg-[#08090a]">
                <Mail className="h-4 w-4 text-zinc-300" strokeWidth={1.75} />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-medium text-zinc-100">Email and password</p>
                <p className="mt-0.5 text-[12.5px] leading-[18px] text-zinc-500">
                  {/* "Active" only once auth is genuinely on: the agent enabled
                      it, or real end users exist. A bare jwtSecret (seeded at
                      creation) is not activation. */}
                  {emailActive
                    ? 'Sign-up, sign-in and password reset with JWT sessions.'
                    : 'Turns on when your agent adds sign-up to the app, or when the first user signs up.'}
                </p>
              </div>
              <StatusDot tone={emailActive ? 'operational' : 'neutral'} label={emailActive ? 'Active' : 'Not set up'} />
            </li>

            {(['google', 'github', 'discord', 'facebook'] as ProviderId[]).map((pid) => {
              const meta = PROVIDER_META[pid]
              const enabled = enabledProviders.has(pid)
              const Mark = meta.Mark
              return (
                <li key={pid} className="flex items-center gap-4 px-5 py-4 sm:px-6">
                  <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-[8px] border border-white/[0.08] bg-[#08090a]">
                    <Mark className={meta.markClass} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-[13px] font-medium text-zinc-100">{meta.name}</p>
                    <p className="mt-0.5 text-[12.5px] leading-[18px] text-zinc-500">{meta.tagline}</p>
                  </div>
                  <div className="flex flex-shrink-0 items-center gap-3">
                    {enabled && <StatusDot tone="operational" label="Connected" className="hidden sm:inline-flex" />}
                    <KitButton size="sm" variant={enabled ? 'ghost' : 'secondary'} onClick={() => openOAuthModal(pid)}>
                      {enabled ? 'Manage' : 'Set up'}
                    </KitButton>
                  </div>
                </li>
              )
            })}
          </ul>
        </SettingsCard>

        <div className="space-y-8">
          <section>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-[13px] font-medium text-zinc-100">Recent sign-ups</h2>
              {recent.length > 0 && (
                <Link href={usersHref} className="inline-flex items-center gap-1 text-[12.5px] text-zinc-400 transition-colors hover:text-zinc-100">
                  All users <ArrowRight className="h-3.5 w-3.5" />
                </Link>
              )}
            </div>
            {recent.length === 0 ? (
              <p className="rounded-[10px] border border-dashed border-white/[0.08] px-4 py-5 text-[12.5px] leading-[19px] text-zinc-500">
                No one has signed up yet. The first account created from your app appears here straight away.
              </p>
            ) : (
              <ul className="overflow-hidden rounded-[10px] border border-white/[0.07] bg-[#111214] divide-y divide-white/[0.05]">
                {recent.map((u) => (
                  <li key={u.id} className="flex items-center gap-3 px-4 py-2.5">
                    <span className={`flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full border text-[12px] font-semibold uppercase ${AVATAR_TONE}`}>
                      {(u.email || '?').slice(0, 1)}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] text-zinc-200">{u.email}</span>
                      <span className="mt-0.5 block truncate text-[12px] tabular-nums text-zinc-500">
                        {(u.provider || 'email').toLowerCase()} · {timeAgo(u.createdAt)}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section>
            <h2 className="mb-3 text-[13px] font-medium text-zinc-100">How identities are protected</h2>
            <KitChecklist
              items={[
                'Tokens signed with this project’s own secret',
                'Passwords hashed with bcrypt, never reversible',
                'Identities kept in this project’s own schema',
                'Sessions revocable server-side on sign-out',
              ]}
            />
          </section>
        </div>
      </div>

      {/* OAuth setup */}
      <KitModal
        open={!!modalProvider}
        onClose={() => setShowWorkspaceOAuthModal(null)}
        width="max-w-lg"
        title={modalMeta ? (modalIsUpdate ? `Manage ${modalMeta.name} sign-in` : `Connect ${modalMeta.name}`) : ''}
        description="Credentials are stored encrypted and scoped to this project."
        footer={
          modalProvider && modalMeta ? (
            <>
              <span className="mr-auto hidden items-center gap-1.5 text-[12.5px] text-zinc-500 sm:inline-flex">
                <KeyRound className="h-3.5 w-3.5" /> Encrypted at rest
              </span>
              <KitButton variant="ghost" onClick={() => setShowWorkspaceOAuthModal(null)}>
                Cancel
              </KitButton>
              <KitButton
                variant="primary"
                loading={saving}
                onClick={async () => {
                  const ok = await handleSaveWorkspaceOAuth(modalProvider, configClientId, configClientSecret)
                  if (ok) setShowWorkspaceOAuthModal(null)
                }}
                disabled={!configClientId || !configClientSecret}
              >
                {saving ? 'Saving…' : modalIsUpdate ? 'Update credentials' : 'Activate'}
              </KitButton>
            </>
          ) : undefined
        }
      >
        {modalProvider && modalMeta && (
          <ol className="space-y-5">
            <OAuthStep n={1} title={
              <>
                Create an OAuth client in{' '}
                <a
                  href={modalMeta.console}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-zinc-50 underline decoration-white/25 underline-offset-4 hover:decoration-white/60"
                >
                  {modalMeta.consoleName} <ExternalLink className="h-3 w-3" />
                </a>
              </>
            } />
            {/* The redirect URI is where most OAuth setups fail; hand it over ready to paste. */}
            <OAuthStep n={2} title="Add this authorized redirect URI">
              {apiBaseUrl ? (
                <CopyField value={callbackUrl(modalProvider)} />
              ) : (
                <span className="text-zinc-500">The project&apos;s address is not available. Reload the page to try again.</span>
              )}
            </OAuthStep>
            <OAuthStep n={3} title={`Paste the credentials ${modalMeta.name} gives you`}>
              <div className="space-y-3">
                <KitField label="Client ID">
                  <KitInput
                    type="text"
                    value={configClientId}
                    onChange={(e) => setConfigClientId(e.target.value)}
                    placeholder={modalIsUpdate ? 'New client ID, replaces the stored one' : 'Client ID'}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </KitField>
                <KitField label="Client secret">
                  <KitInput
                    type="password"
                    value={configClientSecret}
                    onChange={(e) => setConfigClientSecret(e.target.value)}
                    placeholder={modalIsUpdate ? 'New client secret' : 'Client secret'}
                    autoComplete="new-password"
                  />
                </KitField>
              </div>
            </OAuthStep>
          </ol>
        )}
      </KitModal>
    </div>
  )
}

function OAuthStep({ n, title, children }: { n: number; title: React.ReactNode; children?: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="mt-px flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full border border-white/[0.10] bg-white/[0.04] text-[11.5px] font-medium tabular-nums text-zinc-400">
        {n}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-medium leading-[20px] text-zinc-100">{title}</p>
        {children && <div className="mt-2">{children}</div>}
      </div>
    </li>
  )
}
