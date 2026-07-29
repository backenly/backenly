'use client'

import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { Toast } from '@/components/ui/Toast'
import {
  Mail, Check, Users, ArrowRight, Shield, Copy, ExternalLink,
  KeyRound, Settings2,
} from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import { InspectorGovernanceFooter } from '@/components/inspector/InspectorPageHeader'
import {
  KitCard, KitCardHeader,
  KitButton, KitBadge, KitChecklist, KitNote,
  EmptyState,
  KitField, KitInput, KitMoreLink,
  SectionLabel,
} from '@/components/inspector/kit'

type ProviderId = 'google' | 'github'

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

// ─── Copy field (used for redirect URI + snippet) ─────────────────────────────

function CopyValue({ value, mono = true }: { value: string; mono?: boolean }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    } catch { /* clipboard unavailable */ }
  }
  return (
    <div className="flex items-center gap-2 bg-[#0f1015] border border-white/[0.07] rounded-lg pl-3 pr-1.5 py-1.5 min-w-0">
      <span className={`flex-1 min-w-0 truncate text-[12px] text-zinc-300 ${mono ? 'font-mono' : ''}`}>
        {value}
      </span>
      <button
        onClick={copy}
        title="Copy"
        className={`flex-shrink-0 inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium transition-colors ${
          copied
            ? 'text-emerald-300 bg-emerald-500/[0.10]'
            : 'text-zinc-400 hover:text-zinc-100 hover:bg-white/[0.06]'
        }`}
      >
        {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
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
  const [origin, setOrigin] = useState('')
  const [loadError, setLoadError] = useState(false)

  useEffect(() => {
    setOrigin(window.location.origin)
  }, [])

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

  const loadAll = useCallback((projectId: string) => {
    setLoadError(false)
    fetchEnabledProviders(projectId)
    fetchEmailAuthStatus(projectId)
    fetchStats(projectId)
    fetchRecent(projectId)
  }, [fetchEnabledProviders, fetchEmailAuthStatus, fetchStats, fetchRecent])

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

  const handleSaveWorkspaceOAuth = async (provider: ProviderId, clientId: string, clientSecret: string) => {
    if (!currentProjectId) {
      setToast({ message: 'No project selected', type: 'error' })
      return
    }

    setSaving(true)
    try {
      const token = localStorage.getItem('auth-token')
      const headers: HeadersInit = { 'Content-Type': 'application/json' }
      if (token) headers['Authorization'] = `Bearer ${token}`

      const envKeys: Record<ProviderId, Record<string, string>> = {
        google: { GOOGLE_CLIENT_ID: clientId, GOOGLE_CLIENT_SECRET: clientSecret },
        github: { GITHUB_CLIENT_ID: clientId, GITHUB_CLIENT_SECRET: clientSecret },
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
    } catch (error) {
      console.error('Error saving workspace OAuth:', error)
      setToast({ message: 'Failed to save configuration', type: 'error' })
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
    `${origin || 'https://backenly.com'}/api/v1/${currentProjectId ?? '{projectId}'}/auth/${provider}/callback`


  return (
    <div className="px-8 py-6">
      <Toast
        message={toast?.message || ''}
        type={toast?.type || 'info'}
        isVisible={!!toast}
        onClose={() => setToast(null)}
      />

      {loadError && (
        <div className="mb-4">
          <KitNote
            tone="danger"
            icon={Shield}
            actions={
              <KitButton
                size="sm"
                variant="secondary"
                onClick={() => currentProjectId && loadAll(currentProjectId)}
              >
                Retry
              </KitButton>
            }
          >
            Couldn&apos;t load some auth data. The numbers below may be incomplete.
          </KitNote>
        </div>
      )}

      {/* Identity metrics — one dense rail of mono counters, matching the
          workspace home inventory rail. */}
      <div className="mb-4 rounded-xl border border-white/[0.07] bg-[#16171d] shadow-[0_16px_44px_-28px_rgba(0,0,0,0.9)]">
        <div className="grid grid-cols-2 sm:grid-cols-4 divide-x divide-white/[0.06]">
          <div className="flex items-baseline gap-2 px-4 py-3">
            <span className="font-mono text-[16px] font-medium tabular-nums leading-none text-white">
              {statsLoading ? '—' : (stats?.totalUsers ?? 0).toLocaleString()}
            </span>
            <span className="text-[11px] text-zinc-500 leading-none">identities</span>
          </div>
          <div className="flex items-baseline gap-2 px-4 py-3">
            <span className="font-mono text-[16px] font-medium tabular-nums leading-none text-white">
              {statsLoading ? '—' : (stats?.activeUsers ?? 0).toLocaleString()}
            </span>
            <span className="text-[11px] text-zinc-500 leading-none">active · 30d</span>
            {!statsLoading && stats?.activeUsersDelta ? (
              <span className={`font-mono text-[10.5px] font-medium tabular-nums leading-none ${stats.activeUsersDelta > 0 ? 'text-emerald-300/90' : 'text-rose-300'}`}>
                {stats.activeUsersDelta > 0 ? '+' : ''}{stats.activeUsersDelta}%
              </span>
            ) : null}
          </div>
          <div className="flex items-baseline gap-2 px-4 py-3">
            <span className="font-mono text-[16px] font-medium tabular-nums leading-none text-white">
              {statsLoading ? '—' : (stats?.verifications ?? 0).toLocaleString()}
            </span>
            <span className="text-[11px] text-zinc-500 leading-none">verified</span>
          </div>
          <div className="flex items-baseline gap-2 px-4 py-3">
            <span className="font-mono text-[16px] font-medium tabular-nums leading-none text-white">
              {statsLoading ? '—' : (stats?.signups24h ?? 0).toLocaleString()}
            </span>
            <span className="text-[11px] text-zinc-500 leading-none">new · 24h</span>
            {!statsLoading && stats?.signupsDelta ? (
              <span className={`font-mono text-[10.5px] font-medium tabular-nums leading-none ${stats.signupsDelta > 0 ? 'text-emerald-300/90' : 'text-rose-300'}`}>
                {stats.signupsDelta > 0 ? '+' : ''}{stats.signupsDelta}%
              </span>
            ) : null}
          </div>
        </div>
      </div>

      {/* Main: methods + sidebar */}
      <div className="flex gap-6 items-start">
        <div className="flex-1 min-w-0 flex flex-col gap-6">
          <KitCard>
            <KitCardHeader
              title="Sign-in methods"
              description="Choose how end-users authenticate with this backend."
            />

            {/* Email & Password */}
            <div className="px-4 py-3 border-b border-white/[0.05]">
              <div className="flex items-center gap-3">
                <Mail className="w-3.5 h-3.5 text-zinc-500 flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <h4 className="text-[12.5px] font-medium text-zinc-200">Email &amp; password</h4>
                  <p className="text-[11.5px] text-zinc-500 mt-0.5">Secure registration and login with JWT sessions.</p>
                </div>
                {/* "active" only once auth is genuinely on: the agent enabled it,
                    OAuthConfig/policy configured, or real end-users exist. A bare
                    jwtSecret (seeded at creation) is not activation, so a
                    never-built project reads "not set up", not a false green. */}
                {emailProviderEnabled || (stats?.totalUsers ?? 0) > 0 ? (
                  <KitBadge tone="operational">active</KitBadge>
                ) : (
                  <KitBadge tone="neutral">not set up</KitBadge>
                )}
              </div>
            </div>

            {/* Social providers */}
            <div className="px-4 py-4">
              <div className="flex items-center justify-between mb-3">
                <SectionLabel>Social sign-in</SectionLabel>
                <span className="text-[11px] text-zinc-600">Your own OAuth credentials, stored encrypted per project</span>
              </div>
              <div className="grid gap-2">
                {(['google', 'github'] as ProviderId[]).map((pid) => {
                  const meta = PROVIDER_META[pid]
                  const enabled = enabledProviders.has(pid)
                  const Mark = meta.Mark
                  return (
                    <button
                      key={pid}
                      onClick={() => openOAuthModal(pid)}
                      className={`flex items-center gap-3 px-3.5 py-3 rounded-lg border text-left transition-colors group focus:outline-none ${
                        enabled
                          ? 'bg-white/[0.015] border-emerald-500/20 hover:border-emerald-500/30'
                          : 'bg-white/[0.015] border-white/[0.07] hover:border-white/[0.14] hover:bg-white/[0.025]'
                      }`}
                    >
                      <div className="w-8 h-8 rounded-lg border bg-[#0f1015] border-white/[0.07] flex items-center justify-center flex-shrink-0">
                        <Mark className={meta.markClass} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <h4 className="text-[12.5px] font-medium text-zinc-200">{meta.name}</h4>
                        <p className="text-[11.5px] text-zinc-500 mt-0.5">{meta.tagline}</p>
                      </div>
                      {enabled ? (
                        <span className="flex items-center gap-2.5">
                          <KitBadge tone="operational">connected</KitBadge>
                          <span className="hidden group-hover:inline-flex items-center gap-1 text-[11px] font-medium text-zinc-400">
                            <Settings2 className="w-3 h-3" /> Manage
                          </span>
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-[11.5px] font-medium text-zinc-500 group-hover:text-zinc-200 transition-colors">
                          Set up <ArrowRight className="w-3 h-3" />
                        </span>
                      )}
                    </button>
                  )
                })}
              </div>
            </div>
          </KitCard>

        </div>

        {/* Right sidebar */}
        <div className="w-80 flex-shrink-0 flex flex-col gap-6">
          <KitCard>
            <div className="px-4 py-3 border-b border-white/[0.06] flex items-center gap-2">
              <Shield className="w-3 h-3 text-emerald-400/70" />
              <SectionLabel>Security posture</SectionLabel>
            </div>
            <div className="px-4 py-4">
              <KitChecklist items={[
                'Tokens signed with this project’s isolated secret',
                'Passwords hashed with bcrypt, never reversible',
                'Identities isolated in a per-project schema',
                'Sessions revocable server-side on logout',
              ]} />
            </div>
          </KitCard>

          <KitCard>
            <div className="px-4 py-3 border-b border-white/[0.06] flex items-center justify-between">
              <SectionLabel>Recent identities</SectionLabel>
              {recent.length > 0 && (
                <KitMoreLink onClick={() => currentProjectId && router.push(`/app/projects/${currentProjectId}/auth?tab=users`)}>
                  All
                </KitMoreLink>
              )}
            </div>
            {recent.length === 0 ? (
              <EmptyState
                icon={Users}
                title="No identities yet"
                description="The first sign-up from your app appears here instantly."
              />
            ) : (
              <>
                <div className="divide-y divide-white/[0.04]">
                  {recent.map((u) => (
                    <div key={u.id} className="flex items-center gap-3 px-4 py-[11px]">
                      <div className={`w-7 h-7 rounded-full border flex items-center justify-center flex-shrink-0 text-[11px] font-semibold uppercase ${AVATAR_TONE}`}>
                        {(u.email || '?').slice(0, 1)}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-[12.5px] font-medium text-zinc-200 truncate">{u.email}</p>
                        <p className="font-mono text-[10.5px] text-zinc-600 mt-0.5 truncate tabular-nums">
                          {(u.provider || 'email').toLowerCase()} · {timeAgo(u.createdAt)}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
                <button
                  onClick={() => currentProjectId && router.push(`/app/projects/${currentProjectId}/auth?tab=users`)}
                  className="group w-full flex items-center justify-center gap-1.5 px-4 py-2.5 border-t border-white/[0.06] text-[11.5px] font-medium text-zinc-500 hover:text-zinc-200 transition-colors focus:outline-none"
                >
                  Manage all users
                  <ArrowRight className="w-3 h-3 transition-transform group-hover:translate-x-0.5" />
                </button>
              </>
            )}
          </KitCard>
        </div>
      </div>

      <InspectorGovernanceFooter />

      {/* OAuth setup modal */}
      <AnimatePresence>
        {showWorkspaceOAuthModal && (() => {
          const provider = showWorkspaceOAuthModal
          const meta = PROVIDER_META[provider]
          const Mark = meta.Mark
          const isUpdate = enabledProviders.has(provider)
          return (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4"
              onClick={() => setShowWorkspaceOAuthModal(null)}
            >
              <motion.div
                initial={{ scale: 0.96, opacity: 0, y: 8 }}
                animate={{ scale: 1, opacity: 1, y: 0 }}
                exit={{ scale: 0.96, opacity: 0, y: 4 }}
                onClick={(e) => e.stopPropagation()}
                className="bg-[#16171d] border border-white/[0.12] rounded-xl max-w-lg w-full shadow-[0_12px_32px_-16px_rgba(0,0,0,0.85)] overflow-hidden"
              >
                <div className="px-6 pt-5 pb-4 border-b border-white/[0.06] flex items-center gap-3.5">
                  <div className="w-9 h-9 rounded-lg bg-[#0f1015] border border-white/[0.08] flex items-center justify-center">
                    <Mark className="w-[18px] h-[18px]" />
                  </div>
                  <div className="min-w-0">
                    <h3 className="text-[14px] font-semibold text-zinc-50 tracking-[-0.01em]">
                      {isUpdate ? `Manage ${meta.name} sign-in` : `Connect ${meta.name}`}
                    </h3>
                    <p className="text-[12px] text-zinc-500 mt-0.5">Credentials are stored encrypted, scoped to this project.</p>
                  </div>
                </div>

                <div className="px-6 py-5 space-y-5">
                  {/* Step 1 */}
                  <div className="flex gap-3">
                    <span className="w-5 h-5 rounded-full bg-white/[0.05] border border-white/[0.10] text-zinc-400 text-[11px] font-semibold flex items-center justify-center flex-shrink-0 mt-px">1</span>
                    <div className="min-w-0 flex-1">
                      <p className="text-[13px] text-zinc-200 font-medium">
                        Create an OAuth client in{' '}
                        <a href={meta.console} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-violet-300 hover:text-violet-200 transition-colors">
                          {meta.consoleName} <ExternalLink className="w-3 h-3" />
                        </a>
                      </p>
                    </div>
                  </div>

                  {/* Step 2 — the redirect URI is where most OAuth setups fail;
                      hand it over ready to paste. */}
                  <div className="flex gap-3">
                    <span className="w-5 h-5 rounded-full bg-white/[0.05] border border-white/[0.10] text-zinc-400 text-[11px] font-semibold flex items-center justify-center flex-shrink-0 mt-px">2</span>
                    <div className="min-w-0 flex-1">
                      <p className="text-[13px] text-zinc-200 font-medium mb-2">Add this authorized redirect URI</p>
                      <CopyValue value={callbackUrl(provider)} />
                    </div>
                  </div>

                  {/* Step 3 */}
                  <div className="flex gap-3">
                    <span className="w-5 h-5 rounded-full bg-white/[0.05] border border-white/[0.10] text-zinc-400 text-[11px] font-semibold flex items-center justify-center flex-shrink-0 mt-px">3</span>
                    <div className="min-w-0 flex-1 space-y-4">
                      <p className="text-[13px] text-zinc-200 font-medium">Paste the credentials {meta.name} gives you</p>
                      <KitField label="Client ID">
                        <KitInput
                          type="text"
                          value={configClientId}
                          onChange={(e) => setConfigClientId(e.target.value)}
                          placeholder={isUpdate ? 'Enter new client ID to replace the stored one' : 'Paste your client ID'}
                          autoComplete="off"
                        />
                      </KitField>
                      <KitField label="Client Secret">
                        <KitInput
                          type="password"
                          value={configClientSecret}
                          onChange={(e) => setConfigClientSecret(e.target.value)}
                          placeholder={isUpdate ? 'Enter new client secret' : 'Paste your client secret'}
                          autoComplete="new-password"
                        />
                      </KitField>
                    </div>
                  </div>
                </div>

                <div className="px-6 py-4 border-t border-white/[0.06] flex items-center justify-between gap-2">
                  <span className="inline-flex items-center gap-1.5 text-[11.5px] text-zinc-500">
                    <KeyRound className="w-3 h-3" /> Encrypted at rest
                  </span>
                  <div className="flex gap-2">
                    <KitButton variant="ghost" onClick={() => setShowWorkspaceOAuthModal(null)}>
                      Cancel
                    </KitButton>
                    <KitButton
                      variant="primary"
                      onClick={async () => {
                        await handleSaveWorkspaceOAuth(provider, configClientId, configClientSecret)
                        setShowWorkspaceOAuthModal(null)
                      }}
                      disabled={!configClientId || !configClientSecret || saving}
                    >
                      {saving ? 'Saving…' : isUpdate ? 'Update credentials' : 'Activate'}
                    </KitButton>
                  </div>
                </div>
              </motion.div>
            </motion.div>
          )
        })()}
      </AnimatePresence>
    </div>
  )
}
